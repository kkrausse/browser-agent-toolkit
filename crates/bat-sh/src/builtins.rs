//! Command dispatch and the builtins that are part of the shell itself.
use crate::interp::{basename, Done, Flow, Interp, Var, X};
use crate::parser::valid_name;
use crate::sys;

/// Options of a utility: single-letter flags (clustered), `--long[=value]`, operands.
pub struct Args {
    pub flags: Vec<(char, Option<String>)>,
    pub long: Vec<(String, Option<String>)>,
    pub rest: Vec<String>,
}
impl Args {
    /// `with_value`: the letters that take a value. A cluster of digits (`-5`) is flag `#`.
    pub fn parse(argv: &[String], with_value: &str) -> Args {
        let mut a = Args { flags: Vec::new(), long: Vec::new(), rest: Vec::new() };
        let mut i = 1;
        while i < argv.len() {
            let s = &argv[i];
            i += 1;
            if s == "--" {
                a.rest.extend(argv[i..].iter().cloned());
                break;
            }
            if let Some(l) = s.strip_prefix("--") {
                match l.split_once('=') {
                    Some((k, v)) => a.long.push((k.to_string(), Some(v.to_string()))),
                    None => a.long.push((l.to_string(), None)),
                }
            } else if s.len() > 1 && s.starts_with('-') {
                let body = &s[1..];
                if body.bytes().all(|c| c.is_ascii_digit()) {
                    a.flags.push(('#', Some(body.to_string())));
                    continue;
                }
                let chars: Vec<char> = body.chars().collect();
                let mut k = 0;
                while k < chars.len() {
                    let c = chars[k];
                    k += 1;
                    if with_value.contains(c) {
                        let v: String = chars[k..].iter().collect();
                        if !v.is_empty() {
                            a.flags.push((c, Some(v)));
                        } else if i < argv.len() {
                            a.flags.push((c, Some(argv[i].clone())));
                            i += 1;
                        } else {
                            a.flags.push((c, None));
                        }
                        break;
                    }
                    a.flags.push((c, None));
                }
            } else {
                a.rest.push(s.clone());
            }
        }
        a
    }
    pub fn has(&self, c: char) -> bool {
        self.flags.iter().any(|f| f.0 == c)
    }
    pub fn val(&self, c: char) -> Option<&str> {
        self.flags.iter().rev().find(|f| f.0 == c).and_then(|f| f.1.as_deref())
    }
    pub fn long(&self, name: &str) -> bool {
        self.long.iter().any(|l| l.0 == name)
    }
    pub fn long_val(&self, name: &str) -> Option<&str> {
        self.long.iter().rev().find(|l| l.0 == name).and_then(|l| l.1.as_deref())
    }
}

/// Names that run inside the shell. `which` and `type` answer from this list.
pub const BUILTINS: &[&str] = &[
    ":", ".", "[", "alias", "basename", "break", "cat", "cd", "chmod", "command", "continue", "cp", "cut", "date", "dirname", "du", "echo", "env", "eval",
    "exec", "exit", "export", "false", "find", "getopts", "grep", "egrep", "fgrep", "head", "hostname", "id", "local", "ln", "ls", "mkdir", "mktemp", "mv", "printenv",
    "printf", "pwd", "read", "readlink", "readonly", "realpath", "return", "rm", "rmdir", "sed", "seq", "set", "shift", "sleep", "sort", "source", "tail",
    "tee", "test", "touch", "tr", "trap", "true", "type", "umask", "uname", "uniq", "unset", "wait", "wc", "which", "whoami", "xargs", "npm", "npx", "bunx",
    "yarn", "pnpm", "bun", "unalias", "declare", "typeset", "let", "nproc", "stat", "rev", "tac", "yes", "clear", "sync", "rg", "nl", "base64", "sha256sum", "sha1sum", "md5sum", "shasum", "tree", "cmp", "paste", "comm", "expr", "fold", "column", "od", "xxd",
    "hexdump",
];

/// Shell builtins proper: these are not found as programs by `which`.
const SHELL_ONLY: &[&str] = &[
    ":", ".", "alias", "break", "cd", "command", "continue", "eval", "exec", "exit", "export", "getopts", "local", "read", "readonly", "return", "set", "shift",
    "source", "trap", "type", "umask", "unset", "wait", "unalias", "declare", "typeset", "let",
];

