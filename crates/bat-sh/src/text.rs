//! Coreutils that work on text streams, plus `printf` and `date`.
use crate::builtins::{unescape, Args};
use crate::files::fail;
use crate::interp::{Interp, X};
use crate::sys;
use regex_lite::Regex;

pub fn run(sh: &mut Interp, a: &[String]) -> X {
    Ok(match a[0].as_str() {
        "head" => head(sh, a),
        "tail" => tail(sh, a),
        "wc" => wc(sh, a),
        "grep" | "egrep" | "fgrep" => grep(sh, a),
        "sed" => crate::sed::run(sh, a),
        "sort" => sort(sh, a),
        "uniq" => uniq(sh, a),
        "tr" => tr(sh, a),
        "cut" => cut(sh, a),
        "tee" => tee(sh, a),
        "seq" => seq(sh, a),
        "date" => date(sh, a),
        "rev" | "tac" => {
            let args = Args::parse(a, "");
            let (data, st) = input(sh, &a[0], &args.rest);
            let text = String::from_utf8_lossy(&data);
            let mut out = String::with_capacity(text.len());
            if a[0] == "rev" {
                for l in text.lines() {
                    out.extend(l.chars().rev());
                    out.push('\n');
                }
            } else {
                for l in text.lines().rev() {
                    out.push_str(l);
                    out.push('\n');
                }
            }
            sh.outs(&out);
            st
        }
        "uname" => {
            let args = Args::parse(a, "");
            let text = if args.has('a') {
                "Linux localhost 6.0.0-bat #1 SMP wasm32 GNU/Linux"
            } else if args.has('m') || args.has('p') {
                "wasm32"
            } else if args.has('r') {
                "6.0.0-bat"
            } else if args.has('n') {
                "localhost"
            } else if args.has('o') {
                "GNU/Linux"
            } else {
                "Linux"
            };
            sh.outs(&format!("{text}\n"));
            0
        }
        "whoami" => {
            let user = sh.get("USER").unwrap_or("user").to_string();
            sh.outs(&format!("{user}\n"));
            0
        }
        "hostname" => {
            sh.outs("localhost\n");
            0
        }
        "id" => {
            let args = Args::parse(a, "");
            sh.outs(if args.has('u') || args.has('g') { "1000\n" } else { "uid=1000(user) gid=1000(user) groups=1000(user)\n" });
            0
        }
        "nproc" => {
            sh.outs("4\n");
            0
        }
        "yes" => fail(sh, "yes", "not available: an endless producer cannot run inside the shell"),
        _ => 127,
    })
}

/// All input of a filter: the named files in order, or stdin.
pub fn input(sh: &mut Interp, cmd: &str, files: &[String]) -> (Vec<u8>, i32) {
    if files.is_empty() {
        return (sh.read_stdin_all(), 0);
    }
    let mut out = Vec::new();
    let mut st = 0;
    for f in files {
        if f == "-" {
            out.extend(sh.read_stdin_all());
            continue;
        }
        match sys::read_file(&sh.abs(f)) {
            Ok(d) => out.extend(d),
            Err(e) => {
                sh.err(&format!("{cmd}: {f}: {}", sys::strerror(e)));
                st = 1;
            }
        }
    }
    (out, st)
}

fn count_arg(args: &Args, default: i64) -> (i64, bool, bool) {
    // (count, bytes, from-start/all-but form)
    if let Some(n) = args.val('#') {
        return (n.parse().unwrap_or(default), false, false);
    }
    let (raw, bytes) = match (args.val('c').or(args.long_val("bytes")), args.val('n').or(args.long_val("lines"))) {
        (Some(c), _) => (c, true),
        (None, Some(n)) => (n, false),
        _ => return (default, false, false),
    };
    let special = raw.starts_with('+') || raw.starts_with('-');
    let plus = raw.starts_with('+');
    let digits = raw.trim_start_matches(['+', '-']);
    let mul = match digits.as_bytes().last() {
        Some(b'k') | Some(b'K') => 1024,
        Some(b'm') | Some(b'M') => 1024 * 1024,
        _ => 1,
    };
    let n = digits.trim_end_matches(|c: char| c.is_alphabetic()).parse::<i64>().unwrap_or(default) * mul;
    let _ = special;
    (n, bytes, plus || raw.starts_with('-'))
}

fn head(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "nc");
    let (n, bytes, signed) = count_arg(&args, 10);
    let all_but = signed && args.val('n').or(args.val('c')).is_some_and(|v| v.starts_with('-'));
    let mut st = 0;
    if args.rest.is_empty() && !all_but && !bytes {
        // Stop reading once enough lines have arrived (the producer may be a running process).
        let mut out = Vec::new();
        for _ in 0..n {
            match sh.read_line() {
                Some(l) => {
                    out.extend(l);
                    out.push(b'\n');
                }
                None => break,
            }
        }
        sh.out(&out);
        return 0;
    }
    let files: Vec<String> = if args.rest.is_empty() { vec!["-".into()] } else { args.rest.clone() };
    for (i, f) in files.iter().enumerate() {
        let (data, s) = input(sh, "head", std::slice::from_ref(f));
        if s != 0 {
            st = 1;
            continue;
        }
        if files.len() > 1 && !args.has('q') {
            sh.outs(&format!("{}==> {} <==\n", if i > 0 { "\n" } else { "" }, f));
        }
        if bytes {
            let end = if all_but { data.len().saturating_sub(n as usize) } else { (n as usize).min(data.len()) };
            sh.out(&data[..end]);
        } else {
            let ls: Vec<&[u8]> = data.split_inclusive(|c| *c == b'\n').collect();
            let end = if all_but { ls.len().saturating_sub(n as usize) } else { (n as usize).min(ls.len()) };
            sh.out(&ls[..end].concat());
        }
    }
    st
}

