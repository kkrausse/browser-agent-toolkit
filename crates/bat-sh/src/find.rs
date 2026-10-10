//! `find`: tests, `-a`/`-o`/`!`/parentheses, `-print`, `-print0`, `-delete`,
//! `-prune`, `-exec … ;` and `-exec … +`.
use crate::glob::{self, Pc};
use crate::interp::{basename, Flow, Interp, X};
use crate::sys::{self, Stat};

enum Expr {
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
    Name(Vec<Pc>, bool),
    Path(Vec<Pc>, bool),
    Type(char),
    Empty,
    Newer(f64),
    /// (sign, value in 512-byte blocks or bytes, bytes?)
    Size(i8, u64, u64),
    /// minutes or days: (sign, value, unit in ms)
    Mtime(i8, f64, f64),
    Print,
    Print0,
    Delete,
    Prune,
    Exec(Vec<String>, bool),
    True,
    False,
}

struct Parser<'a> {
    a: &'a [String],
    i: usize,
    action: bool,
    sh: &'a Interp,
}

impl Parser<'_> {
    fn or(&mut self) -> Result<Expr, String> {
        let mut e = self.and()?;
        while self.i < self.a.len() && (self.a[self.i] == "-o" || self.a[self.i] == "-or") {
            self.i += 1;
            e = Expr::Or(Box::new(e), Box::new(self.and()?));
        }
        Ok(e)
    }
    fn and(&mut self) -> Result<Expr, String> {
        let mut e = self.not()?;
        while self.i < self.a.len() && !matches!(self.a[self.i].as_str(), "-o" | "-or" | ")") {
            if self.a[self.i] == "-a" || self.a[self.i] == "-and" {
                self.i += 1;
            }
            e = Expr::And(Box::new(e), Box::new(self.not()?));
        }
        Ok(e)
    }
    fn not(&mut self) -> Result<Expr, String> {
        if self.i < self.a.len() && (self.a[self.i] == "!" || self.a[self.i] == "-not") {
            self.i += 1;
            return Ok(Expr::Not(Box::new(self.not()?)));
        }
        self.primary()
    }
    fn arg(&mut self, what: &str) -> Result<String, String> {
        let v = self.a.get(self.i).cloned().ok_or_else(|| format!("missing argument to `{what}'"))?;
        self.i += 1;
        Ok(v)
    }
    fn primary(&mut self) -> Result<Expr, String> {
        let t = self.arg("expression")?;
        let signed = |v: &str| -> (i8, String) {
            match v.as_bytes().first() {
                Some(b'+') => (1, v[1..].to_string()),
                Some(b'-') => (-1, v[1..].to_string()),
                _ => (0, v.to_string()),
            }
        };
        Ok(match t.as_str() {
            "(" => {
                let e = self.or()?;
                if self.arg(")")? != ")" {
                    return Err("missing closing `)'".into());
                }
                e
            }
            "-name" | "-iname" => Expr::Name(glob::pat(&self.arg(&t)?), t == "-iname"),
            "-path" | "-wholename" | "-ipath" => Expr::Path(glob::pat(&self.arg(&t)?), t == "-ipath"),
            "-type" => Expr::Type(self.arg(&t)?.chars().next().unwrap_or('f')),
            "-empty" => Expr::Empty,
            "-newer" => {
                let f = self.arg(&t)?;
                Expr::Newer(sys::stat(&self.sh.abs(&f), true).map(|s| s.mtime_ms).map_err(|e| format!("{f}: {}", sys::strerror(e)))?)
            }
            "-size" => {
                let (sign, v) = signed(&self.arg(&t)?);
                let unit = match v.as_bytes().last() {
                    Some(b'c') => 1,
                    Some(b'k') => 1024,
                    Some(b'M') => 1024 * 1024,
                    Some(b'G') => 1024 * 1024 * 1024,
                    _ => 512,
                };
                Expr::Size(sign, v.trim_end_matches(|c: char| c.is_alphabetic()).parse().map_err(|_| "invalid argument to `-size'")?, unit)
            }
            "-mtime" | "-mmin" => {
                let (sign, v) = signed(&self.arg(&t)?);
                Expr::Mtime(sign, v.parse().map_err(|_| format!("invalid argument to `{t}'"))?, if t == "-mtime" { 86_400_000.0 } else { 60_000.0 })
            }
            "-print" => {
                self.action = true;
                Expr::Print
            }
            "-print0" => {
                self.action = true;
                Expr::Print0
            }
            "-delete" => {
                self.action = true;
                Expr::Delete
            }
            "-prune" => Expr::Prune,
            "-true" => Expr::True,
            "-false" => Expr::False,
            "-exec" | "-execdir" => {
                self.action = true;
                let mut cmd = Vec::new();
                loop {
                    let v = self.arg("-exec")?;
                    if v == ";" {
                        return Ok(Expr::Exec(cmd, false));
                    }
                    if v == "+" && cmd.last().map(String::as_str) == Some("{}") {
                        cmd.pop();
                        return Ok(Expr::Exec(cmd, true));
                    }
                    cmd.push(v);
                }
            }
            other => return Err(format!("unknown predicate `{other}'")),
        })
    }
}

