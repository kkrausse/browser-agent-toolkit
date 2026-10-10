//! Shell state and command execution.
//!
//! Everything a command touches is state of this struct: variables, the
//! working directory and the descriptor table are the shell's own, so a
//! subshell is a clone that is thrown away, and builtins (the coreutils
//! included) run as function calls. Only programs the runtime has to run in a
//! process of their own (`node`, JavaScript files and `.bin` entries) become
//! children, through `sys::spawn`.
use crate::ast::*;
use crate::sys;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

/// A descriptor of the host process. Closed on drop when owned.
pub struct HostFd(pub i32, pub bool);
impl Drop for HostFd {
    fn drop(&mut self) {
        if self.1 {
            sys::close(self.0);
        }
    }
}

pub struct InBuf {
    pub data: Vec<u8>,
    pub pos: Cell<usize>,
}

pub type Capture = Rc<RefCell<Vec<u8>>>;

/// What one of the shell's descriptors is connected to.
#[derive(Clone)]
pub enum Io {
    Host(Rc<HostFd>),
    /// Output collected in memory (command substitution, a pipe between builtins, captured stdout/stderr).
    Cap(Capture),
    /// Input held in memory (here-documents, the previous stage of a pipeline).
    In(Rc<InBuf>),
    Null,
}

impl Io {
    pub fn input(data: Vec<u8>) -> Io {
        Io::In(Rc::new(InBuf { data, pos: Cell::new(0) }))
    }
    pub fn host(fd: i32, owned: bool) -> Io {
        Io::Host(Rc::new(HostFd(fd, owned)))
    }
}

#[derive(Clone)]
pub struct Var {
    pub val: String,
    pub exported: bool,
    pub readonly: bool,
}

/// A bash array: indexed (sparse) or associative (in the order the keys were set).
#[derive(Clone)]
pub enum Arr {
    Indexed(std::collections::BTreeMap<i64, String>),
    Assoc(Vec<(String, String)>),
}

impl Arr {
    pub fn values(&self) -> Vec<String> {
        match self {
            Arr::Indexed(m) => m.values().cloned().collect(),
            Arr::Assoc(v) => v.iter().map(|e| e.1.clone()).collect(),
        }
    }
    pub fn keys(&self) -> Vec<String> {
        match self {
            Arr::Indexed(m) => m.keys().map(|k| k.to_string()).collect(),
            Arr::Assoc(v) => v.iter().map(|e| e.0.clone()).collect(),
        }
    }
    pub fn from_list(items: Vec<String>) -> Arr {
        Arr::Indexed(items.into_iter().enumerate().map(|(i, v)| (i as i64, v)).collect())
    }
}

#[derive(Clone, Default)]
pub struct Opts {
    pub errexit: bool,
    pub xtrace: bool,
    pub nounset: bool,
    pub pipefail: bool,
    pub noglob: bool,
}

#[derive(Clone)]
pub struct Sh {
    pub vars: HashMap<String, Var>,
    pub funcs: HashMap<String, Rc<Cmd>>,
    pub cwd: String,
    pub fds: Vec<Io>,
    pub params: Vec<String>,
    pub arg0: String,
    pub status: i32,
    pub opts: Opts,
    /// > 0 while running something whose failure must not trigger `set -e`.
    pub cond_depth: u32,
    pub loop_depth: u32,
    pub func_depth: u32,
    pub locals: Vec<Vec<(String, Option<Var>)>>,
    pub last_bg: u32,
    pub arrays: HashMap<String, Arr>,
    /// Arrays shadowed by `local` in the running functions.
    pub local_arrays: Vec<Vec<(String, Option<Arr>)>>,
    /// Exit statuses of the stages of the last pipeline (`PIPESTATUS`).
    pub pipestatus: Vec<i32>,
}

pub enum Flow {
    Exit(i32),
    Return(i32),
    Break(u32),
    Continue(u32),
}
pub type X = Result<i32, Flow>;

/// A running child and what has to be collected when it ends.
pub struct Child {
    pub pid: u32,
    /// Temporary files standing in for in-memory captures the child wrote to.
    collects: Vec<(String, Capture)>,
    tmp_in: Option<String>,
}

pub enum Done {
    Status(i32),
    Spawned(Child),
}

pub enum Prog {
    /// (exec for the runtime, argv)
    Exec(String, Vec<String>),
    /// A shell script file.
    Script(String),
    NotFound,
    NotExecutable(String),
}

pub struct Interp {
    pub s: Sh,
    pub jobs: Vec<Child>,
    tmp_seq: u32,
    pub start_ms: f64,
    pub cmdsub_status: i32,
    /// Set while a pipeline stage that is not the last runs: its capture, and the pipe made instead when the stage is a child process.
    stage_cap: Option<Capture>,
    stage_pipe: Option<i32>,
    pub rand: u32,
    /// `trap … EXIT`
    pub exit_trap: Option<String>,
    /// `timeout`: when the command it runs has to stop (host clock, ms), and whether that happened.
    pub deadline: Option<f64>,
    pub timed_out: bool,
    /// Files standing for `<(…)` and `>(…)` of the command being run: (path, command to feed it to afterwards).
    pub procsubs: Vec<(String, Option<Rc<Cmd>>)>,
}

pub fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for c in path.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    let mut s = String::with_capacity(path.len());
    for c in &out {
        s.push('/');
        s.push_str(c);
    }
    if s.is_empty() {
        s.push('/');
    }
    s
}

pub fn basename(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    if t.is_empty() {
        return if p.is_empty() { "" } else { "/" };
    }
    &t[t.rfind('/').map(|i| i + 1).unwrap_or(0)..]
}

pub fn dirname(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    if t.is_empty() {
        return if p.starts_with('/') { "/" } else { "." };
    }
    match t.rfind('/') {
        None => ".",
        Some(0) => "/",
        Some(i) => t[..i].trim_end_matches('/'),
    }
}

