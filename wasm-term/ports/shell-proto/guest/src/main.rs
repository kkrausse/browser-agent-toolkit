//! Test program for the shell prototype. It is to the prototype what codex is to
//! the design: a `wasm32-wasip1` program on wasm-term's host that reads and
//! writes files through WASI (std::fs) and runs shell commands through the
//! process descriptor of `../host/proc.ts`, waiting on it with `poll_oneoff`
//! exactly as tokio's reactor would.
//!
//! Prints what it sees, then one line `RESULT {json}` for the page.

use std::fs::{self, File};
use std::io::Read;
use std::os::fd::{AsRawFd, RawFd};
use std::time::{Duration, Instant};
use wasm_term_sys::net::HttpRequest;
use wasm_term_sys::poll::{poll, PollFd};

const WORK: &str = "/home/user/work";

enum Event {
    Out(u8, Vec<u8>),
    Exit(String),
}

struct Child {
    body: File,
    buf: Vec<u8>,
    spawned: Instant,
}

fn put(b: &mut Vec<u8>, s: &str) {
    b.extend_from_slice(&(s.len() as u32).to_le_bytes());
    b.extend_from_slice(s.as_bytes());
}

impl Child {
    /// What codex's exec does for `exec_command`: argv = [shell, "-lc", command], a cwd, an environment, no stdin.
    fn spawn(mode: &str, argv: &[&str], cwd: &str, timeout_ms: u32) -> Child {
        let env = ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/user", "TERM=dumb", "NO_COLOR=1", "LANG=C.UTF-8", "PAGER=cat"];
        let mut b = Vec::new();
        b.extend_from_slice(&(argv.len() as u32).to_le_bytes());
        b.extend_from_slice(&(env.len() as u32).to_le_bytes());
        put(&mut b, cwd);
        argv.iter().for_each(|a| put(&mut b, a));
        env.iter().for_each(|e| put(&mut b, e));
        let spawned = Instant::now();
        let request = HttpRequest::send("SPAWN", &format!("proc:spawn?mode={mode}&timeout={timeout_ms}"), &[], &b).expect("spawn");
        let response = request.response().expect("spawn head");
        Child { body: response.body, buf: Vec::new(), spawned }
    }

    fn fd(&self) -> RawFd {
        self.body.as_raw_fd()
    }

    fn parse(&mut self) -> Option<Event> {
        if self.buf.len() < 5 {
            return None;
        }
        let len = u32::from_le_bytes(self.buf[1..5].try_into().unwrap()) as usize;
        if self.buf.len() < 5 + len {
            return None;
        }
        let kind = self.buf[0];
        let payload = self.buf[5..5 + len].to_vec();
        self.buf.drain(..5 + len);
        Some(if kind == 3 { Event::Exit(String::from_utf8_lossy(&payload).into_owned()) } else { Event::Out(kind, payload) })
    }

    /// The next event, or None when `timeout` passes first (or the stream ended).
    fn next(&mut self, timeout: Option<Duration>) -> Option<Event> {
        loop {
            if let Some(event) = self.parse() {
                return Some(event);
            }
            let mut fds = [PollFd::new(self.fd())];
            if poll(&mut fds, timeout).expect("poll") == 0 {
                return None;
            }
            let mut chunk = [0u8; 65536];
            match self.body.read(&mut chunk) {
                Ok(0) | Err(_) => return None,
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
            }
        }
    }

    fn kill(&self, signal: u32) {
        let request = HttpRequest::send("KILL", &format!("proc:kill?fd={}&sig={signal}", self.fd()), &[], &[]).expect("kill");
        drop(request);
    }
}

#[derive(Default, Debug)]
struct Output {
    stdout: String,
    stderr: String,
    status: i32,
    signal: i32,
    /// ms from spawn to each output event.
    arrivals: Vec<f64>,
    total_ms: f64,
    queue_us: f64,
    run_us: f64,
    calls: f64,
    exited: bool,
}

fn field(info: &str, name: &str) -> f64 {
    info.split(' ').find_map(|kv| kv.strip_prefix(name).and_then(|v| v.strip_prefix('='))).and_then(|v| v.parse().ok()).unwrap_or(-1.0)
}