fn tail(sh: &mut Interp, a: &[String]) -> i32 {
    // `tail +5` (obsolete form)
    let mut a = a.to_vec();
    for i in 1..a.len() {
        let arg = &a[i];
        if arg.starts_with('+') && arg[1..].bytes().all(|c| c.is_ascii_digit()) && arg.len() > 1 && !matches!(a[i - 1].as_str(), "-n" | "-c") {
            a[i] = format!("-n{arg}");
        }
    }
    let args = Args::parse(&a, "nc");
    let (n, bytes, _) = count_arg(&args, 10);
    let from_start = args.val('n').or(args.val('c')).is_some_and(|v| v.starts_with('+'));
    let files: Vec<String> = if args.rest.is_empty() { vec!["-".into()] } else { args.rest.clone() };
    let mut st = 0;
    for (i, f) in files.iter().enumerate() {
        let (data, s) = input(sh, "tail", std::slice::from_ref(f));
        if s != 0 {
            st = 1;
            continue;
        }
        if files.len() > 1 && !args.has('q') {
            sh.outs(&format!("{}==> {} <==\n", if i > 0 { "\n" } else { "" }, f));
        }
        if bytes {
            let start = if from_start { (n as usize).saturating_sub(1).min(data.len()) } else { data.len().saturating_sub(n as usize) };
            sh.out(&data[start..]);
        } else {
            let ls: Vec<&[u8]> = data.split_inclusive(|c| *c == b'\n').collect();
            let start = if from_start { (n as usize).saturating_sub(1).min(ls.len()) } else { ls.len().saturating_sub(n as usize) };
            sh.out(&ls[start..].concat());
        }
    }
    st
}

fn wc(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "");
    let (mut l, mut w, mut c, m) = (args.has('l'), args.has('w'), args.has('c'), args.has('m'));
    if !(l || w || c || m) {
        l = true;
        w = true;
        c = true;
    }
    let files: Vec<String> = if args.rest.is_empty() { vec!["-".into()] } else { args.rest.clone() };
    let mut rows: Vec<(Vec<u64>, String)> = Vec::new();
    let mut st = 0;
    let mut totals = vec![0u64; 4];
    let mut size_total = 0u64;
    for f in &files {
        let (data, s) = input(sh, "wc", std::slice::from_ref(f));
        if s != 0 {
            st = 1;
            continue;
        }
        let counts = [
            data.iter().filter(|c| **c == b'\n').count() as u64,
            data.split(|c| c.is_ascii_whitespace()).filter(|x| !x.is_empty()).count() as u64,
            String::from_utf8_lossy(&data).chars().count() as u64,
            data.len() as u64,
        ];
        let mut row = Vec::new();
        for (i, on) in [l, w, m, c].iter().enumerate() {
            if *on {
                row.push(counts[i]);
            }
            totals[i] += counts[i];
        }
        size_total += data.len() as u64;
        rows.push((row, if args.rest.is_empty() { String::new() } else { f.clone() }));
    }
    if rows.len() > 1 {
        let row: Vec<u64> = [l, w, m, c].iter().enumerate().filter(|(_, on)| **on).map(|(i, _)| totals[i]).collect();
        rows.push((row, "total".into()));
    }
    let single = rows.iter().all(|r| r.0.len() == 1) && rows.len() == 1;
    let width = if single {
        0
    } else if args.rest.is_empty() {
        7
    } else {
        size_total.to_string().len()
    };
    let mut out = String::new();
    for (row, name) in rows {
        let cols: Vec<String> = row.iter().map(|v| format!("{v:>width$}")).collect();
        out.push_str(&cols.join(" "));
        if !name.is_empty() {
            out.push(' ');
            out.push_str(&name);
        }
        out.push('\n');
    }
    sh.outs(&out);
    st
}

