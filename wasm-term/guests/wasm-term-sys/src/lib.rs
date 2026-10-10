//! Rust bindings for the wasm-term guest ABI.
//!
//! The ABI itself is specified in `wasm-term/docs/abi.md`; this crate is a
//! thin, dependency-free wrapper over it for `wasm32-wasip1` programs:
//!
//! - [`termios`]: `tcgetattr` / `tcsetattr` / `cfmakeraw` / window size
//! - [`signal`]: dispositions and a signalfd-style descriptor
//! - [`poll`]: `poll_oneoff` over any mix of descriptors plus a timeout
//! - [`net`]: WebSocket client and streaming HTTP, as pollable descriptors
//!
//! Everything else (files, stdin/stdout, clocks, env, args) is plain WASI and
//! works through `std`.
#![cfg(target_os = "wasi")]

use std::io;
use std::time::Duration;

pub type RawFd = std::os::fd::RawFd;

/// Raw imports. Every function returns a WASI errno (0 = success).
pub mod raw {
    #[link(wasm_import_module = "wasm_term")]
    extern "C" {
        pub fn tcgetattr(fd: u32, termios: *mut super::termios::Termios) -> u32;
        pub fn tcsetattr(fd: u32, action: u32, termios: *const super::termios::Termios) -> u32;
        pub fn winsize_get(fd: u32, winsize: *mut super::termios::Winsize) -> u32;
        pub fn sig_action(signo: u32, action: u32, old_action: *mut u32) -> u32;
        pub fn sig_fd(mask: u32, fd: *mut u32) -> u32;
        pub fn last_error(buf: *mut u8, buf_len: u32, len: *mut u32) -> u32;
        pub fn ws_open(url: *const u8, url_len: u32, protocols: *const u8, protocols_len: u32, fd: *mut u32) -> u32;
        pub fn ws_send(fd: u32, kind: u32, data: *const u8, len: u32) -> u32;
        pub fn ws_recv(fd: u32, buf: *mut u8, buf_len: u32, out: *mut [u32; 2], flags: u32) -> u32;
        pub fn ws_close(fd: u32, code: u32, reason: *const u8, reason_len: u32) -> u32;
        #[allow(clippy::too_many_arguments)]
        pub fn http_open(
            method: *const u8,
            method_len: u32,
            url: *const u8,
            url_len: u32,
            headers: *const u8,
            headers_len: u32,
            body: *const u8,
            body_len: u32,
            fd: *mut u32,
        ) -> u32;
        pub fn http_head(fd: u32, buf: *mut u8, buf_len: u32, out: *mut [u32; 2], flags: u32) -> u32;
        pub fn tcp_connect(host: *const u8, host_len: u32, port: u32, flags: u32, fd: *mut u32) -> u32;
        pub fn tcp_status(fd: u32, flags: u32) -> u32;
        pub fn proc_spawn(req: *const u8, req_len: u32, flags: u32, fd: *mut u32) -> u32;
        pub fn proc_recv(fd: u32, buf: *mut u8, buf_len: u32, out: *mut [u32; 2], flags: u32) -> u32;
        pub fn proc_send(fd: u32, data: *const u8, len: u32, flags: u32) -> u32;
        pub fn proc_signal(fd: u32, signo: u32) -> u32;
    }

    #[link(wasm_import_module = "wasi_snapshot_preview1")]
    extern "C" {
        pub fn poll_oneoff(subs: *const u8, events: *mut u8, count: u32, nevents: *mut u32) -> u32;
        pub fn fd_fdstat_get(fd: u32, stat: *mut u8) -> u32;
        pub fn fd_fdstat_set_flags(fd: u32, flags: u32) -> u32;
        pub fn sock_shutdown(fd: u32, how: u32) -> u32;
    }
}

pub const ERRNO_AGAIN: u32 = 6;
pub const ERRNO_RANGE: u32 = 68;

/// Converts an ABI errno into `io::Result`. WASI errno numbers are the
/// target's native OS error numbers, so `ErrorKind` mapping comes for free
/// (6 = WouldBlock, 27 = Interrupted, 59 = not a tty, ...).
pub fn check(errno: u32) -> io::Result<()> {
    if errno == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(errno as i32))
    }
}

