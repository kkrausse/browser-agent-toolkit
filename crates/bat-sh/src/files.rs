//! Coreutils that work on files and directories.
use crate::builtins::Args;
use crate::interp::{basename, dirname, Interp, X};
use crate::sys::{self, Stat};

pub fn run(sh: &mut Interp, a: &[String]) -> X {
    Ok(match a[0].as_str() {
        "cat" => cat(sh, a),
        "ls" => ls(sh, a),
        "mkdir" => mkdir(sh, a),
        "rm" => rm(sh, a),
        "rmdir" => each(sh, a, "", |_, p, _| sys::rmdir(p)),
        "cp" => cp_mv(sh, a, false),
        "mv" => cp_mv(sh, a, true),
        "touch" => touch(sh, a),
        "ln" => ln(sh, a),
        "chmod" => chmod(sh, a),
        "basename" => {
            let args = Args::parse(a, "s");
            let Some(p) = args.rest.first() else { return Ok(fail(sh, "basename", "missing operand")) };
            let mut b = basename(p).to_string();
            if let Some(suffix) = args.val('s').or(args.rest.get(1).map(String::as_str)) {
                if b.len() > suffix.len() && b.ends_with(suffix) {
                    b.truncate(b.len() - suffix.len());
                }
            }
            sh.outs(&format!("{b}\n"));
            0
        }
        "dirname" => {
            let Some(p) = a.get(1) else { return Ok(fail(sh, "dirname", "missing operand")) };
            let d = dirname(p).to_string();
            sh.outs(&format!("{d}\n"));
            0
        }
        "realpath" | "readlink" => {
            let args = Args::parse(a, "");
            let canon = a[0] == "realpath" || args.has('f') || args.has('e') || args.has('m');
            let mut st = 0;
            for p in &args.rest {
                let path = sh.abs(p);
                let r = if canon { sys::realpath(&path).or_else(|e| if a[0] == "realpath" && !args.has('e') { Ok(path.clone()) } else { Err(e) }) } else { sys::readlink(&path) };
                match r {
                    Ok(t) => {
                        sh.outs(&format!("{t}\n"));
                    }
                    Err(e) => {
                        if a[0] == "realpath" {
                            sh.err(&format!("realpath: {p}: {}", sys::strerror(e)));
                        }
                        st = 1;
                    }
                }
            }
            st
        }
        "mktemp" => {
            let args = Args::parse(a, "pt");
            let dir = args.val('p').map(str::to_string).unwrap_or_else(|| sh.get("TMPDIR").unwrap_or("/tmp").to_string());
            let template = args.rest.first().cloned().unwrap_or_else(|| "tmp.XXXXXXXXXX".into());
            let mut name = String::new();
            for c in template.chars() {
                if c == 'X' {
                    sh.rand = sh.rand.wrapping_mul(1_103_515_245).wrapping_add(12345);
                    name.push(b"abcdefghijklmnopqrstuvwxyz0123456789"[((sh.rand >> 16) % 36) as usize] as char);
                } else {
                    name.push(c);
                }
            }
            let path = if template.contains('/') { sh.abs(&name) } else { sh.abs(&format!("{dir}/{name}")) };
            let r = if args.has('d') { sys::mkdir(&path, 0o700) } else { sys::write_file(&path, b"", sys::O_EXCL, 0o600) };
            match r {
                Ok(()) => {
                    sh.outs(&format!("{path}\n"));
                    0
                }
                Err(e) => fail(sh, "mktemp", &format!("failed to create {path}: {}", sys::strerror(e))),
            }
        }
        "du" => du(sh, a),
        "stat" => stat(sh, a),
        _ => 127,
    })
}

pub fn fail(sh: &mut Interp, cmd: &str, msg: &str) -> i32 {
    sh.err(&format!("{cmd}: {msg}"));
    1
}

