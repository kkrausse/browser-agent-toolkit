//! Checks and timings for child processes (`wasm_term.proc_*`, docs/abi.md 3.4):
//! a program that writes files with std::fs, runs shell commands as children
//! and waits on them with `poll_oneoff`, exactly as tokio's reactor does.
//!
//!   ?guest=proc&shell=worker            every check, then timings
//!   &arg=quick                          the checks only
//!   ?guest=proc&shell=inline&arg=inline the checks that hold when the shell runs inside proc_spawn
//!
//! Prints one line per check and a last line `RESULT {json}`; the same JSON is
//! written to `/home/user/proc-result.json`.

use std::fs;
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};
use wasm_term_sys::poll::{poll, PollFd};
use wasm_term_sys::process::{Child, ChildEvent, SIGTERM};

const WORK: &str = "/home/user/work";
const ENV: [&str; 6] = ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/user", "TERM=dumb", "NO_COLOR=1", "LANG=C.UTF-8", "PAGER=cat"];

#[derive(Default, Debug)]
struct Output {
    stdout: String,
    stderr: String,
    status: i32,
    signal: i32,
    /// ms from spawn to each output event.
    arrivals: Vec<f64>,
    total_ms: f64,
    queue_ms: f64,
    run_ms: f64,
    calls: u32,
    exited: bool,
}

fn spawn(command: &str, stdin: bool) -> (Child, Instant) {
    let started = Instant::now();
    (Child::spawn(&["/bin/bash", "-lc", command], WORK, &ENV, stdin).expect("proc_spawn"), started)
}

/// The next event, or None when `timeout` passes first.
fn next(child: &mut Child, timeout: Duration) -> Option<ChildEvent> {
    if let Some(event) = child.try_recv().expect("proc_recv") {
        return Some(event);
    }
    let mut fds = [PollFd::new(child.as_raw_fd())];
    if poll(&mut fds, Some(timeout)).expect("poll") == 0 {
        return None;
    }
    child.try_recv().expect("proc_recv")
}

fn collect(child: &mut Child, spawned: Instant, kill_after: Option<(Duration, u32)>, mut each: impl FnMut(&Child, &Output)) -> Output {
    let mut out = Output::default();
    let mut killed = false;
    loop {
        let timeout = match kill_after {
            Some((after, _)) if !killed => after.saturating_sub(spawned.elapsed()),
            _ => Duration::from_secs(20),
        };
        match next(child, timeout) {
            Some(ChildEvent::Stdout(bytes)) => {
                out.arrivals.push(spawned.elapsed().as_secs_f64() * 1000.0);
                out.stdout.push_str(&String::from_utf8_lossy(&bytes));
                each(child, &out);
            }
            Some(ChildEvent::Stderr(bytes)) => {
                out.arrivals.push(spawned.elapsed().as_secs_f64() * 1000.0);
                out.stderr.push_str(&String::from_utf8_lossy(&bytes));
            }
            Some(ChildEvent::Exit { status, signal, usage }) => {
                out.total_ms = spawned.elapsed().as_secs_f64() * 1000.0;
                out.status = status;
                out.signal = signal;
                out.queue_ms = usage.queued.as_secs_f64() * 1000.0;
                out.run_ms = usage.ran.as_secs_f64() * 1000.0;
                out.calls = usage.host_calls;
                out.exited = true;
                return out;
            }
            None => match kill_after {
                Some((_, signal)) if !killed => {
                    killed = true;
                    child.signal(signal).expect("proc_signal");
                }
                _ => {
                    out.total_ms = spawned.elapsed().as_secs_f64() * 1000.0;
                    return out; // gave up
                }
            },
        }
    }
}

