//! HTTP/1.1 message framing over socket rings (docs/design/kernel-abi.md §13).
//!
//! One parser serves the guest `http` module (requests on the server side,
//! responses on the client side) and the host side (endpoint fetch, the
//! preview bridge), so there is no HTTP parser in JavaScript.
//!
//! The parser reads the socket's receive ring in place. Head bytes are moved
//! into the parser's own buffer (they are parsed with `httparse`); body bytes
//! are not copied by the kernel at all: `bat_http_recv` reports them as
//! `(ptr, len)` ranges inside the ring, JS copies them once into its own
//! memory, and the ranges are released by the next `bat_http_recv` (or
//! `bat_http_release`). The ring has a single reader, so the ranges stay
//! valid in between.
//!
//! Sending is the mirror image: `bat_http_reserve` shows the free part of the
//! send ring, JS writes into it, `bat_http_commit` publishes the bytes,
//! optionally wrapped as one chunk of a chunked body.

use crate::errno::*;
use crate::fd::Pipe;
use crate::proc;

/// Protocol error (Linux EPROTO).
pub const EPROTO: i32 = 71;

pub const EV_HEAD: u32 = 1;
pub const EV_BODY: u32 = 2;
pub const EV_END: u32 = 3;
pub const EV_EOF: u32 = 4;
pub const EV_ERROR: u32 = 5;

pub const F_KEEPALIVE: u32 = 1;
pub const F_CHUNKED: u32 = 2;
pub const F_UPGRADE: u32 = 4;
pub const F_HAS_LENGTH: u32 = 8;
pub const F_EXPECT_CONTINUE: u32 = 16;
pub const F_UNTIL_CLOSE: u32 = 32;
pub const F_HTTP10: u32 = 64;
pub const F_NO_BODY: u32 = 128;

const MAX_HEAD: usize = 1 << 20;
const MAX_HEADERS: usize = 256;
const HEAD_WORDS: usize = 13;

#[derive(Clone, Copy, PartialEq)]
enum St {
    Head,
    /// A head with `F_UPGRADE` was reported; waiting for `bat_http_resume`.
    Paused,
    Length(u64),
    ChunkSize { val: u64, digits: u32, ext: bool },
    ChunkSizeLf,
    ChunkData(u64),
    ChunkDataCr,
    ChunkDataLf,
    /// Trailer section: `line` = bytes seen on the current line.
    Trailer { line: u32, cr: bool },
    UntilClose,
    /// Handed over to the caller (upgrade) or finished.
    Raw,
    Failed,
}

pub struct Parser {
    response: bool,
    st: St,
    head: Vec<u8>,
    /// Ring bytes already parsed (and partly lent to JS) but not consumed.
    pending: usize,
    /// The next response has no body whatever its headers say (reply to HEAD).
    no_body_next: bool,
    /// Body framing decided by the last head, applied when it is resumed.
    after_head: St,
    eof_sent: bool,
    /// `head` holds a head that was reported (kept readable until the next one starts).
    head_done: bool,
}

/// The two readable slices of a ring as one logical byte string.
struct View<'a> {
    a: &'a [u8],
    b: &'a [u8],
}
impl View<'_> {
    #[inline]
    fn len(&self) -> usize {
        self.a.len() + self.b.len()
    }
    #[inline]
    fn at(&self, i: usize) -> u8 {
        if i < self.a.len() {
            self.a[i]
        } else {
            self.b[i - self.a.len()]
        }
    }
    /// Up to two contiguous ranges covering `[pos, pos + n)`.
    fn ranges(&self, pos: usize, n: usize) -> [(usize, usize); 2] {
        let al = self.a.len();
        if pos >= al {
            [(self.b.as_ptr() as usize + (pos - al), n), (0, 0)]
        } else if pos + n <= al {
            [(self.a.as_ptr() as usize + pos, n), (0, 0)]
        } else {
            [(self.a.as_ptr() as usize + pos, al - pos), (self.b.as_ptr() as usize, n - (al - pos))]
        }
    }
}

struct Out<'a> {
    w: &'a mut [u32],
    n: usize,
}
impl Out<'_> {
    #[inline]
    fn room(&self) -> usize {
        self.w.len() - self.n
    }
    #[inline]
    fn push(&mut self, words: &[u32]) {
        self.w[self.n..self.n + words.len()].copy_from_slice(words);
        self.n += words.len();
    }
}

