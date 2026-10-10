//! `sed`: addresses (line, `$`, `/re/`, ranges, `!`) and the commands
//! `s d p q a i c y =`. No hold space, branches or blocks.
use crate::builtins::{unescape, Args};
use crate::interp::Interp;
use crate::sys;
use crate::text::posix_regex;
use regex_lite::Regex;

enum Addr {
    Line(usize),
    Last,
    Re(Regex),
    /// `addr1,+N`
    Plus(usize),
}

enum Rep {
    Text(String),
    Group(usize),
}

enum Kind {
    Subst { re: Regex, rep: Vec<Rep>, global: bool, print: bool, nth: usize },
    Delete,
    Print,
    Quit,
    Append(String),
    Insert(String),
    Change(String),
    Translate(Vec<char>, Vec<char>),
    LineNo,
}

struct Command {
    a1: Option<Addr>,
    a2: Option<Addr>,
    negate: bool,
    kind: Kind,
    /// Inside a range: the line it ends on, if known.
    active: Option<usize>,
    in_range: bool,
}

struct P<'a> {
    s: &'a [char],
    i: usize,
    extended: bool,
}

impl P<'_> {
    fn peek(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }
    fn ws(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t')) {
            self.i += 1;
        }
    }
    /// Text up to an unescaped `delim`; `\delim` becomes `delim`, other escapes are kept.
    fn until(&mut self, delim: char) -> Result<String, String> {
        let mut out = String::new();
        loop {
            match self.peek() {
                None => return Err("unterminated command".into()),
                Some(c) if c == delim => {
                    self.i += 1;
                    return Ok(out);
                }
                Some('\\') => {
                    self.i += 1;
                    match self.peek() {
                        Some(c) if c == delim && c != '|' && c != '(' && c != ')' => out.push(c),
                        Some('n') => out.push_str("\\n"),
                        Some(c) => {
                            out.push('\\');
                            out.push(c);
                        }
                        None => out.push('\\'),
                    }
                    self.i += 1;
                }
                Some(c) => {
                    out.push(c);
                    self.i += 1;
                }
            }
        }
    }
    fn regex(&mut self, delim: char, icase: bool) -> Result<Regex, String> {
        let src = self.until(delim)?;
        let mut icase = icase;
        if self.peek() == Some('I') {
            self.i += 1;
            icase = true;
        }
        compile(&src, self.extended, icase)
    }
    fn addr(&mut self) -> Result<Option<Addr>, String> {
        match self.peek() {
            Some(c) if c.is_ascii_digit() => {
                let mut n = 0;
                while let Some(d) = self.peek().and_then(|c| c.to_digit(10)) {
                    n = n * 10 + d as usize;
                    self.i += 1;
                }
                Ok(Some(Addr::Line(n)))
            }
            Some('$') => {
                self.i += 1;
                Ok(Some(Addr::Last))
            }
            Some('/') => {
                self.i += 1;
                Ok(Some(Addr::Re(self.regex('/', false)?)))
            }
            Some('\\') => {
                self.i += 1;
                let d = self.peek().ok_or("unexpected end")?;
                self.i += 1;
                Ok(Some(Addr::Re(self.regex(d, false)?)))
            }
            _ => Ok(None),
        }
    }
    fn text_arg(&mut self) -> String {
        // GNU one-line form: `a text`, or `a\` newline text.
        self.ws();
        if self.peek() == Some('\\') {
            self.i += 1;
            if self.peek() == Some('\n') {
                self.i += 1;
            }
        }
        let mut out = String::new();
        while let Some(c) = self.peek() {
            self.i += 1;
            if c == '\n' {
                break;
            }
            if c == '\\' {
                if let Some(n) = self.peek() {
                    self.i += 1;
                    out.push(if n == 'n' { '\n' } else if n == 't' { '\t' } else { n });
                    continue;
                }
            }
            out.push(c);
        }
        out
    }
}

fn compile(src: &str, extended: bool, icase: bool) -> Result<Regex, String> {
    let mut s = posix_regex(src, extended);
    if icase {
        s = format!("(?i){s}");
    }
    Regex::new(&s).map_err(|e| format!("invalid regular expression: {e}"))
}

