//! Checks the TCP stream descriptor (docs/abi.md 3.3, "TCP") against the dev
//! server's test endpoints (web/tcp-relay.ts): `tcp-echo.test:7` echoes and
//! answers a half-close with "bye\n", `tcp-reset.test:7` says "hello\n" and
//! resets at the first byte, `tcp-closed.test:7` has no listener, `localhost:7`
//! is allowed by name and resolves to loopback, `example.com:80` is not allowed.
//!
//! One line per check; the same as JSON in `/home/user/tcp-result.json`.

use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wasm_term_sys::net::TcpStream as SyncStream;
use wasm_term_tokio::TcpStream;

struct Report {
    checks: Vec<(String, bool, String)>,
}

impl Report {
    fn check(&mut self, name: &str, ok: bool, detail: impl Into<String>) {
        let detail = detail.into();
        println!("{} {name}{}", if ok { "PASS" } else { "FAIL" }, if detail.is_empty() { String::new() } else { format!(" ({detail})") });
        self.checks.push((name.to_string(), ok, detail));
    }

    fn json(&self) -> String {
        let escape = |text: &str| text.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
        let items: Vec<String> = self
            .checks
            .iter()
            .map(|(name, ok, detail)| format!(r#"{{"name":"{}","ok":{ok},"detail":"{}"}}"#, escape(name), escape(detail)))
            .collect();
        let failed = self.checks.iter().filter(|(_, ok, _)| !ok).count();
        format!(r#"{{"failed":{failed},"checks":[{}]}}"#, items.join(","))
    }
}

/// A byte pattern that a reordered or dropped block would break.
fn pattern(offset: usize, buf: &mut [u8]) {
    for (index, byte) in buf.iter_mut().enumerate() {
        let at = offset + index;
        *byte = (at ^ (at >> 8) ^ (at >> 16)) as u8;
    }
}

fn blocking(report: &mut Report) -> io::Result<()> {
    let mut stream = SyncStream::connect("tcp-echo.test", 7)?;
    stream.write_all(b"blocking hello")?;
    let mut buf = [0u8; 64];
    let n = stream.read(&mut buf)?;
    report.check("blocking: connect, write, read the echo", &buf[..n] == b"blocking hello", String::from_utf8_lossy(&buf[..n]));
    // Level-triggered without the edge flag: writable now, and still writable when asked again.
    let first = wasm_term_sys::poll_writable(stream.as_raw_fd(), Some(Duration::from_millis(500)))?;
    let second = wasm_term_sys::poll_writable(stream.as_raw_fd(), Some(Duration::from_millis(500)))?;
    report.check("blocking: an idle stream polls writable, every time it is asked", first && second, format!("{first} {second}"));
    stream.shutdown_write()?;
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest)?;
    report.check("blocking: half-close: the peer sees end of file, its reply and its own end of file arrive", rest == b"bye\n", String::from_utf8_lossy(&rest));
    let after = stream.write(b"x");
    report.check("blocking: a write after shutdown is EPIPE", after.as_ref().is_err_and(|error| error.kind() == io::ErrorKind::BrokenPipe), format!("{after:?}"));

    // Non-blocking, no reader: the window fills and the write says so instead of queueing without bound.
    let mut stream = SyncStream::connect("tcp-echo.test", 7)?;
    wasm_term_sys::set_nonblocking(stream.as_raw_fd(), true)?;
    let block = vec![7u8; 64 * 1024];
    let mut accepted = 0usize;
    let mut short = false;
    let mut blocked = false;
    let started = Instant::now();
    while accepted < 256 << 20 && started.elapsed() < Duration::from_secs(20) {
        match stream.write(&block) {
            Ok(n) => {
                accepted += n;
                short |= n < block.len();
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                // Room may still appear while the relay and the kernel fill up; stalled means none for a while.
                if !wasm_term_sys::poll_writable(stream.as_raw_fd(), Some(Duration::from_millis(700)))? {
                    blocked = true;
                    break;
                }
            }
            Err(error) => return Err(error),
        }
    }
    report.check(
        "non-blocking: with nobody reading, writes stop (EAGAIN) after a bounded amount",
        blocked && accepted < 64 << 20,
        format!("{accepted} bytes accepted, short write seen: {short}"),
    );
    // Reading the echo frees the path again.
    let mut drained = 0usize;
    let mut buf = vec![0u8; 256 * 1024];
    let started = Instant::now();
    while drained < accepted && started.elapsed() < Duration::from_secs(30) {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => drained += n,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let mut fds = [wasm_term_sys::poll::PollFd::new(stream.as_raw_fd())];
                wasm_term_sys::poll::poll(&mut fds, Some(Duration::from_secs(5)))?;
            }
            Err(error) => return Err(error),
        }
    }
    let writable = wasm_term_sys::poll_writable(stream.as_raw_fd(), Some(Duration::from_secs(5)))?;
    report.check("non-blocking: everything written comes back, and the stream is writable again", drained == accepted && writable, format!("{drained} of {accepted}"));
    Ok(())
}

