//! Asking before taking: what can be large (file contents, image chunks) checks that the
//! kernel memory has room before it allocates, so that a full memory is an error to the
//! caller and not Rust's allocation-failure abort. See alloc.rs and
//! docs/design/decisions.md, "the kernel memory has a fixed size".

use crate::errno::*;

#[cfg(target_arch = "wasm32")]
pub fn can_take(bytes: usize) -> bool {
    crate::alloc::can_take(bytes)
}
#[cfg(not(target_arch = "wasm32"))]
pub fn can_take(_bytes: usize) -> bool {
    true
}

#[cfg(target_arch = "wasm32")]
pub fn refused(bytes: usize) {
    crate::alloc::note_refused(bytes, false);
}
#[cfg(not(target_arch = "wasm32"))]
pub fn refused(_bytes: usize) {}

/// Make room for `additional` more bytes in `v`, or fail with `err`. Before failing, the
/// image chunk cache is emptied once: it is only a cache.
pub fn reserve(v: &mut Vec<u8>, additional: usize, err: i32) -> R<()> {
    let extra = (v.len() + additional).saturating_sub(v.capacity());
    if extra == 0 {
        return Ok(());
    }
    if !can_take(extra) {
        crate::image::evict(usize::MAX);
        if !can_take(extra) {
            refused(extra);
            return Err(err);
        }
    }
    v.try_reserve_exact(additional).map_err(|_| err)
}

/// A zeroed buffer of `len` bytes, or `err`.
pub fn zeroed(len: usize, err: i32) -> R<Vec<u8>> {
    let mut v = Vec::new();
    reserve(&mut v, len, err)?;
    v.resize(len, 0);
    Ok(v)
}
