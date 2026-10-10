//! Word expansion: braces, tilde, parameters, command substitution,
//! arithmetic, field splitting and pathname expansion.
use crate::ast::*;
use crate::glob::{self, Pc};
use crate::interp::{Flow, Interp, Io};
use std::rc::Rc;

type F = Vec<Pc>;

#[derive(Default)]
struct Fb {
    done: Vec<F>,
    cur: Option<F>,
}
impl Fb {
    fn touch(&mut self) -> &mut F {
        self.cur.get_or_insert_with(Vec::new)
    }
    fn quoted(&mut self, s: &str) {
        self.touch().extend(s.chars().map(|c| (c, true)));
    }
    fn lit(&mut self, s: &str) {
        if !s.is_empty() {
            self.touch().extend(s.chars().map(|c| (c, false)));
        }
    }
    fn split(&mut self, s: &str, ifs: &str) {
        for ch in s.chars() {
            if ifs.contains(ch) {
                self.brk();
            } else {
                self.touch().push((ch, false));
            }
        }
    }
    fn brk(&mut self) {
        if let Some(c) = self.cur.take() {
            self.done.push(c);
        }
    }
    fn finish(mut self) -> Vec<F> {
        self.brk();
        self.done
    }
}

fn text(f: &[Pc]) -> String {
    f.iter().map(|c| c.0).collect()
}

// ---- brace expansion ----

#[derive(Clone)]
enum Atom {
    C(char),
    P(Part),
}

fn atoms(w: &Word) -> Vec<Atom> {
    let mut out = Vec::new();
    for p in w {
        match p {
            Part::Lit(s) => out.extend(s.chars().map(Atom::C)),
            other => out.push(Atom::P(other.clone())),
        }
    }
    out
}
fn word_of(a: &[Atom]) -> Word {
    let mut out: Word = Vec::new();
    let mut lit = String::new();
    for x in a {
        match x {
            Atom::C(c) => lit.push(*c),
            Atom::P(p) => {
                if !lit.is_empty() {
                    out.push(Part::Lit(std::mem::take(&mut lit)));
                }
                out.push(p.clone());
            }
        }
    }
    if !lit.is_empty() {
        out.push(Part::Lit(lit));
    }
    out
}

fn seq(body: &[Atom]) -> Option<Vec<String>> {
    let mut s = String::new();
    for a in body {
        match a {
            Atom::C(c) => s.push(*c),
            Atom::P(_) => return None,
        }
    }
    let parts: Vec<&str> = s.split("..").collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let step = if parts.len() == 3 { parts[2].parse::<i64>().ok()?.abs().max(1) } else { 1 };
    if let (Ok(a), Ok(b)) = (parts[0].parse::<i64>(), parts[1].parse::<i64>()) {
        let width = if (parts[0].len() > 1 && parts[0].trim_start_matches('-').starts_with('0')) || (parts[1].len() > 1 && parts[1].trim_start_matches('-').starts_with('0')) {
            parts[0].len().max(parts[1].len())
        } else {
            0
        };
        let mut out = Vec::new();
        let mut v = a;
        if (a - b).abs() / step > 100_000 {
            return None;
        }
        loop {
            out.push(format!("{v:0width$}"));
            if v == b {
                break;
            }
            v += if b > a { step } else { -step };
            if (b > a && v > b) || (b < a && v < b) {
                break;
            }
        }
        return Some(out);
    }
    let (ca, cb): (Vec<char>, Vec<char>) = (parts[0].chars().collect(), parts[1].chars().collect());
    if ca.len() == 1 && cb.len() == 1 && ca[0].is_ascii_alphabetic() && cb[0].is_ascii_alphabetic() {
        let (a, b) = (ca[0] as u8, cb[0] as u8);
        let mut out = Vec::new();
        let mut v = a as i64;
        loop {
            out.push((v as u8 as char).to_string());
            if v == b as i64 {
                break;
            }
            v += if b > a { step } else { -step };
            if (b > a && v > b as i64) || (b < a && v < b as i64) {
                break;
            }
        }
        return Some(out);
    }
    None
}

