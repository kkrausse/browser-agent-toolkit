//! C-ABI exports used by the TypeScript host (`host/kernel.ts`).
//!
//! The host and the guest have separate linear memories, so data crosses in a
//! fixed scratch buffer inside the kernel's memory: the host copies into
//! `k_buf()` before a write-like call and out of it after a read-like call.
//! All calls happen on the program's worker thread.

use crate::pty::{Pty, ReadResult};
use crate::termios::{Termios, Winsize, TERMIOS_SIZE};
use std::cell::UnsafeCell;

pub const BUF_SIZE: usize = 64 * 1024;

struct Kernel {
    buf: [u8; BUF_SIZE],
    ptys: Vec<Pty>,
    read_deadline: f64,
}

struct Global(UnsafeCell<Option<Box<Kernel>>>);
// The kernel instance is only ever touched from one thread.
unsafe impl Sync for Global {}
static KERNEL: Global = Global(UnsafeCell::new(None));

#[allow(clippy::mut_from_ref)]
fn k() -> &'static mut Kernel {
    unsafe {
        (*KERNEL.0.get()).get_or_insert_with(|| {
            Box::new(Kernel { buf: [0; BUF_SIZE], ptys: Vec::new(), read_deadline: -1.0 })
        })
    }
}

/// Address of the scratch buffer.
#[no_mangle]
pub extern "C" fn k_buf() -> *mut u8 {
    k().buf.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn k_buf_size() -> u32 {
    BUF_SIZE as u32
}

/// Creates a pty and returns its id.
#[no_mangle]
pub extern "C" fn pty_new(cols: u32, rows: u32) -> u32 {
    let k = k();
    k.ptys.push(Pty::new(cols as u16, rows as u16));
    (k.ptys.len() - 1) as u32
}

/// Terminal → line discipline: `len` bytes from the scratch buffer.
#[no_mangle]
pub extern "C" fn pty_master_write(id: u32, len: u32, now_ms: f64) {
    let k = k();
    let len = (len as usize).min(BUF_SIZE);
    k.ptys[id as usize].master_write(&k.buf[..len], now_ms);
}

/// Line discipline → terminal: fills the scratch buffer, returns the count.
#[no_mangle]
pub extern "C" fn pty_master_read(id: u32) -> u32 {
    let k = k();
    k.ptys[id as usize].master_read(&mut k.buf) as u32
}

#[no_mangle]
pub extern "C" fn pty_master_pending(id: u32) -> u32 {
    k().ptys[id as usize].master_pending() as u32
}

/// Program output: `len` bytes from the scratch buffer.
#[no_mangle]
pub extern "C" fn pty_slave_write(id: u32, len: u32) -> u32 {
    let k = k();
    let len = (len as usize).min(BUF_SIZE);
    k.ptys[id as usize].write(&k.buf[..len]) as u32
}

/// Marks the start of a slave `read` (starts a VMIN=0 VTIME>0 timer).
#[no_mangle]
pub extern "C" fn pty_slave_read_begin(id: u32, now_ms: f64) {
    k().ptys[id as usize].read_begin(now_ms);
}

/// Attempts a slave `read` of up to `cap` bytes into the scratch buffer.
/// Returns the byte count (0 = EOF or expired timer), or -1 when the read
/// would block; `pty_read_deadline()` then gives the time to retry at, or a
/// negative number when only new input can unblock it.
#[no_mangle]
pub extern "C" fn pty_slave_read(id: u32, cap: u32, now_ms: f64) -> i32 {
    let k = k();
    let cap = (cap as usize).min(BUF_SIZE);
    match k.ptys[id as usize].read(&mut k.buf[..cap], now_ms) {
        ReadResult::Data(n) => n as i32,
        ReadResult::Block(deadline) => {
            k.read_deadline = deadline.unwrap_or(-1.0);
            -1
        }
    }
}

#[no_mangle]
pub extern "C" fn pty_read_deadline() -> f64 {
    k().read_deadline
}

/// 1 when a slave `read` would not block.
#[no_mangle]
pub extern "C" fn pty_poll_in(id: u32) -> u32 {
    k().ptys[id as usize].poll_in() as u32
}

/// Writes the 44-byte termios struct into the scratch buffer.
#[no_mangle]
pub extern "C" fn pty_tcgetattr(id: u32) {
    let k = k();
    let bytes = k.ptys[id as usize].termios().to_bytes();
    k.buf[..TERMIOS_SIZE].copy_from_slice(&bytes);
}

/// Applies the 44-byte termios struct found in the scratch buffer.
#[no_mangle]
pub extern "C" fn pty_tcsetattr(id: u32, action: u32) {
    let k = k();
    let mut bytes = [0u8; TERMIOS_SIZE];
    bytes.copy_from_slice(&k.buf[..TERMIOS_SIZE]);
    k.ptys[id as usize].set_termios(action, Termios::from_bytes(&bytes));
}

/// Writes the 8-byte winsize struct into the scratch buffer.
#[no_mangle]
pub extern "C" fn pty_winsize_get(id: u32) {
    let k = k();
    let bytes = k.ptys[id as usize].winsize().to_bytes();
    k.buf[..bytes.len()].copy_from_slice(&bytes);
}

/// Master-side resize; raises SIGWINCH if the size changed.
#[no_mangle]
pub extern "C" fn pty_winsize_set(id: u32, cols: u32, rows: u32, xpixel: u32, ypixel: u32) {
    k().ptys[id as usize].set_winsize(Winsize {
        row: rows as u16,
        col: cols as u16,
        xpixel: xpixel as u16,
        ypixel: ypixel as u16,
    });
}

/// Returns and clears pending signals as a bitmask of `1 << signo`.
#[no_mangle]
pub extern "C" fn pty_take_signals(id: u32) -> u32 {
    k().ptys[id as usize].take_signals()
}

#[no_mangle]
pub extern "C" fn pty_hangup(id: u32) {
    k().ptys[id as usize].hangup();
}