/// Translate a POSIX regular expression into the syntax of the regex engine.
pub fn posix_regex(p: &str, extended: bool) -> String {
    let mut out = String::with_capacity(p.len() + 8);
    let chars: Vec<char> = p.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '[' {
            // A bracket expression is copied as it is.
            let start = i;
            i += 1;
            if i < chars.len() && chars[i] == '^' {
                i += 1;
            }
            if i < chars.len() && chars[i] == ']' {
                i += 1;
            }
            while i < chars.len() && chars[i] != ']' {
                if chars[i] == '[' && i + 1 < chars.len() && chars[i + 1] == ':' {
                    while i < chars.len() && !(chars[i] == ':' && i + 1 < chars.len() && chars[i + 1] == ']') {
                        i += 1;
                    }
                    i += 1;
                }
                i += 1;
            }
            let end = (i + 1).min(chars.len());
            let body: String = chars[start..end].iter().collect();
            // A backslash is literal inside a POSIX bracket expression.
            out.push_str(&body.replace('\\', "\\\\"));
            i = end;
            continue;
        }
        if c == '\\' && i + 1 < chars.len() {
            let n = chars[i + 1];
            i += 2;
            match n {
                '<' | '>' => out.push_str("\\b"),
                '(' | ')' | '{' | '}' | '|' | '+' | '?' if !extended => out.push(n),
                _ => {
                    out.push('\\');
                    out.push(n);
                }
            }
            continue;
        }
        if !extended && matches!(c, '(' | ')' | '{' | '}' | '|' | '+' | '?') {
            out.push('\\');
            out.push(c);
        } else if !extended && c == '*' && (i == 0 || out.ends_with("\\(") && false) {
            out.push_str("\\*");
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn grep(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "eABCmf");
    let has = |c| args.has(c);
    let extended = has('E') || has('P') || a[0] == "egrep";
    let fixed = has('F') || a[0] == "fgrep";
    let mut patterns: Vec<String> = args.flags.iter().filter(|f| f.0 == 'e').filter_map(|f| f.1.clone()).collect();
    for f in args.flags.iter().filter(|f| f.0 == 'f').filter_map(|f| f.1.clone()) {
        if let Ok(d) = sys::read_file(&sh.abs(&f)) {
            patterns.extend(String::from_utf8_lossy(&d).lines().map(str::to_string));
        }
    }
    let mut rest = args.rest.clone();
    if patterns.is_empty() {
        if rest.is_empty() {
            sh.err("Usage: grep [OPTION]... PATTERNS [FILE]...");
            return 2;
        }
        patterns = rest.remove(0).split('\n').map(str::to_string).collect();
    }
    let alts: Vec<String> = patterns.iter().map(|p| if fixed { regex_escape(p) } else { posix_regex(p, extended) }).collect();
    let mut src = if alts.len() == 1 { alts[0].clone() } else { format!("(?:{})", alts.join("|")) };
    if has('w') {
        src = format!("\\b(?:{src})\\b");
    }
    if has('x') {
        src = format!("^(?:{src})$");
    }
    if has('i') || has('y') || args.long("ignore-case") {
        src = format!("(?i){src}");
    }
    let re = match Regex::new(&src) {
        Ok(r) => r,
        Err(e) => {
            sh.err(&format!("grep: {e}"));
            return 2;
        }
    };
    let recursive = has('r') || has('R') || args.long("recursive");
    let includes: Vec<Vec<crate::glob::Pc>> = args.long.iter().filter(|l| l.0 == "include").filter_map(|l| l.1.as_deref()).map(crate::glob::pat).collect();
    let excludes: Vec<Vec<crate::glob::Pc>> = args.long.iter().filter(|l| l.0 == "exclude").filter_map(|l| l.1.as_deref()).map(crate::glob::pat).collect();
    let exclude_dirs: Vec<Vec<crate::glob::Pc>> = args.long.iter().filter(|l| l.0 == "exclude-dir").filter_map(|l| l.1.as_deref()).map(crate::glob::pat).collect();
    // (shown name, path); None path = stdin
    let mut targets: Vec<(String, Option<String>)> = Vec::new();
    let mut st_err = false;
    if rest.is_empty() {
        if recursive {
            rest.push(".".into());
        } else {
            targets.push(("(standard input)".into(), None));
        }
    }
    for f in &rest {
        if f == "-" {
            targets.push(("(standard input)".into(), None));
            continue;
        }
        let path = sh.abs(f);
        match sys::stat(&path, true) {
            Ok(s) if s.is_dir() => {
                if !recursive {
                    if !has('s') {
                        sh.err(&format!("grep: {f}: Is a directory"));
                    }
                    continue;
                }
                let mut stack = vec![(f.trim_end_matches('/').to_string(), path)];
                let strip = f == "." && args.rest.len() <= 1;
                while let Some((shown, dir)) = stack.pop() {
                    let Ok(mut ents) = sys::readdir(&dir) else { continue };
                    ents.sort();
                    for (name, kind) in ents.into_iter().rev() {
                        let p = format!("{}/{}", dir.trim_end_matches('/'), name);
                        let s = format!("{shown}/{name}");
                        let is_dir = kind == sys::K_DIR || (kind == sys::K_SYMLINK && has('R') && sys::stat(&p, true).map(|s| s.is_dir()).unwrap_or(false));
                        if is_dir {
                            if !exclude_dirs.iter().any(|g| crate::glob::matches_str(g, &name)) {
                                stack.push((s, p));
                            }
                        } else if kind != sys::K_SYMLINK || has('R') {
                            if (!includes.is_empty() && !includes.iter().any(|g| crate::glob::matches_str(g, &name))) || excludes.iter().any(|g| crate::glob::matches_str(g, &name)) {
                                continue;
                            }
                            targets.push((if strip { s.trim_start_matches("./").to_string() } else { s }, Some(p)));
                        }
                    }
                }
                // Depth-first order came out reversed per directory; sort for stable output.
                targets.sort();
            }
            Ok(_) => targets.push((f.clone(), Some(path))),
            Err(e) => {
                if !has('s') {
                    sh.err(&format!("grep: {f}: {}", sys::strerror(e)));
                }
                st_err = true;
            }
        }
    }
    let with_name = (targets.len() > 1 || recursive || has('H')) && !has('h');
    let (invert, number, count, list, list_without, only, quiet) = (has('v'), has('n'), has('c'), has('l'), has('L'), has('o'), has('q'));
    let max: usize = args.val('m').and_then(|v| v.parse().ok()).unwrap_or(usize::MAX);
    let ctx = |c: char| args.val(c).or(args.val('C')).or(args.val('#')).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    let (after, before) = (ctx('A'), ctx('B'));
    let mut any = false;
    let mut out = String::new();
    for (shown, path) in targets {
        let data = match &path {
            None => sh.read_stdin_all(),
            Some(p) => match sys::read_file(p) {
                Ok(d) => d,
                Err(e) => {
                    if !has('s') {
                        sh.err(&format!("grep: {shown}: {}", sys::strerror(e)));
                    }
                    st_err = true;
                    continue;
                }
            },
        };
        let binary = data.iter().take(8192).any(|c| *c == 0) && !has('a');
        let text = String::from_utf8_lossy(&data);
        let ls: Vec<&str> = text.lines().collect();
        let prefix = if with_name { format!("{shown}:") } else { String::new() };
        let mut hits = 0usize;
        let mut last_printed: Option<usize> = None;
        let mut after_left = 0usize;
        for (i, line) in ls.iter().enumerate() {
            let m = re.is_match(line) != invert;
            if m {
                hits += 1;
                any = true;
                if quiet {
                    return 0;
                }
                if count || list || list_without {
                    if hits >= max || list {
                        break;
                    }
                    continue;
                }
                if binary {
                    out.push_str(&format!("Binary file {shown} matches\n"));
                    break;
                }
                if before > 0 || after > 0 {
                    let from = i.saturating_sub(before).max(last_printed.map(|p| p + 1).unwrap_or(0));
                    if last_printed.is_some_and(|p| from > p + 1) || (last_printed.is_none() && from > 0 && !out.is_empty()) {
                        out.push_str("--\n");
                    }
                    for (j, l) in ls.iter().enumerate().take(i).skip(from) {
                        out.push_str(&format!("{}{}{}\n", prefix.replace(':', "-"), if number { format!("{}-", j + 1) } else { String::new() }, l));
                    }
                }
                if only && !invert {
                    for mm in re.find_iter(line) {
                        if !mm.as_str().is_empty() {
                            out.push_str(&format!("{}{}{}\n", prefix, if number { format!("{}:", i + 1) } else { String::new() }, mm.as_str()));
                        }
                    }
                } else {
                    out.push_str(&format!("{}{}{}\n", prefix, if number { format!("{}:", i + 1) } else { String::new() }, line));
                }
                last_printed = Some(i);
                after_left = after;
                if hits >= max {
                    break;
                }
            } else if after_left > 0 {
                out.push_str(&format!("{}{}{}\n", prefix.replace(':', "-"), if number { format!("{}-", i + 1) } else { String::new() }, line));
                last_printed = Some(i);
                after_left -= 1;
            }
        }
        if count {
            out.push_str(&format!("{prefix}{hits}\n"));
        } else if (list && hits > 0) || (list_without && hits == 0) {
            out.push_str(&format!("{shown}\n"));
        }
        if out.len() > 1 << 16 {
            sh.outs(&out);
            out.clear();
        }
    }
    sh.outs(&out);
    if st_err && !any {
        2
    } else {
        !any as i32
    }
}

fn sort(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "kto");
    let (data, st) = input(sh, "sort", &args.rest);
    let text = String::from_utf8_lossy(&data);
    let mut ls: Vec<&str> = text.lines().collect();
    let (numeric, reverse, unique, fold) = (args.has('n') || args.has('g') || args.has('h'), args.has('r'), args.has('u'), args.has('f'));
    let sep = args.val('t').and_then(|t| t.chars().next());
    let key = args.val('k').map(|k| {
        let mut it = k.split(',');
        let first = it.next().unwrap_or("1").trim_end_matches(|c: char| c.is_alphabetic());
        let start: usize = first.split('.').next().and_then(|v| v.parse().ok()).unwrap_or(1);
        let end: Option<usize> = it.next().and_then(|v| v.trim_end_matches(|c: char| c.is_alphabetic()).split('.').next().and_then(|v| v.parse().ok()));
        (start.max(1), end, k.contains('n'), k.contains('r'))
    });
    let numeric = numeric || key.is_some_and(|k| k.2);
    let reverse = reverse || key.is_some_and(|k| k.3);
    let extract = |l: &str| -> String {
        let Some((start, end, _, _)) = key else { return l.to_string() };
        let fields: Vec<&str> = match sep {
            Some(s) => l.split(s).collect(),
            None => l.split_whitespace().collect(),
        };
        let end = end.unwrap_or(fields.len()).min(fields.len());
        if start > end {
            return String::new();
        }
        fields[start - 1..end].join(" ")
    };
    let num = |s: &str| -> f64 {
        let t = s.trim_start();
        let mut end = 0;
        for (i, c) in t.char_indices() {
            if c.is_ascii_digit() || c == '.' || (i == 0 && (c == '-' || c == '+')) {
                end = i + c.len_utf8();
            } else {
                break;
            }
        }
        let v = t[..end].parse::<f64>().unwrap_or(0.0);
        match t[end..].chars().next() {
            Some('K') | Some('k') if args.has('h') => v * 1024.0,
            Some('M') if args.has('h') => v * 1024.0 * 1024.0,
            Some('G') if args.has('h') => v * 1024.0 * 1024.0 * 1024.0,
            _ => v,
        }
    };
    let cmp = |x: &&str, y: &&str| {
        let (kx, ky) = (extract(x), extract(y));
        let o = if numeric {
            num(&kx).partial_cmp(&num(&ky)).unwrap_or(std::cmp::Ordering::Equal)
        } else if fold {
            kx.to_lowercase().cmp(&ky.to_lowercase())
        } else {
            kx.cmp(&ky)
        };
        let o = if o == std::cmp::Ordering::Equal && key.is_none() && !unique { x.cmp(y) } else { o };
        if reverse {
            o.reverse()
        } else {
            o
        }
    };
    ls.sort_by(cmp);
    if unique {
        ls.dedup_by(|x, y| cmp(x, y) == std::cmp::Ordering::Equal);
    }
    let mut out = ls.join("\n");
    if !ls.is_empty() {
        out.push('\n');
    }
    match args.val('o') {
        Some(f) => {
            if let Err(e) = sys::write_file(&sh.abs(f), out.as_bytes(), sys::O_TRUNC, 0o644) {
                return fail(sh, "sort", &format!("{f}: {}", sys::strerror(e)));
            }
        }
        None => {
            sh.outs(&out);
        }
    }
    st
}