fn brace(a: &[Atom], out: &mut Vec<Vec<Atom>>) {
    let mut i = 0;
    while i < a.len() {
        if matches!(a[i], Atom::C('{')) && !(i > 0 && matches!(a[i - 1], Atom::C('$'))) {
            // Find the matching close and the top-level commas.
            let mut depth = 0;
            let mut commas = Vec::new();
            let mut close = None;
            for (j, x) in a.iter().enumerate().skip(i + 1) {
                match x {
                    Atom::C('{') => depth += 1,
                    Atom::C('}') if depth == 0 => {
                        close = Some(j);
                        break;
                    }
                    Atom::C('}') => depth -= 1,
                    Atom::C(',') if depth == 0 => commas.push(j),
                    _ => {}
                }
            }
            if let Some(close) = close {
                let alts: Option<Vec<Vec<Atom>>> = if !commas.is_empty() {
                    let mut alts = Vec::new();
                    let mut start = i + 1;
                    for c in commas.iter().chain(std::iter::once(&close)) {
                        alts.push(a[start..*c].to_vec());
                        start = c + 1;
                    }
                    Some(alts)
                } else {
                    seq(&a[i + 1..close]).map(|v| v.into_iter().map(|s| s.chars().map(Atom::C).collect()).collect())
                };
                if let Some(alts) = alts {
                    for alt in alts {
                        let mut tail = alt;
                        tail.extend_from_slice(&a[close + 1..]);
                        let mut subs = Vec::new();
                        brace(&tail, &mut subs);
                        for s in subs {
                            let mut whole = a[..i].to_vec();
                            whole.extend(s);
                            out.push(whole);
                        }
                    }
                    return;
                }
            }
        }
        i += 1;
    }
    out.push(a.to_vec());
}

fn brace_expand(w: &Word) -> Vec<Word> {
    if !w.iter().any(|p| matches!(p, Part::Lit(s) if s.contains('{'))) {
        return vec![w.clone()];
    }
    let mut out = Vec::new();
    brace(&atoms(w), &mut out);
    out.iter().map(|a| word_of(a)).collect()
}

impl Interp {
    /// Full expansion of command words into arguments.
    pub fn expand_words(&mut self, words: &[Word]) -> Result<Vec<String>, Flow> {
        let mut out = Vec::with_capacity(words.len());
        for w in words {
            // The common case: a plain literal with nothing to expand.
            if let [Part::Lit(s)] = w.as_slice() {
                if !s.bytes().any(|c| matches!(c, b'*' | b'?' | b'[' | b'{' | b'~')) {
                    out.push(s.clone());
                    continue;
                }
            }
            for bw in brace_expand(w) {
                let mut fb = Fb::default();
                self.exp_parts(&bw, false, &mut fb, true)?;
                for f in fb.finish() {
                    let globbed = if self.s.opts.noglob { None } else { glob::expand(&f, &self.s.cwd) };
                    match globbed {
                        Some(v) => out.extend(v),
                        None => out.push(text(&f)),
                    }
                }
            }
        }
        Ok(out)
    }

    /// Expansion without field splitting or pathname expansion (assignments, redirection targets, here-documents).
    pub fn expand_one(&mut self, w: &Word) -> Result<String, Flow> {
        Ok(text(&self.expand_pat(w)?))
    }

    /// Like `expand_one`, keeping which characters were quoted, for use as a pattern.
    pub fn expand_pat(&mut self, w: &Word) -> Result<Vec<Pc>, Flow> {
        let mut fb = Fb::default();
        self.exp_parts(w, false, &mut fb, false)?;
        let fields = fb.finish();
        let mut out = Vec::new();
        for (i, f) in fields.into_iter().enumerate() {
            if i > 0 {
                out.push((' ', true));
            }
            out.extend(f);
        }
        Ok(out)
    }

