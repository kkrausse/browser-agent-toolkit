//! The terminal device: a pty pair with a line discipline. The discipline is
//! `bat-pty`'s (`Pty`, plain single-owner Rust, written for wasm-term); here it
//! sits behind a kernel lock with wait queues and readiness subscriptions on
//! both ends, like a pipe's ring.
//!
//! The *master* end is the terminal emulator's (the page writes key bytes and
//! reads what to draw); the *slave* end is a process's stdin/stdout/stderr.
//! Signals the discipline raises (^C, a resize, hang-up) go to the terminal's
//! foreground process: the newest live process that was started on it. There
//! are no process groups or sessions.

use crate::errno::*;
use crate::fd::{post, Sub, POLLHUP, POLLIN, POLLOUT};
use crate::lock::{Mutex, WaitQ};
use crate::proc;
use crate::sys;
use crate::thread::can_block;
use std::sync::Arc;
use bat_pty::pty::{Pty, ReadResult};
use bat_pty::termios::{Termios, Winsize, TERMIOS_SIZE, WINSIZE_SIZE};

/// Output the terminal has not taken yet, above which a writer that may block waits.
const OUT_HIGH: usize = 1 << 20;
/// Processes remembered as started on one terminal (the oldest are forgotten).
const FG_MAX: usize = 64;

struct Inner {
    pty: Pty,
    master_open: bool,
    slave_open: bool,
    /// Pids started with this terminal as stdin, oldest first.
    fg: Vec<u32>,
    m_subs: Vec<Sub>,
    s_subs: Vec<Sub>,
}

pub struct Tty {
    inner: Mutex<Inner>,
    /// Slave readers: input arrived, the mode changed, the master went away.
    rq: WaitQ,
    /// Slave writers: the terminal took output.
    wq: WaitQ,
    /// Master readers: there is output, or no slave is left.
    mq: WaitQ,
}

fn add_sub(subs: &mut Vec<Sub>, s: Sub) {
    subs.retain(|x| !(x.proc.pid == s.proc.pid && x.token == s.token && x.queue == s.queue));
    subs.push(s);
}
fn remove_sub(subs: &mut Vec<Sub>, pid: u32, token: u32, queue: bool) -> Vec<Sub> {
    let (gone, keep): (Vec<Sub>, Vec<Sub>) =
        core::mem::take(subs).into_iter().partition(|x| x.proc.pid == pid && x.token == token && x.queue == queue);
    *subs = keep;
    gone
}

impl Tty {
    pub fn new(cols: u16, rows: u16) -> Arc<Tty> {
        Arc::new(Tty {
            inner: Mutex::new(Inner {
                pty: Pty::new(cols, rows),
                master_open: true,
                slave_open: true,
                fg: Vec::new(),
                m_subs: Vec::new(),
                s_subs: Vec::new(),
            }),
            rq: WaitQ::new(),
            wq: WaitQ::new(),
            mq: WaitQ::new(),
        })
    }

    /// `pid` was started with this terminal as its stdin: it is the foreground process now.
    pub fn attach(&self, pid: u32) {
        let mut t = self.inner.lock();
        if t.fg.len() >= FG_MAX {
            t.fg.remove(0);
        }
        t.fg.push(pid);
    }

    /// Deliver the discipline's pending signals (a `1 << signo` mask).
    fn deliver(&self, sigs: u32) {
        if sigs == 0 {
            return;
        }
        let pids = self.inner.lock().fg.clone();
        for &pid in pids.iter().rev() {
            let mut alive = true;
            for s in 1..32 {
                if sigs & (1 << s) != 0 && proc::kill(pid, s).is_err() {
                    alive = false;
                    break;
                }
            }
            if alive {
                return;
            }
        }
    }

    /// What changed after the discipline took input or a new mode: tell both ends.
    fn after_input(&self, t: &mut Inner) -> u32 {
        if t.pty.poll_in() {
            post(&t.s_subs, POLLIN);
        }
        if t.pty.master_pending() > 0 {
            post(&t.m_subs, POLLIN);
        }
        t.pty.take_signals()
    }
    fn wake_all(&self) {
        self.rq.wake_all();
        self.wq.wake_all();
        self.mq.wake_all();
    }

    // ---- slave end (the program) ----

    pub fn read(&self, dst: &mut [u8], nonblock: bool) -> R<usize> {
        if dst.is_empty() {
            return Ok(0);
        }
        let mut begun = false;
        loop {
            let (seq, deadline);
            {
                let mut t = self.inner.lock();
                let now = sys::now_ms();
                if !begun {
                    t.pty.read_begin(now);
                    begun = true;
                }
                match t.pty.read(dst, now) {
                    ReadResult::Data(n) => return Ok(n),
                    ReadResult::Block(d) => deadline = d,
                }
                seq = self.rq.seq();
            }
            if nonblock || !can_block() {
                return Err(EAGAIN);
            }
            // A VTIME timer is running: look again when it expires.
            let timeout = deadline.map(|d| (d - sys::now_ms()).max(0.0)).unwrap_or(-1.0);
            self.rq.wait(seq, timeout);
        }
    }

