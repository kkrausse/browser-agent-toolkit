//! Native codecs for `node:zlib` and `node:crypto`, called from
//! `runtime/src/node/{zlib,crypto}.ts`.
//!
//! C ABI over linear memory: buffers are `(pointer, length)`, allocated by the
//! caller with `bat_alloc` and released with `bat_free`. Stateful objects
//! (digests, ciphers, compression streams) are returned as opaque non-zero
//! integer handles; 0 means the parameters were rejected. Nothing here reads
//! the clock or randomness, so the module has no imports.
#![allow(clippy::missing_safety_doc)]

pub mod cipher;
pub mod digest;
pub mod kdf;
pub mod z;

#[no_mangle]
pub extern "C" fn bat_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn bat_free(p: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(p, 0, len.max(1)));
}

pub(crate) unsafe fn bytes<'a>(p: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        core::slice::from_raw_parts(p, len)
    }
}

pub(crate) unsafe fn bytes_mut<'a>(p: *mut u8, len: usize) -> &'a mut [u8] {
    if len == 0 {
        &mut []
    } else {
        core::slice::from_raw_parts_mut(p, len)
    }
}
