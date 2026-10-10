//! Package-manager front ends, as far as they can exist without a package
//! manager: `npm run <script>` (and `yarn`/`pnpm`/`bun run`), `npx`/`bunx` for
//! what is already in `node_modules/.bin`, and `bun <file>` as `node <file>`.
use crate::interp::{Interp, Var, X};
use crate::sys;

enum J {
    Obj(Vec<(String, J)>),
    Str(String),
    Other,
}

struct Jp<'a> {
    s: &'a [u8],
    i: usize,
}
impl Jp<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn string(&mut self) -> Option<String> {
        self.i += 1;
        let mut out: Vec<u8> = Vec::new();
        while self.i < self.s.len() {
            let c = self.s[self.i];
            self.i += 1;
            match c {
                b'"' => return Some(String::from_utf8_lossy(&out).into_owned()),
                b'\\' => {
                    let n = *self.s.get(self.i)?;
                    self.i += 1;
                    match n {
                        b'n' => out.push(b'\n'),
                        b't' => out.push(b'\t'),
                        b'r' => out.push(b'\r'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'u' => {
                            let hex = std::str::from_utf8(self.s.get(self.i..self.i + 4)?).ok()?;
                            self.i += 4;
                            let ch = char::from_u32(u32::from_str_radix(hex, 16).ok()?).unwrap_or('?');
                            let mut b = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut b).as_bytes());
                        }
                        other => out.push(other),
                    }
                }
                c => out.push(c),
            }
        }
        None
    }
    fn value(&mut self) -> Option<J> {
        self.ws();
        match *self.s.get(self.i)? {
            b'"' => self.string().map(J::Str),
            b'{' => {
                self.i += 1;
                let mut items = Vec::new();
                loop {
                    self.ws();
                    match *self.s.get(self.i)? {
                        b'}' => {
                            self.i += 1;
                            return Some(J::Obj(items));
                        }
                        b',' => self.i += 1,
                        b'"' => {
                            let k = self.string()?;
                            self.ws();
                            if *self.s.get(self.i)? != b':' {
                                return None;
                            }
                            self.i += 1;
                            items.push((k, self.value()?));
                        }
                        _ => return None,
                    }
                }
            }
            b'[' => {
                self.i += 1;
                loop {
                    self.ws();
                    match *self.s.get(self.i)? {
                        b']' => {
                            self.i += 1;
                            return Some(J::Other);
                        }
                        b',' => self.i += 1,
                        _ => {
                            self.value()?;
                        }
                    }
                }
            }
            _ => {
                while self.i < self.s.len() && !matches!(self.s[self.i], b',' | b'}' | b']') && !self.s[self.i].is_ascii_whitespace() {
                    self.i += 1;
                }
                Some(J::Other)
            }
        }
    }
}

struct Package {
    dir: String,
    name: String,
    scripts: Vec<(String, String)>,
}