    pub fn write(&self, src: &[u8], nonblock: bool) -> R<usize> {
        loop {
            let seq;
            {
                let mut t = self.inner.lock();
                if !t.master_open {
                    return Err(EIO);
                }
                if t.pty.output_len() < OUT_HIGH || nonblock || !can_block() {
                    t.pty.write(src);
                    if t.pty.master_pending() > 0 {
                        post(&t.m_subs, POLLIN);
                    }
                    drop(t);
                    self.mq.wake_all();
                    return Ok(src.len());
                }
                seq = self.wq.seq();
            }
            self.wq.wait(seq, -1.0);
        }
    }

    pub fn slave_state(&self) -> u32 {
        let t = self.inner.lock();
        let mut m = POLLOUT;
        if t.pty.poll_in() {
            m |= POLLIN;
        }
        if t.pty.is_hung_up() {
            m |= POLLHUP;
        }
        m
    }

    pub fn slave_closed(&self) {
        {
            let mut t = self.inner.lock();
            t.slave_open = false;
            post(&t.m_subs, POLLIN | POLLHUP);
        }
        self.mq.wake_all();
    }

    // ---- master end (the terminal emulator) ----

    /// Bytes typed at the terminal.
    pub fn master_write(&self, src: &[u8]) -> R<usize> {
        let sigs;
        {
            let mut t = self.inner.lock();
            t.pty.master_write(src, sys::now_ms());
            sigs = self.after_input(&mut t);
        }
        // Input for readers; echo for the terminal; ^Q or a signal's flush for writers.
        self.wake_all();
        self.deliver(sigs);
        Ok(src.len())
    }

    /// Bytes to draw. 0 once no slave is left and everything was taken.
    pub fn master_read(&self, dst: &mut [u8], nonblock: bool) -> R<usize> {
        if dst.is_empty() {
            return Ok(0);
        }
        loop {
            let seq;
            {
                let mut t = self.inner.lock();
                let n = t.pty.master_read(dst);
                if n > 0 {
                    drop(t);
                    self.wq.wake_all();
                    return Ok(n);
                }
                if !t.slave_open {
                    return Ok(0);
                }
                seq = self.mq.seq();
            }
            if nonblock || !can_block() {
                return Err(EAGAIN);
            }
            self.mq.wait(seq, -1.0);
        }
    }

    pub fn master_state(&self) -> u32 {
        let t = self.inner.lock();
        let mut m = POLLOUT;
        if t.pty.master_pending() > 0 {
            m |= POLLIN;
        }
        if !t.slave_open {
            m |= POLLIN | POLLHUP;
        }
        m
    }

    /// The terminal went away: readers see end of input, the foreground process gets SIGHUP.
    pub fn master_closed(&self) {
        let sigs;
        {
            let mut t = self.inner.lock();
            t.master_open = false;
            t.pty.hangup();
            sigs = t.pty.take_signals();
            post(&t.s_subs, POLLIN | POLLHUP);
        }
        self.wake_all();
        self.deliver(sigs);
    }

    // ---- either end ----

    pub fn subscribe(&self, master: bool, s: Sub) {
        let mut t = self.inner.lock();
        add_sub(if master { &mut t.m_subs } else { &mut t.s_subs }, s);
    }
    pub fn unsubscribe(&self, master: bool, pid: u32, token: u32, queue: bool) {
        // The subscriptions hold processes: dropped outside the lock.
        let old = {
            let mut t = self.inner.lock();
            remove_sub(if master { &mut t.m_subs } else { &mut t.s_subs }, pid, token, queue)
        };
        drop(old);
    }

    pub fn termios(&self) -> [u8; TERMIOS_SIZE] {
        self.inner.lock().pty.termios().to_bytes()
    }
    /// `tcsetattr`: action 0 now, 1 drain, 2 flush input first.
    pub fn set_termios(&self, action: u32, bytes: &[u8; TERMIOS_SIZE]) {
        let sigs;
        {
            let mut t = self.inner.lock();
            t.pty.set_termios(action, Termios::from_bytes(bytes));
            // Leaving canonical mode makes a half-typed line readable; leaving IXON restarts output.
            sigs = self.after_input(&mut t);
        }
        self.wake_all();
        self.deliver(sigs);
    }
    /// rows, cols, xpixel, ypixel as u16 each.
    pub fn winsize(&self) -> [u8; WINSIZE_SIZE] {
        self.inner.lock().pty.winsize().to_bytes()
    }
    /// A changed size raises SIGWINCH on the foreground process.
    pub fn set_winsize(&self, cols: u16, rows: u16, xpixel: u16, ypixel: u16) {
        let sigs = {
            let mut t = self.inner.lock();
            t.pty.set_winsize(Winsize { row: rows, col: cols, xpixel, ypixel });
            t.pty.take_signals()
        };
        self.deliver(sigs);
    }
}
