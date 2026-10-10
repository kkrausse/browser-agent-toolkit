//! Cooked-mode line REPL: proves the line discipline end to end.
//!
//! Lines come from ordinary `std::io::stdin()`. The program never echoes or
//! edits anything itself: echo, backspace, ^U, ^W, ^D and ^C are all the
//! kernel's line discipline, exactly as with a native program on a tty.

use std::io::{self, BufRead, IsTerminal, Read, Write};
use std::time::Duration;
use wasm_term_sys::signal::{self, Action, Signals, SIGINT, SIGWINCH};
use wasm_term_sys::termios::{self, *};

enum Line {
    Text(String),
    Eof,
    Interrupted,
}

/// One line from std stdin. Plain `read` rather than `read_line`, because
/// `read_line` retries EINTR internally and seeing the interruption (a caught
/// ^C or a resize) is the point. In canonical mode the kernel hands over
/// exactly one line per read. `password` below uses `read_line`.
fn read_line() -> io::Result<Line> {
    let mut buf = [0u8; 4096];
    match io::stdin().lock().read(&mut buf) {
        Ok(0) => Ok(Line::Eof),
        Ok(n) => Ok(Line::Text(String::from_utf8_lossy(&buf[..n]).into_owned())),
        Err(error) if error.kind() == io::ErrorKind::Interrupted => Ok(Line::Interrupted),
        Err(error) => Err(error),
    }
}

fn flags(termios: &Termios) -> String {
    let mut names = Vec::new();
    let mut flag = |set: bool, name: &str| names.push(format!("{}{name}", if set { "" } else { "-" }));
    flag(termios.c_lflag & ICANON != 0, "icanon");
    flag(termios.c_lflag & ECHO != 0, "echo");
    flag(termios.c_lflag & ECHOE != 0, "echoe");
    flag(termios.c_lflag & ECHOK != 0, "echok");
    flag(termios.c_lflag & ECHOCTL != 0, "echoctl");
    flag(termios.c_lflag & ISIG != 0, "isig");
    flag(termios.c_lflag & IEXTEN != 0, "iexten");
    flag(termios.c_iflag & ICRNL != 0, "icrnl");
    flag(termios.c_iflag & IXON != 0, "ixon");
    flag(termios.c_oflag & OPOST != 0, "opost");
    flag(termios.c_oflag & ONLCR != 0, "onlcr");
    names.join(" ")
}

fn caret(c: u8) -> String {
    match c {
        0 => "<undef>".into(),
        0x7f => "^?".into(),
        c if c < 0x20 => format!("^{}", (c ^ 0x40) as char),
        c => (c as char).to_string(),
    }
}

/// Prints bytes so that control characters are visible: `\x1b[A` rather than a cursor move.
fn escape(bytes: &[u8]) -> String {
    let mut out = String::new();
    for &b in bytes {
        match b {
            0x1b => out.push_str("\\e"),
            b'\r' => out.push_str("\\r"),
            b'\n' => out.push_str("\\n"),
            b'\t' => out.push_str("\\t"),
            b'\\' => out.push_str("\\\\"),
            0x20..=0x7e => out.push(b as char),
            _ => out.push_str(&format!("\\x{b:02x}")),
        }
    }
    out
}

/// Raw-mode key dump. Turns on bracketed paste, SGR mouse, focus events and
/// the kitty keyboard protocol, then shows exactly which bytes the terminal
/// sends for each action. `q` leaves.
fn keys() -> io::Result<()> {
    let saved = termios::tcgetattr(0)?;
    let mut raw = saved;
    termios::cfmakeraw(&mut raw);
    termios::tcsetattr(0, TCSAFLUSH, &raw)?;
    let mut out = io::stdout();
    write!(out, "\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[>1u")?;
    write!(out, "raw mode: paste, mouse, focus and kitty keys are on. Press q to leave.\r\n")?;
    out.flush()?;
    let mut buf = [0u8; 1024];
    loop {
        let n = io::stdin().lock().read(&mut buf)?;
        if n == 0 {
            break;
        }
        write!(out, "read {n:3}: {}\r\n", escape(&buf[..n]))?;
        out.flush()?;
        if &buf[..n] == b"q" || buf[..n].starts_with(b"\x1b[113") {
            break;
        }
    }
    write!(out, "\x1b[<u\x1b[?1004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?2004l")?;
    out.flush()?;
    termios::tcsetattr(0, TCSAFLUSH, &saved)
}

fn password() -> io::Result<()> {
    let saved = termios::tcgetattr(0)?;
    let mut quiet = saved;
    quiet.c_lflag &= !ECHO;
    quiet.c_lflag |= ECHONL;
    termios::tcsetattr(0, TCSANOW, &quiet)?;
    print!("password (not echoed): ");
    io::stdout().flush()?;
    let mut line = String::new();
    let result = io::stdin().lock().read_line(&mut line);
    termios::tcsetattr(0, TCSANOW, &saved)?;
    result?;
    println!("got {} characters", line.trim_end_matches('\n').chars().count());
    Ok(())
}