fn eq_ignore_case(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_ascii_lowercase() == *y)
}
/// Does a comma-separated header value contain `token` (lower case)?
fn has_token(value: &[u8], token: &[u8]) -> bool {
    value.split(|c| *c == b',').any(|t| {
        let t = trim(t);
        eq_ignore_case(t, token)
    })
}
fn trim(mut s: &[u8]) -> &[u8] {
    while let [b' ' | b'\t', rest @ ..] = s {
        s = rest;
    }
    while let [rest @ .., b' ' | b'\t'] = s {
        s = rest;
    }
    s
}
fn find_end(h: &[u8], from: usize) -> Option<usize> {
    if h.len() < 4 {
        return None;
    }
    let mut i = from;
    while i + 4 <= h.len() {
        // Look at the last byte of the window first: most bytes are not CR/LF.
        match h[i + 3] {
            b'\n' => {
                if h[i + 2] == b'\r' && h[i + 1] == b'\n' && h[i] == b'\r' {
                    return Some(i + 4);
                }
                i += 1;
            }
            b'\r' => i += 1,
            _ => i += 4,
        }
    }
    None
}

impl Parser {
    fn new(response: bool) -> Parser {
        Parser { response, st: St::Head, head: Vec::new(), pending: 0, no_body_next: false, after_head: St::Head, eof_sent: false, head_done: false }
    }

    /// Parse the complete head in `self.head` and write its event. Returns
    /// false when `out` has no room for it (retry on the next call).
    fn emit_head(&mut self, out: &mut Out) -> Result<bool, i32> {
        let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
        let base = self.head.as_ptr() as usize;
        let off = |s: &[u8]| (s.as_ptr() as usize - base) as u32;
        let (status, a, b, minor, n);
        if self.response {
            let mut r = httparse::Response::new(&mut headers);
            match r.parse(&self.head) {
                Ok(httparse::Status::Complete(_)) => {}
                _ => return Err(EPROTO),
            }
            status = r.code.unwrap_or(0) as u32;
            let reason = r.reason.unwrap_or("").as_bytes();
            a = (if reason.is_empty() { 0 } else { off(reason) }, reason.len() as u32);
            b = (0, 0);
            minor = r.version.unwrap_or(1);
            n = r.headers.len();
        } else {
            let mut r = httparse::Request::new(&mut headers);
            match r.parse(&self.head) {
                Ok(httparse::Status::Complete(_)) => {}
                _ => return Err(EPROTO),
            }
            status = 0;
            let m = r.method.unwrap_or("").as_bytes();
            let t = r.path.unwrap_or("").as_bytes();
            a = (off(m), m.len() as u32);
            b = (off(t), t.len() as u32);
            minor = r.version.unwrap_or(1);
            n = r.headers.len();
        }
        let headers = &headers[..n];
        if out.room() < HEAD_WORDS + 4 * n {
            return Ok(false);
        }
        let mut flags = 0u32;
        let mut length: Option<u64> = None;
        let mut chunked = false;
        let mut close = false;
        let mut keep = false;
        let mut upgrade_conn = false;
        let mut upgrade_hdr = false;
        for h in headers {
            let name = h.name.as_bytes();
            if eq_ignore_case(name, b"content-length") {
                let v = trim(h.value);
                if v.is_empty() || !v.iter().all(u8::is_ascii_digit) {
                    return Err(EPROTO);
                }
                let mut x = 0u64;
                for d in v {
                    x = x.checked_mul(10).and_then(|x| x.checked_add((d - b'0') as u64)).ok_or(EPROTO)?;
                }
                if length.is_some_and(|l| l != x) {
                    return Err(EPROTO);
                }
                length = Some(x);
            } else if eq_ignore_case(name, b"transfer-encoding") {
                // Chunked must be the final coding; anything before it is the body's own business.
                chunked = h.value.rsplit(|c| *c == b',').next().is_some_and(|t| eq_ignore_case(trim(t), b"chunked"));
            } else if eq_ignore_case(name, b"connection") {
                close |= has_token(h.value, b"close");
                keep |= has_token(h.value, b"keep-alive");
                upgrade_conn |= has_token(h.value, b"upgrade");
            } else if eq_ignore_case(name, b"upgrade") {
                upgrade_hdr = true;
            } else if eq_ignore_case(name, b"expect") && eq_ignore_case(trim(h.value), b"100-continue") {
                flags |= F_EXPECT_CONTINUE;
            }
        }
        if minor == 0 {
            flags |= F_HTTP10;
            if keep && !close {
                flags |= F_KEEPALIVE;
            }
        } else if !close {
            flags |= F_KEEPALIVE;
        }
        let upgrade = if self.response { status == 101 } else { upgrade_conn && upgrade_hdr };
        let body = if self.response && (self.no_body_next || status / 100 == 1 || status == 204 || status == 304) {
            flags |= F_NO_BODY;
            St::Length(0)
        } else if chunked {
            flags |= F_CHUNKED;
            St::ChunkSize { val: 0, digits: 0, ext: false }
        } else if let Some(l) = length {
            flags |= F_HAS_LENGTH;
            St::Length(l)
        } else if self.response {
            flags |= F_UNTIL_CLOSE;
            flags &= !F_KEEPALIVE;
            St::UntilClose
        } else {
            St::Length(0)
        };
        // An interim response (100, 102, 103) does not answer the request.
        if !(self.response && status / 100 == 1 && status != 101) {
            self.no_body_next = false;
        }
        let l = length.unwrap_or(0);
        out.push(&[
            EV_HEAD,
            (HEAD_WORDS + 4 * n) as u32,
            flags | if upgrade { F_UPGRADE } else { 0 },
            status,
            base as u32,
            self.head.len() as u32,
            a.0,
            a.1,
            b.0,
            b.1,
            l as u32,
            (l >> 32) as u32,
            n as u32,
        ]);
        for h in headers {
            let name = h.name.as_bytes();
            out.push(&[off(name), name.len() as u32, if h.value.is_empty() { 0 } else { off(h.value) }, h.value.len() as u32]);
        }
        if upgrade {
            self.after_head = body;
            self.st = St::Paused;
        } else {
            self.st = body;
        }
        Ok(true)
    }