struct Walk<'a> {
    sh: &'a mut Interp,
    out: Vec<u8>,
    batch: Vec<(usize, Vec<String>)>,
    prune: bool,
    now: f64,
    status: i32,
}

impl Walk<'_> {
    fn eval(&mut self, e: &Expr, shown: &str, path: &str, st: &Stat) -> Result<bool, Flow> {
        Ok(match e {
            Expr::And(a, b) => self.eval(a, shown, path, st)? && self.eval(b, shown, path, st)?,
            Expr::Or(a, b) => self.eval(a, shown, path, st)? || self.eval(b, shown, path, st)?,
            Expr::Not(a) => !self.eval(a, shown, path, st)?,
            Expr::Name(p, fold) => {
                let name = basename(shown);
                if *fold {
                    let lower: Vec<Pc> = p.iter().map(|(c, q)| (c.to_ascii_lowercase(), *q)).collect();
                    glob::matches_str(&lower, &name.to_lowercase())
                } else {
                    glob::matches_str(p, name)
                }
            }
            Expr::Path(p, fold) => {
                if *fold {
                    let lower: Vec<Pc> = p.iter().map(|(c, q)| (c.to_ascii_lowercase(), *q)).collect();
                    glob::matches_str(&lower, &shown.to_lowercase())
                } else {
                    glob::matches_str(p, shown)
                }
            }
            Expr::Type(t) => match t {
                'f' => st.is_file(),
                'd' => st.is_dir(),
                'l' => st.is_symlink(),
                _ => false,
            },
            Expr::Empty => {
                if st.is_dir() {
                    sys::readdir(path).map(|v| v.is_empty()).unwrap_or(false)
                } else {
                    st.is_file() && st.size == 0
                }
            }
            Expr::Newer(t) => st.mtime_ms > *t,
            Expr::Size(sign, v, unit) => {
                let n = st.size.div_ceil(*unit);
                match sign {
                    1 => n > *v,
                    -1 => n < *v,
                    _ => n == *v,
                }
            }
            Expr::Mtime(sign, v, unit) => {
                let age = ((self.now - st.mtime_ms) / unit).floor();
                match sign {
                    1 => age > *v,
                    -1 => age < *v,
                    _ => age == *v,
                }
            }
            Expr::Print => {
                self.out.extend_from_slice(shown.as_bytes());
                self.out.push(b'\n');
                true
            }
            Expr::Print0 => {
                self.out.extend_from_slice(shown.as_bytes());
                self.out.push(0);
                true
            }
            Expr::Delete => {
                let r = if st.is_dir() { sys::rmdir(path) } else { sys::unlink(path) };
                if let Err(e) = r {
                    self.sh.err(&format!("find: cannot delete '{shown}': {}", sys::strerror(e)));
                    self.status = 1;
                }
                r.is_ok()
            }
            Expr::Prune => {
                self.prune = true;
                true
            }
            Expr::True => true,
            Expr::False => false,
            Expr::Exec(cmd, plus) => {
                if *plus {
                    let key = cmd.as_ptr() as usize;
                    match self.batch.iter_mut().find(|b| b.0 == key) {
                        Some(b) => b.1.push(shown.to_string()),
                        None => self.batch.push((key, vec![shown.to_string()])),
                    }
                    true
                } else {
                    let out = std::mem::take(&mut self.out);
                    self.sh.out(&out);
                    let argv: Vec<String> = cmd.iter().map(|c| c.replace("{}", shown)).collect();
                    self.sh.run_status(&argv)? == 0
                }
            }
        })
    }

    fn visit(&mut self, e: &Expr, shown: &str, path: &str, depth: usize, min: usize, max: usize, depth_first: bool) -> Result<(), Flow> {
        let st = match sys::stat(path, false) {
            Ok(s) => s,
            Err(err) => {
                self.sh.err(&format!("find: '{shown}': {}", sys::strerror(err)));
                self.status = 1;
                return Ok(());
            }
        };
        self.prune = false;
        if !depth_first && depth >= min {
            self.eval(e, shown, path, &st)?;
        }
        let descend = st.is_dir() && depth < max && !self.prune;
        if descend {
            match sys::readdir(path) {
                Ok(mut ents) => {
                    ents.sort();
                    for (name, _) in ents {
                        let sep = if shown.ends_with('/') { "" } else { "/" };
                        self.visit(e, &format!("{shown}{sep}{name}"), &format!("{}/{}", path.trim_end_matches('/'), name), depth + 1, min, max, depth_first)?;
                    }
                }
                Err(err) => {
                    self.sh.err(&format!("find: '{shown}': {}", sys::strerror(err)));
                    self.status = 1;
                }
            }
        }
        if depth_first && depth >= min {
            self.eval(e, shown, path, &st)?;
        }
        if self.out.len() > 1 << 16 {
            let out = std::mem::take(&mut self.out);
            self.sh.out(&out);
        }
        Ok(())
    }
}

