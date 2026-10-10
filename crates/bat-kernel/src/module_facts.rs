//! Facts blob of an image module (added by the node-runtime agent).
//!
//! `bat_read_file` with the compiled flag returns the compiled body and the
//! facts word (in the stat), but not the blob that follows the body in the
//! image: the import/export lists (docs/design/image-format.md, "Module
//! record"). The loader needs the export names of a CommonJS module when an
//! ES module imports it, and only then, so this is a separate call rather
//! than extra bytes on every module read.

use crate::errno::*;
use crate::path::PathBuf;
use crate::proc;
use crate::vfs::{NONE, VFS};

/// `bat_module_facts(path, len, buf, cap) -> len`
///
/// Writes the facts blob of the image entry at `path` (0 if the entry has
/// none, or the file is not in an image). On `ERANGE` the needed size is
/// stored in the first 4 bytes of `buf`.
#[no_mangle]
pub unsafe extern "C" fn bat_module_facts(p: *const u8, n: usize, buf: *mut u8, cap: usize) -> i32 {
    match module_facts(p, n, buf, cap) {
        Ok(v) => v as i32,
        Err(e) => -e,
    }
}

unsafe fn module_facts(p: *const u8, n: usize, buf: *mut u8, cap: usize) -> R<usize> {
    let s: &[u8] = if n == 0 { &[] } else { core::slice::from_raw_parts(p, n) };
    let mut pb = PathBuf::new();
    if s.first() != Some(&b'/') {
        if s.is_empty() {
            return Err(ENOENT);
        }
        let pr = proc::cur()?;
        let st = pr.st.lock();
        pb.set(&st.cwd)?;
    }
    pb.join(s)?;
    let (m, ext) = {
        let v = VFS.read();
        let mut canon = PathBuf::new();
        let l = v.walk(pb.as_bytes(), true, &mut canon)?;
        if l.ov != NONE || l.img == NONE {
            return Ok(0);
        }
        let m = v.image(l.img);
        match m.image.entry(l.idx).facts_blob() {
            Some(ext) => (m, ext),
            None => return Ok(0),
        }
    };
    let len = ext.len as usize;
    if len > cap {
        if cap >= 4 {
            (buf as *mut u32).write_unaligned(len as u32);
        }
        return Err(ERANGE);
    }
    if len > 0 {
        m.read_at(ext.offset, core::slice::from_raw_parts_mut(buf, len))?;
    }
    Ok(len)
}
