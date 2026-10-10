//! A pty pair with an N_TTY-style line discipline.
//!
//! The *master* side is the terminal emulator: bytes typed by the user go in
//! with [`Pty::master_write`], bytes to draw come out of [`Pty::master_read`].
//! The *slave* side is the program: [`Pty::read`] / [`Pty::write`].
//!
//! The behaviour follows Linux `drivers/tty/n_tty.c`; where this file makes a
//! choice, the comment names the Linux function it mirrors. Time is passed in
//! explicitly (milliseconds, any monotonic origin) so VMIN/VTIME is testable.

use crate::termios::*;
use std::collections::VecDeque;

/// Longest canonical line, as in Linux (`N_TTY_BUF_SIZE` - 1).
pub const MAX_CANON: usize = 4095;

// Per-byte marks in the read queue (Linux keeps these in `read_flags`).
const F_NONE: u8 = 0;
/// A line terminator that is delivered to the reader (NL, EOL, EOL2).
const F_EOL: u8 = 1;
/// The EOF character: ends the line, is consumed, is not delivered.
const F_EOF: u8 = 2;
/// Last byte of data that was pending when ICANON was switched on.
const F_PUSH: u8 = 3;

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum ReadResult {
    /// `n` bytes were copied. `Data(0)` is end-of-file (canonical ^D on an
    /// empty line, hangup) or an expired VTIME timer.
    Data(usize),
    /// Nothing to return yet. `Some(t)`: call again no later than time `t`
    /// (a VTIME timer is running). `None`: only new input can change this.
    Block(Option<f64>),
}

#[derive(Debug)]
pub struct Pty {
    termios: Termios,
    winsize: Winsize,
    rbuf: VecDeque<u8>,
    rflag: VecDeque<u8>,
    /// Number of bytes at the front of `rbuf` that belong to complete lines.
    canon_head: usize,
    /// Output column at which the echo of the current line started.
    canon_column: u32,
    lnext: bool,
    out: VecDeque<u8>,
    column: u32,
    stopped: bool,
    signals: u32,
    hangup: bool,
    last_input_ms: f64,
    read_start_ms: f64,
}

fn is_cntrl(c: u8) -> bool {
    c < 0x20 || c == 0x7f
}

fn is_continuation(c: u8) -> bool {
    c & 0xc0 == 0x80
}

impl Pty {
    pub fn new(cols: u16, rows: u16) -> Self {
        Pty {
            termios: Termios::default(),
            winsize: Winsize { row: rows, col: cols, xpixel: 0, ypixel: 0 },
            rbuf: VecDeque::new(),
            rflag: VecDeque::new(),
            canon_head: 0,
            canon_column: 0,
            lnext: false,
            out: VecDeque::new(),
            column: 0,
            stopped: false,
            signals: 0,
            hangup: false,
            last_input_ms: 0.0,
            read_start_ms: 0.0,
        }
    }

    fn l(&self, f: u32) -> bool {
        self.termios.lflag & f != 0
    }
    fn i(&self, f: u32) -> bool {
        self.termios.iflag & f != 0
    }
    fn o(&self, f: u32) -> bool {
        self.termios.oflag & f != 0
    }
    /// True when `c` is the control character in slot `idx` (and the slot is enabled).
    fn is_cc(&self, c: u8, idx: usize) -> bool {
        c != VDISABLE && self.termios.cc[idx] == c
    }

    // ---- termios / winsize / signals -------------------------------------

    pub fn termios(&self) -> Termios {
        self.termios
    }

    /// `tcsetattr`. Mirrors `n_tty_set_termios`.
    pub fn set_termios(&mut self, action: u32, new: Termios) {
        if action == TCSAFLUSH {
            self.flush_input();
        }
        let old = self.termios;
        self.termios = new;
        if (old.lflag ^ new.lflag) & ICANON != 0 {
            for f in self.rflag.iter_mut() {
                *f = F_NONE;
            }
            if self.l(ICANON) && !self.rbuf.is_empty() {
                // Data typed in raw mode becomes one already-complete line.
                *self.rflag.back_mut().unwrap() = F_PUSH;
                self.canon_head = self.rbuf.len();
            } else {
                self.canon_head = 0;
            }
            self.lnext = false;
        }
        if !self.i(IXON) {
            self.stopped = false;
        }
    }