/// Human-readable detail for the most recent failed network call.
pub fn last_error() -> String {
    let mut buf = [0u8; 512];
    let mut len = 0u32;
    unsafe { raw::last_error(buf.as_mut_ptr(), buf.len() as u32, &mut len) };
    String::from_utf8_lossy(&buf[..len as usize]).into_owned()
}

/// Sets or clears O_NONBLOCK on any descriptor.
pub fn set_nonblocking(fd: RawFd, nonblocking: bool) -> io::Result<()> {
    check(unsafe { raw::fd_fdstat_set_flags(fd as u32, if nonblocking { 4 } else { 0 }) })
}

pub mod termios {
    use super::{check, raw, RawFd};
    use std::io;

    /// Same field order and flag values as Linux `struct termios`, without `c_line`. 44 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Termios {
        pub c_iflag: u32,
        pub c_oflag: u32,
        pub c_cflag: u32,
        pub c_lflag: u32,
        pub c_cc: [u8; NCCS],
        pub c_ispeed: u32,
        pub c_ospeed: u32,
    }

    /// `struct winsize`. 8 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Winsize {
        pub ws_row: u16,
        pub ws_col: u16,
        pub ws_xpixel: u16,
        pub ws_ypixel: u16,
    }

    pub const NCCS: usize = 20;

    pub const IGNBRK: u32 = 0o1;
    pub const BRKINT: u32 = 0o2;
    pub const PARMRK: u32 = 0o10;
    pub const ISTRIP: u32 = 0o40;
    pub const INLCR: u32 = 0o100;
    pub const IGNCR: u32 = 0o200;
    pub const ICRNL: u32 = 0o400;
    pub const IXON: u32 = 0o2000;
    pub const IXANY: u32 = 0o4000;
    pub const IUTF8: u32 = 0o40000;

    pub const OPOST: u32 = 0o1;
    pub const ONLCR: u32 = 0o4;
    pub const OCRNL: u32 = 0o10;

    pub const CSIZE: u32 = 0o60;
    pub const CS8: u32 = 0o60;
    pub const PARENB: u32 = 0o400;

    pub const ISIG: u32 = 0o1;
    pub const ICANON: u32 = 0o2;
    pub const ECHO: u32 = 0o10;
    pub const ECHOE: u32 = 0o20;
    pub const ECHOK: u32 = 0o40;
    pub const ECHONL: u32 = 0o100;
    pub const NOFLSH: u32 = 0o200;
    pub const ECHOCTL: u32 = 0o1000;
    pub const ECHOKE: u32 = 0o4000;
    pub const IEXTEN: u32 = 0o100000;

    pub const VINTR: usize = 0;
    pub const VQUIT: usize = 1;
    pub const VERASE: usize = 2;
    pub const VKILL: usize = 3;
    pub const VEOF: usize = 4;
    pub const VTIME: usize = 5;
    pub const VMIN: usize = 6;
    pub const VSTART: usize = 8;
    pub const VSTOP: usize = 9;
    pub const VSUSP: usize = 10;
    pub const VEOL: usize = 11;
    pub const VREPRINT: usize = 12;
    pub const VWERASE: usize = 14;
    pub const VLNEXT: usize = 15;
    pub const VEOL2: usize = 16;

    pub const TCSANOW: u32 = 0;
    pub const TCSADRAIN: u32 = 1;
    pub const TCSAFLUSH: u32 = 2;

    pub fn tcgetattr(fd: RawFd) -> io::Result<Termios> {
        let mut termios = std::mem::MaybeUninit::<Termios>::zeroed();
        check(unsafe { raw::tcgetattr(fd as u32, termios.as_mut_ptr()) })?;
        Ok(unsafe { termios.assume_init() })
    }

    pub fn tcsetattr(fd: RawFd, action: u32, termios: &Termios) -> io::Result<()> {
        check(unsafe { raw::tcsetattr(fd as u32, action, termios) })
    }

    /// `cfmakeraw(3)`.
    pub fn cfmakeraw(termios: &mut Termios) {
        termios.c_iflag &= !(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL | IXON);
        termios.c_oflag &= !OPOST;
        termios.c_lflag &= !(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
        termios.c_cflag &= !(CSIZE | PARENB);
        termios.c_cflag |= CS8;
        termios.c_cc[VMIN] = 1;
        termios.c_cc[VTIME] = 0;
    }

    /// `ioctl(fd, TIOCGWINSZ)`.
    pub fn winsize(fd: RawFd) -> io::Result<Winsize> {
        let mut winsize = Winsize::default();
        check(unsafe { raw::winsize_get(fd as u32, &mut winsize) })?;
        Ok(winsize)
    }

    /// True when `fd` refers to the terminal.
    pub fn isatty(fd: RawFd) -> bool {
        tcgetattr(fd).is_ok()
    }
}