pub fn is_builtin(name: &str) -> bool {
    BUILTINS.contains(&name)
}
/// A builtin that stands in for a program (has a conventional path).
pub fn is_program(name: &str) -> bool {
    BUILTINS.contains(&name) && !SHELL_ONLY.contains(&name)
}

pub fn run(sh: &mut Interp, argv: &[String]) -> Option<X> {
    let a = argv;
    let r: X = match a[0].as_str() {
        "trap" => {
            // Only EXIT is honoured: nothing delivers signals to a builtin.
            let args: Vec<&String> = a[1..].iter().filter(|x| x.as_str() != "--").collect();
            if args.len() >= 2 && args[1..].iter().any(|s| s.as_str() == "EXIT" || s.as_str() == "0") {
                sh.exit_trap = if args[0].is_empty() || args[0].as_str() == "-" { None } else { Some(args[0].clone()) };
            }
            Ok(0)
        }
        "sh" | "bash" | "zsh" | "dash" | "ash" => Ok(crate::nested(sh, a)),
        ":" | "true" | "umask" | "alias" | "unalias" | "sync" | "clear" => Ok(0),
        "false" => Ok(1),
        "echo" => echo(sh, a),
        "printf" => crate::text::printf(sh, a),
        "cd" => cd(sh, a),
        "pwd" => {
            let line = format!("{}\n", sh.s.cwd);
            sh.outs(&line);
            Ok(0)
        }
        "exit" => Err(Flow::Exit(a.get(1).and_then(|v| v.parse::<i32>().ok()).map(|v| v & 255).unwrap_or(sh.s.status))),
        "return" => Err(Flow::Return(a.get(1).and_then(|v| v.parse::<i32>().ok()).map(|v| v & 255).unwrap_or(sh.s.status))),
        "break" | "continue" => {
            let n = a.get(1).and_then(|v| v.parse::<u32>().ok()).unwrap_or(1).max(1);
            if sh.s.loop_depth == 0 {
                Ok(0)
            } else if a[0] == "break" {
                Err(Flow::Break(n))
            } else {
                Err(Flow::Continue(n))
            }
        }
        "export" | "readonly" | "local" | "declare" | "typeset" => declare(sh, a),
        "unset" => {
            for name in a[1..].iter().filter(|n| !n.starts_with('-')) {
                if a.get(1).map(String::as_str) == Some("-f") {
                    sh.s.funcs.remove(name);
                } else {
                    sh.s.vars.remove(name);
                }
            }
            Ok(0)
        }
        "set" => set(sh, a),
        "shift" => {
            let n = a.get(1).and_then(|v| v.parse::<usize>().ok()).unwrap_or(1);
            if n > sh.s.params.len() {
                Ok(1)
            } else {
                sh.s.params.drain(..n);
                Ok(0)
            }
        }
        "test" => Ok(crate::test::test(sh, &a[1..])),
        "[" => {
            if a.last().map(String::as_str) != Some("]") {
                sh.err("sh: [: missing `]'");
                Ok(2)
            } else {
                Ok(crate::test::test(sh, &a[1..a.len() - 1]))
            }
        }
        "eval" => {
            let src = a[1..].join(" ");
            sh.run_source(&src)
        }
        "." | "source" => source(sh, a),
        "exec" => {
            if a.len() < 2 {
                Ok(0)
            } else {
                let st = sh.run_status(&a[1..]);
                match st {
                    Ok(s) => Err(Flow::Exit(s)),
                    Err(e) => Err(e),
                }
            }
        }
        "command" => command(sh, a),
        "type" | "which" => which(sh, a),
        "read" => read(sh, a),
        "wait" => Ok(sh.reap_jobs(false)),
        "let" => {
            let mut last = 0;
            for e in &a[1..] {
                match sh.arith(e) {
                    Ok(v) => last = v,
                    Err(f) => return Some(Err(f)),
                }
            }
            Ok((last == 0) as i32)
        }
        "getopts" => getopts(sh, a),
        "env" => env(sh, a),
        "printenv" => {
            if a.len() > 1 {
                let mut st = 1;
                for name in &a[1..] {
                    if let Some(v) = sh.s.vars.get(name).filter(|v| v.exported).map(|v| v.val.clone()) {
                        sh.outs(&format!("{v}\n"));
                        st = 0;
                    }
                }
                Ok(st)
            } else {
                let text = sh.env_list().join("\n");
                sh.outs(&format!("{text}\n"));
                Ok(0)
            }
        }
        "sleep" => {
            let mut total = 0.0;
            for v in &a[1..] {
                let (num, mul) = match v.as_bytes().last() {
                    Some(b's') => (&v[..v.len() - 1], 1.0),
                    Some(b'm') => (&v[..v.len() - 1], 60.0),
                    Some(b'h') => (&v[..v.len() - 1], 3600.0),
                    _ => (v.as_str(), 1.0),
                };
                total += num.parse::<f64>().unwrap_or(0.0) * mul;
            }
            sys::sleep_ms(total * 1000.0);
            Ok(0)
        }
        "xargs" => xargs(sh, a),
        "npm" | "yarn" | "pnpm" | "bun" | "npx" | "bunx" => crate::pkg::run(sh, a),
        "cat" | "ls" | "mkdir" | "rm" | "rmdir" | "cp" | "mv" | "touch" | "ln" | "chmod" | "basename" | "dirname" | "realpath" | "readlink" | "mktemp" | "du" | "stat" => {
            crate::files::run(sh, a)
        }
        "head" | "tail" | "wc" | "grep" | "egrep" | "fgrep" | "sed" | "sort" | "uniq" | "tr" | "cut" | "tee" | "seq" | "date" | "uname" | "whoami" | "hostname" | "id"
        | "nproc" | "rev" | "tac" | "yes" => crate::text::run(sh, a),
        "find" => crate::find::run(sh, a),
        "rg" => crate::rg::run(sh, a),
        "nl" | "base64" | "sha256sum" | "sha1sum" | "md5sum" | "shasum" | "tree" | "cmp" | "paste" | "comm" | "expr" | "fold" | "column" | "od" | "xxd" | "hexdump" => {
            crate::util::run(sh, a)
        }
        _ => return None,
    };
    Some(r)
}