fn parse(script: &str, extended: bool) -> Result<Vec<Command>, String> {
    let chars: Vec<char> = script.chars().collect();
    let mut p = P { s: &chars, i: 0, extended };
    let mut out = Vec::new();
    loop {
        while matches!(p.peek(), Some(' ' | '\t' | '\n' | ';')) {
            p.i += 1;
        }
        if p.peek().is_none() {
            break;
        }
        if p.peek() == Some('#') {
            while !matches!(p.peek(), None | Some('\n')) {
                p.i += 1;
            }
            continue;
        }
        let a1 = p.addr()?;
        let mut a2 = None;
        p.ws();
        if a1.is_some() && p.peek() == Some(',') {
            p.i += 1;
            p.ws();
            if p.peek() == Some('+') {
                p.i += 1;
                let mut n = 0;
                while let Some(d) = p.peek().and_then(|c| c.to_digit(10)) {
                    n = n * 10 + d as usize;
                    p.i += 1;
                }
                a2 = Some(Addr::Plus(n));
            } else {
                a2 = p.addr()?;
                if a2.is_none() {
                    return Err("unexpected `,'".into());
                }
            }
        }
        p.ws();
        let mut negate = false;
        while p.peek() == Some('!') {
            negate = !negate;
            p.i += 1;
            p.ws();
        }
        let c = p.peek().ok_or("missing command")?;
        p.i += 1;
        let kind = match c {
            's' => {
                let d = p.peek().ok_or("unterminated `s' command")?;
                p.i += 1;
                let pat = p.until(d)?;
                let rep_src = p.until(d)?;
                let (mut global, mut print, mut icase, mut nth) = (false, false, false, 0usize);
                while let Some(f) = p.peek() {
                    match f {
                        'g' => global = true,
                        'p' => print = true,
                        'i' | 'I' => icase = true,
                        '0'..='9' => nth = nth * 10 + f.to_digit(10).unwrap() as usize,
                        _ => break,
                    }
                    p.i += 1;
                }
                let mut rep = Vec::new();
                let mut cur = String::new();
                let rc: Vec<char> = rep_src.chars().collect();
                let mut k = 0;
                while k < rc.len() {
                    let ch = rc[k];
                    k += 1;
                    if ch == '&' {
                        rep.push(Rep::Text(std::mem::take(&mut cur)));
                        rep.push(Rep::Group(0));
                    } else if ch == '\\' && k < rc.len() {
                        let n = rc[k];
                        k += 1;
                        match n {
                            '0'..='9' => {
                                rep.push(Rep::Text(std::mem::take(&mut cur)));
                                rep.push(Rep::Group(n.to_digit(10).unwrap() as usize));
                            }
                            'n' => cur.push('\n'),
                            't' => cur.push('\t'),
                            other => cur.push(other),
                        }
                    } else {
                        cur.push(ch);
                    }
                }
                rep.push(Rep::Text(cur));
                Kind::Subst { re: compile(&pat, extended, icase)?, rep, global, print, nth }
            }
            'y' => {
                let d = p.peek().ok_or("unterminated `y' command")?;
                p.i += 1;
                let un = |s: String| -> Vec<char> {
                    let mut b = Vec::new();
                    unescape(&s, &mut b);
                    String::from_utf8_lossy(&b).chars().collect()
                };
                let from = un(p.until(d)?);
                let to = un(p.until(d)?);
                if from.len() != to.len() {
                    return Err("strings for `y' command are different lengths".into());
                }
                Kind::Translate(from, to)
            }
            'd' => Kind::Delete,
            'p' => Kind::Print,
            'q' => Kind::Quit,
            '=' => Kind::LineNo,
            'a' => Kind::Append(p.text_arg()),
            'i' => Kind::Insert(p.text_arg()),
            'c' => Kind::Change(p.text_arg()),
            other => return Err(format!("unknown command: `{other}'")),
        };
        out.push(Command { a1, a2, negate, kind, active: None, in_range: false });
    }
    Ok(out)
}

fn addr_hit(a: &Addr, n: usize, last: bool, line: &str) -> bool {
    match a {
        Addr::Line(k) => *k == n,
        Addr::Last => last,
        Addr::Re(re) => re.is_match(line),
        Addr::Plus(_) => false,
    }
}