fn uniq(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "fsw");
    let (data, st) = input(sh, "uniq", &args.rest.iter().take(1).cloned().collect::<Vec<_>>());
    let text = String::from_utf8_lossy(&data);
    let (count, dups, uniques, fold) = (args.has('c'), args.has('d'), args.has('u'), args.has('i'));
    let mut out = String::new();
    let mut groups: Vec<(&str, usize)> = Vec::new();
    for l in text.lines() {
        match groups.last_mut() {
            Some((prev, n)) if (if fold { prev.eq_ignore_ascii_case(l) } else { *prev == l }) => *n += 1,
            _ => groups.push((l, 1)),
        }
    }
    for (l, n) in groups {
        if (dups && n < 2) || (uniques && n > 1) {
            continue;
        }
        if count {
            out.push_str(&format!("{n:7} {l}\n"));
        } else {
            out.push_str(l);
            out.push('\n');
        }
    }
    sh.outs(&out);
    st
}

fn tr_set(spec: &str) -> Vec<u8> {
    let mut raw = Vec::new();
    unescape(spec, &mut raw);
    let mut out = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'[' && raw.get(i + 1) == Some(&b':') {
            if let Some(end) = raw[i..].windows(2).position(|w| w == b":]") {
                let name = &raw[i + 2..i + end];
                let class: Vec<u8> = (0u8..=255)
                    .filter(|c| match name {
                        b"upper" => c.is_ascii_uppercase(),
                        b"lower" => c.is_ascii_lowercase(),
                        b"alpha" => c.is_ascii_alphabetic(),
                        b"digit" => c.is_ascii_digit(),
                        b"alnum" => c.is_ascii_alphanumeric(),
                        b"space" => c.is_ascii_whitespace() || *c == 11,
                        b"blank" => *c == b' ' || *c == b'\t',
                        b"punct" => c.is_ascii_punctuation(),
                        b"xdigit" => c.is_ascii_hexdigit(),
                        b"cntrl" => c.is_ascii_control(),
                        b"print" => (32..127).contains(c),
                        _ => false,
                    })
                    .collect();
                out.extend(class);
                i += end + 2;
                continue;
            }
        }
        if i + 2 < raw.len() && raw[i + 1] == b'-' && raw[i + 2] >= raw[i] {
            out.extend(raw[i]..=raw[i + 2]);
            i += 3;
        } else {
            out.push(raw[i]);
            i += 1;
        }
    }
    out
}

