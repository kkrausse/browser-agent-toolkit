//! WebSocket framing (RFC 6455) over socket rings.
//!
//! Used by the host side (the preview frame's `WebSocket` shim talks to a
//! guest server through `netd`) and by the guest's own `WebSocket` client to
//! loopback ports. Like http.rs it works in the ring: received payload is
//! unmasked in place and lent to JS as ranges, sent payload is written by JS
//! into reserved ring space behind a header the kernel wrote.

use crate::errno::*;
use crate::http::{EPROTO, EV_EOF, EV_ERROR};
use crate::proc;

pub const EV_WS_FRAME: u32 = 6;
pub const EV_WS_DATA: u32 = 7;
pub const EV_WS_END: u32 = 8;

/// `bat_ws_reserve` flags and the flags word of `EV_WS_FRAME`: opcode in bits 0..3.
pub const WS_FIN: u32 = 0x100;
pub const WS_MASK: u32 = 0x200;

pub struct Ws {
    hdr: [u8; 14],
    have: usize,
    /// Payload bytes of the current frame still to come.
    rem: u64,
    in_payload: bool,
    mask: [u8; 4],
    masked: bool,
    mask_off: usize,
    pending: usize,
    done: bool,
}

impl Ws {
    fn new() -> Ws {
        Ws { hdr: [0; 14], have: 0, rem: 0, in_payload: false, mask: [0; 4], masked: false, mask_off: 0, pending: 0, done: false }
    }
    fn run(&mut self, a: &mut [u8], b: &mut [u8], eof: bool, out: &mut [u32]) -> (usize, usize) {
        let total = a.len() + b.len();
        let al = a.len();
        let mut pos = self.pending.min(total);
        self.pending = 0;
        let mut hold: Option<usize> = None;
        let mut n = 0usize;
        macro_rules! push {
            ($($w:expr),*) => {{ $( out[n] = $w; n += 1; )* }};
        }
        loop {
            if self.done || out.len() - n < 8 {
                break;
            }
            if !self.in_payload {
                // Header: 2 bytes, then 0/2/8 length bytes, then 0/4 mask bytes.
                let need = |h: &[u8; 14], have: usize| -> usize {
                    if have < 2 {
                        return 2;
                    }
                    2 + match h[1] & 127 {
                        126 => 2,
                        127 => 8,
                        _ => 0,
                    } + if h[1] & 128 != 0 { 4 } else { 0 }
                };
                let mut want = need(&self.hdr, self.have);
                while self.have < want && pos < total {
                    self.hdr[self.have] = if pos < al { a[pos] } else { b[pos - al] };
                    self.have += 1;
                    pos += 1;
                    want = need(&self.hdr, self.have);
                }
                if self.have < want {
                    if pos == total && eof {
                        push!(EV_EOF, (self.have == 0) as u32);
                        self.done = true;
                    }
                    break;
                }
                let h = self.hdr;
                let opcode = (h[0] & 15) as u32;
                if h[0] & 0x70 != 0 {
                    push!(EV_ERROR, EPROTO as u32);
                    self.done = true;
                    break;
                }
                let (len, at) = match h[1] & 127 {
                    126 => (u16::from_be_bytes([h[2], h[3]]) as u64, 4),
                    127 => (u64::from_be_bytes([h[2], h[3], h[4], h[5], h[6], h[7], h[8], h[9]]), 10),
                    l => (l as u64, 2),
                };
                self.masked = h[1] & 128 != 0;
                if self.masked {
                    self.mask.copy_from_slice(&h[at..at + 4]);
                }
                if len >> 40 != 0 || (opcode >= 8 && len > 125) {
                    push!(EV_ERROR, EPROTO as u32);
                    self.done = true;
                    break;
                }
                self.mask_off = 0;
                self.rem = len;
                self.have = 0;
                self.in_payload = true;
                let flags = opcode | if h[0] & 128 != 0 { WS_FIN } else { 0 } | if self.masked { WS_MASK } else { 0 };
                push!(EV_WS_FRAME, flags, len as u32, (len >> 32) as u32);
            }
            if self.rem == 0 {
                push!(EV_WS_END);
                self.in_payload = false;
                continue;
            }
            let avail = total - pos;
            if avail == 0 {
                if eof {
                    push!(EV_EOF, 0);
                    self.done = true;
                }
                break;
            }
            let take = (avail as u64).min(self.rem) as usize;
            let mut emit = |s: &mut [u8], mask_off: &mut usize| {
                if s.is_empty() {
                    return;
                }
                if self.masked && self.mask != [0; 4] {
                    for c in s.iter_mut() {
                        *c ^= self.mask[*mask_off & 3];
                        *mask_off += 1;
                    }
                }
                out[n] = EV_WS_DATA;
                out[n + 1] = s.as_ptr() as u32;
                out[n + 2] = s.len() as u32;
                n += 3;
            };
            let mut mo = self.mask_off;
            if pos < al {
                let l = take.min(al - pos);
                emit(&mut a[pos..pos + l], &mut mo);
                emit(&mut b[..take - l], &mut mo);
            } else {
                emit(&mut b[pos - al..pos - al + take], &mut mo);
            }
            self.mask_off = mo;
            hold.get_or_insert(pos);
            pos += take;
            self.rem -= take as u64;
        }
        let now = hold.unwrap_or(pos);
        self.pending = pos - now;
        (now, n)
    }
}

