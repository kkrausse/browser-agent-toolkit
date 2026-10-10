//! tokio adapters for wasm-term descriptors.
//!
//! On wasm32-wasip1 tokio's reactor is mio over `poll_oneoff`, enabled with
//! `--cfg tokio_unstable` and the `net` feature. Every wasm-term descriptor
//! (terminal, signals, WebSocket, HTTP response) is pollable there, so one
//! `current_thread` runtime can wait on all of them and on timers at once.
//!
//! [`Readiness`] is the building block (an `AsyncFd` for wasi); [`WebSocket`]
//! and [`HttpResponse`] are the network primitives made async with it, and
//! [`Child`] a command running in the host's shell. [`TcpStream`] is a TCP
//! connection through the page's relay: a byte stream with `AsyncRead` and
//! `AsyncWrite`, for programs that bring their own protocols (TLS, HTTP).
#![cfg(target_os = "wasi")]

use std::fs::File;
use std::io::{self, Read};
use std::mem::ManuallyDrop;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, RawFd};
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, Interest, ReadBuf};
use tokio::net::TcpStream as TokioStream;
use wasm_term_sys::net;
pub use wasm_term_sys::net::WsEvent;
use wasm_term_sys::process;
pub use wasm_term_sys::process::{ChildEvent, Usage, SIGINT, SIGKILL, SIGTERM};

/// Async readability for a descriptor that something else owns.
///
/// tokio on wasi can only register TCP streams, so the descriptor is dressed
/// as one; it is never read or written through that type, and dropping the
/// `Readiness` deregisters it without closing it.
#[derive(Debug)]
pub struct Readiness {
    stream: ManuallyDrop<TokioStream>,
}

impl Readiness {
    /// Registers `fd` with the current runtime's reactor. Must be called
    /// inside a tokio runtime that has I/O enabled. `fd` must stay open for as
    /// long as this value lives, and must never poll writable (true of every
    /// wasm-term signal/WebSocket/HTTP descriptor and of a terminal opened
    /// read-only) or the reactor will spin.
    pub fn new(fd: RawFd) -> io::Result<Readiness> {
        let stream = TokioStream::from_std(unsafe { std::net::TcpStream::from_raw_fd(fd) })?;
        Ok(Readiness { stream: ManuallyDrop::new(stream) })
    }

    /// Waits until the descriptor is readable.
    pub async fn readable(&self) -> io::Result<()> {
        self.stream.readable().await
    }

    /// Call after a non-blocking read reported "would block", so that the next
    /// [`Readiness::readable`] waits for new data instead of returning at once.
    pub fn clear(&self) {
        let _ = self.stream.try_io(Interest::READABLE, || Err::<(), _>(io::ErrorKind::WouldBlock.into()));
    }
}

impl Drop for Readiness {
    fn drop(&mut self) {
        // Deregister, then give the descriptor back instead of closing it.
        let stream = unsafe { ManuallyDrop::take(&mut self.stream) };
        if let Ok(stream) = stream.into_std() {
            let _ = stream.into_raw_fd();
        }
    }
}

/// An async WebSocket client.
#[derive(Debug)]
pub struct WebSocket {
    // Declared first so it deregisters before `inner` closes the descriptor.
    ready: Readiness,
    inner: net::WebSocket,
}

impl WebSocket {
    /// Starts connecting; the first event from [`WebSocket::recv`] is
    /// `Open` or `Error`. Messages may be sent straight away.
    pub fn connect(url: &str, protocols: &[&str]) -> io::Result<WebSocket> {
        let inner = net::WebSocket::connect(url, protocols)?;
        Ok(WebSocket { ready: Readiness::new(inner.as_raw_fd())?, inner })
    }

    pub fn send_text(&self, text: &str) -> io::Result<()> {
        self.inner.send_text(text)
    }

    pub fn send_binary(&self, data: &[u8]) -> io::Result<()> {
        self.inner.send_binary(data)
    }

    pub fn close(&self, code: u16, reason: &str) -> io::Result<()> {
        self.inner.close(code, reason)
    }

    /// The next event. Cancel-safe: an event is only removed from the queue
    /// when it is returned.
    pub async fn recv(&mut self) -> io::Result<WsEvent> {
        loop {
            if let Some(event) = self.inner.try_recv()? {
                return Ok(event);
            }
            self.ready.clear();
            self.ready.readable().await?;
        }
    }
}