    /// Run over the readable ring bytes. Returns the number of ring bytes to consume now.
    fn run(&mut self, a: &mut [u8], b: &mut [u8], eof: bool, out: &mut Out) -> usize {
        let v = View { a, b };
        let total = v.len();
        // Bytes lent by the previous call are done with.
        let mut pos = self.pending.min(total);
        self.pending = 0;
        // First position that has to stay in the ring because JS will read it.
        let mut hold: Option<usize> = None;
        let mut head_emitted = false;
        macro_rules! fail {
            ($code:expr) => {{
                if out.room() >= 2 {
                    out.push(&[EV_ERROR, $code as u32]);
                    self.st = St::Failed;
                }
                break;
            }};
        }
        loop {
            match self.st {
                St::Head => {
                    if head_emitted {
                        break; // one head per call: its bytes live in `self.head`
                    }
                    if out.room() < HEAD_WORDS {
                        break;
                    }
                    if self.head_done {
                        self.head.clear();
                        self.head_done = false;
                    }
                    if self.head.is_empty() {
                        // Tolerate blank lines between messages.
                        while pos < total && matches!(v.at(pos), b'\r' | b'\n') {
                            pos += 1;
                        }
                    }
                    let avail = total - pos;
                    if avail == 0 {
                        if eof && !self.eof_sent && out.room() >= 2 {
                            // Closed between messages is a clean end; inside a head it is not.
                            out.push(&[EV_EOF, self.head.is_empty() as u32]);
                            self.eof_sent = true;
                            self.st = St::Raw;
                        }
                        break;
                    }
                    // Move what is there into the head buffer and look for the terminator.
                    let before = self.head.len();
                    let take = avail.min(MAX_HEAD + 4 - before);
                    for (p, l) in v.ranges(pos, take) {
                        if l > 0 {
                            self.head.extend_from_slice(unsafe { core::slice::from_raw_parts(p as *const u8, l) });
                        }
                    }
                    match find_end(&self.head, before.saturating_sub(3)) {
                        Some(end) => {
                            self.head.truncate(end);
                            pos += end - before;
                        }
                        None => {
                            pos += take;
                            if self.head.len() > MAX_HEAD {
                                fail!(EPROTO);
                            }
                            continue;
                        }
                    }
                    match self.emit_head(out) {
                        Ok(true) => {
                            self.head_done = true;
                            head_emitted = true;
                        }
                        Ok(false) => {
                            // No room: un-take the head so the next call parses it again.
                            pos -= self.head.len() - before;
                            self.head.truncate(before);
                            if out.n == 0 {
                                fail!(ERANGE);
                            }
                            break;
                        }
                        Err(e) => fail!(e),
                    }
                }
                St::Paused | St::Raw | St::Failed => break,
                St::Length(0) => {
                    if out.room() < 2 {
                        break;
                    }
                    out.push(&[EV_END, 0]);
                    self.st = St::Head;
                }
                St::Length(rem) | St::ChunkData(rem) => {
                    let avail = total - pos;
                    if avail == 0 {
                        if eof && !self.eof_sent && out.room() >= 2 {
                            out.push(&[EV_EOF, 0]);
                            self.eof_sent = true;
                            self.st = St::Raw;
                        }
                        break;
                    }
                    if out.room() < 6 {
                        break;
                    }
                    let n = (avail as u64).min(rem) as usize;
                    for (p, l) in v.ranges(pos, n) {
                        if l > 0 {
                            out.push(&[EV_BODY, p as u32, l as u32]);
                        }
                    }
                    hold.get_or_insert(pos);
                    pos += n;
                    let left = rem - n as u64;
                    self.st = match self.st {
                        St::Length(_) => St::Length(left),
                        _ if left == 0 => St::ChunkDataCr,
                        _ => St::ChunkData(left),
                    };
                }
                St::UntilClose => {
                    let avail = total - pos;
                    if avail == 0 {
                        if eof && !self.eof_sent && out.room() >= 4 {
                            out.push(&[EV_END, 0, EV_EOF, 1]);
                            self.eof_sent = true;
                            self.st = St::Raw;
                        }
                        break;
                    }
                    if out.room() < 6 {
                        break;
                    }
                    for (p, l) in v.ranges(pos, avail) {
                        if l > 0 {
                            out.push(&[EV_BODY, p as u32, l as u32]);
                        }
                    }
                    hold.get_or_insert(pos);
                    pos += avail;
                }
                // Chunk framing is read a byte at a time: it is a few bytes per chunk.
                _ => {
                    if pos == total {
                        if eof && !self.eof_sent && out.room() >= 2 {
                            out.push(&[EV_EOF, 0]);
                            self.eof_sent = true;
                            self.st = St::Raw;
                        }
                        break;
                    }
                    let c = v.at(pos);
                    match self.st {
                        St::ChunkSize { val, digits, ext } => {
                            if c == b'\r' {
                                if digits == 0 {
                                    fail!(EPROTO);
                                }
                                pos += 1;
                                self.after_head = if val == 0 { St::Trailer { line: 0, cr: false } } else { St::ChunkData(val) };
                                self.st = St::ChunkSizeLf;
                            } else if ext {
                                pos += 1;
                            } else if c == b';' || c == b' ' || c == b'\t' {
                                pos += 1;
                                self.st = St::ChunkSize { val, digits, ext: true };
                            } else {
                                let d = match c {
                                    b'0'..=b'9' => c - b'0',
                                    b'a'..=b'f' => c - b'a' + 10,
                                    b'A'..=b'F' => c - b'A' + 10,
                                    _ => fail!(EPROTO),
                                };
                                if digits >= 15 {
                                    fail!(EPROTO);
                                }
                                pos += 1;
                                self.st = St::ChunkSize { val: (val << 4) | d as u64, digits: digits + 1, ext };
                            }
                        }
                        St::ChunkSizeLf => {
                            if c != b'\n' {
                                fail!(EPROTO);
                            }
                            pos += 1;
                            self.st = self.after_head;
                        }
                        St::ChunkDataCr => {
                            if c != b'\r' {
                                fail!(EPROTO);
                            }
                            pos += 1;
                            self.st = St::ChunkDataLf;
                        }
                        St::ChunkDataLf => {
                            if c != b'\n' {
                                fail!(EPROTO);
                            }
                            pos += 1;
                            self.st = St::ChunkSize { val: 0, digits: 0, ext: false };
                        }
                        St::Trailer { line, cr } => {
                            // Trailer fields are skipped; an empty line ends the message.
                            if out.room() < 2 {
                                break;
                            }
                            pos += 1;
                            if c == b'\n' {
                                if line == 0 {
                                    out.push(&[EV_END, 0]);
                                                    self.st = St::Head;
                                } else {
                                    self.st = St::Trailer { line: 0, cr: false };
                                }
                            } else if c == b'\r' {
                                self.st = St::Trailer { line, cr: true };
                            } else {
                                if cr || line > 65536 {
                                    fail!(EPROTO);
                                }
                                self.st = St::Trailer { line: line + 1, cr: false };
                            }
                        }
                        _ => unreachable!(),
                    }
                }
            }
        }
        // Everything before the first lent range can go now; the rest waits
        // for the next call.
        let now = hold.unwrap_or(pos);
        self.pending = pos - now;
        now
    }
}