pub fn unescape(s: &str, out: &mut Vec<u8>) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\\' || i + 1 >= b.len() {
            out.push(b[i]);
            i += 1;
            continue;
        }
        i += 1;
        match b[i] {
            b'n' => out.push(b'\n'),
            b't' => out.push(b'\t'),
            b'r' => out.push(b'\r'),
            b'a' => out.push(7),
            b'b' => out.push(8),
            b'e' => out.push(27),
            b'f' => out.push(12),
            b'v' => out.push(11),
            b'\\' => out.push(b'\\'),
            b'c' => return false,
            b'0'..=b'7' => {
                let mut v = 0u32;
                let mut k = 0;
                if b[i] == b'0' {
                    i += 1;
                }
                while k < 3 && i < b.len() && (b'0'..=b'7').contains(&b[i]) {
                    v = v * 8 + (b[i] - b'0') as u32;
                    i += 1;
                    k += 1;
                }
                out.push(v as u8);
                continue;
            }
            b'x' => {
                let mut v = 0u32;
                let mut k = 0;
                i += 1;
                while k < 2 && i < b.len() && b[i].is_ascii_hexdigit() {
                    v = v * 16 + (b[i] as char).to_digit(16).unwrap();
                    i += 1;
                    k += 1;
                }
                out.push(v as u8);
                continue;
            }
            other => {
                out.push(b'\\');
                out.push(other);
            }
        }
        i += 1;
    }
    true
}

fn echo(sh: &mut Interp, a: &[String]) -> X {
    let mut i = 1;
    let (mut newline, mut escapes) = (true, false);
    while i < a.len() && a[i].len() > 1 && a[i].starts_with('-') && a[i][1..].bytes().all(|c| matches!(c, b'n' | b'e' | b'E')) {
        for c in a[i][1..].bytes() {
            match c {
                b'n' => newline = false,
                b'e' => escapes = true,
                _ => escapes = false,
            }
        }
        i += 1;
    }
    let mut out = Vec::new();
    for (n, s) in a[i..].iter().enumerate() {
        if n > 0 {
            out.push(b' ');
        }
        if escapes {
            if !unescape(s, &mut out) {
                newline = false;
                break;
            }
        } else {
            out.extend_from_slice(s.as_bytes());
        }
    }
    if newline {
        out.push(b'\n');
    }
    sh.out(&out);
    Ok(0)
}