pub mod signal {
    use super::{check, raw, RawFd};
    use std::fs::File;
    use std::io::{self, Read};
    use std::os::fd::{AsRawFd, FromRawFd};

    pub const SIGHUP: u32 = 1;
    pub const SIGINT: u32 = 2;
    pub const SIGQUIT: u32 = 3;
    pub const SIGTERM: u32 = 15;
    pub const SIGTSTP: u32 = 20;
    pub const SIGWINCH: u32 = 28;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    #[repr(u32)]
    pub enum Action {
        /// The signal's default action (terminate for INT/QUIT/TERM/HUP, nothing for WINCH/TSTP).
        Default = 0,
        Ignore = 1,
        /// Queue the signal for reading from a [`Signals`] descriptor. A blocking
        /// terminal read that is in progress fails with `ErrorKind::Interrupted`.
        Catch = 2,
    }

    /// Sets the disposition of `signo`, returning the previous one.
    pub fn action(signo: u32, action: Action) -> io::Result<Action> {
        let mut old = 0u32;
        check(unsafe { raw::sig_action(signo, action as u32, &mut old) })?;
        Ok(match old {
            1 => Action::Ignore,
            2 => Action::Catch,
            _ => Action::Default,
        })
    }

    /// A signalfd-style descriptor: readable (and pollable) when one of the
    /// signals it was opened for has been caught. Each record is one
    /// little-endian `u32` signal number. Several descriptors may watch the
    /// same signal; each gets its own copy.
    #[derive(Debug)]
    pub struct Signals {
        file: File,
    }

    impl Signals {
        /// Sets each of `signals` to [`Action::Catch`] and opens a
        /// non-blocking descriptor that receives them.
        pub fn new(signals: &[u32]) -> io::Result<Signals> {
            let mut mask = 0u32;
            for &signo in signals {
                action(signo, Action::Catch)?;
                mask |= 1 << signo;
            }
            let mut fd = 0u32;
            check(unsafe { raw::sig_fd(mask, &mut fd) })?;
            super::set_nonblocking(fd as RawFd, true)?;
            Ok(Signals { file: unsafe { File::from_raw_fd(fd as RawFd) } })
        }

        /// Returns the signals caught since the last call, without blocking.
        pub fn pending(&mut self) -> io::Result<Vec<u32>> {
            let mut buf = [0u8; 64];
            match self.file.read(&mut buf) {
                Ok(n) => Ok(buf[..n].chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(Vec::new()),
                Err(error) => Err(error),
            }
        }
    }

    impl AsRawFd for Signals {
        fn as_raw_fd(&self) -> RawFd {
            self.file.as_raw_fd()
        }
    }
}

pub mod poll {
    use super::{check, raw, RawFd};
    use std::io;
    use std::time::Duration;

    /// One descriptor to wait on for readability.
    #[derive(Clone, Copy, Debug)]
    pub struct PollFd {
        pub fd: RawFd,
        /// Set by [`poll`].
        pub readable: bool,
    }

    impl PollFd {
        pub fn new(fd: RawFd) -> PollFd {
            PollFd { fd, readable: false }
        }
    }

    const SUBSCRIPTION_SIZE: usize = 48;
    const EVENT_SIZE: usize = 32;
    const TIMEOUT_USERDATA: u64 = u64::MAX;