unsafe fn ws<'a>(h: u32) -> R<&'a mut Ws> {
    if h == 0 {
        return Err(EINVAL);
    }
    Ok(&mut *(h as usize as *mut Ws))
}

#[no_mangle]
pub extern "C" fn bat_ws_new() -> u32 {
    Box::into_raw(Box::new(Ws::new())) as usize as u32
}
#[no_mangle]
pub unsafe extern "C" fn bat_ws_free(h: u32) {
    if h != 0 {
        drop(Box::from_raw(h as usize as *mut Ws));
    }
}
/// Parse frames received on `fd`. Events (u32 words): `[EV_WS_FRAME, flags,
/// len_lo, len_hi]`, `[EV_WS_DATA, ptr, len]` (already unmasked, lent until
/// the next call), `[EV_WS_END]`, `[EV_EOF, clean]`, `[EV_ERROR, errno]`.
/// Returns the number of words; 0 means wait for readability.
#[no_mangle]
pub unsafe extern "C" fn bat_ws_recv(h: u32, fd: i32, out: *mut u32, cap_words: usize) -> i32 {
    let w = match ws(h) {
        Ok(w) => w,
        Err(e) => return -e,
    };
    let ring = match proc::cur().and_then(|p| p.fd(fd)).and_then(|f| f.rx_ring().cloned()) {
        Ok(r) => r,
        Err(e) => return -e,
    };
    let out = core::slice::from_raw_parts_mut(out, cap_words);
    ring.with_rx(|a, b, eof| w.run(a, b, eof, out)) as i32
}
/// Start a frame of up to `len` payload bytes on `fd`: writes the header into
/// the send ring (not yet visible to the peer) and reports where the payload
/// goes. `flags`: opcode | `WS_FIN` | `WS_MASK` (client frames; the masking
/// key is zero, which is legal and leaves the payload as written). `out`:
/// `[header_len, n, ptr1, len1, ptr2, len2]`. If `n < len` the frame was cut
/// to what fits and sent without FIN: continue with opcode 0. Returns `n`,
/// or `-EAGAIN` when not even the header fits.
#[no_mangle]
pub unsafe extern "C" fn bat_ws_reserve(fd: i32, flags: u32, len: f64, out: *mut u32) -> i32 {
    let ring = match proc::cur().and_then(|p| p.fd(fd)).and_then(|f| f.tx_ring().cloned()) {
        Ok(r) => r,
        Err(e) => return -e,
    };
    let len = len as u64;
    let r = ring.with_tx(|a, b| {
        let free = a.len() + b.len();
        if free < 15 && (free < 14 || len > 0) {
            return (0, -EAGAIN);
        }
        let n = len.min((free - 14) as u64) as usize;
        let fin = flags & WS_FIN != 0 && n as u64 == len;
        let mut hdr = [0u8; 14];
        hdr[0] = (flags & 15) as u8 | if fin { 0x80 } else { 0 };
        let mbit = if flags & WS_MASK != 0 { 0x80 } else { 0 };
        let mut hl = if n < 126 {
            hdr[1] = mbit | n as u8;
            2
        } else if n < 65536 {
            hdr[1] = mbit | 126;
            hdr[2..4].copy_from_slice(&(n as u16).to_be_bytes());
            4
        } else {
            hdr[1] = mbit | 127;
            hdr[2..10].copy_from_slice(&(n as u64).to_be_bytes());
            10
        };
        if mbit != 0 {
            hl += 4; // key 00 00 00 00
        }
        for (i, c) in hdr[..hl].iter().enumerate() {
            if i < a.len() {
                a[i] = *c;
            } else {
                b[i - a.len()] = *c;
            }
        }
        let (p1, l1, p2, l2) = if hl < a.len() {
            let l1 = (a.len() - hl).min(n);
            (a.as_ptr() as usize + hl, l1, b.as_ptr() as usize, n - l1)
        } else {
            (b.as_ptr() as usize + (hl - a.len()), n, 0, 0)
        };
        *out = hl as u32;
        *out.add(1) = n as u32;
        *out.add(2) = p1 as u32;
        *out.add(3) = l1 as u32;
        *out.add(4) = p2 as u32;
        *out.add(5) = l2 as u32;
        (0, n as i32)
    });
    match r {
        Ok(n) => n,
        Err(e) => -e,
    }
}
/// Publish the frame started by `bat_ws_reserve` (`total` = header_len + n).
#[no_mangle]
pub extern "C" fn bat_ws_commit(fd: i32, total: usize) -> i32 {
    let ring = match proc::cur().and_then(|p| p.fd(fd)).and_then(|f| f.tx_ring().cloned()) {
        Ok(r) => r,
        Err(e) => return -e,
    };
    match ring.with_tx(|a, b| (total.min(a.len() + b.len()), ())) {
        Ok(()) => 0,
        Err(e) => -e,
    }
}