/// Apply `f` to every operand, reporting errors the usual way.
fn each(sh: &mut Interp, a: &[String], with_value: &str, mut f: impl FnMut(&mut Interp, &str, &Args) -> sys::R<()>) -> i32 {
    let args = Args::parse(a, with_value);
    if args.rest.is_empty() {
        return fail(sh, &a[0], "missing operand");
    }
    let mut st = 0;
    for p in &args.rest {
        let path = sh.abs(p);
        if let Err(e) = f(sh, &path, &args) {
            sh.err(&format!("{}: {}: {}", a[0], p, sys::strerror(e)));
            st = 1;
        }
    }
    st
}

fn cat(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "");
    let number = args.has('n');
    let mut st = 0;
    let mut line_no = 0;
    let files: Vec<String> = if args.rest.is_empty() { vec!["-".into()] } else { args.rest.clone() };
    for f in &files {
        if f == "-" && !number {
            // Stream: the input may be a pipe from a running process.
            let mut buf = vec![0u8; 65536];
            loop {
                let n = sh.read_stdin(&mut buf);
                if n == 0 || !sh.out(&buf[..n]) {
                    break;
                }
            }
            continue;
        }
        let data = if f == "-" { Ok(sh.read_stdin_all()) } else { sys::read_file(&sh.abs(f)) };
        match data {
            Ok(d) if number => {
                let mut out = Vec::with_capacity(d.len() + d.len() / 8);
                for line in d.split_inclusive(|c| *c == b'\n') {
                    line_no += 1;
                    out.extend_from_slice(format!("{line_no:6}\t").as_bytes());
                    out.extend_from_slice(line);
                }
                sh.out(&out);
            }
            Ok(d) => {
                sh.out(&d);
            }
            Err(e) => {
                sh.err(&format!("cat: {f}: {}", sys::strerror(e)));
                st = 1;
            }
        }
    }
    st
}

pub fn mkdir_p(path: &str) -> sys::R<()> {
    let mut cur = String::new();
    for c in path.split('/').filter(|c| !c.is_empty()) {
        cur.push('/');
        cur.push_str(c);
        match sys::mkdir(&cur, 0o755) {
            Ok(()) => {}
            Err(sys::EEXIST) => {}
            Err(e) => {
                // An existing directory may answer with another error (e.g. inside a read-only image).
                if !sys::stat(&cur, true).map(|s| s.is_dir()).unwrap_or(false) {
                    return Err(e);
                }
            }
        }
    }
    if sys::stat(path, true).map(|s| s.is_dir()).unwrap_or(false) {
        Ok(())
    } else {
        Err(sys::ENOTDIR)
    }
}

fn mkdir(sh: &mut Interp, a: &[String]) -> i32 {
    each(sh, a, "m", |_, p, args| if args.has('p') { mkdir_p(p) } else { sys::mkdir(p, 0o755) })
}

pub fn remove_tree(path: &str) -> sys::R<()> {
    let st = sys::stat(path, false)?;
    if st.is_dir() {
        for (name, _) in sys::readdir(path)? {
            remove_tree(&format!("{path}/{name}"))?;
        }
        sys::rmdir(path)
    } else {
        sys::unlink(path)
    }
}

fn rm(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "");
    let (recursive, force) = (args.has('r') || args.has('R') || args.long("recursive"), args.has('f') || args.long("force"));
    if args.rest.is_empty() {
        return if force { 0 } else { fail(sh, "rm", "missing operand") };
    }
    let mut st = 0;
    for p in &args.rest {
        let path = sh.abs(p);
        let r = match sys::stat(&path, false) {
            Err(e) => Err(e),
            Ok(s) if s.is_dir() && !recursive => {
                if args.has('d') {
                    sys::rmdir(&path)
                } else {
                    Err(sys::EISDIR)
                }
            }
            Ok(_) => remove_tree(&path),
        };
        if let Err(e) = r {
            if !(force && e == sys::ENOENT) {
                sh.err(&format!("rm: cannot remove '{p}': {}", sys::strerror(e)));
                st = 1;
            }
        }
    }
    st
}