fn cd(sh: &mut Interp, a: &[String]) -> X {
    let arg = a[1..].iter().find(|x| !x.starts_with('-') || x.as_str() == "-").cloned();
    let target = match arg.as_deref() {
        None => sh.var("HOME"),
        Some("-") => {
            let old = sh.var("OLDPWD");
            sh.outs(&format!("{old}\n"));
            old
        }
        Some(t) => t.to_string(),
    };
    if target.is_empty() {
        sh.err("sh: cd: HOME not set");
        return Ok(1);
    }
    let path = sh.abs(&target);
    match sys::stat(&path, true) {
        Ok(st) if st.is_dir() => {
            let old = std::mem::replace(&mut sh.s.cwd, path.clone());
            sh.set("OLDPWD", old);
            sh.set("PWD", path);
            Ok(0)
        }
        Ok(_) => {
            sh.err(&format!("sh: cd: {target}: Not a directory"));
            Ok(1)
        }
        Err(e) => {
            sh.err(&format!("sh: cd: {target}: {}", sys::strerror(e)));
            Ok(1)
        }
    }
}

fn declare(sh: &mut Interp, a: &[String]) -> X {
    let which = a[0].as_str();
    let mut export = which == "export";
    let mut readonly = which == "readonly";
    let local = which == "local" || ((which == "declare" || which == "typeset") && sh.s.func_depth > 0);
    let mut names = Vec::new();
    let mut unexport = false;
    for arg in &a[1..] {
        if arg.starts_with('-') && names.is_empty() {
            for c in arg[1..].chars() {
                match c {
                    'x' => export = true,
                    'r' => readonly = true,
                    'n' if which == "export" => unexport = true,
                    _ => {}
                }
            }
        } else {
            names.push(arg);
        }
    }
    if names.is_empty() {
        if which == "export" || which == "readonly" {
            let mut lines: Vec<String> = sh.s.vars.iter().filter(|(_, v)| if export { v.exported } else { v.readonly }).map(|(k, v)| format!("{which} {k}='{}'\n", v.val.replace('\'', "'\\''"))).collect();
            lines.sort();
            sh.outs(&lines.concat());
        }
        return Ok(0);
    }
    let mut st = 0;
    for n in names {
        let (name, value) = match n.split_once('=') {
            Some((k, v)) => (k, Some(v.to_string())),
            None => (n.as_str(), None),
        };
        if !valid_name(name) {
            sh.err(&format!("sh: {which}: `{n}': not a valid identifier"));
            st = 1;
            continue;
        }
        if local {
            if let Some(scope) = sh.s.locals.last_mut() {
                if !scope.iter().any(|(k, _)| k == name) {
                    let old = sh.s.vars.get(name).cloned();
                    scope.push((name.to_string(), old));
                }
            }
            if value.is_none() && !sh.s.vars.contains_key(name) {
                sh.s.vars.insert(name.to_string(), Var { val: String::new(), exported: false, readonly: false });
            }
        }
        if let Some(v) = value {
            if !sh.set(name, v) {
                st = 1;
                continue;
            }
        }
        if export || readonly || unexport {
            if let Some(v) = sh.s.vars.get_mut(name) {
                v.exported = (v.exported || export) && !unexport;
                v.readonly |= readonly;
            } else if export {
                // exported once it is assigned
            }
        }
    }
    Ok(st)
}