fn collect(child: &mut Child, kill_after: Option<(Duration, u32)>) -> Output {
    let mut out = Output::default();
    let mut killed = false;
    loop {
        let timeout = match kill_after {
            Some((after, _)) if !killed => Some(after.saturating_sub(child.spawned.elapsed())),
            _ => Some(Duration::from_secs(20)),
        };
        match child.next(timeout) {
            Some(Event::Out(kind, bytes)) => {
                out.arrivals.push(child.spawned.elapsed().as_secs_f64() * 1000.0);
                let text = String::from_utf8_lossy(&bytes);
                if kind == 1 { out.stdout.push_str(&text) } else { out.stderr.push_str(&text) }
            }
            Some(Event::Exit(info)) => {
                out.total_ms = child.spawned.elapsed().as_secs_f64() * 1000.0;
                out.status = field(&info, "status") as i32;
                out.signal = field(&info, "signal") as i32;
                out.queue_us = field(&info, "queue_us");
                out.run_us = field(&info, "run_us");
                out.calls = field(&info, "calls");
                out.exited = true;
                return out;
            }
            None => match kill_after {
                Some((_, signal)) if !killed => {
                    killed = true;
                    child.kill(signal);
                }
                _ => {
                    out.total_ms = child.spawned.elapsed().as_secs_f64() * 1000.0;
                    return out; // gave up
                }
            },
        }
    }
}

fn sh(mode: &str, command: &str) -> Output {
    let mut child = Child::spawn(mode, &["/bin/bash", "-lc", command], WORK, 0);
    collect(&mut child, None)
}