fn copy_file(from: &str, to: &str, st: &Stat) -> sys::R<()> {
    let data = sys::read_file(from)?;
    sys::write_file(to, &data, sys::O_TRUNC, st.mode & 0o777)
}

pub fn copy_tree(from: &str, to: &str) -> sys::R<()> {
    let st = sys::stat(from, false)?;
    if st.is_symlink() {
        let target = sys::readlink(from)?;
        let _ = sys::unlink(to);
        return sys::symlink(&target, to);
    }
    if st.is_dir() {
        match sys::mkdir(to, 0o755) {
            Ok(()) | Err(sys::EEXIST) => {}
            Err(e) => return Err(e),
        }
        for (name, _) in sys::readdir(from)? {
            copy_tree(&format!("{from}/{name}"), &format!("{to}/{name}"))?;
        }
        Ok(())
    } else {
        copy_file(from, to, &st)
    }
}

fn cp_mv(sh: &mut Interp, a: &[String], mv: bool) -> i32 {
    let cmd = a[0].as_str();
    let args = Args::parse(a, "t");
    let recursive = mv || args.has('r') || args.has('R') || args.has('a') || args.long("recursive");
    let no_clobber = args.has('n');
    let mut rest = args.rest.clone();
    let dest = match args.val('t') {
        Some(t) => t.to_string(),
        None => {
            if rest.len() < 2 {
                return fail(sh, cmd, "missing file operand");
            }
            rest.pop().unwrap()
        }
    };
    let dest_abs = sh.abs(&dest);
    let dest_is_dir = sys::stat(&dest_abs, true).map(|s| s.is_dir()).unwrap_or(false);
    if rest.len() > 1 && !dest_is_dir {
        return fail(sh, cmd, &format!("target '{dest}' is not a directory"));
    }
    let mut st = 0;
    for src in &rest {
        let from = sh.abs(src);
        let to = if dest_is_dir { format!("{}/{}", dest_abs.trim_end_matches('/'), basename(src)) } else { dest_abs.clone() };
        let info = match sys::stat(&from, !mv) {
            Ok(s) => s,
            Err(e) => {
                sh.err(&format!("{cmd}: cannot stat '{src}': {}", sys::strerror(e)));
                st = 1;
                continue;
            }
        };
        if from == to {
            sh.err(&format!("{cmd}: '{src}' and '{dest}' are the same file"));
            st = 1;
            continue;
        }
        if no_clobber && sys::stat(&to, false).is_ok() {
            continue;
        }
        if info.is_dir() && !recursive {
            sh.err(&format!("cp: -r not specified; omitting directory '{src}'"));
            st = 1;
            continue;
        }
        let r = if mv {
            match sys::rename(&from, &to) {
                // Across mounts (a directory that lives in the read-only image): copy, then remove.
                Err(sys::EXDEV) | Err(sys::ENOTEMPTY) | Err(sys::EISDIR) => copy_tree(&from, &to).and_then(|_| remove_tree(&from)),
                other => other,
            }
        } else if info.is_dir() {
            copy_tree(&from, &to)
        } else {
            copy_file(&from, &to, &info)
        };
        if let Err(e) = r {
            sh.err(&format!("{cmd}: cannot {} '{src}' to '{dest}': {}", if mv { "move" } else { "copy" }, sys::strerror(e)));
            st = 1;
        } else if args.has('v') {
            sh.outs(&format!("'{src}' -> '{to}'\n"));
        }
    }
    st
}

fn touch(sh: &mut Interp, a: &[String]) -> i32 {
    each(sh, a, "dtr", |_, p, args| match sys::stat(p, true) {
        Ok(_) => sys::utimes(p, sys::now_ms()),
        Err(sys::ENOENT) if !args.has('c') => sys::write_file(p, b"", 0, 0o644),
        Err(sys::ENOENT) => Ok(()),
        Err(e) => Err(e),
    })
}