    /// Waits until at least one descriptor is readable or the timeout passes
    /// (`None` = wait forever). Returns the number of readable descriptors;
    /// 0 means the timeout expired.
    ///
    /// Works for the terminal, [`super::signal::Signals`], WebSockets and HTTP
    /// responses alike, which is how a single-threaded event loop multiplexes
    /// keyboard input, resizes, timers and the network.
    pub fn poll(fds: &mut [PollFd], timeout: Option<Duration>) -> io::Result<usize> {
        let count = fds.len() + usize::from(timeout.is_some());
        if count == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "poll: nothing to wait for"));
        }
        let mut subs = vec![0u8; count * SUBSCRIPTION_SIZE];
        for (index, fd) in fds.iter_mut().enumerate() {
            fd.readable = false;
            let sub = &mut subs[index * SUBSCRIPTION_SIZE..];
            sub[0..8].copy_from_slice(&(index as u64).to_le_bytes());
            sub[8] = 1; // EVENTTYPE_FD_READ
            sub[16..20].copy_from_slice(&(fd.fd as u32).to_le_bytes());
        }
        if let Some(timeout) = timeout {
            let sub = &mut subs[fds.len() * SUBSCRIPTION_SIZE..];
            sub[0..8].copy_from_slice(&TIMEOUT_USERDATA.to_le_bytes());
            sub[8] = 0; // EVENTTYPE_CLOCK
            sub[16..20].copy_from_slice(&1u32.to_le_bytes()); // CLOCKID_MONOTONIC
            let nanos = u64::try_from(timeout.as_nanos()).unwrap_or(u64::MAX);
            sub[24..32].copy_from_slice(&nanos.to_le_bytes());
        }
        let mut events = vec![0u8; count * EVENT_SIZE];
        let mut nevents = 0u32;
        check(unsafe { raw::poll_oneoff(subs.as_ptr(), events.as_mut_ptr(), count as u32, &mut nevents) })?;
        let mut ready = 0;
        for event in events.chunks_exact(EVENT_SIZE).take(nevents as usize) {
            let userdata = u64::from_le_bytes(event[0..8].try_into().unwrap());
            if userdata != TIMEOUT_USERDATA {
                fds[userdata as usize].readable = true;
                ready += 1;
            }
        }
        Ok(ready)
    }
}

/// Waits until `fd` takes a write or the timeout passes (`None` = wait forever): whether it
/// does. Only a TCP stream ([`net::TcpStream`]) and plain files ever do; the other network
/// descriptors never poll writable.
pub fn poll_writable(fd: RawFd, timeout: Option<Duration>) -> io::Result<bool> {
    let count = 1 + usize::from(timeout.is_some());
    let mut subs = vec![0u8; count * 48];
    subs[8] = 2; // EVENTTYPE_FD_WRITE
    subs[16..20].copy_from_slice(&(fd as u32).to_le_bytes());
    if let Some(timeout) = timeout {
        let sub = &mut subs[48..];
        sub[0..8].copy_from_slice(&u64::MAX.to_le_bytes());
        sub[16..20].copy_from_slice(&1u32.to_le_bytes()); // CLOCKID_MONOTONIC
        sub[24..32].copy_from_slice(&u64::try_from(timeout.as_nanos()).unwrap_or(u64::MAX).to_le_bytes());
    }
    let mut events = vec![0u8; count * 32];
    let mut nevents = 0u32;
    check(unsafe { raw::poll_oneoff(subs.as_ptr(), events.as_mut_ptr(), count as u32, &mut nevents) })?;
    Ok(events.chunks_exact(32).take(nevents as usize).any(|event| event[0..8] == [0u8; 8]))
}

pub mod net {
    use super::{check, last_error, raw, RawFd, ERRNO_AGAIN, ERRNO_RANGE};
    use std::fs::File;
    use std::io::{self, Read};
    use std::os::fd::{AsRawFd, FromRawFd};

    fn net_error(errno: u32) -> io::Error {
        let os = io::Error::from_raw_os_error(errno as i32);
        let detail = last_error();
        if errno == 29 && !detail.is_empty() {
            io::Error::new(os.kind(), detail)
        } else {
            os
        }
    }