unsafe fn parser<'a>(h: u32) -> R<&'a mut Parser> {
    if h == 0 {
        return Err(EINVAL);
    }
    Ok(&mut *(h as usize as *mut Parser))
}
fn rx_of(fd: i32) -> R<std::sync::Arc<Pipe>> {
    Ok(proc::cur()?.fd(fd)?.rx_ring()?.clone())
}
fn tx_of(fd: i32) -> R<std::sync::Arc<Pipe>> {
    Ok(proc::cur()?.fd(fd)?.tx_ring()?.clone())
}

/// `kind` 0 parses requests (server side), 1 parses responses (client side).
#[no_mangle]
pub extern "C" fn bat_http_parser_new(kind: u32) -> u32 {
    Box::into_raw(Box::new(Parser::new(kind == 1))) as usize as u32
}
#[no_mangle]
pub unsafe extern "C" fn bat_http_parser_free(h: u32) {
    if h != 0 {
        drop(Box::from_raw(h as usize as *mut Parser));
    }
}
/// The response to come answers a HEAD request: it has no body.
#[no_mangle]
pub unsafe extern "C" fn bat_http_expect_no_body(h: u32) -> i32 {
    match parser(h) {
        Ok(p) => {
            p.no_body_next = true;
            0
        }
        Err(e) => -e,
    }
}
/// Parse what the socket `fd` has received. Writes events as `u32` words to
/// `out` and returns the number of words (0: nothing new, wait for
/// readability). Ranges reported by an earlier call are released first.
#[no_mangle]
pub unsafe extern "C" fn bat_http_recv(h: u32, fd: i32, out: *mut u32, cap_words: usize) -> i32 {
    let p = match parser(h) {
        Ok(p) => p,
        Err(e) => return -e,
    };
    let ring = match rx_of(fd) {
        Ok(r) => r,
        Err(e) => return -e,
    };
    let mut o = Out { w: core::slice::from_raw_parts_mut(out, cap_words), n: 0 };
    ring.with_rx(|a, b, eof| (p.run(a, b, eof, &mut o), ()));
    o.n as i32
}
/// Release ranges lent by the last `bat_http_recv` without parsing further.
#[no_mangle]
pub unsafe extern "C" fn bat_http_release(h: u32, fd: i32) -> i32 {
    let p = match parser(h) {
        Ok(p) => p,
        Err(e) => return -e,
    };
    let ring = match rx_of(fd) {
        Ok(r) => r,
        Err(e) => return -e,
    };
    let n = core::mem::take(&mut p.pending);
    ring.with_rx(|_, _, _| (n, ()));
    0
}
/// After a head with `F_UPGRADE`: `raw` != 0 hands the connection to the
/// caller (the parser is finished, the bytes after the head stay in the ring
/// for `bat_read`); 0 continues with the message as ordinary HTTP.
#[no_mangle]
pub unsafe extern "C" fn bat_http_resume(h: u32, fd: i32, raw: u32) -> i32 {
    let p = match parser(h) {
        Ok(p) => p,
        Err(e) => return -e,
    };
    if p.st != St::Paused {
        return -EINVAL;
    }
    if raw != 0 {
        p.st = St::Raw;
        return bat_http_release(h, fd);
    }
    p.st = p.after_head;
    0
}