fn ln(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "");
    if args.rest.len() < 2 {
        return fail(sh, "ln", "missing file operand");
    }
    let target = &args.rest[0];
    let mut link = sh.abs(&args.rest[1]);
    if sys::stat(&link, true).map(|s| s.is_dir()).unwrap_or(false) {
        link = format!("{link}/{}", basename(target));
    }
    if args.has('f') {
        let _ = sys::unlink(&link);
    }
    let r = if args.has('s') { sys::symlink(target, &link) } else { sys::stat(&sh.abs(target), true).and_then(|st| copy_file(&sh.abs(target), &link, &st)) };
    match r {
        Ok(()) => 0,
        Err(e) => fail(sh, "ln", &format!("failed to create link '{}': {}", args.rest[1], sys::strerror(e))),
    }
}

fn chmod(sh: &mut Interp, a: &[String]) -> i32 {
    // The mode may look like an option (`-x`), so do not use the generic parser.
    let mut i = 1;
    let mut recursive = false;
    while i < a.len() && (a[i] == "-R" || a[i] == "-f" || a[i] == "-v" || a[i] == "--") {
        recursive |= a[i] == "-R";
        i += 1;
    }
    let Some(mode) = a.get(i).cloned() else { return fail(sh, "chmod", "missing operand") };
    let mut st = 0;
    for p in &a[i + 1..] {
        let path = sh.abs(p);
        let mut stack = vec![path];
        while let Some(path) = stack.pop() {
            let cur = match sys::stat(&path, true) {
                Ok(s) => s,
                Err(e) => {
                    sh.err(&format!("chmod: cannot access '{p}': {}", sys::strerror(e)));
                    st = 1;
                    continue;
                }
            };
            let Some(new) = apply_mode(&mode, cur.mode, cur.is_dir()) else {
                return fail(sh, "chmod", &format!("invalid mode: '{mode}'"));
            };
            if let Err(e) = sys::chmod(&path, new) {
                sh.err(&format!("chmod: changing permissions of '{p}': {}", sys::strerror(e)));
                st = 1;
            }
            if recursive && cur.is_dir() {
                if let Ok(ents) = sys::readdir(&path) {
                    stack.extend(ents.into_iter().map(|(n, _)| format!("{path}/{n}")));
                }
            }
        }
    }
    st
}

fn apply_mode(spec: &str, cur: u32, is_dir: bool) -> Option<u32> {
    if spec.bytes().all(|c| (b'0'..=b'7').contains(&c)) {
        return u32::from_str_radix(spec, 8).ok();
    }
    let mut mode = cur;
    for clause in spec.split(',') {
        let b = clause.as_bytes();
        let mut i = 0;
        let mut who = 0u32;
        while i < b.len() && matches!(b[i], b'u' | b'g' | b'o' | b'a') {
            who |= match b[i] {
                b'u' => 0o700,
                b'g' => 0o070,
                b'o' => 0o007,
                _ => 0o777,
            };
            i += 1;
        }
        if who == 0 {
            who = 0o777;
        }
        while i < b.len() {
            let op = b[i];
            if !matches!(op, b'+' | b'-' | b'=') {
                return None;
            }
            i += 1;
            let mut bits = 0u32;
            while i < b.len() && !matches!(b[i], b'+' | b'-' | b'=') {
                bits |= match b[i] {
                    b'r' => 0o444,
                    b'w' => 0o222,
                    b'x' => 0o111,
                    b'X' if is_dir || cur & 0o111 != 0 => 0o111,
                    b'X' | b's' | b't' => 0,
                    _ => return None,
                };
                i += 1;
            }
            match op {
                b'+' => mode |= bits & who,
                b'-' => mode &= !(bits & who),
                _ => mode = (mode & !who) | (bits & who),
            }
        }
    }
    Some(mode)
}