/// An HTTP response whose body is read asynchronously as it arrives.
#[derive(Debug)]
pub struct HttpResponse {
    ready: Readiness,
    body: File,
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

/// Sends a request and waits for the response head.
pub async fn http(method: &str, url: &str, headers: &[(&str, &str)], body: &[u8]) -> io::Result<HttpResponse> {
    let mut request = net::HttpRequest::send(method, url, headers, body)?;
    let ready = Readiness::new(request.as_raw_fd())?;
    let response = loop {
        match request.try_response() {
            Ok(response) => break response?,
            Err(pending) => request = pending,
        }
        ready.clear();
        ready.readable().await?;
    };
    wasm_term_sys::set_nonblocking(response.body.as_raw_fd(), true)?;
    Ok(HttpResponse { ready, body: response.body, status: response.status, headers: response.headers })
}

impl HttpResponse {
    /// Reads the next piece of the body; 0 means the body is complete.
    /// Returns as soon as any bytes are available, which is what makes
    /// server-sent events and other streamed responses usable.
    pub async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            match self.body.read(buf) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.raw_os_error() == Some(29) => {
                    return Err(io::Error::new(error.kind(), wasm_term_sys::last_error()));
                }
                other => return other,
            }
            self.ready.clear();
            self.ready.readable().await?;
        }
    }
}

/// A command running in the host's shell, its output and exit status awaited
/// like any other descriptor. Dropping it kills the command.
#[derive(Debug)]
pub struct Child {
    // Declared first so it deregisters before `inner` closes the descriptor.
    ready: Readiness,
    inner: process::Child,
}

impl Child {
    /// See [`process::Child::spawn`]. Must be called inside a tokio runtime
    /// with I/O enabled. Returns at once; the command runs beside the caller.
    pub fn spawn<A: AsRef<str>, E: AsRef<str>>(argv: &[A], cwd: &str, env: &[E], stdin: bool) -> io::Result<Child> {
        let inner = process::Child::spawn(argv, cwd, env, stdin)?;
        Ok(Child { ready: Readiness::new(inner.as_raw_fd())?, inner })
    }

    /// The next event: output as the command produces it, then `Exit`.
    /// Cancel-safe: an event is only removed from the queue when it is returned.
    pub async fn recv(&mut self) -> io::Result<ChildEvent> {
        loop {
            if let Some(event) = self.inner.try_recv()? {
                return Ok(event);
            }
            self.ready.clear();
            self.ready.readable().await?;
        }
    }

    pub fn send(&self, data: &[u8]) -> io::Result<()> {
        self.inner.send(data)
    }

    pub fn close_stdin(&self) -> io::Result<()> {
        self.inner.close_stdin()
    }

    pub fn signal(&self, signo: u32) -> io::Result<()> {
        self.inner.signal(signo)
    }
}

/// A TCP connection through the page's relay (docs/abi.md 3.3, "TCP").
///
/// Unlike the other descriptors this one is written with `fd_write` and polls writable, so it
/// is a socket as far as tokio is concerned: the stream inside is tokio's own `TcpStream` on
/// the descriptor, and reads, writes and shutdown are tokio's. The descriptor is opened with
/// [`net::TCP_EDGE`]: the host reports readable and writable once per change, not for as long
/// as they hold. mio on wasi is level-triggered and tokio registers both directions, so a
/// stream that polled writable whenever it is (nearly always) would wake the runtime on every
/// pass; with edges the runtime sleeps until something happens, as it does on epoll.
#[derive(Debug)]
pub struct TcpStream {
    inner: TokioStream,
}

impl TcpStream {
    /// Connects to `host:port`; the relay resolves the name. Must be called inside a tokio
    /// runtime with I/O enabled. Errors: `PermissionDenied` (not in the relay's allowlist, or
    /// an address it does not connect to), `ConnectionRefused`, `TimedOut`, `HostUnreachable`.
    pub async fn connect(host: &str, port: u16) -> io::Result<TcpStream> {
        let stream = net::TcpStream::start(host, port, net::TCP_EDGE)?;
        wasm_term_sys::set_nonblocking(stream.as_raw_fd(), true)?;
        let fd = stream.as_raw_fd();
        // From here the descriptor belongs to tokio's stream, which closes it.
        let inner = TokioStream::from_std(unsafe { std::net::TcpStream::from_raw_fd(stream.into_raw_fd()) })?;
        loop {
            // The first writable edge is the connection being established, or having failed.
            inner.writable().await?;
            match unsafe { wasm_term_sys::raw::tcp_status(fd as u32, 1) } {
                0 => return Ok(TcpStream { inner }),
                wasm_term_sys::ERRNO_AGAIN => {
                    let _ = inner.try_io(Interest::WRITABLE, || Err::<(), _>(io::ErrorKind::WouldBlock.into()));
                }
                errno => return Err(net::tcp_error(errno)),
            }
        }
    }

    /// tokio's stream on the descriptor, for code that names `tokio::net::TcpStream`.
    pub fn into_inner(self) -> TokioStream {
        self.inner
    }
}

impl AsRawFd for TcpStream {
    fn as_raw_fd(&self) -> RawFd {
        self.inner.as_raw_fd()
    }
}

impl AsyncRead for TcpStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for TcpStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    /// Closes the sending side; the peer's data still arrives.
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