    pub fn winsize(&self) -> Winsize {
        self.winsize
    }

    /// `TIOCSWINSZ` from the master side: raises SIGWINCH when the size changes.
    pub fn set_winsize(&mut self, ws: Winsize) {
        if ws != self.winsize {
            self.winsize = ws;
            self.signals |= 1 << SIGWINCH;
        }
    }

    /// Returns and clears the pending signals, as a bitmask of `1 << signo`.
    pub fn take_signals(&mut self) -> u32 {
        std::mem::take(&mut self.signals)
    }

    /// The master side went away: readers see EOF, SIGHUP is raised.
    pub fn hangup(&mut self) {
        if !self.hangup {
            self.hangup = true;
            self.signals |= 1 << SIGHUP;
        }
    }

    pub fn is_hung_up(&self) -> bool {
        self.hangup
    }

    fn flush_input(&mut self) {
        self.rbuf.clear();
        self.rflag.clear();
        self.canon_head = 0;
        self.lnext = false;
    }

    // ---- output processing ------------------------------------------------

    /// One byte towards the terminal, through OPOST. Mirrors `do_output_char`.
    fn oproc(&mut self, mut c: u8) {
        if !self.o(OPOST) {
            self.out.push_back(c);
            return;
        }
        match c {
            b'\n' => {
                if self.o(ONLRET) {
                    self.column = 0;
                }
                if self.o(ONLCR) {
                    self.column = 0;
                    self.canon_column = 0;
                    self.out.push_back(b'\r');
                }
            }
            b'\r' => {
                if self.o(ONOCR) && self.column == 0 {
                    return;
                }
                if self.o(OCRNL) {
                    c = b'\n';
                    if self.o(ONLRET) {
                        self.column = 0;
                        self.canon_column = 0;
                    }
                } else {
                    self.column = 0;
                    self.canon_column = 0;
                }
            }
            b'\t' => {
                let spaces = 8 - (self.column & 7);
                self.column += spaces;
                if self.termios.oflag & TABDLY == XTABS {
                    for _ in 0..spaces {
                        self.out.push_back(b' ');
                    }
                    return;
                }
            }
            0x08 => {
                if self.column > 0 {
                    self.column -= 1;
                }
            }
            _ => {
                if !is_cntrl(c) {
                    if self.o(OLCUC) {
                        c = c.to_ascii_uppercase();
                    }
                    if !is_continuation(c) {
                        self.column += 1;
                    }
                }
            }
        }
        self.out.push_back(c);
    }

    /// Program output. Never blocks; returns `data.len()`.
    pub fn write(&mut self, data: &[u8]) -> usize {
        if self.o(OPOST) {
            for &c in data {
                self.oproc(c);
            }
        } else {
            self.out.extend(data);
        }
        data.len()
    }

    /// Bytes for the terminal emulator. Returns 0 while output is stopped (^S).
    pub fn master_read(&mut self, buf: &mut [u8]) -> usize {
        if self.stopped {
            return 0;
        }
        let n = buf.len().min(self.out.len());
        for (dst, src) in buf.iter_mut().zip(self.out.drain(..n)) {
            *dst = src;
        }
        n
    }

    pub fn master_pending(&self) -> usize {
        if self.stopped {
            0
        } else {
            self.out.len()
        }
    }

    // ---- echo ---------------------------------------------------------------

    /// Mirrors `echo_char`: control characters show as `^X` under ECHOCTL.
    fn echo_char(&mut self, c: u8) {
        if self.l(ECHOCTL) && is_cntrl(c) && c != b'\t' {
            self.oproc(b'^');
            self.oproc(c ^ 0x40);
        } else {
            self.oproc(c);
        }
    }