    fn exp_parts(&mut self, parts: &[Part], in_dq: bool, fb: &mut Fb, split: bool) -> Result<(), Flow> {
        for (idx, p) in parts.iter().enumerate() {
            match p {
                Part::Lit(s) => {
                    if idx == 0 && !in_dq && s.starts_with('~') && (s.len() == 1 || s.as_bytes()[1] == b'/') {
                        if let Some(home) = self.get("HOME").map(str::to_string) {
                            fb.quoted(&home);
                            fb.lit(&s[1..]);
                            continue;
                        }
                    }
                    fb.lit(s)
                }
                Part::Quoted(s) => fb.quoted(s),
                Part::Dq(inner) => {
                    let only_at = inner.len() == 1 && self.s.params.is_empty() && matches!(&inner[0], Part::Param(p) if p.name == "@" && matches!(p.op, ParamOp::Plain));
                    if !only_at {
                        fb.touch();
                    }
                    self.exp_parts(inner, true, fb, split)?;
                }
                Part::Param(p) => self.exp_param(p, in_dq, fb, split)?,
                Part::CmdSub(c) => {
                    let s = self.cmdsub(c);
                    self.emit(&s, in_dq, fb, split);
                }
                Part::Arith(w) => {
                    let v = self.arith_word(w)?;
                    fb.lit(&v.to_string());
                }
            }
        }
        Ok(())
    }

    fn emit(&self, v: &str, in_dq: bool, fb: &mut Fb, split: bool) {
        if in_dq {
            fb.quoted(v)
        } else if split {
            fb.split(v, &self.ifs())
        } else {
            fb.lit(v)
        }
    }

    pub fn cmdsub(&mut self, c: &Rc<Cmd>) -> String {
        let cap: crate::interp::Capture = Default::default();
        let capc = cap.clone();
        let st = self.subshell(|sh| {
            sh.set_fd(1, Io::Cap(capc));
            sh.exec(c)
        });
        self.reap_jobs(true);
        self.cmdsub_status = st;
        let bytes = cap.borrow();
        let mut end = bytes.len();
        while end > 0 && bytes[end - 1] == b'\n' {
            end -= 1;
        }
        String::from_utf8_lossy(&bytes[..end]).into_owned()
    }

    pub fn param_value(&mut self, name: &str) -> Option<String> {
        let b = name.as_bytes();
        match b.first()? {
            b'?' => Some(self.s.status.to_string()),
            b'#' => Some(self.s.params.len().to_string()),
            b'$' => Some(crate::sys::getpid().to_string()),
            b'!' => Some(self.s.last_bg.to_string()),
            b'-' => Some(format!("{}{}{}", if self.s.opts.errexit { "e" } else { "" }, if self.s.opts.nounset { "u" } else { "" }, if self.s.opts.xtrace { "x" } else { "" })),
            b'@' | b'*' => Some(self.s.params.join(" ")),
            b'0'..=b'9' => {
                let n: usize = name.parse().ok()?;
                if n == 0 {
                    Some(self.s.arg0.clone())
                } else {
                    self.s.params.get(n - 1).cloned()
                }
            }
            _ => match name {
                "RANDOM" if self.get(name).is_none() => {
                    self.rand = self.rand.wrapping_mul(1_103_515_245).wrapping_add(12345);
                    Some(((self.rand >> 16) & 0x7fff).to_string())
                }
                "SECONDS" if self.get(name).is_none() => Some((((crate::sys::now_ms() - self.start_ms) / 1000.0) as i64).to_string()),
                "LINENO" if self.get(name).is_none() => Some("0".into()),
                _ => self.get(name).map(str::to_string),
            },
        }
    }