fn kind_of<T>(result: &io::Result<T>) -> String {
    match result {
        Ok(_) => "Ok".to_string(),
        Err(error) => format!("{:?}: {error}", error.kind()),
    }
}

async fn asynchronous(report: &mut Report) -> io::Result<()> {
    let mut stream = TcpStream::connect("tcp-echo.test", 7).await?;
    stream.write_all(b"async hello").await?;
    let mut buf = [0u8; 64];
    let n = stream.read(&mut buf).await?;
    report.check("tokio: connect, write, read the echo", &buf[..n] == b"async hello", String::from_utf8_lossy(&buf[..n]));

    // An open, idle stream must not keep the runtime awake: it is writable the whole time.
    let metrics = tokio::runtime::Handle::current().metrics();
    let parks = metrics.worker_park_count(0);
    tokio::time::sleep(Duration::from_secs(1)).await;
    let parks = metrics.worker_park_count(0) - parks;
    report.check("tokio: an idle stream does not spin the runtime", parks < 20, format!("{parks} parks in 1 s"));

    // 24 MiB through the echo with both directions busy: nothing lost, nothing reordered.
    const TOTAL: usize = 24 << 20;
    let (mut reader, mut writer) = tokio::io::split(stream);
    let started = Instant::now();
    let write = async {
        let mut block = vec![0u8; 100_000];
        let mut sent = 0;
        while sent < TOTAL {
            let len = block.len().min(TOTAL - sent);
            pattern(sent, &mut block[..len]);
            writer.write_all(&block[..len]).await?;
            sent += len;
        }
        writer.shutdown().await?;
        io::Result::Ok(sent)
    };
    let read = async {
        let mut block = vec![0u8; 70_000];
        let mut expected = vec![0u8; 70_000];
        let mut received = 0;
        let mut intact = true;
        let mut tail = Vec::new();
        loop {
            let n = reader.read(&mut block).await?;
            if n == 0 {
                break;
            }
            let body = n.min(TOTAL.saturating_sub(received));
            pattern(received, &mut expected[..body]);
            intact &= block[..body] == expected[..body];
            tail.extend_from_slice(&block[body..n]);
            received += body;
        }
        io::Result::Ok((received, intact, tail))
    };
    let (sent, (received, intact, tail)) = tokio::try_join!(write, read)?;
    report.check(
        "tokio: 24 MiB echoed with both directions under back-pressure, intact, then half-close and end of file",
        sent == TOTAL && received == TOTAL && intact && tail == b"bye\n",
        format!("{received} bytes in {} ms, tail {:?}", started.elapsed().as_millis(), String::from_utf8_lossy(&tail)),
    );

    let denied = TcpStream::connect("example.com", 80).await;
    report.check("a destination outside the allowlist is refused (EACCES)", denied.as_ref().is_err_and(|error| error.kind() == io::ErrorKind::PermissionDenied), kind_of(&denied));
    let private = TcpStream::connect("localhost", 7).await;
    report.check("an allowed name that resolves to loopback is refused (EACCES)", private.as_ref().is_err_and(|error| error.kind() == io::ErrorKind::PermissionDenied), kind_of(&private));
    let refused = TcpStream::connect("tcp-closed.test", 7).await;
    report.check("a connection nobody accepts is ECONNREFUSED", refused.as_ref().is_err_and(|error| error.kind() == io::ErrorKind::ConnectionRefused), kind_of(&refused));

    let mut stream = TcpStream::connect("tcp-reset.test", 7).await?;
    let mut hello = [0u8; 6];
    stream.read_exact(&mut hello).await?;
    stream.write_all(b"x").await?;
    let reset = stream.read(&mut buf).await;
    report.check("a reset by the peer is ECONNRESET on the next read", &hello == b"hello\n" && reset.as_ref().is_err_and(|error| error.kind() == io::ErrorKind::ConnectionReset), kind_of(&reset));
    let after = stream.write(b"y").await;
    report.check("... and on the next write", after.as_ref().is_err_and(|error| error.kind() == io::ErrorKind::ConnectionReset), kind_of(&after));
    Ok(())
}

fn main() {
    let mut report = Report { checks: Vec::new() };
    if let Err(error) = blocking(&mut report) {
        report.check("blocking checks ran to the end", false, error.to_string());
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
    if let Err(error) = runtime.block_on(asynchronous(&mut report)) {
        report.check("tokio checks ran to the end", false, error.to_string());
    }
    let failed = report.checks.iter().filter(|(_, ok, _)| !ok).count();
    println!("tcp: {} checks, {failed} failed", report.checks.len());
    let _ = std::fs::write("/home/user/tcp-result.json", report.json());
    std::process::exit(if failed == 0 { 0 } else { 1 });
}