    fn echo_erase_seq(&mut self) {
        self.oproc(0x08);
        self.oproc(b' ');
        self.oproc(0x08);
    }

    // ---- input processing -----------------------------------------------

    fn line_len(&self) -> usize {
        self.rbuf.len() - self.canon_head
    }

    fn push_input(&mut self, c: u8, flag: u8) {
        self.rbuf.push_back(c);
        self.rflag.push_back(flag);
        if flag != F_NONE {
            self.canon_head = self.rbuf.len();
        }
    }

    fn signal_char(&mut self, signo: u32, c: u8) {
        self.signals |= 1 << signo;
        if !self.l(NOFLSH) {
            self.flush_input();
            self.out.clear();
        }
        if self.i(IXON) {
            self.stopped = false;
        }
        if self.l(ECHO) {
            self.echo_char(c);
        }
    }

    /// Column at which the uncommitted byte at line offset `upto` was echoed.
    fn column_at(&self, upto: usize) -> u32 {
        let mut col = self.canon_column;
        for idx in 0..upto {
            let c = self.rbuf[self.canon_head + idx];
            if c == b'\t' {
                col = (col | 7) + 1;
            } else if is_cntrl(c) {
                if self.l(ECHOCTL) {
                    col += 2;
                }
            } else if !(self.i(IUTF8) && is_continuation(c)) {
                col += 1;
            }
        }
        col
    }

    /// ERASE / WERASE / KILL in canonical mode. Mirrors `eraser`.
    fn eraser(&mut self, c: u8) {
        #[derive(PartialEq)]
        enum Kind {
            Erase,
            Werase,
            Kill,
        }
        if self.line_len() == 0 {
            return;
        }
        let kind = if self.is_cc(c, VERASE) {
            Kind::Erase
        } else if self.is_cc(c, VWERASE) {
            Kind::Werase
        } else {
            if !self.l(ECHO) {
                self.rbuf.truncate(self.canon_head);
                self.rflag.truncate(self.canon_head);
                return;
            }
            if !self.l(ECHOK) || !self.l(ECHOKE) || !self.l(ECHOE) {
                self.rbuf.truncate(self.canon_head);
                self.rflag.truncate(self.canon_head);
                self.echo_char(c);
                // A newline follows the kill character if ECHOK is on and ECHOKE is off.
                if self.l(ECHOK) {
                    self.oproc(b'\n');
                }
                return;
            }
            Kind::Kill
        };

        let mut seen_alnums = false;
        while self.line_len() > 0 {
            // Step back over one character (a whole UTF-8 sequence under IUTF8).
            let mut head = self.rbuf.len();
            let mut ch;
            loop {
                head -= 1;
                ch = self.rbuf[head];
                if !(self.i(IUTF8) && is_continuation(ch) && head > self.canon_head) {
                    break;
                }
            }
            if self.i(IUTF8) && is_continuation(ch) {
                break; // do not partially erase a multibyte character
            }
            if kind == Kind::Werase {
                if ch.is_ascii_alphanumeric() || ch == b'_' {
                    seen_alnums = true;
                } else if seen_alnums {
                    break;
                }
            }
            let line_off = head - self.canon_head;
            if self.l(ECHO) {
                if kind == Kind::Erase && !self.l(ECHOE) {
                    self.echo_char(self.termios.cc[VERASE]);
                } else if ch == b'\t' {
                    let col = self.column_at(line_off);
                    let width = 8 - (col & 7);
                    for _ in 0..width {
                        self.oproc(0x08);
                    }
                } else {
                    if is_cntrl(ch) && self.l(ECHOCTL) {
                        self.echo_erase_seq();
                    }
                    if !is_cntrl(ch) || self.l(ECHOCTL) {
                        self.echo_erase_seq();
                    }
                }
            }
            self.rbuf.truncate(head);
            self.rflag.truncate(head);
            if kind == Kind::Erase {
                break;
            }
        }
    }