fn run(command: &str, rest: &str) -> io::Result<Option<i32>> {
    match command {
        "" => {}
        "help" => {
            println!("echo TEXT        print TEXT");
            println!("stty             show terminal settings");
            println!("size             show window size");
            println!("keys             raw mode: show the bytes each key / paste / click sends");
            println!("password         read a line with echo off");
            println!("trap on|off      catch SIGINT (on: ^C interrupts the read; off: ^C kills)");
            println!("sleep SECS       block in a timer");
            println!("write PATH TEXT  write a file        cat PATH   read it back");
            println!("ls [PATH]        list a directory    env        show environment");
            println!("exit [CODE]      leave               ^D         end of file");
        }
        "echo" => println!("{rest}"),
        "stty" => {
            let t = termios::tcgetattr(0)?;
            let ws = termios::winsize(0)?;
            println!("rows {}; columns {};", ws.ws_row, ws.ws_col);
            println!(
                "intr = {}; quit = {}; erase = {}; kill = {}; eof = {}; susp = {}; werase = {}; min = {}; time = {};",
                caret(t.c_cc[VINTR]),
                caret(t.c_cc[VQUIT]),
                caret(t.c_cc[VERASE]),
                caret(t.c_cc[VKILL]),
                caret(t.c_cc[VEOF]),
                caret(t.c_cc[VSUSP]),
                caret(t.c_cc[VWERASE]),
                t.c_cc[VMIN],
                t.c_cc[VTIME]
            );
            println!("{}", flags(&t));
        }
        "size" => {
            let ws = termios::winsize(0)?;
            println!("{} columns x {} rows ({}x{} px)", ws.ws_col, ws.ws_row, ws.ws_xpixel, ws.ws_ypixel);
        }
        "keys" => keys()?,
        "password" => password()?,
        "trap" => {
            let trap = rest != "off";
            signal::action(SIGINT, if trap { Action::Catch } else { Action::Default })?;
            println!("SIGINT is {}", if trap { "caught: ^C interrupts the read" } else { "default: ^C kills this program" });
        }
        "sleep" => {
            let seconds: f64 = rest.parse().unwrap_or(1.0);
            std::thread::sleep(Duration::from_secs_f64(seconds));
            println!("slept {seconds}s");
        }
        "write" => {
            let (path, text) = rest.split_once(' ').unwrap_or((rest, ""));
            std::fs::write(path, format!("{text}\n"))?;
            println!("wrote {} bytes to {path}", text.len() + 1);
        }
        "cat" => print!("{}", std::fs::read_to_string(rest)?),
        "ls" => {
            let path = if rest.is_empty() { "." } else { rest };
            let mut names: Vec<String> = std::fs::read_dir(path)?
                .filter_map(|entry| entry.ok())
                .map(|entry| {
                    let dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    format!("{}{}", entry.file_name().to_string_lossy(), if dir { "/" } else { "" })
                })
                .collect();
            names.sort();
            println!("{}", names.join("  "));
        }
        "env" => {
            for (key, value) in std::env::vars() {
                println!("{key}={value}");
            }
        }
        "exit" => return Ok(Some(rest.parse().unwrap_or(0))),
        other => println!("{other}: unknown command (try help)"),
    }
    Ok(None)
}

fn main() -> io::Result<()> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let _ = std::env::set_current_dir(&home);
    let ws = termios::winsize(0)?;
    println!("wasm-term repl: a cooked-mode program reading lines from std stdin.");
    println!(
        "stdin is {}a terminal, {}x{}, cwd {}. Type help.",
        if io::stdin().is_terminal() { "" } else { "NOT " },
        ws.ws_col,
        ws.ws_row,
        std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default()
    );

    let mut signals = Signals::new(&[SIGINT, SIGWINCH])?;

    loop {
        for signo in signals.pending()? {
            match signo {
                SIGINT => println!("\n[SIGINT caught: line discarded]"),
                SIGWINCH => {
                    let ws = termios::winsize(0)?;
                    println!("\n[SIGWINCH: now {}x{}]", ws.ws_col, ws.ws_row);
                }
                other => println!("\n[signal {other}]"),
            }
        }
        print!("wasm-term> ");
        io::stdout().flush()?;
        let line = match read_line()? {
            Line::Text(line) => line,
            Line::Eof => {
                println!("\n[EOF: read returned 0 bytes] bye");
                return Ok(());
            }
            Line::Interrupted => continue,
        };
        if !line.ends_with('\n') {
            // ^D on a non-empty line pushes it without a newline.
            println!("  [partial line pushed by ^D]");
        }
        let line = line.trim();
        let (command, rest) = line.split_once(' ').unwrap_or((line, ""));
        match run(command, rest.trim()) {
            Ok(Some(code)) => std::process::exit(code),
            Ok(None) => {}
            Err(error) => println!("{command}: {error}"),
        }
    }
}