/// Show the free part of the send ring of `fd`. `out`: `[cap, ptr1, len1,
/// ptr2, len2]`, where `cap = len1 + len2` is how many payload bytes fit.
/// `flags` bit 0: the payload will be committed as one chunk of a chunked
/// body (room for the chunk framing is set aside). Returns `cap`, `-EAGAIN`
/// when nothing fits, `-EPIPE` when the peer is gone.
#[no_mangle]
pub unsafe extern "C" fn bat_http_reserve(fd: i32, flags: u32, out: *mut u32) -> i32 {
    let ring = match tx_of(fd) {
        Ok(r) => r,
        Err(e) => return -e,
    };
    let chunked = flags & 1 != 0;
    let r = ring.with_tx(|a, b| {
        let free = a.len() + b.len();
        let (skip, tail) = if chunked { (10, 2) } else { (0, 0) };
        if free <= skip + tail {
            return (0, 0usize);
        }
        let cap = free - skip - tail;
        // Payload starts `skip` bytes into the free region.
        let (p1, l1, p2, l2) = if skip < a.len() {
            let l1 = (a.len() - skip).min(cap);
            (a.as_ptr() as usize + skip, l1, b.as_ptr() as usize, cap - l1)
        } else {
            (b.as_ptr() as usize + (skip - a.len()), cap, 0, 0)
        };
        *out = cap as u32;
        *out.add(1) = p1 as u32;
        *out.add(2) = l1 as u32;
        *out.add(3) = p2 as u32;
        *out.add(4) = l2 as u32;
        (0, cap)
    });
    match r {
        Ok(0) => -EAGAIN,
        Ok(n) => n as i32,
        Err(e) => -e,
    }
}
/// Publish `n` payload bytes written after `bat_http_reserve` with the same `flags`.
#[no_mangle]
pub unsafe extern "C" fn bat_http_commit(fd: i32, flags: u32, n: usize) -> i32 {
    let ring = match tx_of(fd) {
        Ok(r) => r,
        Err(e) => return -e,
    };
    let chunked = flags & 1 != 0;
    let r = ring.with_tx(|a, b| {
        let free = a.len() + b.len();
        if !chunked {
            return (n.min(free), n <= free);
        }
        if n == 0 || n + 12 > free {
            return (0, n == 0);
        }
        let mut put = |i: usize, c: u8| {
            if i < a.len() {
                a[i] = c;
            } else {
                b[i - a.len()] = c;
            }
        };
        // Fixed-width size line (leading zeros are legal), so the payload
        // position was known before its length.
        for i in 0..8 {
            put(i, b"0123456789abcdef"[(n >> (28 - 4 * i)) & 15]);
        }
        put(8, b'\r');
        put(9, b'\n');
        put(10 + n, b'\r');
        put(11 + n, b'\n');
        (n + 12, true)
    });
    match r {
        Ok(true) => n as i32,
        Ok(false) => -EINVAL,
        Err(e) => -e,
    }
}