fn sh(command: &str) -> Output {
    let (mut child, spawned) = spawn(command, false);
    collect(&mut child, spawned, None, |_, _| {})
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

fn checks(r: &mut Report, inline: bool) {
    let _ = fs::remove_dir_all(WORK);
    fs::create_dir_all(WORK).unwrap();

    // Files crossing both ways: one filesystem.
    fs::write(format!("{WORK}/from-rust.txt"), "written by the rust program\n").unwrap();
    let o = sh("echo hi > f.txt && cat f.txt | wc -c && ls");
    r.check("bash -lc 'echo hi > f.txt && cat f.txt | wc -c && ls'", o.status == 0 && o.stdout == "3\nf.txt\nfrom-rust.txt\n", format!("status {} stdout {:?} stderr {:?}", o.status, o.stdout, o.stderr));
    let seen = fs::read_to_string(format!("{WORK}/f.txt")).unwrap_or_default();
    r.check("file written by the shell is read by the rust program (std::fs)", seen == "hi\n", format!("{seen:?}"));
    let o = sh("cat from-rust.txt");
    r.check("file written by the rust program is read by the shell", o.stdout == "written by the rust program\n", format!("{:?}", o.stdout));
    let o = sh("mkdir -p a/b && mv f.txt a/b/g.txt && rm from-rust.txt && ln -s a/b/g.txt link && echo more >> a/b/g.txt");
    let moved = fs::read_to_string(format!("{WORK}/a/b/g.txt")).unwrap_or_default();
    let through_link = fs::read_to_string(format!("{WORK}/link")).unwrap_or_default();
    r.check("mkdir/mv/rm/ln -s/append by the shell, seen through WASI", o.status == 0 && moved == "hi\nmore\n" && through_link == moved && !fs::exists(format!("{WORK}/from-rust.txt")).unwrap_or(true), format!("status {} {moved:?} {through_link:?} {:?}", o.status, o.stderr));

    // stdout and stderr apart, exit status.
    let o = sh("echo out; echo err >&2; exit 7");
    r.check("stdout, stderr and exit status kept apart", o.status == 7 && o.stdout == "out\n" && o.stderr == "err\n", format!("{} {:?} {:?}", o.status, o.stdout, o.stderr));
    let o = sh("cat /nope/missing.txt; echo \"status $?\"");
    r.check("a failing command", o.stdout == "status 1\n" && o.stderr.contains("No such file or directory"), format!("{:?} {:?}", o.stdout, o.stderr));
    let o = sh("nosuchprogram --flag; echo $?");
    r.check("unknown program is 127", o.stdout == "127\n" && o.stderr.contains("command not found"), format!("{:?} {:?}", o.stdout, o.stderr));
    let o = sh("for f in a/b/*.txt; do n=$(wc -l < \"$f\"); echo \"$f:$n\"; done | sort; find . -type f | sort | head -3; grep -rn more . | sed 's/more/MORE/'");
    r.check("loop, $(...), glob, pipeline, find, grep -rn, sed", o.status == 0 && o.stdout == "a/b/g.txt:2\n./a/b/g.txt\n./a/b/g.txt:2:MORE\n", format!("{} {:?} {:?}", o.status, o.stdout, o.stderr));
    let o = sh("cat > notes.md <<'EOF'\n# title\nbody $HOME\nEOF\nsed -i 's/title/Title/' notes.md && head -1 notes.md && /bin/bash -lc 'echo nested $((6*7))'");
    r.check("here-doc, sed -i, nested /bin/bash -lc", o.stdout == "# Title\nnested 42\n", format!("{} {:?} {:?}", o.status, o.stdout, o.stderr));
    let (mut child, spawned) = (Child::spawn(&["ls", "-1", "a"], WORK, &ENV, false).expect("proc_spawn"), Instant::now());
    let o = collect(&mut child, spawned, None, |_, _| {});
    r.check("a command of the shell by itself as argv (ls -1 a)", o.status == 0 && o.stdout == "b\n", format!("{} {:?} {:?}", o.status, o.stdout, o.stderr));
    let o = sh("cat; echo \"eof $?\"");
    r.check("stdin not opened reads end of file", o.status == 0 && o.stdout == "eof 0\n", format!("{} {:?} {:?}", o.status, o.stdout, o.stderr));
    let (mut child, _) = spawn("echo x", false);
    r.check("proc_send to a child without stdin is EPIPE", child.send(b"x").is_err_and(|e| e.kind() == std::io::ErrorKind::BrokenPipe), String::new());
    while !matches!(child.recv(), Ok(ChildEvent::Exit { .. })) {}
    r.check("proc_recv after the exit event is ENOTCONN", child.try_recv().is_err_and(|e| e.kind() == std::io::ErrorKind::NotConnected), String::new());

    // Output as it is produced.
    let o = sh("for i in 1 2 3; do echo tick $i; sleep 0.2; done");
    let gaps: Vec<f64> = o.arrivals.windows(2).map(|w| w[1] - w[0]).collect();
    let incremental = o.arrivals.len() == 3 && gaps.iter().all(|g| *g > 120.0);
    r.number("arrival of 3 lines printed 200 ms apart (ms after spawn)", format!("[{}]", o.arrivals.iter().map(|a| format!("{a:.1}")).collect::<Vec<_>>().join(",")));
    if inline {
        r.check("inline: output arrives only when the command has ended", !incremental && o.stdout == "tick 1\ntick 2\ntick 3\n", format!("{:?}", o.arrivals));
        return;
    }
    r.check("output arrives while the command is still running", incremental && o.stdout == "tick 1\ntick 2\ntick 3\n", format!("{:?}", o.arrivals));

    // stdin: lines answered one at a time, then end of file.
    let (mut child, spawned) = spawn("while IFS= read -r line; do echo \"got:$line\"; done; echo done", true);
    child.send(b"one\n").unwrap();
    let mut sent = 1;
    let o = collect(&mut child, spawned, None, |child, out| {
        if sent == 1 && out.stdout == "got:one\n" {
            sent = 2;
            child.send(b"two\nthr").unwrap();
            child.send(b"ee\n").unwrap();
        } else if sent == 2 && out.stdout.ends_with("got:three\n") {
            sent = 3;
            child.close_stdin().unwrap();
        }
    });
    r.check("stdin: three lines sent as the child answers, then end of file", o.status == 0 && o.stdout == "got:one\ngot:two\ngot:three\ndone\n" && sent == 3, format!("{} {:?} {:?} sent {sent}", o.status, o.stdout, o.stderr));
    let (mut child, spawned) = spawn("wc -c; sort -r", true);
    child.send(&vec![b'x'; 300_000]).unwrap();
    child.close_stdin().unwrap();
    let o = collect(&mut child, spawned, None, |_, _| {});
    r.check("stdin: 300 kB read to end of file by wc", o.status == 0 && o.stdout == "300000\n", format!("{} {:?} {:?}", o.status, o.stdout, o.stderr));
    let (mut child, spawned) = spawn("echo waiting; cat; echo never", true);
    let o = collect(&mut child, spawned, Some((Duration::from_millis(200), SIGTERM)), |_, _| {});
    r.check("a child waiting on stdin is killed at once", o.exited && o.status == 143 && o.signal == 15 && o.stdout == "waiting\n" && o.total_ms < 300.0, format!("status {} signal {} after {:.0} ms, {:?}", o.status, o.signal, o.total_ms, o.stdout));

    // The guest is not blocked while a child runs: three at once, one poll_oneoff over all descriptors.
    let started = Instant::now();
    let mut children: Vec<Child> = (1..=3).map(|i| spawn(&format!("sleep 0.3; echo child {i}"), false).0).collect();
    let mut done = vec![String::new(); 3];
    let mut open = 3;
    let mut wakeups = 0;
    while open > 0 && wakeups < 1000 {
        let running: Vec<usize> = (0..3).filter(|i| !done[*i].ends_with('!')).collect();
        let mut fds: Vec<PollFd> = running.iter().map(|i| PollFd::new(children[*i].as_raw_fd())).collect();
        poll(&mut fds, Some(Duration::from_secs(5))).expect("poll");
        wakeups += 1;
        for (slot, i) in running.into_iter().enumerate() {
            if !fds[slot].readable {
                continue;
            }
            match children[i].try_recv().expect("proc_recv") {
                Some(ChildEvent::Stdout(b)) | Some(ChildEvent::Stderr(b)) => done[i].push_str(&String::from_utf8_lossy(&b)),
                Some(ChildEvent::Exit { .. }) => {
                    done[i].push('!');
                    open -= 1;
                }
                None => {}
            }
        }
    }
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    r.check("three children at once under one poll_oneoff", done == ["child 1\n!", "child 2\n!", "child 3\n!"] && ms < 600.0, format!("{done:?} in {ms:.0} ms, {wakeups} wakeups"));
    r.number("three 300 ms children at once, wall ms", format!("{ms:.1}"));
    drop(children);

    // More children than shell Workers: the rest wait their turn.
    let started = Instant::now();
    let mut children: Vec<(Child, Instant)> = (1..=7).map(|i| spawn(&format!("sleep 0.1; echo q{i}"), false)).collect();
    let all: Vec<Output> = children.iter_mut().map(|(child, spawned)| collect(child, *spawned, None, |_, _| {})).collect();
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    r.check("seven children on four shell Workers all finish", all.iter().enumerate().all(|(i, o)| o.status == 0 && o.stdout == format!("q{}\n", i + 1)) && ms < 600.0, format!("{ms:.0} ms {:?}", all.iter().map(|o| o.stdout.clone()).collect::<Vec<_>>()));
    drop(children);

    // Timeout as codex does it: the guest decides, the host kills.
    let (mut child, spawned) = spawn("echo started; sleep 30; echo never", false);
    let o = collect(&mut child, spawned, Some((Duration::from_millis(300), SIGTERM)), |_, _| {});
    r.check("kill of a sleeping command (SIGTERM after 300 ms)", o.exited && o.status == 143 && o.stdout == "started\n" && o.total_ms < 600.0, format!("status {} after {:.0} ms, stdout {:?}", o.status, o.total_ms, o.stdout));
    r.number("kill of `sleep 30`: ms from kill to exit event", format!("{:.1}", o.total_ms - 300.0));

    // A command that never makes a host call can only be stopped by ending its Worker.
    let (mut child, spawned) = spawn("echo spinning; while :; do :; done", false);
    let o = collect(&mut child, spawned, Some((Duration::from_millis(300), SIGTERM)), |_, _| {});
    r.check("kill of a busy loop (Worker replaced)", o.exited && o.status == 143 && o.stdout == "spinning\n" && o.total_ms < 900.0, format!("status {} after {:.0} ms, stdout {:?}", o.status, o.total_ms, o.stdout));
    r.number("kill of `while :; do :; done`: ms from kill to exit event", format!("{:.1}", o.total_ms - 300.0));
    let o = sh("echo alive");
    r.check("the next command after a replaced Worker", o.status == 0 && o.stdout == "alive\n", format!("{} {:?} in {:.1} ms (queued {:.1} ms)", o.status, o.stdout, o.total_ms, o.queue_ms));
    r.number("first command after a Worker was replaced, total ms", format!("{:.1}", o.total_ms));

    // Closing the descriptor of a running child ends it; the slot is free again.
    for _ in 0..6 {
        drop(spawn("sleep 30", false));
    }
    std::thread::sleep(Duration::from_millis(100));
    let o = sh("echo after-drops");
    r.check("dropping running children frees their Workers", o.stdout == "after-drops\n" && o.total_ms < 400.0, format!("{:?} in {:.1} ms", o.stdout, o.total_ms));

    // Back-pressure: a child that prints 8 MiB while the guest reads slowly must not pile up in memory.
    let (mut child, spawned) = spawn("seq 1 1200000", false);
    std::thread::sleep(Duration::from_millis(200));
    let o = collect(&mut child, spawned, None, |_, _| {});
    r.check("8 MiB of output, reader starts late", o.status == 0 && o.stdout.len() == 8488896 && o.stdout.ends_with("1200000\n"), format!("status {} bytes {}", o.status, o.stdout.len()));
    r.number("8 MiB of output: total ms / events", format!("[{:.0},{}]", o.total_ms, o.arrivals.len()));

    // The program's own output flow control: while this program is blocked writing to a terminal
    // that is behind, a child's file calls are still answered.
    let (mut child, spawned) = spawn("for i in $(seq 1 400); do echo $i > flood-$i.txt; done; ls flood-*.txt | wc -l; rm flood-*.txt", false);
    let line = "x".repeat(199);
    let flood_started = Instant::now();
    for _ in 0..12_000 {
        println!("{line}");
    }
    let flood_ms = flood_started.elapsed().as_secs_f64() * 1000.0;
    let o = collect(&mut child, spawned, None, |_, _| {});
    r.check("a child runs to its end while this program is busy writing (and blocked on) its own terminal output", o.exited && o.status == 0 && o.stdout == "400\n" && o.queue_ms + o.run_ms < flood_ms, format!("flood {flood_ms:.0} ms, child ran {:.0} ms, {} calls, {:?}", o.queue_ms + o.run_ms, o.calls, o.stderr));
}

fn timings(r: &mut Report) {
    let time = |r: &mut Report, name: &str, command: &str, n: usize| {
        let mut total = Vec::new();
        let mut queue = Vec::new();
        let mut calls = 0;
        for _ in 0..n {
            let o = sh(command);
            total.push(o.total_ms);
            queue.push(o.queue_ms);
            calls = o.calls;
        }
        r.number(&format!("{name}: spawn to exit event, ms"), stats(&mut total));
        r.number(&format!("{name}: spawn to shell running, ms"), stats(&mut queue));
        r.number(&format!("{name}: host calls per run"), format!("{calls}"));
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
    let o = sh("find tree -type f | wc -l; grep -rn NEEDLE tree | wc -l");
    r.check("2,000 files (6.5 MB) made through WASI, found and searched by the shell", o.stdout == "2000\n200\n", format!("{:?} {:?}", o.stdout, o.stderr));
    time(r, "`find tree -type f | wc -l` over 2,000 files", "find tree -type f | wc -l", 10);
    time(r, "`grep -rn NEEDLE tree | wc -l` over 2,000 files, 6.5 MB", "grep -rn NEEDLE tree | wc -l", 10);
    time(r, "`cat tree/d1/*.rs | wc -c` (50 files)", "cat tree/d1/*.rs | wc -c", 50);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let inline = args.iter().any(|a| a == "inline");
    let mut r = Report { checks: Vec::new(), numbers: Vec::new() };

    fs::create_dir_all(WORK).unwrap();
    let o = sh("echo first");
    r.check("the very first command", o.stdout == "first\n", format!("{:?} {:?}", o.stdout, o.stderr));
    r.number("very first command, total ms / of which waiting for a shell", format!("[{:.1},{:.1}]", o.total_ms, o.queue_ms));
    checks(&mut r, inline);
    if !args.iter().any(|a| a == "quick") {
        timings(&mut r);
    }

    let failed = r.checks.iter().filter(|c| !c.1).count();
    let checks: Vec<String> = r.checks.iter().map(|(n, ok, d)| format!("{{\"name\":\"{}\",\"ok\":{ok},\"detail\":\"{}\"}}", esc(n), esc(&d.chars().take(300).collect::<String>()))).collect();
    let numbers: Vec<String> = r.numbers.iter().map(|(n, j)| format!("\"{}\":{j}", esc(n))).collect();
    let result = format!("{{\"failed\":{failed},\"checks\":[{}],\"numbers\":{{{}}}}}", checks.join(","), numbers.join(","));
    // Also as a file: the page reads it with `wasmTerm.readFile` (the line is wider than any screen).
    let _ = fs::write("/home/user/proc-result.json", &result);
    println!("RESULT {result}");
    std::process::exit(if failed == 0 { 0 } else { 1 });
}
