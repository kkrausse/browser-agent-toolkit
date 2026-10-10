//! Message digests and HMAC.
//!
//! Algorithm numbers: 0 md5, 1 sha1, 2 sha224, 3 sha256, 4 sha384, 5 sha512,
//! 6 sha512-256. A handle is a digest state, or for HMAC the inner and outer
//! states after the key pads.
use crate::{bytes, bytes_mut};
use digest::{Digest, DynDigest};

/// Run `$body` with `$D` bound to the digest type for `$alg`.
macro_rules! with_alg {
    ($alg:expr, $D:ident => $body:expr, $else:expr) => {
        match $alg {
            0 => { type $D = md5::Md5; $body }
            1 => { type $D = sha1::Sha1; $body }
            2 => { type $D = sha2::Sha224; $body }
            3 => { type $D = sha2::Sha256; $body }
            4 => { type $D = sha2::Sha384; $body }
            5 => { type $D = sha2::Sha512; $body }
            6 => { type $D = sha2::Sha512_256; $body }
            _ => $else,
        }
    };
}
pub(crate) use with_alg;

pub const MAX_OUT: usize = 64;

fn new_digest(alg: u32) -> Option<Box<dyn DynDigest>> {
    with_alg!(alg, D => Some(Box::new(D::new()) as Box<dyn DynDigest>), None)
}

fn block_size(alg: u32) -> usize {
    if alg >= 4 { 128 } else { 64 }
}

pub struct Hasher {
    inner: Box<dyn DynDigest>,
    outer: Option<Box<dyn DynDigest>>,
}

impl Hasher {
    pub fn hmac(alg: u32, key: &[u8]) -> Option<Hasher> {
        let mut inner = new_digest(alg)?;
        let mut outer = new_digest(alg)?;
        let block = block_size(alg);
        let mut pad = [0u8; 128];
        if key.len() > block {
            let n = inner.output_size();
            inner.update(key);
            inner.finalize_into_reset(&mut pad[..n]).ok()?;
        } else {
            pad[..key.len()].copy_from_slice(key);
        }
        let pad = &mut pad[..block];
        pad.iter_mut().for_each(|b| *b ^= 0x36);
        inner.update(pad);
        pad.iter_mut().for_each(|b| *b ^= 0x36 ^ 0x5c);
        outer.update(pad);
        Some(Hasher { inner, outer: Some(outer) })
    }

    pub fn update(&mut self, data: &[u8]) {
        self.inner.update(data);
    }

    /// Writes the digest and returns its length. The state is spent afterwards.
    pub fn finish(&mut self, out: &mut [u8]) -> usize {
        let n = self.inner.output_size();
        let _ = self.inner.finalize_into_reset(&mut out[..n]);
        if let Some(outer) = &mut self.outer {
            outer.update(&out[..n]);
            let _ = outer.finalize_into_reset(&mut out[..n]);
        }
        n
    }
}

/// HMAC over the concatenation of `parts`; returns the tag length.
pub fn hmac_once(alg: u32, key: &[u8], parts: &[&[u8]], out: &mut [u8; MAX_OUT]) -> Option<usize> {
    let mut h = Hasher::hmac(alg, key)?;
    for p in parts {
        h.update(p);
    }
    Some(h.finish(out))
}

/// Digest of one buffer, no handle. Returns the digest length, 0 for an unknown algorithm.
#[no_mangle]
pub unsafe extern "C" fn bat_hash_oneshot(alg: u32, data: *const u8, len: usize, out: *mut u8) -> usize {
    let data = bytes(data, len);
    with_alg!(alg, D => {
        let d = D::digest(data);
        bytes_mut(out, d.len()).copy_from_slice(&d);
        d.len()
    }, 0)
}

#[no_mangle]
pub unsafe extern "C" fn bat_hmac_oneshot(alg: u32, key: *const u8, key_len: usize, data: *const u8, len: usize, out: *mut u8) -> usize {
    let mut buf = [0u8; MAX_OUT];
    match hmac_once(alg, bytes(key, key_len), &[bytes(data, len)], &mut buf) {
        Some(n) => {
            bytes_mut(out, n).copy_from_slice(&buf[..n]);
            n
        }
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn bat_hash_new(alg: u32) -> *mut Hasher {
    match new_digest(alg) {
        Some(inner) => Box::into_raw(Box::new(Hasher { inner, outer: None })),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn bat_hmac_new(alg: u32, key: *const u8, key_len: usize) -> *mut Hasher {
    match Hasher::hmac(alg, bytes(key, key_len)) {
        Some(h) => Box::into_raw(Box::new(h)),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn bat_hash_update(h: *mut Hasher, data: *const u8, len: usize) {
    (*h).update(bytes(data, len));
}

/// Writes the digest (at most 64 bytes), frees the handle, returns the length.
#[no_mangle]
pub unsafe extern "C" fn bat_hash_final(h: *mut Hasher, out: *mut u8) -> usize {
    let mut h = Box::from_raw(h);
    let mut buf = [0u8; MAX_OUT];
    let n = h.finish(&mut buf);
    bytes_mut(out, n).copy_from_slice(&buf[..n]);
    n
}

#[no_mangle]
pub unsafe extern "C" fn bat_hash_copy(h: *const Hasher) -> *mut Hasher {
    let h = &*h;
    Box::into_raw(Box::new(Hasher {
        inner: h.inner.box_clone(),
        outer: h.outer.as_ref().map(|o| o.box_clone()),
    }))
}

#[no_mangle]
pub unsafe extern "C" fn bat_hash_free(h: *mut Hasher) {
    drop(Box::from_raw(h));
}

#[no_mangle]
pub unsafe extern "C" fn bat_crc32(data: *const u8, len: usize, init: u32) -> u32 {
    let mut h = crc32fast::Hasher::new_with_initial(init);
    h.update(bytes(data, len));
    h.finalize()
}