fn set(sh: &mut Interp, a: &[String]) -> X {
    if a.len() == 1 {
        let mut lines: Vec<String> = sh.s.vars.iter().map(|(k, v)| format!("{k}='{}'\n", v.val.replace('\'', "'\\''"))).collect();
        lines.sort();
        sh.outs(&lines.concat());
        return Ok(0);
    }
    let mut i = 1;
    while i < a.len() {
        let arg = &a[i];
        if arg == "--" {
            sh.s.params = a[i + 1..].to_vec();
            return Ok(0);
        }
        let on = arg.starts_with('-');
        if !(on || arg.starts_with('+')) || arg.len() < 2 {
            sh.s.params = a[i..].to_vec();
            return Ok(0);
        }
        for c in arg[1..].chars() {
            match c {
                'e' => sh.s.opts.errexit = on,
                'x' => sh.s.opts.xtrace = on,
                'u' => sh.s.opts.nounset = on,
                'f' => sh.s.opts.noglob = on,
                'o' => {
                    i += 1;
                    match a.get(i).map(String::as_str) {
                        Some("pipefail") => sh.s.opts.pipefail = on,
                        Some("errexit") => sh.s.opts.errexit = on,
                        Some("nounset") => sh.s.opts.nounset = on,
                        Some("xtrace") => sh.s.opts.xtrace = on,
                        Some("noglob") => sh.s.opts.noglob = on,
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    Ok(0)
}

fn source(sh: &mut Interp, a: &[String]) -> X {
    let Some(file) = a.get(1) else {
        sh.err("sh: .: filename argument required");
        return Ok(2);
    };
    let path = if file.contains('/') { sh.abs(file) } else { sh.find_on_path(file).unwrap_or_else(|| sh.abs(file)) };
    let src = match sys::read_file(&path) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) => {
            sh.err(&format!("sh: {file}: {}", sys::strerror(e)));
            return Ok(1);
        }
    };
    let saved = if a.len() > 2 { Some(std::mem::replace(&mut sh.s.params, a[2..].to_vec())) } else { None };
    let r = sh.run_source(&src);
    if let Some(p) = saved {
        sh.s.params = p;
    }
    match r {
        Err(Flow::Return(c)) => Ok(c),
        other => other,
    }
}

/// Where a command name comes from, as `which`/`type`/`command -v` report it.
pub fn locate(sh: &Interp, name: &str) -> Option<(String, &'static str)> {
    if sh.s.funcs.contains_key(name) {
        return Some((name.to_string(), "function"));
    }
    if SHELL_ONLY.contains(&name) {
        return Some((name.to_string(), "builtin"));
    }
    if let Some(p) = sh.find_on_path(name) {
        return Some((p, "file"));
    }
    if Interp::is_node(name) && !name.contains('/') {
        return Some(("/usr/local/bin/node".into(), "file"));
    }
    if crate::interp::SHELL_NAMES.contains(&name) || is_builtin(name) {
        return Some((format!("/bin/{name}"), "file"));
    }
    None
}

fn which(sh: &mut Interp, a: &[String]) -> X {
    let mut st = 0;
    for name in a[1..].iter().filter(|n| !n.starts_with('-')) {
        match locate(sh, name) {
            Some((p, kind)) => {
                let line = if a[0] == "type" {
                    match kind {
                        "function" => format!("{name} is a function\n"),
                        "builtin" => format!("{name} is a shell builtin\n"),
                        _ => format!("{name} is {p}\n"),
                    }
                } else if kind == "file" {
                    format!("{p}\n")
                } else {
                    st = 1;
                    continue;
                };
                sh.outs(&line);
            }
            None => {
                if a[0] == "type" {
                    sh.err(&format!("sh: type: {name}: not found"));
                }
                st = 1;
            }
        }
    }
    Ok(st)
}

fn command(sh: &mut Interp, a: &[String]) -> X {
    let mut i = 1;
    let mut describe = false;
    while i < a.len() && a[i].starts_with('-') {
        if a[i].contains('v') || a[i].contains('V') {
            describe = true;
        }
        i += 1;
    }
    if i >= a.len() {
        return Ok(0);
    }
    if describe {
        return match locate(sh, &a[i]) {
            Some((p, _)) => {
                sh.outs(&format!("{p}\n"));
                Ok(0)
            }
            None => Ok(1),
        };
    }
    // Skip functions.
    match run(sh, &a[i..]) {
        Some(r) => r,
        None => match sh.run_program(&a[i..], false)? {
            Done::Status(s) => Ok(s),
            Done::Spawned(ch) => Ok(sh.reap(ch)),
        },
    }
}

fn read(sh: &mut Interp, a: &[String]) -> X {
    let args = Args::parse(a, "pdntu");
    let raw = args.has('r');
    let mut line = match sh.read_line() {
        Some(l) => String::from_utf8_lossy(&l).into_owned(),
        None => {
            for n in &args.rest {
                sh.set(n, String::new());
            }
            return Ok(1);
        }
    };
    if !raw {
        while line.ends_with('\\') {
            line.pop();
            match sh.read_line() {
                Some(l) => line.push_str(&String::from_utf8_lossy(&l)),
                None => break,
            }
        }
        line = line.replace("\\", "");
    }
    let names: Vec<String> = if args.rest.is_empty() { vec!["REPLY".into()] } else { args.rest.clone() };
    let ifs = sh.ifs();
    let is_ws = |c: char| ifs.contains(c) && c.is_whitespace();
    let mut rest = line.trim_matches(|c| is_ws(c));
    if names.len() == 1 && args.rest.is_empty() {
        rest = line.as_str();
    }
    for (i, name) in names.iter().enumerate() {
        if i + 1 == names.len() {
            sh.set(name, rest.to_string());
        } else {
            match rest.find(|c| ifs.contains(c)) {
                Some(p) => {
                    let v = rest[..p].to_string();
                    let after = &rest[p..];
                    // One non-blank separator, surrounded by any blanks.
                    let after = after.trim_start_matches(|c| is_ws(c));
                    let after = match after.chars().next() {
                        Some(c) if ifs.contains(c) && !c.is_whitespace() && !rest[p..].starts_with(|c: char| is_ws(c)) => &after[c.len_utf8()..],
                        _ => after,
                    };
                    sh.set(name, v);
                    rest = after.trim_start_matches(|c| is_ws(c));
                }
                None => {
                    sh.set(name, rest.to_string());
                    rest = "";
                }
            }
        }
    }
    Ok(0)
}

fn getopts(sh: &mut Interp, a: &[String]) -> X {
    if a.len() < 3 {
        return Ok(2);
    }
    let spec = a[1].clone();
    let name = a[2].clone();
    let args: Vec<String> = if a.len() > 3 { a[3..].to_vec() } else { sh.s.params.clone() };
    let mut ind: usize = sh.get("OPTIND").and_then(|v| v.parse().ok()).unwrap_or(1);
    let mut sub: usize = sh.get("_OPTSUB").and_then(|v| v.parse().ok()).unwrap_or(0);
    let done = |sh: &mut Interp, ind: usize| {
        sh.set("OPTIND", ind.to_string());
        sh.set("_OPTSUB", "0".into());
        sh.set(&name, "?".into());
        Ok(1)
    };
    let Some(arg) = args.get(ind - 1) else { return done(sh, ind) };
    if sub == 0 {
        if arg == "--" {
            return done(sh, ind + 1);
        }
        if !arg.starts_with('-') || arg.len() < 2 {
            return done(sh, ind);
        }
        sub = 1;
    }
    let c = arg[sub..].chars().next().unwrap_or('?');
    sub += c.len_utf8();
    let pos = spec.find(c);
    let takes = pos.is_some_and(|p| spec[p + c.len_utf8()..].starts_with(':'));
    let mut optarg = String::new();
    let mut opt = c.to_string();
    if pos.is_none() || c == ':' {
        opt = "?".into();
        if spec.starts_with(':') {
            optarg = c.to_string();
        } else {
            sh.err(&format!("sh: illegal option -- {c}"));
        }
    } else if takes {
        if sub < arg.len() {
            optarg = arg[sub..].to_string();
        } else if let Some(next) = args.get(ind) {
            optarg = next.clone();
            ind += 1;
        } else {
            opt = if spec.starts_with(':') { ":".into() } else { "?".into() };
        }
        sub = arg.len();
    }
    if sub >= arg.len() {
        ind += 1;
        sub = 0;
    }
    sh.set("OPTIND", ind.to_string());
    sh.set("_OPTSUB", sub.to_string());
    sh.set("OPTARG", optarg);
    sh.set(&name, opt);
    Ok(0)
}

fn env(sh: &mut Interp, a: &[String]) -> X {
    let mut i = 1;
    let mut clear = false;
    let mut unset = Vec::new();
    while i < a.len() && a[i].starts_with('-') {
        match a[i].as_str() {
            "-i" | "-" | "--ignore-environment" => clear = true,
            "-u" => {
                i += 1;
                if let Some(n) = a.get(i) {
                    unset.push(n.clone());
                }
            }
            "--" => {
                i += 1;
                break;
            }
            _ => {}
        }
        i += 1;
    }
    let mut sets = Vec::new();
    while i < a.len() {
        match a[i].split_once('=') {
            Some((k, v)) if valid_name(k) => sets.push((k.to_string(), v.to_string())),
            _ => break,
        }
        i += 1;
    }
    let rest = a[i..].to_vec();
    let st = sh.subshell(|sh| {
        if clear {
            for v in sh.s.vars.values_mut() {
                v.exported = false;
            }
        }
        for n in &unset {
            sh.s.vars.remove(n);
        }
        for (k, v) in sets {
            sh.s.vars.insert(k, Var { val: v, exported: true, readonly: false });
        }
        if rest.is_empty() {
            let text = sh.env_list().join("\n");
            sh.outs(&format!("{text}\n"));
            return Ok(0);
        }
        sh.run_status(&rest)
    });
    Ok(st)
}

fn xargs(sh: &mut Interp, a: &[String]) -> X {
    // Options end at the first operand: the rest is the command.
    let mut i = 1;
    let (mut n, mut replace, mut zero, mut no_run_empty, mut delim) = (0usize, None::<String>, false, false, None::<char>);
    while i < a.len() && a[i].starts_with('-') && a[i].len() > 1 {
        let s = a[i].as_str();
        match &s[..2] {
            "-n" | "-L" | "-P" | "-I" | "-d" => {
                let v = if s.len() > 2 {
                    s[2..].to_string()
                } else {
                    i += 1;
                    a.get(i).cloned().unwrap_or_default()
                };
                match &s[..2] {
                    "-n" | "-L" => n = v.parse().unwrap_or(0),
                    "-I" => replace = Some(v),
                    "-d" => delim = if v == "\\n" { Some('\n') } else { v.chars().next() },
                    _ => {}
                }
            }
            "-0" => zero = true,
            "-r" => no_run_empty = true,
            _ => {}
        }
        i += 1;
    }
    let mut cmd: Vec<String> = a[i..].to_vec();
    if cmd.is_empty() {
        cmd.push("echo".into());
    }
    let input = String::from_utf8_lossy(&sh.read_stdin_all()).into_owned();
    let items: Vec<String> = if zero {
        input.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect()
    } else if let Some(d) = delim {
        input.split(d).filter(|s| !s.is_empty()).map(str::to_string).collect()
    } else if replace.is_some() {
        input.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()
    } else {
        // Blank-separated, with quotes and backslashes.
        let mut out = Vec::new();
        let mut cur = String::new();
        let mut has = false;
        let mut q = '\0';
        let mut chars = input.chars();
        while let Some(c) = chars.next() {
            if q != '\0' {
                if c == q {
                    q = '\0'
                } else {
                    cur.push(c)
                }
            } else if c == '\'' || c == '"' {
                q = c;
                has = true;
            } else if c == '\\' {
                if let Some(n) = chars.next() {
                    cur.push(n);
                    has = true;
                }
            } else if c.is_whitespace() {
                if has || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                has = false;
            } else {
                cur.push(c)
            }
        }
        if has || !cur.is_empty() {
            out.push(cur);
        }
        out
    };
    let mut st = 0;
    let mut run = |sh: &mut Interp, argv: Vec<String>| -> Result<(), Flow> {
        let s = sh.run_status(&argv)?;
        if s != 0 {
            st = if s == 255 { 124 } else { 123 };
        }
        Ok(())
    };
    if let Some(pat) = replace {
        for item in items {
            run(sh, cmd.iter().map(|c| c.replace(&pat, &item)).collect())?;
        }
    } else if items.is_empty() {
        if !no_run_empty {
            run(sh, cmd)?;
        }
    } else {
        let per = if n == 0 { 4096 } else { n };
        for chunk in items.chunks(per) {
            let mut argv = cmd.clone();
            argv.extend(chunk.iter().cloned());
            run(sh, argv)?;
        }
    }
    Ok(st)
}

/// The `name` to show for a command in messages and `$0` of applets.
pub fn applet_name(arg0: &str) -> &str {
    basename(arg0)
}