/// Identity of the listener on `port` (changes when the port is re-bound), 0
/// when nothing listens. Wait on `BAT_PORTS_WORD` for changes.
#[no_mangle]
pub extern "C" fn bat_port_listener(port: u32) -> u32 {
    crate::fd::port_listener(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive a parser over `input` delivered in pieces of `step` bytes through a real ring.
    fn drive(response: bool, input: &[u8], step: usize, close: bool) -> (Vec<String>, Vec<u8>) {
        let ring = Pipe::new(64);
        let mut p = Parser::new(response);
        // Events carry 32-bit addresses; natively the upper half comes from the ring.
        let hi = ring.with_rx(|a, _, _| (0, a.as_ptr() as usize & !0xffff_ffff));
        let mut log = Vec::new();
        let mut body = Vec::new();
        let mut sent = 0;
        let mut closed = false;
        let mut idle = 0;
        loop {
            let mut words = [0u32; 600];
            let mut o = Out { w: &mut words, n: 0 };
            ring.with_rx(|a, b, eof| (p.run(a, b, eof || closed, &mut o), ()));
            let n = o.n;
            let mut i = 0;
            while i < n {
                match words[i] {
                    EV_HEAD => {
                        let nh = words[i + 12] as usize;
                        let head = p.head.clone();
                        let s = |o: u32, l: u32| String::from_utf8_lossy(&head[o as usize..(o + l) as usize]).to_string();
                        let mut line = format!(
                            "HEAD flags={} status={} a={} b={} len={}",
                            words[i + 2],
                            words[i + 3],
                            s(words[i + 6], words[i + 7]),
                            s(words[i + 8], words[i + 9]),
                            words[i + 10]
                        );
                        for k in 0..nh {
                            let w = &words[i + 13 + 4 * k..];
                            line += &format!(" {}={}", s(w[0], w[1]), s(w[2], w[3]));
                        }
                        log.push(line);
                        let was_upgrade = words[i + 2] & F_UPGRADE != 0;
                        i += words[i + 1] as usize;
                        if was_upgrade {
                            p.st = St::Raw;
                        }
                    }
                    EV_BODY => {
                        body.extend_from_slice(unsafe { core::slice::from_raw_parts((hi | words[i + 1] as usize) as *const u8, words[i + 2] as usize) });
                        i += 3;
                    }
                    EV_END => {
                        log.push(format!("END body={}", String::from_utf8_lossy(&body)));
                        body.clear();
                        i += 2;
                    }
                    EV_EOF => {
                        log.push(format!("EOF clean={}", words[i + 1]));
                        i += 2;
                    }
                    EV_ERROR => {
                        log.push(format!("ERROR {}", words[i + 1]));
                        i += 2;
                    }
                    _ => panic!("bad event"),
                }
            }
            if n == 0 {
                if sent < input.len() {
                    let m = step.min(input.len() - sent);
                    let w = ring.write(&input[sent..sent + m], true).unwrap_or(0);
                    sent += w;
                    idle = if w == 0 { idle + 1 } else { 0 };
                    assert!(idle < 3, "ring stuck");
                } else if close && !closed {
                    closed = true;
                } else {
                    break;
                }
            }
        }
        let mut rest = vec![0u8; 256];
        let pend = core::mem::take(&mut p.pending);
        ring.with_rx(|_, _, _| (pend, ()));
        let n = ring.read(&mut rest, true).unwrap_or(0);
        rest.truncate(n);
        (log, rest)
    }

    #[test]
    fn requests_any_split() {
        let input = b"POST /a?b=1 HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhelloGET /next HTTP/1.1\r\nConnection: close\r\n\r\n";
        let want = vec![
            "HEAD flags=9 status=0 a=POST b=/a?b=1 len=5 Host=x Content-Length=5".to_string(),
            "END body=hello".to_string(),
            "HEAD flags=0 status=0 a=GET b=/next len=0 Connection=close".to_string(),
            "END body=".to_string(),
            "EOF clean=1".to_string(),
        ];
        for step in [1, 2, 3, 7, 16, 63, 64, 1000] {
            let (log, _) = drive(false, input, step, true);
            assert_eq!(log, want, "step {step}");
        }
    }

    #[test]
    fn chunked_response_and_trailers() {
        let input = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n5\r\nhello\r\n00000006;x=y\r\n world\r\n0\r\nX-T: 1\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n";
        for step in [1, 5, 64, 1000] {
            let (log, _) = drive(true, input, step, false);
            assert_eq!(log[0], "HEAD flags=3 status=200 a=OK b= len=0 Transfer-Encoding=gzip, chunked", "step {step}");
            assert_eq!(log[1], "END body=hello world");
            assert_eq!(log[2], "HEAD flags=129 status=204 a=No Content b= len=0");
            assert_eq!(log[3], "END body=");
        }
    }

    #[test]
    fn until_close_truncation_and_upgrade() {
        let (log, _) = drive(true, b"HTTP/1.0 200 OK\r\n\r\nabc", 2, true);
        assert_eq!(log, vec!["HEAD flags=96 status=200 a=OK b= len=0", "END body=abc", "EOF clean=1"]);
        let (log, _) = drive(true, b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc", 64, true);
        assert_eq!(log.last().unwrap(), "EOF clean=0");
        let (log, rest) = drive(false, b"GET /ws HTTP/1.1\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\n\r\n\x81\x00raw", 64, false);
        assert_eq!(log, vec!["HEAD flags=5 status=0 a=GET b=/ws len=0 Connection=keep-alive, Upgrade Upgrade=websocket"]);
        assert_eq!(rest, b"\x81\x00raw");
        let (log, _) = drive(false, b"GET / HTTP/1.1\r\nContent-Length: 1x\r\n\r\n", 64, false);
        assert_eq!(log, vec![format!("ERROR {EPROTO}")]);
    }

    #[test]
    fn chunk_commit_framing() {
        // What bat_http_commit writes must parse back as one chunk.
        let ring = Pipe::new(64);
        ring.with_tx(|a, _| {
            a[10..15].copy_from_slice(b"hello");
            (0, ())
        })
        .unwrap();
        let n = 5usize;
        ring.with_tx(|a, _| {
            for i in 0..8 {
                a[i] = b"0123456789abcdef"[(n >> (28 - 4 * i)) & 15];
            }
            a[8] = b'\r';
            a[9] = b'\n';
            a[15] = b'\r';
            a[16] = b'\n';
            (17, ())
        })
        .unwrap();
        let mut buf = [0u8; 32];
        let got = ring.read(&mut buf, true).unwrap();
        assert_eq!(&buf[..got], b"00000005\r\nhello\r\n");
    }
}
