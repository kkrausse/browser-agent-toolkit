//! termios / winsize definitions.
//!
//! Flag bits and `c_cc` indexes use the Linux (asm-generic) values so code
//! written against `libc::termios` constants ports 1:1. The wire layout
//! (`Termios::to_bytes`) is the guest ABI documented in `docs/abi.md`.

// c_iflag
pub const IGNBRK: u32 = 0o000001;
pub const BRKINT: u32 = 0o000002;
pub const IGNPAR: u32 = 0o000004;
pub const PARMRK: u32 = 0o000010;
pub const INPCK: u32 = 0o000020;
pub const ISTRIP: u32 = 0o000040;
pub const INLCR: u32 = 0o000100;
pub const IGNCR: u32 = 0o000200;
pub const ICRNL: u32 = 0o000400;
pub const IUCLC: u32 = 0o001000;
pub const IXON: u32 = 0o002000;
pub const IXANY: u32 = 0o004000;
pub const IXOFF: u32 = 0o010000;
pub const IMAXBEL: u32 = 0o020000;
pub const IUTF8: u32 = 0o040000;

// c_oflag
pub const OPOST: u32 = 0o000001;
pub const OLCUC: u32 = 0o000002;
pub const ONLCR: u32 = 0o000004;
pub const OCRNL: u32 = 0o000010;
pub const ONOCR: u32 = 0o000020;
pub const ONLRET: u32 = 0o000040;
pub const TABDLY: u32 = 0o014000;
pub const XTABS: u32 = 0o014000;

// c_cflag
pub const CSIZE: u32 = 0o000060;
pub const CS8: u32 = 0o000060;
pub const CREAD: u32 = 0o000200;
pub const PARENB: u32 = 0o000400;
pub const HUPCL: u32 = 0o002000;
pub const B38400: u32 = 0o000017;

// c_lflag
pub const ISIG: u32 = 0o000001;
pub const ICANON: u32 = 0o000002;
pub const ECHO: u32 = 0o000010;
pub const ECHOE: u32 = 0o000020;
pub const ECHOK: u32 = 0o000040;
pub const ECHONL: u32 = 0o000100;
pub const NOFLSH: u32 = 0o000200;
pub const TOSTOP: u32 = 0o000400;
pub const ECHOCTL: u32 = 0o001000;
pub const ECHOPRT: u32 = 0o002000;
pub const ECHOKE: u32 = 0o004000;
pub const IEXTEN: u32 = 0o100000;

// c_cc indexes
pub const VINTR: usize = 0;
pub const VQUIT: usize = 1;
pub const VERASE: usize = 2;
pub const VKILL: usize = 3;
pub const VEOF: usize = 4;
pub const VTIME: usize = 5;
pub const VMIN: usize = 6;
pub const VSWTC: usize = 7;
pub const VSTART: usize = 8;
pub const VSTOP: usize = 9;
pub const VSUSP: usize = 10;
pub const VEOL: usize = 11;
pub const VREPRINT: usize = 12;
pub const VDISCARD: usize = 13;
pub const VWERASE: usize = 14;
pub const VLNEXT: usize = 15;
pub const VEOL2: usize = 16;
pub const NCCS: usize = 20;

/// `_POSIX_VDISABLE`: a `c_cc` slot holding this value never matches.
pub const VDISABLE: u8 = 0;

// tcsetattr actions
pub const TCSANOW: u32 = 0;
pub const TCSADRAIN: u32 = 1;
pub const TCSAFLUSH: u32 = 2;

// signal numbers (Linux)
pub const SIGHUP: u32 = 1;
pub const SIGINT: u32 = 2;
pub const SIGQUIT: u32 = 3;
pub const SIGTERM: u32 = 15;
pub const SIGTSTP: u32 = 20;
pub const SIGWINCH: u32 = 28;

pub const TERMIOS_SIZE: usize = 44;
pub const WINSIZE_SIZE: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Termios {
    pub iflag: u32,
    pub oflag: u32,
    pub cflag: u32,
    pub lflag: u32,
    pub cc: [u8; NCCS],
    pub ispeed: u32,
    pub ospeed: u32,
}

impl Default for Termios {
    /// The state of a freshly opened Linux pty slave (`stty sane`-like).
    fn default() -> Self {
        let mut cc = [0u8; NCCS];
        cc[VINTR] = 0x03; // ^C
        cc[VQUIT] = 0x1c; // ^\
        cc[VERASE] = 0x7f; // DEL
        cc[VKILL] = 0x15; // ^U
        cc[VEOF] = 0x04; // ^D
        cc[VTIME] = 0;
        cc[VMIN] = 1;
        cc[VSTART] = 0x11; // ^Q
        cc[VSTOP] = 0x13; // ^S
        cc[VSUSP] = 0x1a; // ^Z
        cc[VREPRINT] = 0x12; // ^R
        cc[VDISCARD] = 0x0f; // ^O
        cc[VWERASE] = 0x17; // ^W
        cc[VLNEXT] = 0x16; // ^V
        Termios {
            iflag: ICRNL | IXON | IUTF8,
            oflag: OPOST | ONLCR,
            cflag: B38400 | CS8 | CREAD | HUPCL,
            lflag: ISIG | ICANON | ECHO | ECHOE | ECHOK | ECHOCTL | ECHOKE | IEXTEN,
            cc,
            ispeed: 38400,
            ospeed: 38400,
        }
    }
}

impl Termios {
    /// `cfmakeraw(3)`.
    pub fn make_raw(&mut self) {
        self.iflag &= !(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL | IXON);
        self.oflag &= !OPOST;
        self.lflag &= !(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
        self.cflag &= !(CSIZE | PARENB);
        self.cflag |= CS8;
        self.cc[VMIN] = 1;
        self.cc[VTIME] = 0;
    }

    pub fn to_bytes(&self) -> [u8; TERMIOS_SIZE] {
        let mut b = [0u8; TERMIOS_SIZE];
        b[0..4].copy_from_slice(&self.iflag.to_le_bytes());
        b[4..8].copy_from_slice(&self.oflag.to_le_bytes());
        b[8..12].copy_from_slice(&self.cflag.to_le_bytes());
        b[12..16].copy_from_slice(&self.lflag.to_le_bytes());
        b[16..36].copy_from_slice(&self.cc);
        b[36..40].copy_from_slice(&self.ispeed.to_le_bytes());
        b[40..44].copy_from_slice(&self.ospeed.to_le_bytes());
        b
    }

    pub fn from_bytes(b: &[u8; TERMIOS_SIZE]) -> Self {
        let u = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        let mut cc = [0u8; NCCS];
        cc.copy_from_slice(&b[16..36]);
        Termios { iflag: u(0), oflag: u(4), cflag: u(8), lflag: u(12), cc, ispeed: u(36), ospeed: u(40) }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Winsize {
    pub row: u16,
    pub col: u16,
    pub xpixel: u16,
    pub ypixel: u16,
}

impl Winsize {
    pub fn to_bytes(&self) -> [u8; WINSIZE_SIZE] {
        let mut b = [0u8; WINSIZE_SIZE];
        b[0..2].copy_from_slice(&self.row.to_le_bytes());
        b[2..4].copy_from_slice(&self.col.to_le_bytes());
        b[4..6].copy_from_slice(&self.xpixel.to_le_bytes());
        b[6..8].copy_from_slice(&self.ypixel.to_le_bytes());
        b
    }
}