fn tr(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "");
    let (delete, squeeze, complement) = (args.has('d'), args.has('s'), args.has('c') || args.has('C'));
    let Some(s1) = args.rest.first() else { return fail(sh, "tr", "missing operand") };
    let mut set1 = tr_set(s1);
    if complement {
        set1 = (0u8..=255).filter(|c| !set1.contains(c)).collect();
    }
    let set2 = args.rest.get(1).map(|s| tr_set(s)).unwrap_or_default();
    let data = sh.read_stdin_all();
    let mut map: [i16; 256] = [-1; 256];
    if !delete && !set2.is_empty() {
        for (i, c) in set1.iter().enumerate() {
            map[*c as usize] = *set2.get(i).or(set2.last()).unwrap() as i16;
        }
    }
    let squeeze_set: &[u8] = if delete || !set2.is_empty() { &set2 } else { &set1 };
    let squeeze_set: Vec<u8> = if squeeze { if delete || !set2.is_empty() { squeeze_set.to_vec() } else { set1.clone() } } else { Vec::new() };
    let mut out = Vec::with_capacity(data.len());
    for c in data {
        if delete && set1.contains(&c) {
            continue;
        }
        let c = if map[c as usize] >= 0 { map[c as usize] as u8 } else { c };
        if squeeze && out.last() == Some(&c) && squeeze_set.contains(&c) {
            continue;
        }
        out.push(c);
    }
    sh.out(&out);
    0
}

fn ranges(spec: &str) -> Vec<(usize, usize)> {
    spec.split(',')
        .filter_map(|r| {
            let (a, b) = match r.split_once('-') {
                Some((a, b)) => (a.parse().unwrap_or(1), if b.is_empty() { usize::MAX } else { b.parse().ok()? }),
                None => {
                    let n = r.parse().ok()?;
                    (n, n)
                }
            };
            Some((a.max(1), b))
        })
        .collect()
}

fn cut(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "dfcb");
    let (data, st) = input(sh, "cut", &args.rest);
    let text = String::from_utf8_lossy(&data);
    let mut out = String::new();
    let pick = |n: usize, r: &[(usize, usize)]| r.iter().any(|(a, b)| n >= *a && n <= *b);
    if let Some(f) = args.val('f') {
        let r = ranges(f);
        let d = args.val('d').and_then(|d| d.chars().next()).unwrap_or('\t');
        let od = args.long_val("output-delimiter").map(str::to_string).unwrap_or_else(|| d.to_string());
        for l in text.lines() {
            if !l.contains(d) {
                if !args.has('s') {
                    out.push_str(l);
                    out.push('\n');
                }
                continue;
            }
            let fields: Vec<&str> = l.split(d).enumerate().filter(|(i, _)| pick(i + 1, &r)).map(|(_, f)| f).collect();
            out.push_str(&fields.join(&od));
            out.push('\n');
        }
    } else if let Some(c) = args.val('c').or(args.val('b')) {
        let r = ranges(c);
        for l in text.lines() {
            out.extend(l.chars().enumerate().filter(|(i, _)| pick(i + 1, &r)).map(|(_, c)| c));
            out.push('\n');
        }
    } else {
        return fail(sh, "cut", "you must specify a list of bytes, characters, or fields");
    }
    sh.outs(&out);
    st
}