pub const SHELL_NAMES: &[&str] = &["sh", "bash", "zsh", "dash", "ash"];

impl Interp {
    pub fn new(cwd: String, env: Vec<(String, String)>, fds: [Io; 3]) -> Interp {
        let mut vars = HashMap::new();
        for (k, v) in env {
            vars.insert(k, Var { val: v, exported: true, readonly: false });
        }
        vars.entry("IFS".into()).or_insert(Var { val: " \t\n".into(), exported: false, readonly: false });
        vars.insert("PWD".into(), Var { val: cwd.clone(), exported: true, readonly: false });
        let now = sys::now_ms();
        Interp {
            s: Sh {
                vars,
                funcs: HashMap::new(),
                cwd,
                fds: fds.to_vec(),
                params: Vec::new(),
                arg0: "sh".into(),
                status: 0,
                opts: Opts::default(),
                cond_depth: 0,
                loop_depth: 0,
                func_depth: 0,
                locals: Vec::new(),
                last_bg: 0,
                arrays: HashMap::new(),
                local_arrays: Vec::new(),
                pipestatus: Vec::new(),
            },
            jobs: Vec::new(),
            tmp_seq: 0,
            start_ms: now,
            cmdsub_status: 0,
            stage_cap: None,
            stage_pipe: None,
            rand: (now as u64 as u32) ^ 0x9e37_79b9,
            exit_trap: None,
            deadline: None,
            timed_out: false,
            procsubs: Vec::new(),
        }
    }

    /// Under `timeout`: unwind (as `exit 124`) once the time is up. Checked before
    /// every command, so loops and lists stop between two commands.
    pub fn check_deadline(&mut self) -> Result<(), Flow> {
        match self.deadline {
            Some(d) if sys::now_ms() >= d => {
                self.timed_out = true;
                Err(Flow::Exit(124))
            }
            _ => Ok(()),
        }
    }

    // ---- variables ----

    pub fn get(&self, name: &str) -> Option<&str> {
        self.s.vars.get(name).map(|v| v.val.as_str())
    }
    pub fn var(&self, name: &str) -> String {
        self.get(name).unwrap_or("").to_string()
    }
    pub fn set(&mut self, name: &str, val: String) -> bool {
        match self.s.vars.get_mut(name) {
            Some(v) if v.readonly => {
                self.err(&format!("sh: {name}: readonly variable"));
                false
            }
            Some(v) => {
                v.val = val;
                true
            }
            None => {
                self.s.vars.insert(name.to_string(), Var { val, exported: false, readonly: false });
                true
            }
        }
    }
    pub fn env_list(&self) -> Vec<String> {
        let mut out: Vec<String> = self.s.vars.iter().filter(|(_, v)| v.exported).map(|(k, v)| format!("{k}={}", v.val)).collect();
        out.sort();
        out
    }
    pub fn ifs(&self) -> String {
        self.get("IFS").unwrap_or(" \t\n").to_string()
    }

    // ---- paths ----

    pub fn abs(&self, p: &str) -> String {
        if p.starts_with('/') {
            normalize(p)
        } else {
            normalize(&format!("{}/{}", self.s.cwd, p))
        }
    }

    // ---- descriptors ----

    pub fn fd(&self, n: usize) -> Io {
        self.s.fds.get(n).cloned().unwrap_or(Io::Null)
    }
    pub fn set_fd(&mut self, n: usize, io: Io) -> Io {
        while self.s.fds.len() <= n {
            self.s.fds.push(Io::Null);
        }
        std::mem::replace(&mut self.s.fds[n], io)
    }
    pub fn write_fd(&mut self, n: usize, data: &[u8]) -> bool {
        match self.s.fds.get(n) {
            Some(Io::Host(h)) => sys::write_all(h.0, data).is_ok(),
            Some(Io::Cap(c)) => {
                c.borrow_mut().extend_from_slice(data);
                true
            }
            _ => true,
        }
    }
    pub fn out(&mut self, data: &[u8]) -> bool {
        self.write_fd(1, data)
    }
    pub fn outs(&mut self, s: &str) -> bool {
        self.write_fd(1, s.as_bytes())
    }
    /// A line on stderr.
    pub fn err(&mut self, s: &str) {
        let mut line = Vec::with_capacity(s.len() + 1);
        line.extend_from_slice(s.as_bytes());
        line.push(b'\n');
        self.write_fd(2, &line);
    }
    /// Read up to `buf.len()` bytes of stdin; 0 at the end.
    pub fn read_stdin(&mut self, buf: &mut [u8]) -> usize {
        match self.s.fds.first() {
            Some(Io::Host(h)) => sys::read(h.0, buf).unwrap_or(0),
            Some(Io::In(b)) => {
                let pos = b.pos.get();
                let n = buf.len().min(b.data.len() - pos);
                buf[..n].copy_from_slice(&b.data[pos..pos + n]);
                b.pos.set(pos + n);
                n
            }
            _ => 0,
        }
    }
    pub fn read_stdin_all(&mut self) -> Vec<u8> {
        match self.s.fds.first() {
            Some(Io::Host(h)) => sys::read_fd_all(h.0).unwrap_or_default(),
            Some(Io::In(b)) => {
                let pos = b.pos.get();
                b.pos.set(b.data.len());
                b.data[pos..].to_vec()
            }
            _ => Vec::new(),
        }
    }
    /// One line of stdin without its newline; `None` at the end. Never reads past the newline.
    pub fn read_line(&mut self) -> Option<Vec<u8>> {
        let mut line = Vec::new();
        match self.s.fds.first() {
            Some(Io::In(b)) => {
                let pos = b.pos.get();
                if pos >= b.data.len() {
                    return None;
                }
                let rest = &b.data[pos..];
                match rest.iter().position(|c| *c == b'\n') {
                    Some(n) => {
                        b.pos.set(pos + n + 1);
                        Some(rest[..n].to_vec())
                    }
                    None => {
                        b.pos.set(b.data.len());
                        Some(rest.to_vec())
                    }
                }
            }
            Some(Io::Host(h)) => {
                let fd = h.0;
                let mut one = [0u8; 1];
                loop {
                    match sys::read(fd, &mut one) {
                        Ok(1) => {
                            if one[0] == b'\n' {
                                return Some(line);
                            }
                            line.push(one[0]);
                        }
                        _ => return if line.is_empty() { None } else { Some(line) },
                    }
                }
            }
            _ => None,
        }
    }