fn has_delete(e: &Expr) -> bool {
    match e {
        Expr::And(a, b) | Expr::Or(a, b) => has_delete(a) || has_delete(b),
        Expr::Not(a) => has_delete(a),
        Expr::Delete => true,
        _ => false,
    }
}

fn exec_templates<'e>(e: &'e Expr, out: &mut Vec<&'e Vec<String>>) {
    match e {
        Expr::And(a, b) | Expr::Or(a, b) => {
            exec_templates(a, out);
            exec_templates(b, out);
        }
        Expr::Not(a) => exec_templates(a, out),
        Expr::Exec(cmd, true) => out.push(cmd),
        _ => {}
    }
}

pub fn run(sh: &mut Interp, a: &[String]) -> X {
    let mut i = 1;
    let mut roots = Vec::new();
    while i < a.len() && !a[i].starts_with('-') && a[i] != "!" && a[i] != "(" {
        roots.push(a[i].clone());
        i += 1;
    }
    if roots.is_empty() {
        roots.push(".".into());
    }
    // Global options may appear anywhere among the tests.
    let (mut min, mut max, mut depth_first) = (0usize, usize::MAX, false);
    let mut rest: Vec<String> = Vec::new();
    while i < a.len() {
        match a[i].as_str() {
            "-maxdepth" | "-mindepth" => {
                let v = a.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(0);
                if a[i] == "-maxdepth" {
                    max = v
                } else {
                    min = v
                }
                i += 2;
            }
            "-depth" => {
                depth_first = true;
                i += 1;
            }
            "-L" | "-H" | "-P" | "-follow" | "-xdev" | "-mount" | "-noleaf" => i += 1,
            _ => {
                rest.push(a[i].clone());
                i += 1;
            }
        }
    }
    let (expr, action) = if rest.is_empty() {
        (Expr::True, false)
    } else {
        let mut p = Parser { a: &rest, i: 0, action: false, sh };
        match p.or() {
            Ok(e) if p.i >= rest.len() => (e, p.action),
            Ok(_) => {
                sh.err("find: paths must precede expression");
                return Ok(1);
            }
            Err(e) => {
                sh.err(&format!("find: {e}"));
                return Ok(1);
            }
        }
    };
    let expr = if action { expr } else { Expr::And(Box::new(expr), Box::new(Expr::Print)) };
    depth_first |= has_delete(&expr);
    let now = sys::now_ms();
    let mut w = Walk { sh, out: Vec::new(), batch: Vec::new(), prune: false, now, status: 0 };
    for r in &roots {
        let path = w.sh.abs(r);
        w.visit(&expr, r, &path, 0, min, max, depth_first)?;
    }
    let out = std::mem::take(&mut w.out);
    let batch = std::mem::take(&mut w.batch);
    let mut status = w.status;
    sh.out(&out);
    let mut templates = Vec::new();
    exec_templates(&expr, &mut templates);
    for (key, files) in batch {
        if let Some(cmd) = templates.iter().find(|c| c.as_ptr() as usize == key) {
            let mut argv = (*cmd).clone();
            argv.extend(files);
            if sh.run_status(&argv)? != 0 {
                status = 1;
            }
        }
    }
    Ok(status)
}