    /// One byte from the terminal. Mirrors `n_tty_receive_char*`.
    fn receive(&mut self, mut c: u8) {
        if self.i(ISTRIP) {
            c &= 0x7f;
        }
        if self.i(IUCLC) && self.l(IEXTEN) {
            c = c.to_ascii_lowercase();
        }

        if self.lnext {
            // The byte after VLNEXT is taken literally.
            self.lnext = false;
            if self.l(ECHO) {
                if self.line_len() == 0 {
                    self.canon_column = self.column;
                }
                self.echo_char(c);
            }
            if self.line_len() < MAX_CANON {
                self.push_input(c, F_NONE);
            }
            return;
        }

        if self.i(IXON) {
            if self.is_cc(c, VSTART) {
                self.stopped = false;
                return;
            }
            if self.is_cc(c, VSTOP) {
                self.stopped = true;
                return;
            }
        }
        if self.stopped && self.i(IXON) && self.i(IXANY) {
            self.stopped = false;
        }

        if self.l(ISIG) {
            if self.is_cc(c, VINTR) {
                return self.signal_char(SIGINT, c);
            }
            if self.is_cc(c, VQUIT) {
                return self.signal_char(SIGQUIT, c);
            }
            if self.is_cc(c, VSUSP) {
                return self.signal_char(SIGTSTP, c);
            }
        }

        if c == b'\r' {
            if self.i(IGNCR) {
                return;
            }
            if self.i(ICRNL) {
                c = b'\n';
            }
        } else if c == b'\n' && self.i(INLCR) {
            c = b'\r';
        }

        if self.l(ICANON) {
            if self.is_cc(c, VERASE)
                || self.is_cc(c, VKILL)
                || (self.is_cc(c, VWERASE) && self.l(IEXTEN))
            {
                return self.eraser(c);
            }
            if self.is_cc(c, VLNEXT) && self.l(IEXTEN) {
                self.lnext = true;
                if self.l(ECHO) && self.l(ECHOCTL) {
                    self.oproc(b'^');
                    self.oproc(0x08);
                }
                return;
            }
            if self.is_cc(c, VREPRINT) && self.l(ECHO) && self.l(IEXTEN) {
                self.echo_char(c);
                self.oproc(b'\n');
                for idx in self.canon_head..self.rbuf.len() {
                    let ch = self.rbuf[idx];
                    self.echo_char(ch);
                }
                return;
            }
            if c == b'\n' {
                if self.l(ECHO) || self.l(ECHONL) {
                    self.oproc(b'\n');
                }
                return self.push_input(c, F_EOL);
            }
            if self.is_cc(c, VEOF) {
                // No echo. An empty line makes read() return 0.
                return self.push_input(c, F_EOF);
            }
            if self.is_cc(c, VEOL) || (self.is_cc(c, VEOL2) && self.l(IEXTEN)) {
                if self.l(ECHO) {
                    if self.line_len() == 0 {
                        self.canon_column = self.column;
                    }
                    self.echo_char(c);
                }
                return self.push_input(c, F_EOL);
            }
            if self.line_len() >= MAX_CANON {
                if self.i(IMAXBEL) {
                    self.out.push_back(0x07);
                }
                return;
            }
        }

        if self.l(ECHO) {
            if c == b'\n' {
                self.oproc(b'\n');
            } else {
                if self.l(ICANON) && self.line_len() == 0 {
                    self.canon_column = self.column;
                }
                self.echo_char(c);
            }
        }
        self.push_input(c, F_NONE);
    }

    /// Bytes typed at the terminal (`write(2)` on the master).
    pub fn master_write(&mut self, data: &[u8], now_ms: f64) {
        if self.hangup {
            return;
        }
        for &c in data {
            self.receive(c);
        }
        if !data.is_empty() {
            self.last_input_ms = now_ms;
        }
    }

    // ---- reading ------------------------------------------------------------