    /// After a command: run the `>(…)` commands on what was written for them and remove the files.
    pub fn end_procsubs(&mut self, mark: usize) {
        while self.procsubs.len() > mark {
            let Some((path, cmd)) = self.procsubs.pop() else { break };
            if let Some(c) = cmd {
                let data = sys::read_file(&path).unwrap_or_default();
                self.subshell(|sh| {
                    sh.set_fd(0, Io::input(data));
                    sh.exec(&c)
                });
            }
            let _ = sys::unlink(&path);
        }
    }

    // ---- arrays ----

    /// The elements of an array (or of the scalar of that name, as its only element).
    pub fn array_items(&self, name: &str, keys: bool) -> Vec<String> {
        if name == "PIPESTATUS" {
            return if keys { (0..self.s.pipestatus.len()).map(|i| i.to_string()).collect() } else { self.s.pipestatus.iter().map(|s| s.to_string()).collect() };
        }
        match self.s.arrays.get(name) {
            Some(a) if keys => a.keys(),
            Some(a) => a.values(),
            None => match self.get(name) {
                Some(v) if keys => vec![if v.is_empty() { String::new() } else { "0".into() }].into_iter().filter(|k| !k.is_empty()).collect(),
                Some(v) => vec![v.to_string()],
                None => Vec::new(),
            },
        }
    }

    /// The key a subscript stands for: text for an associative array, a number otherwise (negative counts from the end).
    fn array_key(&mut self, name: &str, index: &Word) -> Result<Result<String, i64>, Flow> {
        if matches!(self.s.arrays.get(name), Some(Arr::Assoc(_))) {
            let k = self.expand_one(index)?;
            // Quotes inside a subscript are not removed by the parser.
            let k = match k.as_bytes() {
                [b'"', .., b'"'] | [b'\'', .., b'\''] if k.len() >= 2 => k[1..k.len() - 1].to_string(),
                _ => k,
            };
            return Ok(Ok(k));
        }
        let mut n = self.arith_word(index)?;
        if n < 0 {
            let len = match self.s.arrays.get(name) {
                Some(Arr::Indexed(m)) => m.keys().next_back().map(|k| k + 1).unwrap_or(0),
                _ if name == "PIPESTATUS" => self.s.pipestatus.len() as i64,
                _ => 1,
            };
            n += len;
        }
        Ok(Err(n))
    }

    pub fn array_get(&mut self, name: &str, index: &Word) -> Result<Option<String>, Flow> {
        Ok(match self.array_key(name, index)? {
            Ok(key) => match self.s.arrays.get(name) {
                Some(Arr::Assoc(v)) => v.iter().find(|e| e.0 == key).map(|e| e.1.clone()),
                _ => None,
            },
            Err(n) if name == "PIPESTATUS" => self.s.pipestatus.get(n as usize).map(|s| s.to_string()),
            Err(n) => match self.s.arrays.get(name) {
                Some(Arr::Indexed(m)) => m.get(&n).cloned(),
                _ if n == 0 => self.get(name).map(str::to_string),
                _ => None,
            },
        })
    }

    pub fn array_set(&mut self, name: &str, index: &Word, val: String, append: bool) -> Result<(), Flow> {
        let key = self.array_key(name, index)?;
        if !self.s.arrays.contains_key(name) {
            // A scalar becomes element 0 of the new array.
            let first = self.s.vars.remove(name).map(|v| v.val);
            self.s.arrays.insert(name.to_string(), Arr::Indexed(first.into_iter().map(|v| (0, v)).collect()));
        }
        match (self.s.arrays.get_mut(name), key) {
            (Some(Arr::Assoc(v)), Ok(k)) => match v.iter_mut().find(|e| e.0 == k) {
                Some(e) if append => e.1.push_str(&val),
                Some(e) => e.1 = val,
                None => v.push((k, val)),
            },
            (Some(Arr::Indexed(m)), Err(n)) if n >= 0 => {
                let slot = m.entry(n).or_default();
                if append {
                    slot.push_str(&val);
                } else {
                    *slot = val;
                }
            }
            _ => self.err(&format!("sh: {name}: bad array subscript")),
        }
        Ok(())
    }