    /// One event from a WebSocket, in arrival order.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum WsEvent {
        /// The handshake completed; carries the negotiated subprotocol (may be empty).
        Open(String),
        Text(String),
        Binary(Vec<u8>),
        /// The connection closed. No further events follow.
        Close { code: u16, reason: String },
        /// The connection failed. No further events follow.
        Error(String),
    }

    /// A WebSocket client connection. The descriptor is pollable: it is
    /// readable whenever [`WebSocket::try_recv`] would return an event.
    #[derive(Debug)]
    pub struct WebSocket {
        fd: RawFd,
        buf: Vec<u8>,
    }

    impl WebSocket {
        /// Starts connecting. Returns immediately; the first event is
        /// [`WsEvent::Open`] or [`WsEvent::Error`]. Messages sent before the
        /// handshake completes are held and sent once it does.
        pub fn connect(url: &str, protocols: &[&str]) -> io::Result<WebSocket> {
            let protocols = protocols.join(",");
            let mut fd = 0u32;
            let errno = unsafe {
                raw::ws_open(url.as_ptr(), url.len() as u32, protocols.as_ptr(), protocols.len() as u32, &mut fd)
            };
            if errno != 0 {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, last_error()));
            }
            Ok(WebSocket { fd: fd as RawFd, buf: vec![0; 16 * 1024] })
        }

        pub fn send_text(&self, text: &str) -> io::Result<()> {
            check(unsafe { raw::ws_send(self.fd as u32, 2, text.as_ptr(), text.len() as u32) })
        }

        pub fn send_binary(&self, data: &[u8]) -> io::Result<()> {
            check(unsafe { raw::ws_send(self.fd as u32, 3, data.as_ptr(), data.len() as u32) })
        }

        /// Starts the closing handshake; a [`WsEvent::Close`] follows.
        pub fn close(&self, code: u16, reason: &str) -> io::Result<()> {
            check(unsafe { raw::ws_close(self.fd as u32, code as u32, reason.as_ptr(), reason.len() as u32) })
        }

        fn recv_inner(&mut self, flags: u32) -> io::Result<Option<WsEvent>> {
            loop {
                let mut out = [0u32; 2];
                let errno = unsafe {
                    raw::ws_recv(self.fd as u32, self.buf.as_mut_ptr(), self.buf.len() as u32, &mut out, flags)
                };
                let [kind, len] = out;
                match errno {
                    0 => {}
                    ERRNO_AGAIN => return Ok(None),
                    ERRNO_RANGE => {
                        self.buf.resize(len as usize, 0);
                        continue;
                    }
                    other => return Err(io::Error::from_raw_os_error(other as i32)),
                }
                let data = &self.buf[..len as usize];
                let text = || String::from_utf8_lossy(data).into_owned();
                return Ok(Some(match kind {
                    1 => WsEvent::Open(text()),
                    2 => WsEvent::Text(text()),
                    3 => WsEvent::Binary(data.to_vec()),
                    4 => WsEvent::Close {
                        code: u16::from_le_bytes([data[0], data[1]]),
                        reason: String::from_utf8_lossy(&data[2..]).into_owned(),
                    },
                    _ => WsEvent::Error(text()),
                }));
            }
        }

        /// Blocks until the next event. After `Close`/`Error` has been
        /// returned, fails with `ErrorKind::NotConnected`.
        pub fn recv(&mut self) -> io::Result<WsEvent> {
            Ok(self.recv_inner(0)?.expect("blocking ws_recv returned EAGAIN"))
        }

        /// Returns the next event if one is queued.
        pub fn try_recv(&mut self) -> io::Result<Option<WsEvent>> {
            self.recv_inner(1)
        }
    }

    impl AsRawFd for WebSocket {
        fn as_raw_fd(&self) -> RawFd {
            self.fd
        }
    }

    impl Drop for WebSocket {
        fn drop(&mut self) {
            drop(unsafe { File::from_raw_fd(self.fd) });
        }
    }

    /// An HTTP request in flight (browser `fetch`). The descriptor is pollable:
    /// readable when the response head has arrived, and after that whenever
    /// body bytes (or end of body) are available.
    #[derive(Debug)]
    pub struct HttpRequest {
        file: File,
    }

    #[derive(Debug)]
    pub struct HttpResponse {
        pub status: u16,
        /// Lower-cased names, in the order the browser reports them.
        pub headers: Vec<(String, String)>,
        /// The response body as a byte stream. `read` returns data as it
        /// arrives from the network, so server-sent events and other
        /// streaming bodies can be consumed incrementally; 0 means end of body.
        pub body: File,
    }

    impl HttpResponse {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
        }
    }

    impl HttpRequest {
        /// Sends a request. `headers` are (name, value) pairs; `body` may be empty.
        pub fn send(method: &str, url: &str, headers: &[(&str, &str)], body: &[u8]) -> io::Result<HttpRequest> {
            let header_text: String = headers.iter().map(|(name, value)| format!("{name}: {value}\n")).collect();
            let mut fd = 0u32;
            let errno = unsafe {
                raw::http_open(
                    method.as_ptr(),
                    method.len() as u32,
                    url.as_ptr(),
                    url.len() as u32,
                    header_text.as_ptr(),
                    header_text.len() as u32,
                    body.as_ptr(),
                    body.len() as u32,
                    &mut fd,
                )
            };
            if errno != 0 {
                return Err(net_error(errno));
            }
            Ok(HttpRequest { file: unsafe { File::from_raw_fd(fd as RawFd) } })
        }

        fn head(self, flags: u32) -> Result<io::Result<HttpResponse>, HttpRequest> {
            let mut buf = vec![0u8; 8 * 1024];
            loop {
                let mut out = [0u32; 2];
                let errno = unsafe {
                    raw::http_head(self.file.as_raw_fd() as u32, buf.as_mut_ptr(), buf.len() as u32, &mut out, flags)
                };
                let [status, len] = out;
                match errno {
                    0 => {}
                    ERRNO_AGAIN => return Err(self),
                    ERRNO_RANGE => {
                        buf.resize(len as usize, 0);
                        continue;
                    }
                    other => return Ok(Err(net_error(other))),
                }
                let headers = String::from_utf8_lossy(&buf[..len as usize])
                    .lines()
                    .filter_map(|line| line.split_once(": ").map(|(k, v)| (k.to_string(), v.to_string())))
                    .collect();
                return Ok(Ok(HttpResponse { status: status as u16, headers, body: self.file }));
            }
        }

        /// Blocks until the response head arrives.
        pub fn response(self) -> io::Result<HttpResponse> {
            match self.head(0) {
                Ok(result) => result,
                Err(_) => unreachable!("blocking http_head returned EAGAIN"),
            }
        }

        /// Returns the response if its head has arrived, otherwise gives the request back.
        pub fn try_response(self) -> Result<io::Result<HttpResponse>, HttpRequest> {
            self.head(1)
        }
    }

    impl AsRawFd for HttpRequest {
        fn as_raw_fd(&self) -> RawFd {
            self.file.as_raw_fd()
        }
    }

    /// `tcp_connect` flag: readiness is reported by `poll_oneoff` once per change instead of
    /// for as long as it holds. What a reactor that caches readiness (tokio over mio) must ask
    /// for: a stream is writable nearly all the time, and reported level-triggered it would
    /// wake such a reactor on every pass.
    pub const TCP_EDGE: u32 = 1;

    /// A TCP connection, carried by the page's relay (docs/abi.md 3.3, "TCP"). The bytes are
    /// the program's own: the relay opens the connection and copies. A plain byte stream:
    /// `Read` and `Write` are `fd_read` and `fd_write` on the descriptor.
    ///
    /// Blocking by default. With [`super::set_nonblocking`], a read with nothing to return and
    /// a write the relay has no room for fail with `WouldBlock`; a write may take only part of
    /// its buffer. The descriptor polls readable and writable accordingly.
    #[derive(Debug)]
    pub struct TcpStream {
        file: File,
    }

    impl TcpStream {
        /// Starts connecting to `host:port` and returns at once. `host` is a name or an address;
        /// the relay resolves it and only connects to what its allowlist names. Writes wait for
        /// the connection (or fail with `WouldBlock`); [`TcpStream::status`] tells how it went.
        pub fn start(host: &str, port: u16, flags: u32) -> io::Result<TcpStream> {
            let mut fd = 0u32;
            let errno = unsafe { raw::tcp_connect(host.as_ptr(), host.len() as u32, port as u32, flags, &mut fd) };
            if errno != 0 {
                return Err(io::Error::new(io::Error::from_raw_os_error(errno as i32).kind(), last_error()));
            }
            Ok(TcpStream { file: unsafe { File::from_raw_fd(fd as RawFd) } })
        }

        /// Connects and waits for the connection: refused by the relay's allowlist is
        /// `PermissionDenied`, then `ConnectionRefused`, `TimedOut`, `HostUnreachable`.
        pub fn connect(host: &str, port: u16) -> io::Result<TcpStream> {
            let stream = TcpStream::start(host, port, 0)?;
            match stream.status(true)? {
                true => Ok(stream),
                false => unreachable!("blocking tcp_status returned EAGAIN"),
            }
        }

        /// `Ok(true)` once connected, `Ok(false)` while still connecting (only when not
        /// `wait`ing), the error if the connection failed, also later on.
        pub fn status(&self, wait: bool) -> io::Result<bool> {
            match unsafe { raw::tcp_status(self.file.as_raw_fd() as u32, if wait { 0 } else { 1 }) } {
                0 => Ok(true),
                ERRNO_AGAIN => Ok(false),
                errno => Err(tcp_error(errno)),
            }
        }

        /// Closes the sending side: the peer reads end of file, its data still arrives.
        pub fn shutdown_write(&self) -> io::Result<()> {
            check(unsafe { raw::sock_shutdown(self.file.as_raw_fd() as u32, 2) })
        }

        /// The descriptor, given up: the caller closes it.
        pub fn into_raw_fd(self) -> RawFd {
            std::os::fd::IntoRawFd::into_raw_fd(self.file)
        }
    }

    /// The errno with what the relay said about it.
    pub fn tcp_error(errno: u32) -> io::Error {
        let os = io::Error::from_raw_os_error(errno as i32);
        let detail = last_error();
        if detail.is_empty() { os } else { io::Error::new(os.kind(), detail) }
    }

    impl Read for TcpStream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.file.read(buf)
        }
    }

    impl io::Write for TcpStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            io::Write::write(&mut self.file, buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl AsRawFd for TcpStream {
        fn as_raw_fd(&self) -> RawFd {
            self.file.as_raw_fd()
        }
    }

    /// Convenience: performs a request and reads the whole body.
    pub fn fetch(method: &str, url: &str, headers: &[(&str, &str)], body: &[u8]) -> io::Result<(u16, Vec<u8>)> {
        let mut response = HttpRequest::send(method, url, headers, body)?.response()?;
        let mut data = Vec::new();
        response.body.read_to_end(&mut data).map_err(|error| {
            if error.raw_os_error() == Some(29) {
                io::Error::new(error.kind(), last_error())
            } else {
                error
            }
        })?;
        Ok((response.status, data))
    }
}