pub fn mode_string(st: &Stat) -> String {
    let mut s = String::with_capacity(10);
    s.push(if st.is_dir() {
        'd'
    } else if st.is_symlink() {
        'l'
    } else {
        '-'
    });
    for shift in [6, 3, 0] {
        let bits = (st.mode >> shift) & 7;
        s.push(if bits & 4 != 0 { 'r' } else { '-' });
        s.push(if bits & 2 != 0 { 'w' } else { '-' });
        s.push(if bits & 1 != 0 { 'x' } else { '-' });
    }
    s
}

pub fn human(n: u64) -> String {
    const U: [&str; 5] = ["", "K", "M", "G", "T"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < 4 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n}")
    } else if v < 10.0 {
        format!("{:.1}{}", (v * 10.0).ceil() / 10.0, U[i])
    } else {
        format!("{}{}", v.ceil() as u64, U[i])
    }
}

fn ls(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "");
    let (all, almost, long, dir_only, recursive) = (args.has('a'), args.has('A'), args.has('l') || args.has('g') || args.has('o'), args.has('d'), args.has('R'));
    let (by_time, by_size, reverse, classify, slash, humanize) = (args.has('t'), args.has('S'), args.has('r'), args.has('F'), args.has('p'), args.has('h'));
    let mut st = 0;
    let mut out = String::new();
    let operands: Vec<String> = if args.rest.is_empty() { vec![".".into()] } else { args.rest.clone() };
    let now = sys::now_ms();
    let tz = sys::tz_offset_min();
    let entry_line = |out: &mut String, name: &str, path: &str| {
        let info = sys::stat(path, false).unwrap_or_default();
        let mut shown = name.to_string();
        if classify || slash {
            if info.is_dir() {
                shown.push('/');
            } else if classify && info.is_symlink() {
                shown.push('@');
            } else if classify && info.mode & 0o111 != 0 {
                shown.push('*');
            }
        }
        if long {
            let size = if humanize { human(info.size) } else { info.size.to_string() };
            let when = crate::text::ls_time(info.mtime_ms, now, tz);
            let link = if info.is_symlink() { format!(" -> {}", sys::readlink(path).unwrap_or_default()) } else { String::new() };
            out.push_str(&format!("{} 1 user user {:>8} {} {}{}\n", mode_string(&info), size, when, shown, link));
        } else {
            out.push_str(&shown);
            out.push('\n');
        }
    };
    let sort = |v: &mut Vec<(String, String)>| {
        if by_time || by_size {
            let mut keyed: Vec<(f64, (String, String))> = v
                .drain(..)
                .map(|e| {
                    let s = sys::stat(&e.1, false).unwrap_or_default();
                    (if by_time { s.mtime_ms } else { s.size as f64 }, e)
                })
                .collect();
            keyed.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.1 .0.cmp(&b.1 .0)));
            v.extend(keyed.into_iter().map(|k| k.1));
        } else {
            v.sort();
        }
        if reverse {
            v.reverse();
        }
    };
    let mut files: Vec<(String, String)> = Vec::new();
    let mut dirs: Vec<(String, String)> = Vec::new();
    for p in &operands {
        let path = sh.abs(p);
        match sys::stat(&path, true).or_else(|_| sys::stat(&path, false)) {
            Ok(s) if s.is_dir() && !dir_only => dirs.push((p.clone(), path)),
            Ok(_) => files.push((p.clone(), path)),
            Err(e) => {
                sh.err(&format!("ls: cannot access '{p}': {}", sys::strerror(e)));
                st = 2;
            }
        }
    }
    sort(&mut files);
    for (name, path) in &files {
        entry_line(&mut out, name, path);
    }
    sort(&mut dirs);
    let headers = recursive || dirs.len() + files.len() > 1;
    let mut first = files.is_empty();
    let mut queue: Vec<(String, String)> = dirs.into_iter().rev().collect();
    while let Some((shown, path)) = queue.pop() {
        if headers {
            if !first {
                out.push('\n');
            }
            out.push_str(&format!("{shown}:\n"));
        }
        first = false;
        match sys::readdir(&path) {
            Ok(ents) => {
                let mut list: Vec<(String, String)> =
                    ents.into_iter().filter(|(n, _)| all || almost || !n.starts_with('.')).map(|(n, _)| (n.clone(), format!("{}/{}", path.trim_end_matches('/'), n))).collect();
                if all {
                    list.push((".".into(), path.clone()));
                    list.push(("..".into(), crate::interp::normalize(&format!("{path}/.."))));
                }
                sort(&mut list);
                if long {
                    let blocks: u64 = list.iter().map(|(_, p)| sys::stat(p, false).map(|s| s.size.div_ceil(1024)).unwrap_or(0)).sum();
                    out.push_str(&format!("total {blocks}\n"));
                }
                for (name, p) in &list {
                    entry_line(&mut out, name, p);
                }
                if recursive {
                    for (name, p) in list.iter().rev() {
                        if name != "." && name != ".." && sys::stat(p, false).map(|s| s.is_dir()).unwrap_or(false) {
                            queue.push((format!("{}/{}", shown.trim_end_matches('/'), name), p.clone()));
                        }
                    }
                }
            }
            Err(e) => {
                sh.err(&format!("ls: cannot open directory '{shown}': {}", sys::strerror(e)));
                st = 2;
            }
        }
    }
    sh.outs(&out);
    st
}

