//! `EventStream` for wasm-term (wasm32-wasip1).
//!
//! The portable implementation parks a helper thread in a blocking
//! `poll(None)` and has it wake the stream's task. wasm32-wasip1 has no
//! threads, so here the async runtime's reactor does the waiting instead: the
//! stream registers the terminal and a SIGWINCH descriptor with tokio's I/O
//! driver (mio over `poll_oneoff`), and when either becomes readable it runs
//! the ordinary event reader, which then finds its input without blocking.
//!
//! Requirements, both met by a normal `#[tokio::main(flavor = "current_thread")]`
//! program built with `--cfg tokio_unstable`:
//! - the stream is created and polled inside a tokio runtime with I/O enabled;
//! - nothing else calls the blocking `event::read()` concurrently.

use std::{
    fs::File,
    io,
    os::fd::{AsRawFd, FromRawFd, IntoRawFd},
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use futures_core::stream::Stream;
use tokio::{io::Interest, net::TcpStream};

use crate::event::{
    Event,
    filter::EventFilter,
    internal::{self, InternalEvent},
};

/// A stream of `Result<Event>`.
///
/// **This type is not available by default. You have to use the `event-stream` feature flag
/// to make it available.**
///
/// It implements the [Stream](futures_core::stream::Stream) trait.
#[derive(Debug)]
pub struct EventStream {
    /// Read-only handle on the terminal, used only to learn when input is
    /// ready. Read-only matters: a descriptor open for writing always polls
    /// writable, and tokio registers both directions.
    tty: TcpStream,
    /// Becomes readable on SIGWINCH. The event source has its own descriptor
    /// for the signal and produces `Event::Resize` from it; this one only
    /// wakes the task.
    winch: TcpStream,
}

/// Hands a descriptor to tokio's reactor. tokio on wasi only knows how to
/// register TCP streams; the type is used here purely for readiness and is
/// never read or written as a socket.
fn register(fd: std::os::fd::RawFd) -> io::Result<TcpStream> {
    TcpStream::from_std(unsafe { std::net::TcpStream::from_raw_fd(fd) })
}

impl Default for EventStream {
    fn default() -> Self {
        Self::try_new().expect("EventStream needs a terminal and a tokio runtime with I/O enabled")
    }
}

impl EventStream {
    /// Constructs a new instance of `EventStream`.
    pub fn new() -> EventStream {
        EventStream::default()
    }

    fn try_new() -> io::Result<EventStream> {
        let tty = File::options().read(true).open("/dev/tty")?;
        wasm_term_sys::set_nonblocking(tty.as_raw_fd(), true)?;
        let winch = wasm_term_sys::signal::Signals::new(&[wasm_term_sys::signal::SIGWINCH])?;
        let winch_fd = winch.as_raw_fd();
        std::mem::forget(winch); // ownership moves to the TcpStream below
        Ok(EventStream { tty: register(tty.into_raw_fd())?, winch: register(winch_fd)? })
    }

    /// Tells tokio the descriptor is drained, so the next readiness is a new one.
    fn clear(stream: &TcpStream) {
        let _ = stream.try_io(Interest::READABLE, || Err::<(), _>(io::ErrorKind::WouldBlock.into()));
    }
}

impl Stream for EventStream {
    type Item = io::Result<Event>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            // Never blocks: hands out the next event an earlier read already
            // parsed, else reads whatever the terminal has ready (the wasi
            // source makes one pass even with a zero timeout). It must not
            // depend on a timeout still having time left: a 1 µs one had
            // usually expired before the source looked, by the clock's own
            // granularity, and the rest of a burst (a fast-typed line, key
            // repeat, wheel reports) then sat in the parser until the next
            // keystroke.
            match internal::poll(Some(Duration::ZERO), &EventFilter) {
                Ok(true) => {
                    return match internal::read(&EventFilter) {
                        Ok(InternalEvent::Event(event)) => Poll::Ready(Some(Ok(event))),
                        Err(error) => Poll::Ready(Some(Err(error))),
                        _ => unreachable!(),
                    };
                }
                Ok(false) => {}
                Err(error) => return Poll::Ready(Some(Err(error))),
            }

            let tty = self.tty.poll_read_ready(cx);
            let winch = self.winch.poll_read_ready(cx);
            match (tty, winch) {
                (Poll::Pending, Poll::Pending) => return Poll::Pending,
                (Poll::Ready(Err(error)), _) | (_, Poll::Ready(Err(error))) => {
                    return Poll::Ready(Some(Err(error)));
                }
                (tty, winch) => {
                    // Reported readable, yet the reader found no complete
                    // event: the readiness is stale (already consumed), or the
                    // bytes were only part of a sequence. Clear it and go
                    // around; the next `poll_read_ready` either parks the task
                    // or reports fresh input.
                    if tty.is_ready() {
                        Self::clear(&self.tty);
                    }
                    if winch.is_ready() {
                        let mut buf = [0u8; 64];
                        while matches!(self.winch.try_read(&mut buf), Ok(n) if n > 0) {}
                        Self::clear(&self.winch);
                    }
                }
            }
        }
    }
}
