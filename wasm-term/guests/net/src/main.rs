//! Network guest: exercises the WebSocket and streaming-HTTP primitives
//! against the dev server's /test/ endpoints, then multiplexes the keyboard,
//! a WebSocket, an event stream and a timer in one `poll` loop.

use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};
use wasm_term_sys::net::{self, HttpRequest, WebSocket, WsEvent};
use wasm_term_sys::poll::{poll, PollFd};

fn show(event: &WsEvent) -> String {
    match event {
        WsEvent::Open(protocol) => format!("OPEN (subprotocol {protocol:?})"),
        WsEvent::Text(text) => format!("TEXT {text:?}"),
        WsEvent::Binary(data) => format!("BINARY {data:?}"),
        WsEvent::Close { code, reason } => format!("CLOSE {code} {reason:?}"),
        WsEvent::Error(message) => format!("ERROR {message}"),
    }
}

fn check(label: &str, ok: bool) {
    println!("  {} {label}", if ok { "\x1b[32mPASS\x1b[0m" } else { "\x1b[31mFAIL\x1b[0m" });
}

fn scripted(origin: &str, ws_origin: &str) -> io::Result<()> {
    println!("\x1b[1m1. HTTP POST {origin}/test/echo\x1b[0m");
    let response = HttpRequest::send("POST", &format!("{origin}/test/echo"), &[("X-Wasm-Term", "guest")], b"ping body")?.response()?;
    let status = response.status;
    let x_echo = response.header("x-echo").map(str::to_string);
    let mut body = String::new();
    { response.body }.read_to_string(&mut body)?;
    println!("  status {status}, x-echo {x_echo:?}, body {body}");
    check("status 200, response header, request header and body round-trip", status == 200 && x_echo.as_deref() == Some("yes") && body.contains("\"body\":\"ping body\"") && body.contains("\"header\":\"guest\""));

    println!("\x1b[1m2. Streaming GET {origin}/test/sse?count=4&interval=250\x1b[0m");
    let started = Instant::now();
    let mut response = HttpRequest::send("GET", &format!("{origin}/test/sse?count=4&interval=250"), &[("Accept", "text/event-stream")], b"")?.response()?;
    println!("  head after {:4} ms: status {}, content-type {:?}", started.elapsed().as_millis(), response.status, response.header("content-type"));
    let mut arrivals = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        let n = response.body.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let at = started.elapsed().as_millis();
        arrivals.push(at);
        println!("  +{at:4} ms: {:?}", String::from_utf8_lossy(&buf[..n]));
    }
    println!("  end of body after {} ms", started.elapsed().as_millis());
    let spread = arrivals.last().copied().unwrap_or(0) - arrivals.first().copied().unwrap_or(0);
    check("body arrived incrementally (reads spread over time, not one buffered blob)", arrivals.len() >= 4 && spread >= 500);

    println!("\x1b[1m3. WebSocket {ws_origin}/test/ws\x1b[0m");
    let mut ws = WebSocket::connect(&format!("{ws_origin}/test/ws"), &[])?;
    ws.send_text("sent before the handshake finished")?;
    let mut seen = Vec::new();
    for _ in 0..3 {
        let event = ws.recv()?;
        println!("  {}", show(&event));
        seen.push(event);
    }
    ws.send_binary(&[1, 2, 3, 250])?;
    let event = ws.recv()?;
    println!("  {}", show(&event));
    seen.push(event);
    check(
        "open, greeting, text echo, binary echo",
        matches!(&seen[0], WsEvent::Open(_))
            && seen[1] == WsEvent::Text("hello from /test/ws".into())
            && seen[2] == WsEvent::Text("echo: sent before the handshake finished".into())
            && seen[3] == WsEvent::Binary(vec![250, 3, 2, 1]),
    );
    ws.send_text("bye")?;
    let event = ws.recv()?;
    println!("  {}", show(&event));
    check("server-initiated close with code and reason", event == WsEvent::Close { code: 1000, reason: "goodbye".into() });

    println!("\x1b[1m4. Failure reporting\x1b[0m");
    let failed = net::fetch("GET", "http://127.0.0.1:9/nothing-listens-here", &[], b"");
    println!("  fetch to a closed port: {failed:?}");
    check("a network error is an Err, not a hang", failed.is_err());
    let mut bad = WebSocket::connect("ws://127.0.0.1:9/", &[])?;
    let event = bad.recv()?;
    println!("  websocket to a closed port: {}", show(&event));
    check("a failed WebSocket reports Error", matches!(event, WsEvent::Error(_)));
    Ok(())
}

/// One loop over: the terminal (cooked mode, so readable = a whole line is
/// ready), a WebSocket, an optional event stream, and a 1 s timer.
fn interactive(origin: &str, ws_origin: &str) -> io::Result<()> {
    println!("\x1b[1m5. Interactive: one poll loop over keyboard + WebSocket + event stream + timer\x1b[0m");
    println!("  type a line to send it over the WebSocket; `sse` starts an event stream;");
    println!("  `tick` toggles a 1 s timer; `quit` (or ^D) leaves.");
    let mut ws = WebSocket::connect(&format!("{ws_origin}/test/ws"), &[])?;
    let mut stream: Option<std::fs::File> = None;
    let mut ticking = false;
    let mut ticks = 0;
    let stdin = io::stdin();
    loop {
        let mut fds = vec![PollFd::new(0), PollFd::new(ws.as_raw_fd())];
        if let Some(stream) = &stream {
            fds.push(PollFd::new(stream.as_raw_fd()));
        }
        let ready = poll(&mut fds, ticking.then_some(Duration::from_secs(1)))?;
        if ready == 0 {
            ticks += 1;
            println!("  [timer] tick {ticks}");
            continue;
        }
        if fds[1].readable {
            while let Some(event) = ws.try_recv()? {
                println!("  [ws] {}", show(&event));
                if matches!(event, WsEvent::Close { .. } | WsEvent::Error(_)) {
                    println!("  websocket finished; leaving");
                    return Ok(());
                }
            }
        }
        if fds.len() > 2 && fds[2].readable {
            let mut buf = [0u8; 1024];
            let n = stream.as_mut().unwrap().read(&mut buf)?;
            if n == 0 {
                println!("  [sse] end of stream");
                stream = None;
            } else {
                println!("  [sse] {:?}", String::from_utf8_lossy(&buf[..n]));
            }
        }
        if fds[0].readable {
            let mut line = String::new();
            if stdin.read_line(&mut line)? == 0 {
                println!("  [stdin] EOF");
                return Ok(());
            }
            match line.trim() {
                "" => {}
                "quit" => return Ok(()),
                "tick" => {
                    ticking = !ticking;
                    println!("  timer {}", if ticking { "on" } else { "off" });
                }
                "sse" => {
                    let response = HttpRequest::send("GET", &format!("{origin}/test/sse?count=5&interval=700"), &[], b"")?.response()?;
                    println!("  [sse] status {}", response.status);
                    stream = Some(response.body);
                }
                text => ws.send_text(text)?,
            }
        }
    }
}

fn main() {
    let origin = std::env::var("WASM_TERM_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:4790".into());
    let ws_origin = origin.replacen("http", "ws", 1);
    let result = scripted(&origin, &ws_origin).and_then(|()| interactive(&origin, &ws_origin));
    if let Err(error) = result {
        println!("\x1b[31merror: {error}\x1b[0m");
        io::stdout().flush().ok();
        std::process::exit(1);
    }
    println!("bye");
}