    /// `name=(…)`, `name+=(…)`, `name[i]=v`.
    fn assign_array(&mut self, a: &Assign) -> Result<(), Flow> {
        if let Some(index) = &a.index {
            let v = self.expand_one(&a.value)?;
            return self.array_set(&a.name, index, v, a.append);
        }
        let Some(words) = &a.array else { return Ok(()) };
        let assoc = matches!(self.s.arrays.get(&a.name), Some(Arr::Assoc(_)));
        let mut next: i64 = 0;
        let mut arr = match self.s.arrays.remove(&a.name) {
            Some(old) if a.append => old,
            _ if assoc => Arr::Assoc(Vec::new()),
            _ if a.append => Arr::Indexed(self.s.vars.get(&a.name).map(|v| (0, v.val.clone())).into_iter().collect()),
            _ => Arr::Indexed(Default::default()),
        };
        if let Arr::Indexed(m) = &arr {
            next = m.keys().next_back().map(|k| k + 1).unwrap_or(0);
        }
        self.s.vars.remove(&a.name);
        for w in words {
            // `[key]=value` sets that key; anything else is expanded like command words.
            let keyed = matches!(w.first(), Some(Part::Lit(s)) if s.starts_with('[')) && as_keyed(w);
            if keyed {
                let text = self.expand_one(w)?;
                if let Some((k, v)) = text[1..].split_once("]=") {
                    match &mut arr {
                        Arr::Assoc(list) => match list.iter_mut().find(|e| e.0 == k) {
                            Some(e) => e.1 = v.to_string(),
                            None => list.push((k.to_string(), v.to_string())),
                        },
                        Arr::Indexed(m) => {
                            let n = self.arith(k)?;
                            m.insert(n, v.to_string());
                            next = n + 1;
                        }
                    }
                    continue;
                }
            }
            for item in self.expand_words(std::slice::from_ref(w))? {
                match &mut arr {
                    Arr::Indexed(m) => {
                        m.insert(next, item);
                        next += 1;
                    }
                    Arr::Assoc(list) => list.push((item, String::new())),
                }
            }
        }
        self.s.arrays.insert(a.name.clone(), arr);
        Ok(())
    }

    pub fn tmp(&mut self) -> String {
        self.tmp_seq += 1;
        let dir = self.get("TMPDIR").filter(|d| d.starts_with('/')).unwrap_or("/tmp").to_string();
        format!("{}/.sh-{}-{}-{}", dir.trim_end_matches('/'), sys::getpid(), (self.start_ms as u64) % 1_000_000, self.tmp_seq)
    }

    // ---- running things ----

    /// Run a script text in this shell.
    pub fn run_source(&mut self, src: &str) -> X {
        match crate::parser::parse(src) {
            Ok(c) => self.exec(&c),
            Err(e) => {
                self.err(&format!("{}: {}", self.s.arg0, e));
                Ok(2)
            }
        }
    }

    /// Run `f` in a copy of the shell state; `exit` only leaves the copy.
    pub fn subshell(&mut self, f: impl FnOnce(&mut Interp) -> X) -> i32 {
        let saved = self.s.clone();
        let st = match f(self) {
            Ok(s) => s,
            Err(Flow::Exit(c)) | Err(Flow::Return(c)) => c,
            Err(_) => 0,
        };
        self.s = saved;
        st
    }

    pub fn exec(&mut self, c: &Cmd) -> X {
        self.check_deadline()?;
        let st = self.exec_inner(c)?;
        self.s.status = st;
        if let Cmd::Simple { .. } = c {
            self.s.pipestatus.clear();
            self.s.pipestatus.push(st);
        }
        if st != 0 && self.s.opts.errexit && self.s.cond_depth == 0 {
            if matches!(c, Cmd::Simple { .. } | Cmd::Pipeline { negate: false, .. } | Cmd::Subshell(..) | Cmd::Cond(_) | Cmd::Arith(_)) {
                return Err(Flow::Exit(st));
            }
        }
        Ok(st)
    }

    fn cond(&mut self, c: &Cmd) -> X {
        self.s.cond_depth += 1;
        let r = self.exec(c);
        self.s.cond_depth -= 1;
        r
    }

    fn with_redirs(&mut self, redirs: &[Redir], f: impl FnOnce(&mut Interp) -> X) -> X {
        if redirs.is_empty() {
            return f(self);
        }
        let mark = self.procsubs.len();
        let Some(saved) = self.apply_redirs(redirs)? else { return Ok(1) };
        let r = f(self);
        self.restore_fds(saved);
        self.end_procsubs(mark);
        r
    }

    fn exec_inner(&mut self, c: &Cmd) -> X {
        match c {
            Cmd::Simple { assigns, words, redirs } => match self.exec_simple(assigns, words, redirs, false)? {
                Done::Status(s) => Ok(s),
                Done::Spawned(ch) => Ok(self.reap(ch)),
            },
            Cmd::List(items) => {
                let mut st = 0;
                for (cmd, bg) in items {
                    if *bg {
                        self.exec_bg(cmd);
                        st = 0;
                        self.s.status = 0;
                    } else {
                        st = self.exec(cmd)?;
                    }
                }
                Ok(st)
            }
            Cmd::AndOr { first, rest } => {
                let mut st = self.cond(first)?;
                for (n, (and, cmd)) in rest.iter().enumerate() {
                    if (st == 0) == *and {
                        st = if n + 1 == rest.len() { self.exec(cmd)? } else { self.cond(cmd)? };
                    }
                }
                Ok(st)
            }
            Cmd::Pipeline { negate, cmds } => {
                let st = if cmds.len() == 1 {
                    let st = if *negate { self.cond(&cmds[0])? } else { self.exec(&cmds[0])? };
                    self.s.pipestatus.clear();
                    self.s.pipestatus.push(st);
                    st
                } else {
                    self.pipeline(cmds)
                };
                Ok(if *negate { (st == 0) as i32 } else { st })
            }
            Cmd::Group(body, redirs) => self.with_redirs(redirs, |sh| sh.exec(body)),
            Cmd::Subshell(body, redirs) => self.with_redirs(redirs, |sh| Ok(sh.subshell(|sh| sh.exec(body)))),
            Cmd::If { clauses, otherwise, redirs } => self.with_redirs(redirs, |sh| {
                for (cond, body) in clauses {
                    if sh.cond(cond)? == 0 {
                        return sh.exec(body);
                    }
                }
                match otherwise {
                    Some(body) => sh.exec(body),
                    None => Ok(0),
                }
            }),
            Cmd::While { until, cond, body, redirs } => self.with_redirs(redirs, |sh| {
                let mut st = 0;
                loop {
                    let c = sh.cond(cond)?;
                    if (c == 0) == *until {
                        break;
                    }
                    match sh.loop_body(body) {
                        Ok(Some(s)) => st = s,
                        Ok(None) => break,
                        Err(e) => return Err(e),
                    }
                }
                Ok(st)
            }),
            Cmd::For { var, words, body, redirs } => {
                let list = match words {
                    Some(w) => self.expand_words(w)?,
                    None => self.s.params.clone(),
                };
                self.with_redirs(redirs, |sh| {
                    let mut st = 0;
                    for item in list {
                        sh.set(var, item);
                        match sh.loop_body(body) {
                            Ok(Some(s)) => st = s,
                            Ok(None) => break,
                            Err(e) => return Err(e),
                        }
                    }
                    Ok(st)
                })
            }
            Cmd::ForArith { init, cond, step, body, redirs } => self.with_redirs(redirs, |sh| {
                let mut st = 0;
                sh.arith_word(init)?;
                loop {
                    if !cond.is_empty() && sh.arith_word(cond)? == 0 {
                        break;
                    }
                    match sh.loop_body(body) {
                        Ok(Some(s)) => st = s,
                        Ok(None) => break,
                        Err(e) => return Err(e),
                    }
                    sh.arith_word(step)?;
                }
                Ok(st)
            }),
            Cmd::Case { word, arms, redirs } => {
                let subject = self.expand_one(word)?;
                self.with_redirs(redirs, |sh| {
                    for (pats, body) in arms {
                        for p in pats {
                            let pat = sh.expand_pat(p)?;
                            if crate::glob::matches_str(&pat, &subject) {
                                return sh.exec(body);
                            }
                        }
                    }
                    Ok(0)
                })
            }
            Cmd::FuncDef { name, body } => {
                self.s.funcs.insert(name.clone(), body.clone());
                Ok(0)
            }
            Cmd::Cond(toks) => crate::test::cond(self, toks),
            Cmd::Arith(w) => Ok((self.arith_word(w)? == 0) as i32),
        }
    }