/// `Sec-WebSocket-Accept` for a `Sec-WebSocket-Key`: 28 ASCII bytes at `out`.
#[no_mangle]
pub unsafe extern "C" fn bat_ws_accept_key(key: *const u8, len: usize, out: *mut u8) -> i32 {
    let mut data = Vec::with_capacity(len + 36);
    data.extend_from_slice(core::slice::from_raw_parts(key, len));
    data.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    let text = base64(&sha1(&data));
    core::ptr::copy_nonoverlapping(text.as_ptr(), out, 28);
    28
}

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([block[4 * i], block[4 * i + 1], block[4 * i + 2], block[4 * i + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, x) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&x.to_be_bytes());
    }
    out
}

fn base64(data: &[u8]) -> Vec<u8> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63]);
        out.push(T[(n >> 12) as usize & 63]);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] } else { b'=' });
        out.push(if c.len() > 2 { T[n as usize & 63] } else { b'=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fd::Pipe;

    #[test]
    fn accept_key_matches_rfc() {
        // RFC 6455 §1.3
        assert_eq!(base64(&sha1(b"dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11")), b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn frames_any_split() {
        // Unmasked "Hello" (RFC §5.7), masked "Hello", a 300-byte binary frame, close.
        let mut input = vec![0x81, 0x05, b'H', b'e', b'l', b'l', b'o'];
        input.extend_from_slice(&[0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
        input.extend_from_slice(&[0x82, 126, 1, 44]);
        input.extend((0..300).map(|i| i as u8));
        input.extend_from_slice(&[0x88, 0]);
        for step in [1, 3, 17, 64, 1000] {
            let ring = Pipe::new(128);
            let mut w = Ws::new();
            // Events carry 32-bit addresses; natively the upper half comes from the ring.
            let hi = ring.with_rx(|a, _, _| (0, a.as_ptr() as usize & !0xffff_ffff));
            let mut log = Vec::new();
            let mut data = Vec::new();
            let mut sent = 0;
            loop {
                let mut words = [0u32; 64];
                let n = ring.with_rx(|a, b, eof| w.run(a, b, eof, &mut words));
                let mut i = 0;
                while i < n {
                    match words[i] {
                        EV_WS_FRAME => {
                            log.push(format!("F{:x}:{}", words[i + 1], words[i + 2]));
                            i += 4;
                        }
                        EV_WS_DATA => {
                            data.extend_from_slice(unsafe { core::slice::from_raw_parts((hi | words[i + 1] as usize) as *const u8, words[i + 2] as usize) });
                            i += 3;
                        }
                        EV_WS_END => {
                            log.push(format!("E{}", data.len()));
                            if data.len() == 5 {
                                assert_eq!(data, b"Hello");
                            } else if data.len() == 300 {
                                assert!(data.iter().enumerate().all(|(i, c)| *c == i as u8));
                            }
                            data.clear();
                            i += 1;
                        }
                        _ => panic!("event {}", words[i]),
                    }
                }
                if n == 0 {
                    if sent == input.len() {
                        break;
                    }
                    let m = step.min(input.len() - sent);
                    sent += ring.write(&input[sent..sent + m], true).unwrap();
                }
            }
            assert_eq!(log, ["F101:5", "E5", "F301:5", "E5", "F102:300", "E300", "F108:0", "E0"], "step {step}");
        }
    }
}
