//! wasm-term (wasm32-wasip1) support.
//!
//! crossterm's unix backend is reused as it is: the tty event source
//! (`event/source/unix/tty.rs`), its parser, the terminal mode code and the
//! cursor/keyboard queries all compile for wasi. What they need from the OS is
//! supplied here, under the names the unix code already uses, so the unix
//! files only differ in a few `use` lines:
//!
//! | unix code uses                         | on wasi it gets                      |
//! | -------------------------------------- | ------------------------------------ |
//! | `rustix::termios::{tcgetattr, ...}`    | [`termios`], over `wasm_term` imports |
//! | `filedescriptor::poll`                 | [`filedescriptor::poll`], over `poll_oneoff` |
//! | `signal_hook::low_level::pipe`         | [`signal_hook`], over a `wasm_term` signal descriptor |
//! | `std::os::unix::net::UnixStream` pairs | [`UnixStream`], see below            |
//!
//! Plain file-descriptor work (`rustix::io::read`, `isatty`, `FIONREAD`) uses
//! the real rustix, which supports wasi.

use std::{
    io,
    os::fd::{AsFd, AsRawFd, BorrowedFd, RawFd},
    sync::{
        Arc,
        atomic::{AtomicI32, Ordering},
    },
};

/// Stand-in for the socket pairs the tty event source uses as self-pipes.
///
/// There are two such pairs. The SIGWINCH one is handed to
/// [`signal_hook::low_level::pipe::register`], which binds both ends to a
/// wasm-term signal descriptor: the receiving end then polls readable when the
/// window is resized, exactly like the real pipe. The other pair backs
/// `Waker`, which exists to interrupt a blocked `try_read` from another
/// thread; wasm32-wasip1 has no threads, so that pair stays unbound and never
/// becomes readable.
#[derive(Debug, Clone)]
pub(crate) struct UnixStream {
    fd: Arc<AtomicI32>,
}

const UNBOUND: RawFd = -1;

impl UnixStream {
    pub(crate) fn pair() -> io::Result<(UnixStream, UnixStream)> {
        let fd = Arc::new(AtomicI32::new(UNBOUND));
        Ok((UnixStream { fd: fd.clone() }, UnixStream { fd }))
    }

    pub(crate) fn set_nonblocking(&self, _nonblocking: bool) -> io::Result<()> {
        // Signal descriptors are opened non-blocking; unbound ends have nothing to set.
        Ok(())
    }

    fn bind(&self, fd: RawFd) {
        self.fd.store(fd, Ordering::SeqCst);
    }
}

impl AsRawFd for UnixStream {
    fn as_raw_fd(&self) -> RawFd {
        self.fd.load(Ordering::SeqCst)
    }
}

impl AsFd for UnixStream {
    fn as_fd(&self) -> BorrowedFd<'_> {
        let fd = self.as_raw_fd();
        assert_ne!(fd, UNBOUND, "an unbound wake pipe never becomes readable, so it is never read");
        // The descriptor is leaked by `register`, so it outlives every borrow.
        unsafe { BorrowedFd::borrow_raw(fd) }
    }
}

impl io::Write for UnixStream {
    /// `Waker::wake` writes a byte to interrupt a poll on another thread.
    /// With a single thread nothing is ever blocked while this runs.
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) mod signal_hook {
    pub(crate) mod low_level {
        pub(crate) mod pipe {
            use super::super::super::UnixStream;
            use std::{io, os::fd::AsRawFd};

            /// Arranges for the receiving end of `sender`'s pair to become
            /// readable whenever `signal` is delivered.
            pub(crate) fn register(signal: i32, sender: UnixStream) -> io::Result<()> {
                let signals = wasm_term_sys::signal::Signals::new(&[signal as u32])?;
                sender.bind(signals.as_raw_fd());
                // The event source is a process-wide singleton and never unregisters.
                std::mem::forget(signals);
                Ok(())
            }
        }
    }
}

pub(crate) mod filedescriptor {
    use std::{io, time::Duration};
    use wasm_term_sys::poll::PollFd;

    pub(crate) const POLLIN: i16 = 1;

    #[allow(non_camel_case_types)]
    #[derive(Debug, Clone, Copy)]
    pub(crate) struct pollfd {
        pub(crate) fd: i32,
        pub(crate) events: i16,
        pub(crate) revents: i16,
    }

    #[derive(Debug)]
    #[allow(dead_code)]
    pub(crate) enum Error {
        Poll(io::Error),
        Io(io::Error),
        Other,
    }

    /// `poll(2)` for readability. As with `poll(2)`, negative descriptors are ignored.
    pub(crate) fn poll(fds: &mut [pollfd], timeout: Option<Duration>) -> Result<usize, Error> {
        let mut watched: Vec<(usize, PollFd)> = Vec::with_capacity(fds.len());
        for (index, fd) in fds.iter_mut().enumerate() {
            fd.revents = 0;
            if fd.fd >= 0 && fd.events & POLLIN != 0 {
                watched.push((index, PollFd::new(fd.fd)));
            }
        }
        let mut poll_fds: Vec<PollFd> = watched.iter().map(|(_, fd)| *fd).collect();
        let ready = wasm_term_sys::poll::poll(&mut poll_fds, timeout).map_err(Error::Poll)?;
        for ((index, _), polled) in watched.iter().zip(&poll_fds) {
            if polled.readable {
                fds[*index].revents = POLLIN;
            }
        }
        Ok(ready)
    }
}

/// The subset of `rustix::termios` the terminal backend uses.
pub(crate) mod termios {
    use std::{
        io,
        os::fd::{AsFd, AsRawFd},
    };
    use wasm_term_sys::termios as sys;

    pub(crate) use sys::Winsize;

    #[derive(Debug, Clone)]
    pub(crate) struct Termios(sys::Termios);

    impl Termios {
        pub(crate) fn make_raw(&mut self) {
            sys::cfmakeraw(&mut self.0);
        }
    }

    #[allow(dead_code)]
    pub(crate) enum OptionalActions {
        Now = sys::TCSANOW as isize,
        Drain = sys::TCSADRAIN as isize,
        Flush = sys::TCSAFLUSH as isize,
    }

    pub(crate) fn tcgetattr(fd: impl AsFd) -> io::Result<Termios> {
        sys::tcgetattr(fd.as_fd().as_raw_fd()).map(Termios)
    }

    pub(crate) fn tcsetattr(fd: impl AsFd, actions: OptionalActions, termios: &Termios) -> io::Result<()> {
        sys::tcsetattr(fd.as_fd().as_raw_fd(), actions as u32, &termios.0)
    }

    pub(crate) fn tcgetwinsize(fd: impl AsFd) -> io::Result<Winsize> {
        sys::winsize(fd.as_fd().as_raw_fd())
    }
}