fn process(cmds: &mut [Command], text: &str, quiet: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let had_newline = text.ends_with('\n') || text.is_empty();
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    for c in cmds.iter_mut() {
        c.in_range = false;
        c.active = None;
    }
    'lines: for (idx, raw) in lines.iter().enumerate() {
        let n = idx + 1;
        let last = n == total;
        let mut line = raw.to_string();
        let mut deleted = false;
        let mut after: Vec<String> = Vec::new();
        let mut quit = false;
        for c in cmds.iter_mut() {
            let selected = match (&c.a1, &c.a2) {
                (None, _) => true,
                (Some(a), None) => addr_hit(a, n, last, &line),
                (Some(a), Some(b)) => {
                    if c.in_range {
                        let end = match b {
                            Addr::Line(k) => n >= *k,
                            Addr::Plus(_) => c.active.is_some_and(|e| n >= e),
                            other => addr_hit(other, n, last, &line),
                        };
                        if end {
                            c.in_range = false;
                        }
                        true
                    } else if addr_hit(a, n, last, &line) {
                        let ends_here = match b {
                            Addr::Line(k) => *k <= n,
                            Addr::Plus(0) => true,
                            Addr::Plus(k) => {
                                c.active = Some(n + k);
                                false
                            }
                            _ => false,
                        };
                        c.in_range = !ends_here;
                        true
                    } else {
                        false
                    }
                }
            };
            if selected == c.negate {
                continue;
            }
            match &c.kind {
                Kind::Subst { re, rep, global, print, nth } => {
                    let mut res = String::with_capacity(line.len());
                    let mut pos = 0;
                    let mut count = 0;
                    let mut changed = false;
                    for caps in re.captures_iter(&line) {
                        let m = caps.get(0).unwrap();
                        count += 1;
                        if (*nth > 0 && count < *nth) || (!*global && *nth == 0 && count > 1) || (!*global && *nth > 0 && count > *nth) {
                            continue;
                        }
                        res.push_str(&line[pos..m.start()]);
                        for r in rep {
                            match r {
                                Rep::Text(t) => res.push_str(t),
                                Rep::Group(g) => res.push_str(caps.get(*g).map(|m| m.as_str()).unwrap_or("")),
                            }
                        }
                        pos = m.end();
                        changed = true;
                    }
                    if changed {
                        res.push_str(&line[pos..]);
                        line = res;
                        if *print {
                            out.push_str(&line);
                            out.push('\n');
                        }
                    }
                }
                Kind::Translate(from, to) => {
                    line = line.chars().map(|ch| from.iter().position(|f| *f == ch).map(|i| to[i]).unwrap_or(ch)).collect();
                }
                Kind::Delete => {
                    deleted = true;
                    break;
                }
                Kind::Print => {
                    out.push_str(&line);
                    out.push('\n');
                }
                Kind::LineNo => out.push_str(&format!("{n}\n")),
                Kind::Quit => {
                    quit = true;
                    break;
                }
                Kind::Append(t) => after.push(t.clone()),
                Kind::Insert(t) => {
                    out.push_str(t);
                    out.push('\n');
                }
                Kind::Change(t) => {
                    if !c.in_range {
                        out.push_str(t);
                        out.push('\n');
                    }
                    deleted = true;
                    break;
                }
            }
        }
        if !deleted && !quiet {
            out.push_str(&line);
            if !(last && !had_newline) {
                out.push('\n');
            }
        }
        for t in after {
            out.push_str(&t);
            out.push('\n');
        }
        if quit {
            break 'lines;
        }
    }
    out
}

pub fn run(sh: &mut Interp, a: &[String]) -> i32 {
    // `-i` may carry a backup suffix glued to it; `-e` and `-f` take a value.
    let mut argv: Vec<String> = Vec::with_capacity(a.len());
    let mut in_place = false;
    let mut backup: Option<String> = None;
    for (n, arg) in a.iter().enumerate() {
        if n > 0 && (arg == "-i" || arg == "--in-place") {
            in_place = true;
        } else if n > 0 && arg.starts_with("-i") && !arg.starts_with("--") && arg.len() > 2 && !arg[2..].chars().all(|c| "nErse".contains(c)) {
            in_place = true;
            backup = Some(arg[2..].to_string());
        } else {
            argv.push(arg.clone());
        }
    }
    let args = Args::parse(&argv, "ef");
    in_place |= args.has('i');
    let extended = args.has('E') || args.has('r') || args.long("regexp-extended");
    let quiet = args.has('n') || args.long("quiet") || args.long("silent");
    let mut scripts: Vec<String> = args.flags.iter().filter(|f| f.0 == 'e').filter_map(|f| f.1.clone()).collect();
    for f in args.flags.iter().filter(|f| f.0 == 'f').filter_map(|f| f.1.clone()) {
        match sys::read_file(&sh.abs(&f)) {
            Ok(d) => scripts.push(String::from_utf8_lossy(&d).into_owned()),
            Err(e) => {
                sh.err(&format!("sed: couldn't open file {f}: {}", sys::strerror(e)));
                return 1;
            }
        }
    }
    let mut files = args.rest.clone();
    if scripts.is_empty() {
        if files.is_empty() {
            sh.err("Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...");
            return 1;
        }
        scripts.push(files.remove(0));
    }
    let mut cmds = match parse(&scripts.join("\n"), extended) {
        Ok(c) => c,
        Err(e) => {
            sh.err(&format!("sed: -e expression #1: {e}"));
            return 1;
        }
    };
    if in_place {
        let mut st = 0;
        for f in &files {
            let path = sh.abs(f);
            match sys::read_file(&path) {
                Ok(d) => {
                    if let Some(suffix) = &backup {
                        let _ = sys::write_file(&format!("{path}{suffix}"), &d, sys::O_TRUNC, 0o644);
                    }
                    let res = process(&mut cmds, &String::from_utf8_lossy(&d), quiet);
                    if let Err(e) = sys::write_file(&path, res.as_bytes(), sys::O_TRUNC, 0o644) {
                        sh.err(&format!("sed: couldn't write {f}: {}", sys::strerror(e)));
                        st = 1;
                    }
                }
                Err(e) => {
                    sh.err(&format!("sed: can't read {f}: {}", sys::strerror(e)));
                    st = 2;
                }
            }
        }
        return st;
    }
    let (data, st) = crate::text::input(sh, "sed", &files);
    let res = process(&mut cmds, &String::from_utf8_lossy(&data), quiet);
    sh.outs(&res);
    st
}