fn esc(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

/// min, median, p90, max
fn stats(v: &mut [f64]) -> String {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
    format!("{{\"n\":{},\"min\":{:.3},\"median\":{:.3},\"p90\":{:.3},\"max\":{:.3}}}", v.len(), v[0], at(0.5), at(0.9), v[v.len() - 1])
}

struct Report {
    checks: Vec<(String, bool, String)>,
    numbers: Vec<(String, String)>,
}
impl Report {
    fn check(&mut self, name: &str, ok: bool, detail: String) {
        println!("{} {name}{}", if ok { "ok  " } else { "FAIL" }, if ok && detail.len() > 90 { String::new() } else { format!("  [{}]", detail.replace('\n', "\\n")) });
        self.checks.push((name.to_string(), ok, detail));
    }
    fn number(&mut self, name: &str, json: String) {
        println!("     {name}: {json}");
        self.numbers.push((name.to_string(), json));
    }
}

fn run_mode(mode: &str, r: &mut Report, bench: bool) {
    let p = |name: &str| format!("{mode}: {name}");
    let _ = fs::remove_dir_all(WORK);
    fs::create_dir_all(WORK).unwrap();

    // The command of the brief, and files crossing both ways.
    fs::write(format!("{WORK}/from-rust.txt"), "written by the rust program\n").unwrap();
    let o = sh(mode, "echo hi > f.txt && cat f.txt | wc -c && ls");
    r.check(&p("bash -lc 'echo hi > f.txt && cat f.txt | wc -c && ls'"), o.status == 0 && o.stdout == "3\nf.txt\nfrom-rust.txt\n", format!("status {} stdout {:?} stderr {:?}", o.status, o.stdout, o.stderr));
    let seen = fs::read_to_string(format!("{WORK}/f.txt")).unwrap_or_default();
    r.check(&p("file written by the shell is read by the rust program (std::fs)"), seen == "hi\n", format!("{seen:?}"));
    let o = sh(mode, "cat from-rust.txt");
    r.check(&p("file written by the rust program is read by the shell"), o.stdout == "written by the rust program\n", format!("{:?}", o.stdout));
    let o = sh(mode, "mkdir -p a/b && mv f.txt a/b/g.txt && rm from-rust.txt && ln -s a/b/g.txt link && echo more >> a/b/g.txt");
    let moved = fs::read_to_string(format!("{WORK}/a/b/g.txt")).unwrap_or_default();
    let through_link = fs::read_to_string(format!("{WORK}/link")).unwrap_or_default();
    r.check(&p("mkdir/mv/rm/ln -s/append by the shell, seen through WASI"), o.status == 0 && moved == "hi\nmore\n" && through_link == moved && !fs::exists(format!("{WORK}/from-rust.txt")).unwrap_or(true), format!("status {} {moved:?} {through_link:?} {:?}", o.status, o.stderr));

    // stdout and stderr apart, exit status.
    let o = sh(mode, "echo out; echo err >&2; exit 7");
    r.check(&p("stdout, stderr and exit status kept apart"), o.status == 7 && o.stdout == "out\n" && o.stderr == "err\n", format!("{} {:?} {:?}", o.status, o.stdout, o.stderr));
    let o = sh(mode, "cat /nope/missing.txt; echo \"status $?\"");
    r.check(&p("a failing command"), o.stdout == "status 1\n" && o.stderr.contains("No such file or directory"), format!("{:?} {:?}", o.stdout, o.stderr));
    let o = sh(mode, "nosuchprogram --flag; echo $?");
    r.check(&p("unknown program is 127"), o.stdout == "127\n" && o.stderr.contains("command not found"), format!("{:?} {:?}", o.stdout, o.stderr));
    let o = sh(mode, "for f in a/b/*.txt; do n=$(wc -l < \"$f\"); echo \"$f:$n\"; done | sort; find . -type f | sort | head -3; grep -rn more . | sed 's/more/MORE/'");
    r.check(&p("loop, $(...), glob, pipeline, find, grep -rn, sed"), o.status == 0 && o.stdout == "a/b/g.txt:2\n./a/b/g.txt\n./a/b/g.txt:2:MORE\n", format!("{} {:?} {:?}", o.status, o.stdout, o.stderr));
    let o = sh(mode, "cat > notes.md <<'EOF'\n# title\nbody $HOME\nEOF\nsed -i 's/title/Title/' notes.md && head -1 notes.md && /bin/bash -lc 'echo nested $((6*7))'");
    r.check(&p("here-doc, sed -i, nested /bin/bash -lc"), o.stdout == "# Title\nnested 42\n", format!("{} {:?} {:?}", o.status, o.stdout, o.stderr));

    // Output as it is produced.
    let o = sh(mode, "for i in 1 2 3; do echo tick $i; sleep 0.2; done");
    let gaps: Vec<f64> = o.arrivals.windows(2).map(|w| w[1] - w[0]).collect();
    let incremental = o.arrivals.len() == 3 && gaps.iter().all(|g| *g > 120.0);
    r.number(&p("arrival of 3 lines printed 200 ms apart (ms after spawn)"), format!("[{}]", o.arrivals.iter().map(|a| format!("{a:.1}")).collect::<Vec<_>>().join(",")));
    if mode == "worker" {
        r.check(&p("output arrives while the command is still running"), incremental && o.stdout == "tick 1\ntick 2\ntick 3\n", format!("{:?}", o.arrivals));
    } else {
        r.check(&p("output arrives only when the command has ended (expected for inline)"), !incremental && o.stdout == "tick 1\ntick 2\ntick 3\n", format!("{:?}", o.arrivals));
    }

    if mode == "worker" {
        // The guest is not blocked while a child runs: three at once, one poll_oneoff over all descriptors.
        let started = Instant::now();
        let mut children: Vec<Child> = (1..=3).map(|i| Child::spawn(mode, &["bash", "-lc", &format!("sleep 0.3; echo child {i}")], WORK, 0)).collect();
        let mut done = vec![String::new(); 3];
        let mut open = 3;
        let mut wakeups = 0;
        while open > 0 {
            // A finished child's descriptor stays readable (end of file), so only the running ones are polled.
            let running: Vec<usize> = (0..3).filter(|i| !done[*i].ends_with('!')).collect();
            let mut fds: Vec<PollFd> = running.iter().map(|i| PollFd::new(children[*i].fd())).collect();
            poll(&mut fds, Some(Duration::from_secs(5))).expect("poll");
            wakeups += 1;
            for (slot, i) in running.into_iter().enumerate() {
                let child = &mut children[i];
                if !fds[slot].readable {
                    continue;
                }
                match child.next(Some(Duration::ZERO)) {
                    Some(Event::Out(_, b)) => done[i].push_str(&String::from_utf8_lossy(&b)),
                    Some(Event::Exit(_)) => {
                        done[i].push('!');
                        open -= 1;
                    }
                    None => {}
                }
            }
            if wakeups > 1000 {
                break;
            }
        }
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        r.check(&p("three children at once under one poll_oneoff"), done == ["child 1\n!", "child 2\n!", "child 3\n!"] && ms < 600.0, format!("{done:?} in {ms:.0} ms, {wakeups} wakeups"));
        r.number(&p("three 300 ms children at once, wall ms"), format!("{ms:.1}"));

        // Timeout as codex does it: the guest decides, the host kills.
        let mut child = Child::spawn(mode, &["bash", "-lc", "echo started; sleep 30; echo never"], WORK, 0);
        let o = collect(&mut child, Some((Duration::from_millis(300), 15)));
        r.check(&p("kill of a sleeping command (SIGTERM after 300 ms)"), o.exited && o.status == 143 && o.stdout == "started\n" && o.total_ms < 600.0, format!("status {} after {:.0} ms, stdout {:?}", o.status, o.total_ms, o.stdout));
        r.number(&p("kill of `sleep 30`: ms from kill to exit event"), format!("{:.1}", o.total_ms - 300.0));

        // A command that never makes a host call can only be stopped by ending its Worker.
        let mut child = Child::spawn(mode, &["bash", "-lc", "echo spinning; while :; do :; done"], WORK, 0);
        let o = collect(&mut child, Some((Duration::from_millis(300), 15)));
        r.check(&p("kill of a busy loop (Worker replaced)"), o.exited && o.status == 137 && o.stdout == "spinning\n", format!("status {} after {:.0} ms, stdout {:?}", o.status, o.total_ms, o.stdout));
        r.number(&p("kill of `while :; do :; done`: ms from kill to exit event"), format!("{:.1}", o.total_ms - 300.0));
        let o = sh(mode, "echo alive");
        r.check(&p("the next command after a replaced Worker"), o.status == 0 && o.stdout == "alive\n", format!("{} {:?} in {:.1} ms (queued {:.1} ms)", o.status, o.stdout, o.total_ms, o.queue_us / 1000.0));
        r.number(&p("first command on the replacement Worker, total ms"), format!("{:.1}", o.total_ms));

        // Closing the descriptor of a running child ends it; the slot is free again.
        for _ in 0..6 {
            drop(Child::spawn(mode, &["bash", "-lc", "sleep 30"], WORK, 0));
        }
        std::thread::sleep(Duration::from_millis(100));
        let o = sh(mode, "echo after-drops");
        r.check(&p("dropping running children frees their Workers"), o.stdout == "after-drops\n" && o.total_ms < 400.0, format!("{:?} in {:.1} ms", o.stdout, o.total_ms));

        // Back-pressure: a child that prints 8 MiB while the guest reads slowly must not pile up in memory.
        let mut child = Child::spawn(mode, &["bash", "-lc", "seq 1 1200000"], WORK, 0);
        std::thread::sleep(Duration::from_millis(200));
        let o = collect(&mut child, None);
        r.check(&p("8 MiB of output, reader starts late"), o.status == 0 && o.stdout.len() == 8488896 && o.stdout.ends_with("1200000\n"), format!("status {} bytes {}", o.status, o.stdout.len()));
        r.number(&p("8 MiB of output: total ms / frames"), format!("[{:.0},{}]", o.total_ms, o.arrivals.len()));
    } else {
        let mut child = Child::spawn(mode, &["bash", "-lc", "echo started; sleep 30; echo never"], WORK, 300);
        let o = collect(&mut child, None);
        r.check(&p("timeout enforced by the host (300 ms) on a sleeping command"), o.exited && o.status == 124 && o.stdout == "started\n" && o.total_ms < 400.0, format!("status {} after {:.0} ms", o.status, o.total_ms));
    }

    if !bench {
        return;
    }
    // ---- numbers ----
    let time = |r: &mut Report, name: &str, command: &str, n: usize| {
        let mut total = Vec::new();
        let mut queue = Vec::new();
        let mut first = Vec::new();
        let mut calls = 0.0;
        for _ in 0..n {
            let o = sh(mode, command);
            total.push(o.total_ms);
            queue.push(o.queue_us / 1000.0);
            if let Some(a) = o.arrivals.first() {
                first.push(*a);
            }
            calls = o.calls;
        }
        r.number(&p(&format!("{name}: spawn to exit event, ms")), stats(&mut total));
        if mode == "worker" {
            r.number(&p(&format!("{name}: spawn to shell running, ms")), stats(&mut queue));
        }
        if !first.is_empty() {
            r.number(&p(&format!("{name}: spawn to first output, ms")), stats(&mut first));
        }
        r.number(&p(&format!("{name}: host calls per run")), format!("{calls}"));
    };
    time(r, "`echo hi`", "echo hi", 300);
    time(r, "`echo hi > f.txt && cat f.txt | wc -c && ls`", "echo hi > f.txt && cat f.txt | wc -c && ls", 200);
    time(r, "`sed -n 2,4p notes.md; wc -l notes.md`", "sed -n '2,4p' notes.md; wc -l notes.md", 200);

    // A tree the size of a small project, made through WASI, searched by the shell.
    for d in 0..40 {
        fs::create_dir_all(format!("{WORK}/tree/d{d}")).unwrap();
        for f in 0..50 {
            let mut text = String::new();
            for line in 0..60 {
                text.push_str(&format!("fn item_{d}_{f}_{line}() {{ let value = {line}; }}\n"));
            }
            if f % 10 == 0 {
                text.push_str("// NEEDLE here\n");
            }
            fs::write(format!("{WORK}/tree/d{d}/f{f}.rs"), text).unwrap();
        }
    }
    let o = sh(mode, "find tree -type f | wc -l; grep -rn NEEDLE tree | wc -l");
    r.check(&p("2,000 files (6.5 MB) made through WASI, found and searched by the shell"), o.stdout == "2000\n200\n", format!("{:?} {:?}", o.stdout, o.stderr));
    time(r, "`find tree -type f | wc -l` over 2,000 files", "find tree -type f | wc -l", 10);
    time(r, "`grep -rn NEEDLE tree | wc -l` over 2,000 files, 6.5 MB", "grep -rn NEEDLE tree | wc -l", 10);
    time(r, "`cat tree/d1/*.rs | wc -c` (50 files)", "cat tree/d1/*.rs | wc -c", 50);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bench = !args.iter().any(|a| a == "quick");
    let modes: Vec<&str> = if args.iter().any(|a| a == "worker-only") { vec!["worker"] } else { vec!["inline", "worker"] };
    let mut r = Report { checks: Vec::new(), numbers: Vec::new() };

    // The very first command, before anything is warm (with ?warm=0 this includes starting a Worker).
    let first = if args.iter().any(|a| a == "cold") {
        fs::create_dir_all(WORK).unwrap();
        let o = sh("worker", "echo first");
        r.check("worker: the very first command", o.stdout == "first\n", format!("{:?} {:?}", o.stdout, o.stderr));
        r.number("worker: very first command, total ms / of which waiting for the shell Worker", format!("[{:.1},{:.1}]", o.total_ms, o.queue_us / 1000.0));
        true
    } else {
        false
    };
    if !first {
        std::thread::sleep(Duration::from_millis(400)); // let the warm shell Workers come up
    }
    for mode in modes {
        println!("== {mode} ==");
        run_mode(mode, &mut r, bench);
    }

    let failed = r.checks.iter().filter(|c| !c.1).count();
    let checks: Vec<String> = r.checks.iter().map(|(n, ok, d)| format!("{{\"name\":\"{}\",\"ok\":{ok},\"detail\":\"{}\"}}", esc(n), esc(&d.chars().take(300).collect::<String>()))).collect();
    let numbers: Vec<String> = r.numbers.iter().map(|(n, j)| format!("\"{}\":{j}", esc(n))).collect();
    println!("RESULT {{\"failed\":{failed},\"checks\":[{}],\"numbers\":{{{}}}}}", checks.join(","), numbers.join(","));
    std::process::exit(if failed == 0 { 0 } else { 1 });
}