    /// One iteration: `Ok(Some(status))` to go on, `Ok(None)` after `break`.
    fn loop_body(&mut self, body: &Cmd) -> Result<Option<i32>, Flow> {
        self.s.loop_depth += 1;
        let r = self.exec(body);
        self.s.loop_depth -= 1;
        match r {
            Ok(s) => Ok(Some(s)),
            Err(Flow::Break(n)) if n > 1 => Err(Flow::Break(n - 1)),
            Err(Flow::Break(_)) => Ok(None),
            Err(Flow::Continue(n)) if n > 1 => Err(Flow::Continue(n - 1)),
            Err(Flow::Continue(_)) => Ok(Some(0)),
            Err(e) => Err(e),
        }
    }

    pub fn call_func(&mut self, body: Rc<Cmd>, args: &[String]) -> X {
        let saved = std::mem::replace(&mut self.s.params, args.to_vec());
        self.s.locals.push(Vec::new());
        self.s.local_arrays.push(Vec::new());
        self.s.func_depth += 1;
        let saved_loop = std::mem::replace(&mut self.s.loop_depth, 0);
        let r = self.exec(&body);
        self.s.loop_depth = saved_loop;
        self.s.func_depth -= 1;
        for (name, old) in self.s.locals.pop().unwrap_or_default().into_iter().rev() {
            match old {
                Some(v) => {
                    self.s.vars.insert(name, v);
                }
                None => {
                    self.s.vars.remove(&name);
                }
            }
        }
        for (name, old) in self.s.local_arrays.pop().unwrap_or_default().into_iter().rev() {
            match old {
                Some(a) => {
                    self.s.arrays.insert(name, a);
                }
                None => {
                    self.s.arrays.remove(&name);
                }
            }
        }
        self.s.params = saved;
        match r {
            Err(Flow::Return(c)) => Ok(c),
            other => other,
        }
    }

    fn exec_bg(&mut self, c: &Cmd) {
        if let Cmd::Simple { assigns, words, redirs } = c {
            let saved = self.s.clone();
            let r = self.exec_simple(assigns, words, redirs, true);
            self.s = saved;
            if let Ok(Done::Spawned(ch)) = r {
                self.s.last_bg = ch.pid;
                self.jobs.push(ch);
            }
        } else {
            // Nothing in the shell runs concurrently with the shell: a compound command in the background runs to its end here.
            self.subshell(|sh| sh.exec(c));
        }
    }

    fn pipeline(&mut self, cmds: &[Cmd]) -> i32 {
        let mut children: Vec<(usize, Child)> = Vec::new();
        let mut statuses = vec![0; cmds.len()];
        let mut input = self.fd(0);
        for (n, c) in cmds.iter().enumerate() {
            let last = n + 1 == cmds.len();
            let saved = self.s.clone();
            let outer_stage = (self.stage_cap.take(), self.stage_pipe.take());
            self.set_fd(0, input.clone());
            let cap: Capture = Default::default();
            if !last {
                self.set_fd(1, Io::Cap(cap.clone()));
                self.stage_cap = Some(cap.clone());
            }
            let r = match c {
                Cmd::Simple { assigns, words, redirs } => self.exec_simple(assigns, words, redirs, true),
                other => self.exec(other).map(Done::Status),
            };
            let pipe = self.stage_pipe.take();
            self.stage_cap = outer_stage.0;
            self.stage_pipe = outer_stage.1;
            self.s = saved;
            match r {
                Ok(Done::Spawned(ch)) => children.push((n, ch)),
                Ok(Done::Status(s)) => statuses[n] = s,
                Err(Flow::Exit(s)) | Err(Flow::Return(s)) => statuses[n] = s,
                Err(_) => {}
            }
            if !last {
                input = match pipe {
                    Some(r) => Io::host(r, true),
                    None => Io::input(std::mem::take(&mut *cap.borrow_mut())),
                };
            }
        }
        drop(input);
        for (n, ch) in children {
            statuses[n] = self.reap(ch);
        }
        self.s.pipestatus = statuses.clone();
        if self.s.opts.pipefail {
            statuses.iter().rev().copied().find(|s| *s != 0).unwrap_or(0)
        } else {
            *statuses.last().unwrap_or(&0)
        }
    }