fn tee(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "");
    let mut fds = Vec::new();
    let mut st = 0;
    for f in &args.rest {
        match sys::open(&sh.abs(f), sys::O_WRONLY | sys::O_CREAT | if args.has('a') { sys::O_APPEND } else { sys::O_TRUNC }, 0o644) {
            Ok(fd) => fds.push(fd),
            Err(e) => {
                sh.err(&format!("tee: {f}: {}", sys::strerror(e)));
                st = 1;
            }
        }
    }
    let mut buf = vec![0u8; 65536];
    loop {
        let n = sh.read_stdin(&mut buf);
        if n == 0 {
            break;
        }
        sh.out(&buf[..n]);
        for fd in &fds {
            let _ = sys::write_all(*fd, &buf[..n]);
        }
    }
    for fd in fds {
        sys::close(fd);
    }
    st
}

fn seq(sh: &mut Interp, a: &[String]) -> i32 {
    // Operands may be negative numbers: parse by hand.
    let mut sep = "\n".to_string();
    let mut pad = false;
    let mut nums: Vec<f64> = Vec::new();
    let mut texts: Vec<&str> = Vec::new();
    let mut i = 1;
    while i < a.len() {
        match a[i].as_str() {
            "-s" => {
                i += 1;
                sep = a.get(i).cloned().unwrap_or_default();
            }
            "-w" => pad = true,
            v if v.starts_with("-s") && v.len() > 2 => sep = v[2..].to_string(),
            v => match v.parse::<f64>() {
                Ok(n) => {
                    nums.push(n);
                    texts.push(v);
                }
                Err(_) => return fail(sh, "seq", &format!("invalid floating point argument: '{v}'")),
            },
        }
        i += 1;
    }
    let (first, step, last) = match nums.len() {
        1 => (1.0, 1.0, nums[0]),
        2 => (nums[0], 1.0, nums[1]),
        3 => (nums[0], nums[1], nums[2]),
        _ => return fail(sh, "seq", "missing operand"),
    };
    if step == 0.0 {
        return fail(sh, "seq", "invalid Zero increment value");
    }
    let decimals = texts.iter().map(|t| t.split_once('.').map(|(_, d)| d.len()).unwrap_or(0)).max().unwrap_or(0);
    let width = if pad { format!("{:.*}", decimals, first).len().max(format!("{:.*}", decimals, last).len()) } else { 0 };
    let mut items = Vec::new();
    let mut k = 0u64;
    loop {
        let v = first + step * k as f64;
        if (step > 0.0 && v > last + 1e-9) || (step < 0.0 && v < last - 1e-9) || k > 10_000_000 {
            break;
        }
        items.push(format!("{:0width$.*}", decimals, v));
        k += 1;
    }
    if !items.is_empty() {
        let mut out = items.join(&sep);
        out.push('\n');
        sh.outs(&out);
    }
    0
}

// ---- time ----