fn tree_size(path: &str, out: &mut Vec<(u64, String)>, shown: &str, list: bool) -> u64 {
    let Ok(st) = sys::stat(path, false) else { return 0 };
    if !st.is_dir() {
        return st.size;
    }
    let mut total = 0;
    if let Ok(mut ents) = sys::readdir(path) {
        ents.sort();
        for (name, _) in ents {
            total += tree_size(&format!("{path}/{name}"), out, &format!("{shown}/{name}"), list);
        }
    }
    if list {
        out.push((total, shown.to_string()));
    }
    total
}

fn du(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "d");
    let summary = args.has('s') || args.val('d') == Some("0");
    let operands: Vec<String> = if args.rest.is_empty() { vec![".".into()] } else { args.rest.clone() };
    let mut text = String::new();
    for p in &operands {
        let mut list = Vec::new();
        let total = tree_size(&sh.abs(p), &mut list, p, !summary);
        if summary || list.is_empty() {
            list = vec![(total, p.clone())];
        }
        for (size, name) in list {
            let shown = if args.has('h') { human(size) } else if args.has('b') { size.to_string() } else { size.div_ceil(1024).to_string() };
            text.push_str(&format!("{shown}\t{name}\n"));
        }
    }
    sh.outs(&text);
    0
}

fn stat(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "cf");
    let mut st = 0;
    for p in &args.rest {
        let path = sh.abs(p);
        match sys::stat(&path, false) {
            Ok(s) => {
                let kind = if s.is_dir() {
                    "directory"
                } else if s.is_symlink() {
                    "symbolic link"
                } else {
                    "regular file"
                };
                let line = match args.val('c').or(args.long_val("format")) {
                    Some(f) => f
                        .replace("%s", &s.size.to_string())
                        .replace("%n", p)
                        .replace("%F", kind)
                        .replace("%a", &format!("{:o}", s.mode & 0o777))
                        .replace("%A", &mode_string(&s))
                        .replace("%Y", &((s.mtime_ms / 1000.0) as i64).to_string()),
                    None => format!("  File: {p}\n  Size: {}\t{kind}\nAccess: ({:04o}/{})\nModify: {}", s.size, s.mode & 0o777, mode_string(&s), crate::text::format_date("%Y-%m-%d %H:%M:%S %z", s.mtime_ms, sys::tz_offset_min())),
                };
                sh.outs(&format!("{line}\n"));
            }
            Err(e) => {
                sh.err(&format!("stat: cannot stat '{p}': {}", sys::strerror(e)));
                st = 1;
            }
        }
    }
    st
}