fn package(sh: &Interp) -> Option<Package> {
    let mut dir = sh.s.cwd.clone();
    loop {
        if let Ok(data) = sys::read_file(&format!("{}/package.json", dir.trim_end_matches('/'))) {
            let mut p = Package { dir: dir.clone(), name: String::new(), scripts: Vec::new() };
            if let Some(J::Obj(items)) = (Jp { s: &data, i: 0 }).value() {
                for (k, v) in items {
                    match (k.as_str(), v) {
                        ("name", J::Str(s)) => p.name = s,
                        ("scripts", J::Obj(list)) => {
                            for (name, v) in list {
                                if let J::Str(cmd) = v {
                                    p.scripts.push((name, cmd));
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            return Some(p);
        }
        if dir == "/" || dir.is_empty() {
            return None;
        }
        dir = crate::interp::dirname(&dir).to_string();
    }
}

/// `node_modules/.bin` of `dir` and of every directory above it, then the current PATH.
fn bin_path(sh: &Interp, dir: &str) -> String {
    let mut parts = Vec::new();
    let mut d = dir.to_string();
    loop {
        parts.push(format!("{}/node_modules/.bin", d.trim_end_matches('/')));
        if d == "/" || d.is_empty() {
            break;
        }
        d = crate::interp::dirname(&d).to_string();
    }
    parts.push(sh.var("PATH"));
    parts.join(":")
}

fn quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_-./=:@%+,".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

fn export(sh: &mut Interp, k: &str, v: String) {
    sh.s.vars.insert(k.to_string(), Var { val: v, exported: true, readonly: false });
}

fn run_script(sh: &mut Interp, tool: &str, name: &str, extra: &[String]) -> X {
    let Some(pkg) = package(sh) else {
        sh.err(&format!("{tool}: no package.json found in {} or above", sh.s.cwd));
        return Ok(1);
    };
    let Some(cmd) = pkg.scripts.iter().find(|s| s.0 == name).map(|s| s.1.clone()) else {
        sh.err(&format!("{tool}: Missing script: \"{name}\""));
        return Ok(1);
    };
    let mut line = cmd.clone();
    for a in extra {
        line.push(' ');
        line.push_str(&quote(a));
    }
    if tool == "npm" {
        sh.outs(&format!("\n> {} {}\n> {}\n\n", pkg.name, name, line));
    } else {
        sh.err(&format!("$ {line}"));
    }
    let path = bin_path(sh, &pkg.dir);
    Ok(sh.subshell(|sh| {
        sh.s.cwd = pkg.dir.clone();
        export(sh, "PWD", pkg.dir.clone());
        export(sh, "PATH", path);
        export(sh, "npm_lifecycle_event", name.to_string());
        export(sh, "npm_package_name", pkg.name.clone());
        export(sh, "INIT_CWD", pkg.dir.clone());
        sh.s.arg0 = "sh".into();
        sh.s.params.clear();
        sh.run_source(&line)
    }))
}

fn npx(sh: &mut Interp, tool: &str, args: &[String]) -> X {
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        match args[i].as_str() {
            "-p" | "--package" | "-c" | "--call" => i += 1,
            "--" => {
                i += 1;
                break;
            }
            _ => {}
        }
        i += 1;
    }
    let Some(cmd) = args.get(i).cloned() else {
        sh.err(&format!("{tool}: a command is required"));
        return Ok(1);
    };
    let rest: Vec<String> = args[i..].to_vec();
    let path = bin_path(sh, &sh.s.cwd.clone());
    Ok(sh.subshell(|sh| {
        export(sh, "PATH", path);
        if crate::builtins::locate(sh, &cmd).is_none() {
            sh.err(&format!("{tool}: {cmd}: not installed in this project, and packages cannot be downloaded in this environment"));
            return Ok(127);
        }
        sh.run_status(&rest)
    }))
}

fn unavailable(sh: &mut Interp, tool: &str, sub: &str) -> X {
    sh.err(&format!("{tool}: '{sub}' is not available in this environment (no package manager; dependencies are fixed when the project is prepared)"));
    Ok(1)
}

pub fn run(sh: &mut Interp, a: &[String]) -> X {
    let tool = a[0].as_str();
    if tool == "npx" || tool == "bunx" {
        return npx(sh, tool, &a[1..]);
    }
    // Leading flags of the tool itself.
    let mut i = 1;
    while i < a.len() && a[i].starts_with('-') && !matches!(a[i].as_str(), "-v" | "--version" | "-e" | "--eval" | "-p" | "--print") {
        if matches!(a[i].as_str(), "--cwd" | "--prefix" | "-C" | "--filter") {
            i += 1;
        }
        i += 1;
    }
    let sub = a.get(i).map(String::as_str).unwrap_or("");
    let rest: Vec<String> = a.get(i + 1..).map(|r| r.to_vec()).unwrap_or_default();
    let script_args = |rest: &[String]| -> Vec<String> {
        // npm passes only what follows `--`; the others pass everything.
        match rest.iter().position(|x| x == "--") {
            Some(p) => rest[p + 1..].to_vec(),
            None if tool == "npm" => Vec::new(),
            None => rest.to_vec(),
        }
    };
    let node = |sh: &mut Interp, args: &[String]| -> X {
        let mut argv = vec!["node".to_string()];
        argv.extend(args.iter().cloned());
        sh.run_status(&argv)
    };
    match sub {
        "-v" | "--version" => {
            sh.outs(match tool {
                "npm" => "10.9.0\n",
                "bun" => "1.2.0\n",
                "yarn" => "1.22.22\n",
                _ => "9.0.0\n",
            });
            Ok(0)
        }
        "run" | "run-script" => {
            let Some(name) = rest.first() else {
                let scripts = package(sh).map(|p| p.scripts).unwrap_or_default();
                let text: String = scripts.iter().map(|(k, v)| format!("  {k}\n    {v}\n")).collect();
                sh.outs(&text);
                return Ok(0);
            };
            let is_script = package(sh).is_some_and(|p| p.scripts.iter().any(|s| &s.0 == name));
            if tool == "bun" && !is_script && sys::stat(&sh.abs(name), true).map(|s| s.is_file()).unwrap_or(false) {
                return node(sh, &rest);
            }
            run_script(sh, tool, name, &script_args(&rest[1..]))
        }
        "test" | "t" | "start" | "build" | "dev" | "lint" | "typecheck" | "format" | "check" if tool != "bun" || sub != "build" && sub != "test" => {
            let name = if sub == "t" { "test" } else { sub };
            if tool == "npm" && !matches!(name, "test" | "start") {
                return unavailable(sh, tool, sub);
            }
            run_script(sh, tool, name, &script_args(&rest))
        }
        "exec" | "x" | "dlx" => npx(sh, tool, &rest),
        "-e" | "--eval" | "-p" | "--print" if tool == "bun" => node(sh, &a[i..]),
        "" => {
            if tool == "yarn" {
                return unavailable(sh, tool, "install");
            }
            sh.err(&format!("{tool}: a command is required (run, test, start, exec)"));
            Ok(1)
        }
        other => {
            if tool == "bun" && sys::stat(&sh.abs(other), true).map(|s| s.is_file()).unwrap_or(false) {
                return node(sh, &a[i..]);
            }
            if tool != "npm" && package(sh).is_some_and(|p| p.scripts.iter().any(|s| s.0 == other)) {
                return run_script(sh, tool, other, &script_args(&rest));
            }
            unavailable(sh, tool, other)
        }
    }
}