/// Child processes: commands run in the host's shell (`proc_*`, docs/abi.md 3.4).
pub mod process {
    use super::{check, last_error, raw, RawFd, ERRNO_AGAIN, ERRNO_RANGE};
    use std::fs::File;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::time::Duration;

    pub const SIGINT: u32 = 2;
    pub const SIGKILL: u32 = 9;
    pub const SIGTERM: u32 = 15;

    /// What the host measured for a child that has ended.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Usage {
        /// From `spawn` until a shell picked the command up.
        pub queued: Duration,
        /// From then until it ended.
        pub ran: Duration,
        /// Host calls (file operations, writes) the shell made.
        pub host_calls: u32,
    }

    /// One event from a child, in the order they happened.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum ChildEvent {
        Stdout(Vec<u8>),
        Stderr(Vec<u8>),
        /// The child ended; no further events follow. `status` is its exit
        /// status, 128 + `signal` when a signal ended it (`signal` 0 otherwise).
        Exit { status: i32, signal: i32, usage: Usage },
    }

    /// A running command. The descriptor is pollable: readable whenever
    /// [`Child::try_recv`] would return an event. Dropping it kills the child.
    #[derive(Debug)]
    pub struct Child {
        fd: RawFd,
        buf: Vec<u8>,
    }

    impl Child {
        /// Starts `argv` (`["/bin/bash", "-lc", "<command line>"]`, or a command
        /// of the shell by itself) in `cwd` with exactly the environment `env`
        /// (`NAME=value` strings). Returns at once. With `stdin` the child's
        /// stdin stays open for [`Child::send`]; without, it reads end of file.
        pub fn spawn<A: AsRef<str>, E: AsRef<str>>(argv: &[A], cwd: &str, env: &[E], stdin: bool) -> io::Result<Child> {
            let mut request = Vec::new();
            let put = |request: &mut Vec<u8>, text: &str| {
                request.extend_from_slice(&(text.len() as u32).to_le_bytes());
                request.extend_from_slice(text.as_bytes());
            };
            request.extend_from_slice(&(argv.len() as u32).to_le_bytes());
            request.extend_from_slice(&(env.len() as u32).to_le_bytes());
            put(&mut request, cwd);
            argv.iter().for_each(|arg| put(&mut request, arg.as_ref()));
            env.iter().for_each(|pair| put(&mut request, pair.as_ref()));
            let mut fd = 0u32;
            let errno = unsafe { raw::proc_spawn(request.as_ptr(), request.len() as u32, u32::from(stdin), &mut fd) };
            if errno != 0 {
                let os = io::Error::from_raw_os_error(errno as i32);
                return Err(io::Error::new(os.kind(), last_error()));
            }
            Ok(Child { fd: fd as RawFd, buf: vec![0; 64 * 1024] })
        }

        fn recv_inner(&mut self, flags: u32) -> io::Result<Option<ChildEvent>> {
            loop {
                let mut out = [0u32; 2];
                let errno = unsafe { raw::proc_recv(self.fd as u32, self.buf.as_mut_ptr(), self.buf.len() as u32, &mut out, flags) };
                let [kind, len] = out;
                match errno {
                    0 => {}
                    ERRNO_AGAIN => return Ok(None),
                    ERRNO_RANGE => {
                        self.buf.resize(len as usize, 0);
                        continue;
                    }
                    other => return Err(io::Error::from_raw_os_error(other as i32)),
                }
                let data = &self.buf[..len as usize];
                let word = |at: usize| u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]);
                return Ok(Some(match kind {
                    1 => ChildEvent::Stdout(data.to_vec()),
                    2 => ChildEvent::Stderr(data.to_vec()),
                    _ => ChildEvent::Exit {
                        status: word(0) as i32,
                        signal: word(4) as i32,
                        usage: Usage {
                            queued: Duration::from_micros(u64::from(word(8))),
                            ran: Duration::from_micros(u64::from(word(12))),
                            host_calls: word(16),
                        },
                    },
                }));
            }
        }

        /// Blocks until the next event. After `Exit` has been returned, fails
        /// with `ErrorKind::NotConnected`.
        pub fn recv(&mut self) -> io::Result<ChildEvent> {
            Ok(self.recv_inner(0)?.expect("blocking proc_recv returned EAGAIN"))
        }

        /// Returns the next event if one is queued.
        pub fn try_recv(&mut self) -> io::Result<Option<ChildEvent>> {
            self.recv_inner(1)
        }

        /// Queues bytes for the child's stdin. Fails with `BrokenPipe` when
        /// stdin was not opened, has been closed, or the child has ended.
        pub fn send(&self, data: &[u8]) -> io::Result<()> {
            check(unsafe { raw::proc_send(self.fd as u32, data.as_ptr(), data.len() as u32, 0) })
        }

        /// Ends the child's stdin: it reads end of file after what was sent.
        pub fn close_stdin(&self) -> io::Result<()> {
            check(unsafe { raw::proc_send(self.fd as u32, [].as_ptr(), 0, 1) })
        }

        /// Sends [`SIGINT`], [`SIGTERM`] or [`SIGKILL`]: the child ends with
        /// status 128 + signal, at its next host call or within about 250 ms.
        pub fn signal(&self, signo: u32) -> io::Result<()> {
            check(unsafe { raw::proc_signal(self.fd as u32, signo) })
        }
    }

    impl AsRawFd for Child {
        fn as_raw_fd(&self) -> RawFd {
            self.fd
        }
    }

    impl Drop for Child {
        fn drop(&mut self) {
            drop(unsafe { File::from_raw_fd(self.fd) });
        }
    }
}
