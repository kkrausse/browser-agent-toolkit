//! The guest's `/bin/sh` (also `bash`): a POSIX-style shell with the coreutils
//! built in. See `interp.rs` for how commands run and `sys.rs` for the host
//! calls. `main` is the whole program; the Wasm exports below are how the
//! runtime calls it (runtime/src/process/sh.ts).
pub mod ast;
pub mod awk;
pub mod builtins;
pub mod diff;
pub mod expand;
pub mod files;
pub mod find;
pub mod glob;
pub mod interp;
pub mod parser;
pub mod pkg;
pub mod rg;
pub mod sed;
pub mod sys;
pub mod test;
pub mod text;
pub mod util;

use interp::{basename, Flow, Interp, Io, X, SHELL_NAMES};

fn shell_main(sh: &mut Interp, argv: &[String]) -> X {
    let mut i = 1;
    let mut command = false;
    let mut from_stdin = false;
    while i < argv.len() {
        let a = argv[i].as_str();
        if a == "--" {
            i += 1;
            break;
        }
        if a.starts_with("--") {
            // --login, --norc, --noprofile, --posix: nothing to do
            i += 1;
            continue;
        }
        if !(a.starts_with('-') || a.starts_with('+')) || a.len() < 2 {
            break;
        }
        let on = a.starts_with('-');
        if a == "-o" || a == "+o" {
            if argv.get(i + 1).map(String::as_str) == Some("pipefail") {
                sh.s.opts.pipefail = on;
            }
            i += 2;
            continue;
        }
        for c in a[1..].chars() {
            match c {
                // `bash -euo pipefail -c …`: an `o` inside a cluster takes the next argument as its option name.
                'o' => {
                    if argv.get(i + 1).map(String::as_str) == Some("pipefail") {
                        sh.s.opts.pipefail = on;
                    }
                    i += 1;
                }
                'c' => command = true,
                's' => from_stdin = true,
                'e' => sh.s.opts.errexit = on,
                'x' => sh.s.opts.xtrace = on,
                'u' => sh.s.opts.nounset = on,
                'f' => sh.s.opts.noglob = on,
                _ => {}
            }
        }
        i += 1;
    }
    if command {
        let Some(src) = argv.get(i).cloned() else {
            sh.err("sh: -c: option requires an argument");
            return Ok(2);
        };
        if let Some(name) = argv.get(i + 1) {
            sh.s.arg0 = name.clone();
        }
        sh.s.params = argv.get(i + 2..).map(|r| r.to_vec()).unwrap_or_default();
        return sh.run_source(&src);
    }
    if !from_stdin {
        if let Some(file) = argv.get(i) {
            let path = sh.abs(file);
            return sh.run_file(&path, file, argv[i + 1..].to_vec());
        }
    }
    sh.s.params = argv.get(i..).map(|r| r.to_vec()).unwrap_or_default();
    let src = String::from_utf8_lossy(&sh.read_stdin_all()).into_owned();
    sh.run_source(&src)
}

/// `sh …` run from inside the shell: a fresh shell that inherits the exported
/// variables, the working directory and the descriptors.
pub fn nested(sh: &mut Interp, argv: &[String]) -> i32 {
    let trap = sh.exit_trap.take();
    let st = sh.subshell(|sh| {
        sh.s.vars.retain(|k, v| v.exported || k == "IFS");
        sh.s.funcs.clear();
        sh.s.params.clear();
        sh.s.opts = Default::default();
        sh.s.cond_depth = 0;
        sh.s.loop_depth = 0;
        sh.s.func_depth = 0;
        sh.s.locals.clear();
        sh.s.arg0 = argv[0].clone();
        let r = shell_main(sh, argv);
        run_exit_trap(sh, r)
    });
    sh.exit_trap = trap;
    st
}

fn run_exit_trap(sh: &mut Interp, r: X) -> X {
    let st = match r {
        Ok(s) => s,
        Err(Flow::Exit(c)) | Err(Flow::Return(c)) => c,
        Err(_) => 0,
    };
    if let Some(t) = sh.exit_trap.take() {
        sh.s.status = st;
        if let Err(Flow::Exit(c)) = sh.run_source(&t) {
            return Ok(c);
        }
    }
    Ok(st)
}

