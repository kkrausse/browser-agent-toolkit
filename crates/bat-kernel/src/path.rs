//! Fixed-size path buffers so path resolution never allocates.
use crate::errno::*;
use core::mem::MaybeUninit;

pub const PATH_MAX: usize = 4096;

pub struct PathBuf {
    len: usize,
    buf: [MaybeUninit<u8>; PATH_MAX],
}

impl PathBuf {
    #[inline]
    pub fn new() -> Self {
        PathBuf { len: 0, buf: [MaybeUninit::uninit(); PATH_MAX] }
    }
    #[inline]
    pub fn as_bytes(&self) -> &[u8] {
        unsafe { core::slice::from_raw_parts(self.buf.as_ptr() as *const u8, self.len) }
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }
    #[inline]
    pub fn clear(&mut self) {
        self.len = 0;
    }
    #[inline]
    pub fn truncate(&mut self, n: usize) {
        if n < self.len {
            self.len = n;
        }
    }
    #[inline]
    pub fn push(&mut self, b: &[u8]) -> R<()> {
        if self.len + b.len() > PATH_MAX {
            return Err(ENAMETOOLONG);
        }
        unsafe {
            core::ptr::copy_nonoverlapping(b.as_ptr(), (self.buf.as_mut_ptr() as *mut u8).add(self.len), b.len());
        }
        self.len += b.len();
        Ok(())
    }
    pub fn set(&mut self, b: &[u8]) -> R<()> {
        self.len = 0;
        self.push(b)
    }
    fn pop_component(&mut self) {
        let b = self.as_bytes();
        let mut i = b.len();
        while i > 0 && b[i - 1] != b'/' {
            i -= 1;
        }
        self.len = i.saturating_sub(1);
    }
    /// Append `p` lexically: an absolute `p` replaces the buffer; `.` and
    /// empty components vanish; `..` pops. The buffer always holds a
    /// normalized absolute path: `""` for the root, else `/a/b`.
    pub fn join(&mut self, p: &[u8]) -> R<()> {
        if p.first() == Some(&b'/') {
            self.len = 0;
        }
        for c in p.split(|&b| b == b'/') {
            match c {
                b"" | b"." => {}
                b".." => self.pop_component(),
                _ => {
                    self.push(b"/")?;
                    self.push(c)?;
                }
            }
        }
        Ok(())
    }
}

/// Split a normalized path into (parent, name). The root has no name.
pub fn split_parent(p: &[u8]) -> Option<(&[u8], &[u8])> {
    let i = p.iter().rposition(|&b| b == b'/')?;
    Some((&p[..i], &p[i + 1..]))
}

/// Iterate the components of a normalized path.
pub fn components(p: &[u8]) -> impl Iterator<Item = &[u8]> {
    p.split(|&b| b == b'/').filter(|c| !c.is_empty())
}

/// True if `p` equals `root` or lies under it (both normalized).
pub fn is_under(p: &[u8], root: &[u8]) -> bool {
    p.len() >= root.len() && &p[..root.len()] == root && (p.len() == root.len() || p[root.len()] == b'/')
}
