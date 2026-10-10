//! tokio adapters for wasm-term descriptors.
//!
//! On wasm32-wasip1 tokio's reactor is mio over `poll_oneoff`, enabled with
//! `--cfg tokio_unstable` and the `net` feature. Every wasm-term descriptor
//! (terminal, signals, WebSocket, HTTP response) is pollable there, so one
//! `current_thread` runtime can wait on all of them and on timers at once.
//!
//! [`Readiness`] is the building block (an `AsyncFd` for wasi); [`WebSocket`]
//! and [`HttpResponse`] are the network primitives made async with it.
#![cfg(target_os = "wasi")]

use std::fs::File;
use std::io::{self, Read};
use std::mem::ManuallyDrop;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, RawFd};

use tokio::io::Interest;
use tokio::net::TcpStream;
use wasm_term_sys::net;
pub use wasm_term_sys::net::WsEvent;

/// Async readability for a descriptor that something else owns.
///
/// tokio on wasi can only register TCP streams, so the descriptor is dressed
/// as one; it is never read or written through that type, and dropping the
/// `Readiness` deregisters it without closing it.
#[derive(Debug)]
pub struct Readiness {
    stream: ManuallyDrop<TcpStream>,
}

impl Readiness {
    /// Registers `fd` with the current runtime's reactor. Must be called
    /// inside a tokio runtime that has I/O enabled. `fd` must stay open for as
    /// long as this value lives, and must never poll writable (true of every
    /// wasm-term signal/WebSocket/HTTP descriptor and of a terminal opened
    /// read-only) or the reactor will spin.
    pub fn new(fd: RawFd) -> io::Result<Readiness> {
        let stream = TcpStream::from_std(unsafe { std::net::TcpStream::from_raw_fd(fd) })?;
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