    /// Marks the start of a `read(2)` call, which is when a VMIN=0 VTIME>0
    /// timer starts. Call once before the first [`Pty::read`] attempt.
    pub fn read_begin(&mut self, now_ms: f64) {
        self.read_start_ms = now_ms;
    }

    fn take(&mut self, buf: &mut [u8], n: usize) {
        for (dst, src) in buf.iter_mut().zip(self.rbuf.drain(..n)) {
            *dst = src;
        }
        self.rflag.drain(..n);
    }

    /// `read(2)` on the slave. Mirrors `n_tty_read` and its VMIN/VTIME cases.
    pub fn read(&mut self, buf: &mut [u8], now_ms: f64) -> ReadResult {
        if buf.is_empty() {
            return ReadResult::Data(0);
        }
        if self.l(ICANON) {
            if self.canon_head == 0 {
                return if self.hangup { ReadResult::Data(0) } else { ReadResult::Block(None) };
            }
            let mut n = 0;
            let mut consumed = 0;
            let mut last_flag = F_EOL;
            while consumed < self.canon_head {
                let f = self.rflag[consumed];
                if f == F_EOF {
                    consumed += 1;
                    last_flag = f;
                    break;
                }
                if n == buf.len() {
                    break;
                }
                buf[n] = self.rbuf[consumed];
                n += 1;
                consumed += 1;
                last_flag = f;
                if f != F_NONE {
                    break;
                }
            }
            // A read that stops mid-line because the buffer is full, right in
            // front of an EOF mark, swallows the mark so the next read does not
            // report a false end-of-file (Linux `canon_skip_eof`).
            if last_flag == F_NONE && consumed < self.canon_head && self.rflag[consumed] == F_EOF {
                consumed += 1;
            }
            self.rbuf.drain(..consumed);
            self.rflag.drain(..consumed);
            self.canon_head -= consumed;
            return ReadResult::Data(n);
        }

        let avail = self.rbuf.len();
        let vmin = self.termios.cc[VMIN] as usize;
        let vtime = self.termios.cc[VTIME] as f64 * 100.0;
        if vmin == 0 {
            if avail > 0 {
                let n = avail.min(buf.len());
                self.take(buf, n);
                return ReadResult::Data(n);
            }
            if vtime == 0.0 || self.hangup {
                return ReadResult::Data(0);
            }
            let deadline = self.read_start_ms + vtime;
            return if now_ms >= deadline {
                ReadResult::Data(0)
            } else {
                ReadResult::Block(Some(deadline))
            };
        }
        let need = vmin.min(buf.len());
        if avail >= need || (self.hangup) {
            let n = avail.min(buf.len());
            self.take(buf, n);
            return ReadResult::Data(n);
        }
        if vtime > 0.0 && avail > 0 {
            // Inter-byte timer: runs from the most recent byte.
            let deadline = self.last_input_ms + vtime;
            if now_ms >= deadline {
                let n = avail.min(buf.len());
                self.take(buf, n);
                return ReadResult::Data(n);
            }
            return ReadResult::Block(Some(deadline));
        }
        ReadResult::Block(None)
    }

    /// `ioctl(FIONREAD)`: bytes a `read` could return right now.
    pub fn readable_len(&self) -> usize {
        if !self.l(ICANON) {
            return self.rbuf.len();
        }
        // The first complete line, without its EOF mark if it ends in one.
        let mut n = 0;
        for idx in 0..self.canon_head {
            match self.rflag[idx] {
                F_EOF => break,
                F_NONE => n += 1,
                _ => {
                    n += 1;
                    break;
                }
            }
        }
        n
    }

    /// `poll(POLLIN)` on the slave. Mirrors `input_available_p(tty, 1)`.
    pub fn poll_in(&self) -> bool {
        if self.hangup {
            return true;
        }
        if self.l(ICANON) {
            return self.canon_head > 0;
        }
        let vmin = self.termios.cc[VMIN] as usize;
        let amt = if self.termios.cc[VTIME] == 0 && vmin > 0 { vmin } else { 1 };
        self.rbuf.len() >= amt
    }
}