/// Run `argv` as the shell (`sh -c …`, `sh file`, script on stdin) or, when
/// `argv[0]` is not a shell name, as that one command (`ls -la`).
pub fn main(argv: Vec<String>, env: Vec<(String, String)>, cwd: String, fds: [Io; 3]) -> i32 {
    let mut sh = Interp::new(cwd, env, fds);
    let name = basename(argv.first().map(String::as_str).unwrap_or("sh")).to_string();
    let r = if argv.is_empty() || SHELL_NAMES.contains(&name.as_str()) {
        sh.s.arg0 = name;
        let r = shell_main(&mut sh, &argv);
        run_exit_trap(&mut sh, r)
    } else {
        let mut v = argv;
        v[0] = name;
        sh.run_status(&v)
    };
    let st = match r {
        Ok(s) => s,
        Err(Flow::Exit(c)) | Err(Flow::Return(c)) => c,
        Err(_) => 0,
    };
    // Children that write into an in-memory capture must end before the capture is handed back.
    sh.reap_jobs(true);
    st
}

// ---- Wasm ABI ----

use std::cell::RefCell;
thread_local! {
    static OUT: RefCell<[Vec<u8>; 2]> = const { RefCell::new([Vec::new(), Vec::new()]) };
}

#[no_mangle]
pub extern "C" fn sh_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p` must come from `sh_alloc(n)`.
#[no_mangle]
pub unsafe extern "C" fn sh_free(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n.max(1)));
}

/// Run one shell. Request: i32 x3 stdio (a host descriptor, -1 nothing, -2 in
/// memory: the stdin bytes below, or a capture read back with `sh_out_*`),
/// u32 argc, u32 envc, then cwd, argv.., env.. (`NAME=value`) and the stdin
/// bytes, each u32 length + bytes. Returns the exit status.
///
/// # Safety
/// `req` must point at `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn sh_run(req: *const u8, len: usize) -> i32 {
    let b = std::slice::from_raw_parts(req, len);
    let mut o = 0usize;
    let u32_ = |o: &mut usize| -> u32 {
        let v = u32::from_le_bytes(b[*o..*o + 4].try_into().unwrap());
        *o += 4;
        v
    };
    let stdio = [u32_(&mut o) as i32, u32_(&mut o) as i32, u32_(&mut o) as i32];
    let argc = u32_(&mut o) as usize;
    let envc = u32_(&mut o) as usize;
    let bytes = |o: &mut usize| -> &[u8] {
        let n = u32::from_le_bytes(b[*o..*o + 4].try_into().unwrap()) as usize;
        *o += 4;
        let s = &b[*o..*o + n];
        *o += n;
        s
    };
    let text = |s: &[u8]| String::from_utf8_lossy(s).into_owned();
    let cwd = text(bytes(&mut o));
    let argv: Vec<String> = (0..argc).map(|_| text(bytes(&mut o))).collect();
    let env: Vec<(String, String)> = (0..envc)
        .filter_map(|_| {
            let kv = text(bytes(&mut o));
            kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect();
    let input = bytes(&mut o).to_vec();
    let caps: [interp::Capture; 2] = Default::default();
    let io = |i: usize| -> Io {
        match stdio[i] {
            fd if fd >= 0 => Io::host(fd, false),
            -2 if i == 0 => Io::input(input.clone()),
            -2 => Io::Cap(caps[i - 1].clone()),
            _ => Io::Null,
        }
    };
    let st = main(argv, env, cwd, [io(0), io(1), io(2)]);
    OUT.with(|out| {
        let mut out = out.borrow_mut();
        out[0] = std::mem::take(&mut *caps[0].borrow_mut());
        out[1] = std::mem::take(&mut *caps[1].borrow_mut());
    });
    st
}

#[no_mangle]
pub extern "C" fn sh_out_ptr(which: u32) -> *const u8 {
    OUT.with(|out| out.borrow()[(which & 1) as usize].as_ptr())
}
#[no_mangle]
pub extern "C" fn sh_out_len(which: u32) -> usize {
    OUT.with(|out| out.borrow()[(which & 1) as usize].len())
}