    pub fn exec_simple(&mut self, assigns: &[Assign], words: &[Word], redirs: &[Redir], may_spawn: bool) -> Result<Done, Flow> {
        let mark = self.procsubs.len();
        let r = self.exec_simple_inner(assigns, words, redirs, may_spawn);
        if self.procsubs.len() > mark {
            // The files of `<(…)` are read by the command, so a child has to end first.
            let r = match r {
                Ok(Done::Spawned(ch)) => Ok(Done::Status(self.reap(ch))),
                other => other,
            };
            self.end_procsubs(mark);
            return r;
        }
        r
    }

    fn exec_simple_inner(&mut self, assigns: &[Assign], words: &[Word], redirs: &[Redir], may_spawn: bool) -> Result<Done, Flow> {
        self.cmdsub_status = 0;
        let argv = self.expand_words(words)?;
        if argv.is_empty() {
            for a in assigns {
                if a.index.is_some() || a.array.is_some() {
                    self.assign_array(a)?;
                    continue;
                }
                if self.s.arrays.contains_key(&a.name) {
                    // Assigning to an array by its name alone is element 0.
                    let v = self.expand_one(&a.value)?;
                    self.array_set(&a.name, &vec![Part::Lit("0".into())], v, a.append)?;
                    continue;
                }
                let mut v = self.expand_one(&a.value)?;
                if a.append {
                    v = format!("{}{}", self.var(&a.name), v);
                }
                if !self.set(&a.name, v) {
                    return Ok(Done::Status(1));
                }
                if a.name == "PATH" || a.name == "HOME" {
                    // commonly expected to reach children even without export when inherited as exported
                }
            }
            if !redirs.is_empty() {
                let Some(saved) = self.apply_redirs(redirs)? else { return Ok(Done::Status(1)) };
                self.restore_fds(saved);
            }
            return Ok(Done::Status(self.cmdsub_status));
        }
        let mut values = Vec::with_capacity(assigns.len());
        for a in assigns {
            if a.index.is_some() || a.array.is_some() {
                // An array in front of a command is simply assigned.
                self.assign_array(a)?;
            }
            let mut v = self.expand_one(&a.value)?;
            if a.append {
                v = format!("{}{}", self.var(&a.name), v);
            }
            values.push(v);
        }
        if self.s.opts.xtrace {
            let line = format!("+ {}", argv.join(" "));
            self.err(&line);
        }
        let saved_fds = if redirs.is_empty() {
            None
        } else {
            match self.apply_redirs(redirs)? {
                Some(s) => Some(s),
                None => return Ok(Done::Status(1)),
            }
        };
        let mut saved_vars = Vec::with_capacity(assigns.len());
        for (a, v) in assigns.iter().zip(values) {
            if a.index.is_some() || a.array.is_some() {
                continue;
            }
            saved_vars.push((a.name.clone(), self.s.vars.insert(a.name.clone(), Var { val: v, exported: true, readonly: false })));
        }
        let r = self.run_argv(&argv, may_spawn);
        for (name, old) in saved_vars.into_iter().rev() {
            match old {
                Some(v) => {
                    self.s.vars.insert(name, v);
                }
                None => {
                    self.s.vars.remove(&name);
                }
            }
        }
        if let Some(s) = saved_fds {
            self.restore_fds(s);
        }
        r
    }

    /// Run a command given as words: function, builtin, or program.
    pub fn run_argv(&mut self, argv: &[String], may_spawn: bool) -> Result<Done, Flow> {
        self.check_deadline()?;
        if let Some(f) = self.s.funcs.get(&argv[0]).cloned() {
            return self.call_func(f, &argv[1..]).map(Done::Status);
        }
        if let Some(r) = crate::builtins::run(self, argv) {
            return r.map(Done::Status);
        }
        // `/bin/ls`, `/usr/bin/env`, `/bin/bash`: the same commands by their conventional paths.
        let name = argv[0].as_str();
        if let Some(base) = name.strip_prefix("/bin/").or_else(|| name.strip_prefix("/usr/bin/")).or_else(|| name.strip_prefix("/usr/local/bin/")) {
            // A shell by its path is this shell, whatever file the machine has there; `$0` is the name as given.
            if SHELL_NAMES.contains(&base) {
                return Ok(Done::Status(crate::nested(self, argv)));
            }
            if crate::builtins::is_program(base) && sys::stat(name, true).map(|s| s.size < 64).unwrap_or(true) {
                let mut v = argv.to_vec();
                v[0] = base.to_string();
                if let Some(r) = crate::builtins::run(self, &v) {
                    return r.map(Done::Status);
                }
            }
        }
        self.run_program(argv, may_spawn)
    }

    pub fn run_status(&mut self, argv: &[String]) -> X {
        match self.run_argv(argv, false)? {
            Done::Status(s) => Ok(s),
            Done::Spawned(ch) => Ok(self.reap(ch)),
        }
    }