    fn exp_param(&mut self, p: &Param, in_dq: bool, fb: &mut Fb, split: bool) -> Result<(), Flow> {
        let name = p.name.as_str();
        if (name == "@" || name == "*") && matches!(p.op, ParamOp::Plain) {
            let params = self.s.params.clone();
            if in_dq && name == "@" {
                for (i, a) in params.iter().enumerate() {
                    if i > 0 {
                        fb.brk();
                    }
                    fb.quoted(a);
                }
            } else if in_dq {
                let sep = self.ifs().chars().next().map(|c| c.to_string()).unwrap_or_default();
                fb.quoted(&params.join(&sep));
            } else {
                let ifs = self.ifs();
                for (i, a) in params.iter().enumerate() {
                    if i > 0 {
                        if split {
                            fb.brk();
                        } else {
                            fb.lit(" ");
                        }
                    }
                    if split {
                        fb.split(a, &ifs)
                    } else {
                        fb.lit(a)
                    }
                }
            }
            return Ok(());
        }
        let val = self.param_value(name);
        let out: String = match &p.op {
            ParamOp::Plain => {
                if val.is_none() && self.s.opts.nounset && !matches!(name, "@" | "*") {
                    self.err(&format!("sh: {name}: unbound variable"));
                    return Err(Flow::Exit(1));
                }
                val.unwrap_or_default()
            }
            ParamOp::Len => {
                if name == "@" || name == "*" {
                    self.s.params.len().to_string()
                } else {
                    val.unwrap_or_default().chars().count().to_string()
                }
            }
            ParamOp::Default { colon, kind, word } => {
                let missing = val.is_none() || (*colon && val.as_deref() == Some(""));
                match kind {
                    b'-' => {
                        if missing {
                            return self.exp_parts(word, in_dq, fb, split);
                        }
                        val.unwrap_or_default()
                    }
                    b'=' => {
                        if missing {
                            let v = self.expand_one(word)?;
                            self.set(name, v.clone());
                            v
                        } else {
                            val.unwrap_or_default()
                        }
                    }
                    b'+' => {
                        if !missing {
                            return self.exp_parts(word, in_dq, fb, split);
                        }
                        String::new()
                    }
                    _ => {
                        if missing {
                            let m = self.expand_one(word)?;
                            self.err(&format!("sh: {name}: {}", if m.is_empty() { "parameter null or not set" } else { &m }));
                            return Err(Flow::Exit(1));
                        }
                        val.unwrap_or_default()
                    }
                }
            }
            ParamOp::Trim { suffix, longest, pat } => {
                let pat = self.expand_pat(pat)?;
                let chars: Vec<char> = val.unwrap_or_default().chars().collect();
                let n = chars.len();
                let mut res: Option<String> = None;
                // k = number of characters removed.
                let order: Box<dyn Iterator<Item = usize>> = if *longest { Box::new((0..=n).rev()) } else { Box::new(0..=n) };
                for k in order {
                    let hit = if *suffix { glob::matches(&pat, &chars[n - k..]) } else { glob::matches(&pat, &chars[..k]) };
                    if hit {
                        res = Some(if *suffix { chars[..n - k].iter().collect() } else { chars[k..].iter().collect() });
                        break;
                    }
                }
                res.unwrap_or_else(|| chars.iter().collect())
            }
            ParamOp::Subst { all, pat, rep } => {
                let mut pat = self.expand_pat(pat)?;
                let rep = self.expand_one(rep)?;
                let chars: Vec<char> = val.unwrap_or_default().chars().collect();
                let n = chars.len();
                let anchor = match pat.first() {
                    Some(('#', false)) => 1,
                    Some(('%', false)) => 2,
                    _ => 0,
                };
                if anchor != 0 {
                    pat.remove(0);
                }
                let mut out = String::new();
                let mut i = 0;
                let mut done = false;
                while i < n {
                    let mut hit = None;
                    if !done && !pat.is_empty() {
                        for j in (i + 1..=n).rev() {
                            if anchor == 2 && j != n {
                                break;
                            }
                            if glob::matches(&pat, &chars[i..j]) {
                                hit = Some(j);
                                break;
                            }
                        }
                    }
                    match hit {
                        Some(j) => {
                            out.push_str(&rep);
                            i = j;
                            done = !*all || anchor != 0;
                        }
                        None => {
                            if anchor == 1 {
                                done = true;
                            }
                            out.push(chars[i]);
                            i += 1;
                        }
                    }
                }
                out
            }
            ParamOp::Slice { off, len } => {
                let chars: Vec<char> = val.unwrap_or_default().chars().collect();
                let n = chars.len() as i64;
                let mut o = self.arith_word(off)?;
                if o < 0 {
                    o = (n + o).max(0);
                }
                let o = o.min(n);
                let end = match len {
                    Some(l) => {
                        let l = self.arith_word(l)?;
                        if l < 0 {
                            (n + l).max(o)
                        } else {
                            (o + l).min(n)
                        }
                    }
                    None => n,
                };
                chars[o as usize..end as usize].iter().collect()
            }
            ParamOp::Case { upper, all } => {
                let v = val.unwrap_or_default();
                if *all {
                    if *upper {
                        v.to_uppercase()
                    } else {
                        v.to_lowercase()
                    }
                } else {
                    let mut c = v.chars();
                    match c.next() {
                        Some(f) => {
                            let head: String = if *upper { f.to_uppercase().collect() } else { f.to_lowercase().collect() };
                            format!("{head}{}", c.as_str())
                        }
                        None => v,
                    }
                }
            }
        };
        self.emit(&out, in_dq, fb, split);
        Ok(())
    }

