//! `test`, `[` and `[[ … ]]`.
use crate::ast::CondTok;
use crate::expand::parse_int;
use crate::glob::{self, Pc};
use crate::interp::{Interp, X};
use crate::sys;

struct Tok {
    text: String,
    /// Keeps quoting, for the right-hand side of `==` in `[[ ]]`.
    pat: Option<Vec<Pc>>,
    /// An operator written as such (`[[ ]]` only); in `[` operators are recognised by their text.
    op: bool,
}

struct Ev<'a> {
    sh: &'a mut Interp,
    t: Vec<Tok>,
    i: usize,
    double: bool,
    err: Option<String>,
}

const UNARY: &str = "abcdefghknoprstuvwxzGLNOS";

fn is_binary(s: &str) -> bool {
    matches!(s, "=" | "==" | "!=" | "=~" | "<" | ">" | "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge" | "-nt" | "-ot" | "-ef")
}

impl Ev<'_> {
    fn peek(&self) -> Option<&str> {
        self.t.get(self.i).map(|t| t.text.as_str())
    }
    fn or(&mut self) -> bool {
        let mut v = self.and();
        while matches!(self.peek(), Some("-o") | Some("||")) && (self.double || self.t[self.i].text == "-o") {
            self.i += 1;
            let r = self.and();
            v = v || r;
        }
        v
    }
    fn and(&mut self) -> bool {
        let mut v = self.not();
        while matches!(self.peek(), Some("-a") | Some("&&")) && (self.double || self.t[self.i].text == "-a") {
            self.i += 1;
            let r = self.not();
            v = v && r;
        }
        v
    }
    fn not(&mut self) -> bool {
        if self.peek() == Some("!") && self.i + 1 < self.t.len() {
            self.i += 1;
            return !self.not();
        }
        self.primary()
    }
    fn int(&mut self, s: &str) -> i64 {
        match parse_int(s.trim()) {
            Some(v) => v,
            None if self.double => self.sh.arith(s).unwrap_or(0),
            None => {
                self.err = Some(format!("{s}: integer expression expected"));
                0
            }
        }
    }
    fn primary(&mut self) -> bool {
        let Some(a) = self.t.get(self.i).map(|t| t.text.clone()) else {
            return false;
        };
        let a_is_op = self.t[self.i].op;
        // binary first: `[ -n = -n ]`
        if self.i + 2 < self.t.len() && !a_is_op {
            let op = self.t[self.i + 1].text.clone();
            if is_binary(&op) && (a != "(" || self.t.get(self.i + 3).map(|t| t.text.as_str()) != Some(")")) {
                let b = self.t[self.i + 2].text.clone();
                let bpat = self.t[self.i + 2].pat.clone();
                self.i += 3;
                return match op.as_str() {
                    "=" | "==" | "!=" => {
                        let eq = if self.double { glob::matches_str(&bpat.unwrap_or_else(|| glob::pat(&b)), &a) } else { a == b };
                        eq == (op != "!=")
                    }
                    "=~" => match regex_lite::Regex::new(&b) {
                        Ok(re) => re.is_match(&a),
                        Err(_) => {
                            self.err = Some(format!("{b}: invalid regular expression"));
                            false
                        }
                    },
                    "<" => a < b,
                    ">" => a > b,
                    "-nt" | "-ot" => {
                        let ma = sys::stat(&self.sh.abs(&a), true).map(|s| s.mtime_ms).ok();
                        let mb = sys::stat(&self.sh.abs(&b), true).map(|s| s.mtime_ms).ok();
                        match (ma, mb) {
                            (Some(x), Some(y)) => {
                                if op == "-nt" {
                                    x > y
                                } else {
                                    x < y
                                }
                            }
                            (Some(_), None) => op == "-nt",
                            (None, Some(_)) => op == "-ot",
                            _ => false,
                        }
                    }
                    "-ef" => sys::realpath(&self.sh.abs(&a)).ok().is_some_and(|x| Some(x) == sys::realpath(&self.sh.abs(&b)).ok()),
                    _ => {
                        let (x, y) = (self.int(&a), self.int(&b));
                        match op.as_str() {
                            "-eq" => x == y,
                            "-ne" => x != y,
                            "-lt" => x < y,
                            "-le" => x <= y,
                            "-gt" => x > y,
                            _ => x >= y,
                        }
                    }
                };
            }
        }
        if a == "(" {
            self.i += 1;
            let v = self.or();
            if self.peek() == Some(")") {
                self.i += 1;
            }
            return v;
        }
        if a.len() == 2 && a.starts_with('-') && UNARY.contains(&a[1..]) && self.i + 1 < self.t.len() {
            let b = self.t[self.i + 1].text.clone();
            self.i += 2;
            let path = self.sh.abs(&b);
            let st = |follow: bool| sys::stat(&path, follow).ok();
            return match a.as_bytes()[1] {
                b'n' => !b.is_empty(),
                b'z' => b.is_empty(),
                b'e' | b'a' => !b.is_empty() && st(true).is_some(),
                b'f' => !b.is_empty() && st(true).is_some_and(|s| s.is_file()),
                b'd' => !b.is_empty() && st(true).is_some_and(|s| s.is_dir()),
                b'L' | b'h' => !b.is_empty() && st(false).is_some_and(|s| s.is_symlink()),
                b's' => !b.is_empty() && st(true).is_some_and(|s| s.size > 0),
                b'r' | b'w' | b'O' | b'G' => !b.is_empty() && st(true).is_some(),
                b'x' => !b.is_empty() && st(true).is_some_and(|s| s.is_dir() || s.mode & 0o111 != 0),
                b'v' => self.sh.get(&b).is_some(),
                b't' => false,
                _ => false,
            };
        }
        self.i += 1;
        !a.is_empty()
    }
}

/// `test …` / `[ … ]` with already expanded arguments.
pub fn test(sh: &mut Interp, args: &[String]) -> i32 {
    let t: Vec<Tok> = args.iter().map(|a| Tok { text: a.clone(), pat: None, op: false }).collect();
    if t.is_empty() {
        return 1;
    }
    let mut ev = Ev { sh, t, i: 0, double: false, err: None };
    let v = ev.or();
    let extra = ev.i < ev.t.len();
    let err = ev.err.take();
    if let Some(e) = err {
        sh.err(&format!("sh: test: {e}"));
        return 2;
    }
    if extra {
        sh.err("sh: test: too many arguments");
        return 2;
    }
    !v as i32
}

pub fn cond(sh: &mut Interp, toks: &[CondTok]) -> X {
    let mut t = Vec::with_capacity(toks.len());
    for tok in toks {
        match tok {
            CondTok::Op(o) => t.push(Tok { text: o.clone(), pat: None, op: true }),
            CondTok::W(w) => {
                let pat = sh.expand_pat(w)?;
                t.push(Tok { text: pat.iter().map(|c| c.0).collect(), pat: Some(pat), op: false });
            }
        }
    }
    let mut ev = Ev { sh, t, i: 0, double: true, err: None };
    let v = ev.or();
    if let Some(e) = ev.err.take() {
        sh.err(&format!("sh: [[: {e}"));
        return Ok(2);
    }
    Ok(!v as i32)
}