    pub fn run_program(&mut self, argv: &[String], may_spawn: bool) -> Result<Done, Flow> {
        match self.resolve(&argv[0], &argv[1..]) {
            Prog::Exec(exec, args) => match self.spawn_child(&exec, &args) {
                Ok(ch) if may_spawn => Ok(Done::Spawned(ch)),
                Ok(ch) => Ok(Done::Status(self.reap(ch))),
                Err(e) => {
                    self.err(&format!("sh: {}: {}", argv[0], sys::strerror(e)));
                    Ok(Done::Status(126))
                }
            },
            Prog::Script(path) => {
                let args = argv[1..].to_vec();
                let name = argv[0].clone();
                Ok(Done::Status(self.subshell(|sh| sh.run_file(&path, &name, args))))
            }
            Prog::NotFound => {
                if argv[0] == "git" {
                    // Probed by every agent; say what to use instead of leaving it at "not found".
                    self.err("git: not available in this environment (no git; use rg/find/ls/diff)");
                } else {
                    self.err(&format!("sh: {}: command not found", argv[0]));
                }
                Ok(Done::Status(127))
            }
            Prog::NotExecutable(why) => {
                self.err(&format!("sh: {}: {}", argv[0], why));
                Ok(Done::Status(126))
            }
        }
    }