    // ---- arithmetic ----

    pub fn arith_word(&mut self, w: &Word) -> Result<i64, Flow> {
        let text = self.expand_one(w)?;
        self.arith(&text)
    }

    pub fn arith(&mut self, text: &str) -> Result<i64, Flow> {
        let mut a = Ar { s: text.as_bytes(), i: 0, sh: self, depth: 0 };
        let r = a.comma().and_then(|v| {
            a.ws();
            if a.i < a.s.len() {
                Err(format!("syntax error in expression: {text}"))
            } else {
                Ok(v)
            }
        });
        match r {
            Ok(v) => Ok(v),
            Err(msg) => {
                self.err(&format!("sh: {msg}"));
                Err(Flow::Exit(1))
            }
        }
    }
}

struct Ar<'a> {
    s: &'a [u8],
    i: usize,
    sh: &'a mut Interp,
    depth: u32,
}

type AR = Result<i64, String>;

impl Ar<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn eat(&mut self, t: &str) -> bool {
        self.ws();
        if self.s[self.i..].starts_with(t.as_bytes()) {
            self.i += t.len();
            true
        } else {
            false
        }
    }
    fn peek_is(&mut self, t: &str) -> bool {
        self.ws();
        self.s[self.i..].starts_with(t.as_bytes())
    }
    fn ident(&mut self) -> Option<String> {
        self.ws();
        let start = self.i;
        if self.i < self.s.len() && (self.s[self.i].is_ascii_alphabetic() || self.s[self.i] == b'_') {
            while self.i < self.s.len() && (self.s[self.i].is_ascii_alphanumeric() || self.s[self.i] == b'_') {
                self.i += 1;
            }
            return Some(String::from_utf8_lossy(&self.s[start..self.i]).into_owned());
        }
        None
    }
    fn value_of(&mut self, name: &str) -> AR {
        let v = self.sh.param_value(name).unwrap_or_default();
        let v = v.trim();
        if v.is_empty() {
            return Ok(0);
        }
        if let Some(n) = parse_int(v) {
            return Ok(n);
        }
        if self.depth > 16 {
            return Err("expression recursion level exceeded".into());
        }
        let mut sub = Ar { s: v.as_bytes(), i: 0, sh: self.sh, depth: self.depth + 1 };
        sub.comma()
    }
    fn comma(&mut self) -> AR {
        let mut v = self.assign()?;
        while self.eat(",") {
            v = self.assign()?;
        }
        Ok(v)
    }
    fn assign(&mut self) -> AR {
        let save = self.i;
        if let Some(name) = self.ident() {
            self.ws();
            for op in ["<<=", ">>=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "="] {
                if self.s[self.i..].starts_with(op.as_bytes()) && !(op == "=" && self.s.get(self.i + 1) == Some(&b'=')) {
                    self.i += op.len();
                    let rhs = self.assign()?;
                    let v = if op == "=" { rhs } else { binop(&op[..op.len() - 1], self.value_of(&name)?, rhs)? };
                    self.sh.set(&name, v.to_string());
                    return Ok(v);
                }
            }
        }
        self.i = save;
        self.ternary()
    }
    fn ternary(&mut self) -> AR {
        let c = self.binary(0)?;
        if self.eat("?") {
            let a = self.assign()?;
            if !self.eat(":") {
                return Err("expected `:' in conditional expression".into());
            }
            let b = self.assign()?;
            return Ok(if c != 0 { a } else { b });
        }
        Ok(c)
    }
    fn binary(&mut self, level: usize) -> AR {
        const LEVELS: &[&[&str]] = &[&["||"], &["&&"], &["|"], &["^"], &["&"], &["==", "!="], &["<=", ">=", "<", ">"], &["<<", ">>"], &["+", "-"], &["*", "/", "%"]];
        if level == LEVELS.len() {
            return self.power();
        }
        let mut v = self.binary(level + 1)?;
        'outer: loop {
            self.ws();
            for op in LEVELS[level] {
                if self.s[self.i..].starts_with(op.as_bytes()) {
                    let next = self.s.get(self.i + op.len()).copied().unwrap_or(0);
                    // Do not take a prefix of a longer operator.
                    let longer = match *op {
                        "|" => next == b'|' || next == b'=',
                        "&" => next == b'&' || next == b'=',
                        "<" | ">" => next == b'<' || next == b'>' || next == b'=',
                        "+" | "-" | "*" | "/" | "%" | "^" => next == b'=' || (*op == "*" && next == b'*'),
                        "<<" | ">>" => next == b'=',
                        _ => false,
                    };
                    if longer {
                        continue;
                    }
                    self.i += op.len();
                    let r = self.binary(level + 1)?;
                    v = binop(op, v, r)?;
                    continue 'outer;
                }
            }
            return Ok(v);
        }
    }
    fn power(&mut self) -> AR {
        let base = self.unary()?;
        if self.eat("**") {
            let e = self.power()?;
            if e < 0 {
                return Err("exponent less than 0".into());
            }
            return Ok(base.wrapping_pow(e.min(u32::MAX as i64) as u32));
        }
        Ok(base)
    }
    fn unary(&mut self) -> AR {
        self.ws();
        if self.peek_is("++") || self.peek_is("--") {
            let inc = self.s[self.i] == b'+';
            self.i += 2;
            let name = self.ident().ok_or("operand expected")?;
            let v = self.value_of(&name)? + if inc { 1 } else { -1 };
            self.sh.set(&name, v.to_string());
            return Ok(v);
        }
        if self.eat("!") {
            return Ok((self.unary()? == 0) as i64);
        }
        if self.eat("~") {
            return Ok(!self.unary()?);
        }
        if self.eat("-") {
            return Ok(self.unary()?.wrapping_neg());
        }
        if self.eat("+") {
            return self.unary();
        }
        self.primary()
    }
    fn primary(&mut self) -> AR {
        self.ws();
        if self.eat("(") {
            let v = self.comma()?;
            if !self.eat(")") {
                return Err("missing `)'".into());
            }
            return Ok(v);
        }
        if let Some(name) = self.ident() {
            let v = self.value_of(&name)?;
            if self.peek_is("++") || self.peek_is("--") {
                let inc = self.s[self.i] == b'+';
                self.i += 2;
                self.sh.set(&name, (v + if inc { 1 } else { -1 }).to_string());
            }
            return Ok(v);
        }
        let start = self.i;
        while self.i < self.s.len() && (self.s[self.i].is_ascii_alphanumeric() || self.s[self.i] == b'#') {
            self.i += 1;
        }
        let tok = std::str::from_utf8(&self.s[start..self.i]).unwrap_or("");
        if tok.is_empty() {
            return Err(format!("syntax error: operand expected (error token is \"{}\")", String::from_utf8_lossy(&self.s[start..])));
        }
        parse_int(tok).ok_or_else(|| format!("value too great for base (error token is \"{tok}\")"))
    }
}