/// (year, month 1..12, day 1..31, weekday 0=Sunday, day of year 1..)
fn civil(days: i64) -> (i64, u32, u32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    let wd = (days + 4).rem_euclid(7) as u32;
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    const CUM: [u32; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let yday = CUM[(m - 1) as usize] + d + if leap && m > 2 { 1 } else { 0 };
    (y, m, d, wd, yday)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

pub fn format_date(fmt: &str, ms: f64, tz_min: i32) -> String {
    let local = (ms / 1000.0).floor() as i64 + tz_min as i64 * 60;
    let (days, secs) = (local.div_euclid(86_400), local.rem_euclid(86_400));
    let (y, mo, d, wd, yday) = civil(days);
    let (h, mi, s) = (secs / 3600, secs % 3600 / 60, secs % 60);
    let zone = format!("{}{:02}{:02}", if tz_min < 0 { '-' } else { '+' }, tz_min.abs() / 60, tz_min.abs() % 60);
    let mut out = String::new();
    let mut it = fmt.chars();
    while let Some(c) = it.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        let mut f = it.next().unwrap_or('%');
        // flags `-` (no padding) and `:` as in %:z
        let nopad = f == '-';
        if nopad || f == ':' {
            f = it.next().unwrap_or('%');
        }
        let two = |v: i64| if nopad { v.to_string() } else { format!("{v:02}") };
        match f {
            'Y' => out.push_str(&y.to_string()),
            'y' => out.push_str(&format!("{:02}", y % 100)),
            'C' => out.push_str(&format!("{:02}", y / 100)),
            'm' => out.push_str(&two(mo as i64)),
            'd' => out.push_str(&two(d as i64)),
            'e' => out.push_str(&format!("{d:2}")),
            'H' => out.push_str(&two(h)),
            'I' => out.push_str(&two(if h % 12 == 0 { 12 } else { h % 12 })),
            'M' => out.push_str(&two(mi)),
            'S' => out.push_str(&two(s)),
            'N' => out.push_str(&format!("{:09}", ((ms.rem_euclid(1000.0)) * 1e6) as u64)),
            'p' => out.push_str(if h < 12 { "AM" } else { "PM" }),
            'j' => out.push_str(&format!("{yday:03}")),
            'a' => out.push_str(&DAYS[wd as usize][..3]),
            'A' => out.push_str(DAYS[wd as usize]),
            'b' | 'h' => out.push_str(&MONTHS[(mo - 1) as usize][..3]),
            'B' => out.push_str(MONTHS[(mo - 1) as usize]),
            'u' => out.push_str(&(if wd == 0 { 7 } else { wd }).to_string()),
            'w' => out.push_str(&wd.to_string()),
            's' => out.push_str(&((ms / 1000.0).floor() as i64).to_string()),
            'F' => out.push_str(&format!("{y}-{mo:02}-{d:02}")),
            'T' => out.push_str(&format!("{h:02}:{mi:02}:{s:02}")),
            'R' => out.push_str(&format!("{h:02}:{mi:02}")),
            'D' => out.push_str(&format!("{mo:02}/{d:02}/{:02}", y % 100)),
            'c' => out.push_str(&format_date("%a %b %e %H:%M:%S %Y", ms, tz_min)),
            'z' => out.push_str(&if c == '%' && fmt.contains("%:z") { format!("{}:{}", &zone[..3], &zone[3..]) } else { zone.clone() }),
            'Z' => out.push_str(if tz_min == 0 { "UTC" } else { &zone }),
            'n' => out.push('\n'),
            't' => out.push('\t'),
            '%' => out.push('%'),
            other => {
                out.push('%');
                out.push(other);
            }
        }
    }
    out
}

pub fn ls_time(ms: f64, now: f64, tz_min: i32) -> String {
    if (now - ms).abs() < 182.0 * 86_400_000.0 {
        format_date("%b %e %H:%M", ms, tz_min)
    } else {
        format_date("%b %e  %Y", ms, tz_min)
    }
}

fn parse_date(s: &str, tz_min: i32) -> Option<f64> {
    if let Some(secs) = s.strip_prefix('@') {
        return secs.parse::<f64>().ok().map(|v| v * 1000.0);
    }
    let s = s.trim();
    let (date, time) = match s.split_once(['T', ' ']) {
        Some((d, t)) => (d, t),
        None => (s, "00:00:00"),
    };
    let mut d = date.split('-').map(|v| v.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let utc = time.ends_with('Z');
    let time = time.trim_end_matches('Z');
    let mut t = time.split(':').map(|v| v.split('.').next().unwrap_or("0").parse::<i64>().unwrap_or(0));
    let secs = t.next().unwrap_or(0) * 3600 + t.next().unwrap_or(0) * 60 + t.next().unwrap_or(0);
    let local = days_from_civil(y, m, day) * 86_400 + secs;
    Some((local - if utc { 0 } else { tz_min as i64 * 60 }) as f64 * 1000.0)
}

fn date(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "dr");
    let utc = args.has('u') || args.long("utc");
    let tz = if utc || sh.get("TZ") == Some("UTC") { 0 } else { sys::tz_offset_min() };
    let mut ms = sys::now_ms();
    if let Some(d) = args.val('d').or(args.long_val("date")) {
        match parse_date(d, tz) {
            Some(v) => ms = v,
            None => return fail(sh, "date", &format!("invalid date '{d}'")),
        }
    }
    if let Some(r) = args.val('r') {
        match sys::stat(&sh.abs(r), true) {
            Ok(s) => ms = s.mtime_ms,
            Err(e) => return fail(sh, "date", &format!("{r}: {}", sys::strerror(e))),
        }
    }
    let fmt = match args.rest.first() {
        Some(f) if f.starts_with('+') => f[1..].to_string(),
        _ if args.has('I') || args.long("iso-8601") => match args.long_val("iso-8601") {
            Some("seconds") => "%Y-%m-%dT%H:%M:%S%:z".into(),
            _ => "%Y-%m-%d".into(),
        },
        _ if args.has('R') => "%a, %d %b %Y %H:%M:%S %z".into(),
        _ => "%a %b %e %H:%M:%S %Z %Y".into(),
    };
    let text = format_date(&fmt, ms, tz);
    sh.outs(&format!("{text}\n"));
    0
}

// ---- printf ----

pub fn printf(sh: &mut Interp, a: &[String]) -> X {
    let mut args = &a[1..];
    let mut assign: Option<String> = None;
    if args.first().map(String::as_str) == Some("-v") && args.len() >= 2 {
        assign = Some(args[1].clone());
        args = &args[2..];
    }
    if args.first().map(String::as_str) == Some("--") {
        args = &args[1..];
    }
    let Some(fmt) = args.first() else {
        sh.err("printf: usage: printf [-v var] format [arguments]");
        return Ok(2);
    };
    let mut rest = &args[1..];
    let mut out: Vec<u8> = Vec::new();
    let f: Vec<char> = fmt.chars().collect();
    let mut status = 0;
    loop {
        let consumed_before = rest.len();
        let mut i = 0;
        let mut stop = false;
        while i < f.len() {
            let c = f[i];
            if c == '\\' {
                // One escape sequence.
                let mut j = i + 1;
                let mut seq = String::from("\\");
                if j < f.len() {
                    seq.push(f[j]);
                    j += 1;
                    if matches!(f[j - 1], '0'..='7') {
                        let mut k = 0;
                        while k < 2 && j < f.len() && matches!(f[j], '0'..='7') {
                            seq.push(f[j]);
                            j += 1;
                            k += 1;
                        }
                        // printf takes \NNN (echo takes \0NNN)
                        seq = format!("\\0{}", &seq[1..]);
                    } else if f[j - 1] == 'x' {
                        while j < f.len() && f[j].is_ascii_hexdigit() && seq.len() < 4 {
                            seq.push(f[j]);
                            j += 1;
                        }
                    }
                }
                if !unescape(&seq, &mut out) {
                    stop = true;
                    break;
                }
                i = j;
                continue;
            }
            if c != '%' {
                let mut b = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
                i += 1;
                continue;
            }
            i += 1;
            if i < f.len() && f[i] == '%' {
                out.push(b'%');
                i += 1;
                continue;
            }
            let (mut left, mut zero, mut plus, mut space, mut alt) = (false, false, false, false, false);
            while i < f.len() && matches!(f[i], '-' | '0' | '+' | ' ' | '#') {
                match f[i] {
                    '-' => left = true,
                    '0' => zero = true,
                    '+' => plus = true,
                    ' ' => space = true,
                    _ => alt = true,
                }
                i += 1;
            }
            let next_arg = |rest: &mut &[String]| -> Option<String> {
                let v = rest.first().cloned();
                if !rest.is_empty() {
                    *rest = &rest[1..];
                }
                v
            };
            let mut width = 0usize;
            if i < f.len() && f[i] == '*' {
                let w = next_arg(&mut rest).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
                left |= w < 0;
                width = w.unsigned_abs() as usize;
                i += 1;
            }
            while i < f.len() && f[i].is_ascii_digit() {
                width = width * 10 + f[i].to_digit(10).unwrap() as usize;
                i += 1;
            }
            let mut prec: Option<usize> = None;
            if i < f.len() && f[i] == '.' {
                i += 1;
                let mut p = 0;
                if i < f.len() && f[i] == '*' {
                    p = next_arg(&mut rest).and_then(|v| v.parse().ok()).unwrap_or(0);
                    i += 1;
                }
                while i < f.len() && f[i].is_ascii_digit() {
                    p = p * 10 + f[i].to_digit(10).unwrap() as usize;
                    i += 1;
                }
                prec = Some(p);
            }
            while i < f.len() && matches!(f[i], 'l' | 'h' | 'q' | 'j' | 'z') {
                i += 1;
            }
            let conv = if i < f.len() { f[i] } else { 's' };
            i += 1;
            let arg = next_arg(&mut rest);
            let int = |sh: &mut Interp, status: &mut i32| -> i64 {
                let Some(v) = arg.as_deref() else { return 0 };
                if let Some(c) = v.strip_prefix(['\'', '"']) {
                    return c.chars().next().map(|c| c as i64).unwrap_or(0);
                }
                match crate::expand::parse_int(v.trim()) {
                    Some(n) => n,
                    None => {
                        if !v.is_empty() {
                            sh.err(&format!("printf: {v}: invalid number"));
                            *status = 1;
                        }
                        v.trim().split(|c: char| !c.is_ascii_digit() && c != '-').next().and_then(|d| d.parse().ok()).unwrap_or(0)
                    }
                }
            };
            let body: String = match conv {
                'd' | 'i' | 'u' => {
                    let v = int(sh, &mut status);
                    let mut s = v.unsigned_abs().to_string();
                    if let Some(p) = prec {
                        while s.len() < p {
                            s.insert(0, '0');
                        }
                    }
                    let sign = if v < 0 {
                        "-"
                    } else if plus {
                        "+"
                    } else if space {
                        " "
                    } else {
                        ""
                    };
                    if zero && !left && prec.is_none() {
                        while s.len() + sign.len() < width {
                            s.insert(0, '0');
                        }
                    }
                    format!("{sign}{s}")
                }
                'x' | 'X' | 'o' => {
                    let v = int(sh, &mut status);
                    let mut s = match conv {
                        'x' => format!("{v:x}"),
                        'X' => format!("{v:X}"),
                        _ => format!("{v:o}"),
                    };
                    if alt && v != 0 {
                        s = format!("{}{s}", if conv == 'o' { "0" } else if conv == 'x' { "0x" } else { "0X" });
                    }
                    if zero && !left {
                        while s.len() < width {
                            s.insert(0, '0');
                        }
                    }
                    s
                }
                'f' | 'F' | 'e' | 'E' | 'g' | 'G' => {
                    let v: f64 = arg.as_deref().and_then(|v| v.trim().parse().ok()).unwrap_or(0.0);
                    let mut s = match conv {
                        'e' | 'E' => {
                            let t = format!("{:.*e}", prec.unwrap_or(6), v);
                            // Rust prints 1.5e2; C prints 1.5e+02.
                            match t.split_once('e') {
                                Some((m, e)) => {
                                    let n: i32 = e.parse().unwrap_or(0);
                                    format!("{m}e{}{:02}", if n < 0 { '-' } else { '+' }, n.abs())
                                }
                                None => t,
                            }
                        }
                        'g' | 'G' => {
                            let t = format!("{:.*}", prec.unwrap_or(6), v);
                            if t.contains('.') {
                                t.trim_end_matches('0').trim_end_matches('.').to_string()
                            } else {
                                t
                            }
                        }
                        _ => format!("{:.*}", prec.unwrap_or(6), v),
                    };
                    if plus && v >= 0.0 {
                        s.insert(0, '+');
                    }
                    if zero && !left {
                        while s.len() < width {
                            s.insert(if s.starts_with(['-', '+']) { 1 } else { 0 }, '0');
                        }
                    }
                    s
                }
                'c' => arg.as_deref().and_then(|v| v.chars().next()).map(|c| c.to_string()).unwrap_or_default(),
                'b' => {
                    let mut b = Vec::new();
                    let go = unescape(arg.as_deref().unwrap_or(""), &mut b);
                    let s = String::from_utf8_lossy(&b).into_owned();
                    if !go {
                        out.extend_from_slice(s.as_bytes());
                        stop = true;
                        break;
                    }
                    s
                }
                'q' => {
                    let v = arg.unwrap_or_default();
                    if !v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric() || "_-./=:@%+,".contains(c)) {
                        v
                    } else {
                        format!("'{}'", v.replace('\'', "'\\''"))
                    }
                }
                _ => {
                    let v = arg.unwrap_or_default();
                    match prec {
                        Some(p) => v.chars().take(p).collect(),
                        None => v,
                    }
                }
            };
            let len = body.chars().count();
            if len < width && !left {
                out.extend(std::iter::repeat_n(b' ', width - len));
            }
            out.extend_from_slice(body.as_bytes());
            if len < width && left {
                out.extend(std::iter::repeat_n(b' ', width - len));
            }
        }
        if stop || rest.is_empty() || rest.len() == consumed_before {
            break;
        }
    }
    match assign {
        Some(name) => {
            sh.set(&name, String::from_utf8_lossy(&out).into_owned());
        }
        None => {
            sh.out(&out);
        }
    }
    Ok(status)
}