    pub fn run_file(&mut self, path: &str, arg0: &str, args: Vec<String>) -> X {
        let src = match sys::read_file(path) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(e) => {
                self.err(&format!("sh: {}: {}", arg0, sys::strerror(e)));
                return Ok(127);
            }
        };
        self.s.arg0 = arg0.to_string();
        self.s.params = args;
        self.s.loop_depth = 0;
        match self.run_source(&src) {
            Err(Flow::Return(c)) => Ok(c),
            other => other,
        }
    }

    pub fn is_node(name: &str) -> bool {
        matches!(basename(name), "node" | "nodejs")
    }

    /// Find the file a command name refers to on PATH (or directly, with a slash).
    pub fn find_on_path(&self, name: &str) -> Option<String> {
        if name.contains('/') {
            let p = self.abs(name);
            return sys::stat(&p, true).ok().filter(|s| !s.is_dir()).map(|_| p);
        }
        let path = self.get("PATH").unwrap_or("/usr/local/bin:/usr/bin:/bin").to_string();
        for dir in path.split(':') {
            if dir.is_empty() {
                continue;
            }
            let p = self.abs(&format!("{dir}/{name}"));
            if sys::stat(&p, true).map(|s| !s.is_dir()).unwrap_or(false) {
                return Some(p);
            }
        }
        None
    }

    /// What running `name` means for the runtime.
    pub fn resolve(&self, name: &str, args: &[String]) -> Prog {
        let with = |first: &str| -> Vec<String> {
            let mut v = Vec::with_capacity(args.len() + 1);
            v.push(first.to_string());
            v.extend(args.iter().cloned());
            v
        };
        if Self::is_node(name) {
            return Prog::Exec("node".into(), with("node"));
        }
        let Some(path) = self.find_on_path(name) else {
            return if name.contains('/') && sys::stat(&self.abs(name), true).map(|s| s.is_dir()).unwrap_or(false) {
                Prog::NotExecutable("Is a directory".into())
            } else {
                Prog::NotFound
            };
        };
        let real = sys::realpath(&path).unwrap_or(path);
        if real.ends_with(".js") || real.ends_with(".mjs") || real.ends_with(".cjs") {
            return Prog::Exec(real, with(name));
        }
        let mut head = [0u8; 256];
        let n = match sys::open(&real, sys::O_RDONLY, 0) {
            Ok(fd) => {
                let n = sys::read(fd, &mut head).unwrap_or(0);
                sys::close(fd);
                n
            }
            Err(e) => return Prog::NotExecutable(sys::strerror(e).into()),
        };
        let head = &head[..n];
        if head.starts_with(b"#!") {
            let line = String::from_utf8_lossy(head.split(|c| *c == b'\n').next().unwrap_or(b""))[2..].trim().to_string();
            let mut words = line.split_whitespace();
            let mut interp = words.next().unwrap_or("");
            if basename(interp) == "env" {
                interp = words.find(|w| !w.starts_with('-')).unwrap_or("");
            }
            let b = basename(interp);
            if b == "node" || b == "nodejs" || b == "bun" {
                return Prog::Exec(real, with(name));
            }
            if SHELL_NAMES.contains(&b) {
                return Prog::Script(real);
            }
            return Prog::NotExecutable(format!("{interp}: bad interpreter: not available in this environment"));
        }
        if head.contains(&0) || head.starts_with(b"\x7fELF") {
            return Prog::NotExecutable("cannot execute binary file".into());
        }
        // A text file without a shebang: sh runs it as a script.
        Prog::Script(real)
    }

    /// Start a child process on the shell's current descriptors 0..2.
    pub fn spawn_child(&mut self, exec: &str, argv: &[String]) -> Result<Child, i32> {
        let mut stdio = [sys::FD_NULL; 3];
        let mut close_after: Vec<i32> = Vec::new();
        let mut child = Child { pid: 0, collects: Vec::new(), tmp_in: None };
        let mut pipe_r = None;
        for i in 0..3 {
            match self.fd(i) {
                Io::Host(h) => stdio[i] = h.0,
                Io::Null => {}
                Io::In(b) => {
                    if i == 0 {
                        let path = self.tmp();
                        let pos = b.pos.get();
                        sys::write_file(&path, &b.data[pos..], sys::O_TRUNC, 0o600)?;
                        b.pos.set(b.data.len());
                        let fd = sys::open(&path, sys::O_RDONLY, 0)?;
                        stdio[0] = fd;
                        close_after.push(fd);
                        child.tmp_in = Some(path);
                    }
                }
                Io::Cap(c) => {
                    if i == 0 {
                        continue;
                    }
                    if i == 1 && self.stage_cap.as_ref().is_some_and(|s| Rc::ptr_eq(s, &c)) {
                        // The direct command of a pipeline stage: give it a real pipe so it runs alongside the next stage.
                        let (r, w) = sys::pipe()?;
                        stdio[1] = w;
                        close_after.push(w);
                        pipe_r = Some(r);
                        continue;
                    }
                    if i == 2 {
                        if let Io::Cap(o) = self.fd(1) {
                            if Rc::ptr_eq(&o, &c) && stdio[1] >= 0 && pipe_r.is_none() {
                                stdio[2] = stdio[1];
                                continue;
                            }
                        }
                        if pipe_r.is_some() && self.stage_cap.as_ref().is_some_and(|s| Rc::ptr_eq(s, &c)) {
                            stdio[2] = stdio[1];
                            continue;
                        }
                    }
                    let path = self.tmp();
                    let fd = sys::open(&path, sys::O_WRONLY | sys::O_CREAT | sys::O_APPEND, 0o600)?;
                    stdio[i] = fd;
                    close_after.push(fd);
                    child.collects.push((path, c));
                }
            }
        }
        let env = self.env_list();
        let r = sys::spawn(&sys::Spawn { exec, argv, env: &env, cwd: &self.s.cwd, stdio });
        for fd in close_after {
            sys::close(fd);
        }
        match r {
            Ok(pid) => {
                child.pid = pid;
                if let Some(r) = pipe_r {
                    self.stage_pipe = Some(r);
                }
                Ok(child)
            }
            Err(e) => {
                if let Some(r) = pipe_r {
                    sys::close(r);
                }
                self.cleanup(&child);
                Err(e)
            }
        }
    }

    fn cleanup(&mut self, ch: &Child) {
        for (path, cap) in &ch.collects {
            if let Ok(data) = sys::read_file(path) {
                cap.borrow_mut().extend_from_slice(&data);
            }
            let _ = sys::unlink(path);
        }
        if let Some(p) = &ch.tmp_in {
            let _ = sys::unlink(p);
        }
    }

    /// Wait for a child and gather what it wrote into captures.
    pub fn reap(&mut self, ch: Child) -> i32 {
        let st = sys::wait(ch.pid);
        self.cleanup(&ch);
        st
    }

    pub fn reap_jobs(&mut self, only_captured: bool) -> i32 {
        let mut st = 0;
        let jobs = std::mem::take(&mut self.jobs);
        for ch in jobs {
            if only_captured && ch.collects.is_empty() {
                continue;
            }
            st = self.reap(ch);
        }
        st
    }

    // ---- redirections ----

    pub fn restore_fds(&mut self, saved: Vec<(usize, Io)>) {
        for (n, io) in saved.into_iter().rev() {
            self.set_fd(n, io);
        }
    }

    /// `None`: a redirection failed (already reported, nothing left changed).
    pub fn apply_redirs(&mut self, redirs: &[Redir]) -> Result<Option<Vec<(usize, Io)>>, Flow> {
        let mut saved: Vec<(usize, Io)> = Vec::new();
        for r in redirs {
            let default_fd = match r.op {
                RedirOp::In | RedirOp::DupIn | RedirOp::HereDoc | RedirOp::HereStr | RedirOp::InOut => 0,
                _ => 1,
            };
            let fd = r.fd.unwrap_or(default_fd) as usize;
            let io: Result<Io, String> = match r.op {
                RedirOp::HereDoc => {
                    let body = r.body.borrow().clone();
                    Ok(Io::input(self.expand_one(&body)?.into_bytes()))
                }
                RedirOp::HereStr => {
                    let mut s = self.expand_one(&r.target)?;
                    s.push('\n');
                    Ok(Io::input(s.into_bytes()))
                }
                _ => {
                    let target = self.expand_one(&r.target)?;
                    let mut op = r.op.clone();
                    if matches!(op, RedirOp::DupOut | RedirOp::DupIn) && target != "-" && target.parse::<usize>().is_err() {
                        // `>& file` is `&> file`.
                        op = if op == RedirOp::DupOut { RedirOp::OutErr { append: false } } else { RedirOp::In };
                    }
                    match op {
                        RedirOp::DupIn | RedirOp::DupOut => {
                            if target == "-" {
                                Ok(Io::Null)
                            } else {
                                Ok(self.fd(target.parse().unwrap_or(0)))
                            }
                        }
                        _ => {
                            let flags = match op {
                                RedirOp::In => sys::O_RDONLY,
                                RedirOp::InOut => sys::O_RDWR | sys::O_CREAT,
                                RedirOp::Append | RedirOp::OutErr { append: true } => sys::O_WRONLY | sys::O_CREAT | sys::O_APPEND,
                                _ => sys::O_WRONLY | sys::O_CREAT | sys::O_TRUNC,
                            };
                            let io = match target.as_str() {
                                "/dev/null" => Ok(Io::Null),
                                "/dev/stdin" => Ok(self.fd(0)),
                                "/dev/stdout" => Ok(self.fd(1)),
                                "/dev/stderr" => Ok(self.fd(2)),
                                "" => Err(": No such file or directory".to_string()),
                                t => {
                                    let path = self.abs(t);
                                    match sys::open(&path, flags, 0o644) {
                                        Ok(h) => Ok(Io::host(h, true)),
                                        Err(e) => Err(format!("{}: {}", t, sys::strerror(e))),
                                    }
                                }
                            };
                            if let (Ok(io), RedirOp::OutErr { .. }) = (&io, &op) {
                                saved.push((1, self.set_fd(1, io.clone())));
                                saved.push((2, self.set_fd(2, io.clone())));
                                continue;
                            }
                            io
                        }
                    }
                }
            };
            match io {
                Ok(io) => saved.push((fd, self.set_fd(fd, io))),
                Err(msg) => {
                    self.restore_fds(saved);
                    self.err(&format!("sh: {msg}"));
                    return Ok(None);
                }
            }
        }
        Ok(Some(saved))
    }
}

/// Is this array element word of the form `[key]=value`?
fn as_keyed(w: &Word) -> bool {
    w.iter().any(|p| matches!(p, Part::Lit(s) if s.contains("]=")))
}