pub fn parse_int(t: &str) -> Option<i64> {
    let (neg, t) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let v = if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        i64::from_str_radix(h, 16).ok()?
    } else if let Some((base, digits)) = t.split_once('#') {
        i64::from_str_radix(digits, base.parse().ok()?).ok()?
    } else if t.len() > 1 && t.starts_with('0') && t.bytes().all(|c| c.is_ascii_digit()) {
        i64::from_str_radix(t, 8).ok()?
    } else {
        t.parse().ok()?
    };
    Some(if neg { -v } else { v })
}

fn binop(op: &str, a: i64, b: i64) -> AR {
    Ok(match op {
        "||" => (a != 0 || b != 0) as i64,
        "&&" => (a != 0 && b != 0) as i64,
        "|" => a | b,
        "^" => a ^ b,
        "&" => a & b,
        "==" => (a == b) as i64,
        "!=" => (a != b) as i64,
        "<=" => (a <= b) as i64,
        ">=" => (a >= b) as i64,
        "<" => (a < b) as i64,
        ">" => (a > b) as i64,
        "<<" => a.wrapping_shl(b as u32),
        ">>" => a.wrapping_shr(b as u32),
        "+" => a.wrapping_add(b),
        "-" => a.wrapping_sub(b),
        "*" => a.wrapping_mul(b),
        "/" | "%" => {
            if b == 0 {
                return Err("division by 0".into());
            }
            if op == "/" {
                a.wrapping_div(b)
            } else {
                a.wrapping_rem(b)
            }
        }
        _ => return Err(format!("bad operator {op}")),
    })
}
