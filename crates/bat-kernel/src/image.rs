//! Image mounts: the immutable index is held in kernel memory; bodies are read
//! on demand through the host into a chunk cache shared by every instance.

use crate::errno::*;
use crate::lock::WaitQ;
use crate::sys;
use bat_image::Image;
use core::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering::*};

pub const CHUNK_LOG2: u32 = 17;
pub const CHUNK: usize = 1 << CHUNK_LOG2;
/// Host return value meaning "this thread has no handle for the image".
pub const HOST_NO_HANDLE: i32 = -EAGAIN;

const ABSENT: usize = 0;
const LOADING: usize = 1;

pub struct ImageMount {
    pub id: u32,
    pub image: Image<'static>,
    pub name: Box<[u8]>,
    pub file_len: u64,
    slots: Box<[AtomicUsize]>,
    wq: WaitQ,
    pub cached_bytes: AtomicU64,
    pub host_reads: AtomicU64,
    /// Open-addressing table: full image-relative path -> entry index + 1.
    /// Built at mount (one pass over the index); makes a lookup of a path
    /// that lies wholly inside the image one hash and one compare instead of
    /// a binary search per component.
    table: Box<[u32]>,
    mask: u32,
}

#[inline]
fn hash_path(p: &[u8]) -> u32 {
    const K: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut h = K ^ p.len() as u64;
    let mut chunks = p.chunks_exact(8);
    for c in &mut chunks {
        h = (h ^ u64::from_le_bytes(c.try_into().unwrap())).wrapping_mul(K);
        h ^= h >> 32;
    }
    let r = chunks.remainder();
    if !r.is_empty() {
        let mut w = [0u8; 8];
        w[..r.len()].copy_from_slice(r);
        h = (h ^ u64::from_le_bytes(w)).wrapping_mul(K);
        h ^= h >> 32;
    }
    (h ^ (h >> 29)) as u32
}

/// Bumped when a fault serviced by the supervisor completes; the page waits
/// on it with `Atomics.waitAsync` before retrying a read that returned EAGAIN.
#[no_mangle]
pub static BAT_FAULT_WORD: AtomicU32 = AtomicU32::new(0);

fn host_read_exact(id: u32, off: u64, dst: &mut [u8]) -> R<()> {
    let n = sys::image_read(id, off, dst);
    if n == HOST_NO_HANDLE {
        return Err(EAGAIN);
    }
    if n < 0 || n as usize != dst.len() {
        return Err(EIO);
    }
    Ok(())
}

impl ImageMount {
    /// Read and validate the head through the calling thread's handle.
    pub fn open(id: u32, name: &[u8]) -> R<&'static ImageMount> {
        let mut hdr = [0u8; bat_image::HEADER_LEN];
        host_read_exact(id, 0, &mut hdr)?;
        let head_len = Image::head_len(&hdr).map_err(|_| EINVAL)? as usize;
        let mut head = vec![0u8; head_len];
        host_read_exact(id, 0, &mut head)?;
        let head: &'static [u8] = Box::leak(head.into_boxed_slice());
        let image = Image::new(head).map_err(|_| EINVAL)?;
        let file_len = image.file_len();
        let n = file_len.div_ceil(CHUNK as u64) as usize;
        let slots = (0..n).map(|_| AtomicUsize::new(ABSENT)).collect::<Vec<_>>().into_boxed_slice();
        let size = (image.len() as usize * 2).next_power_of_two().max(16);
        let mask = size as u32 - 1;
        let mut table = vec![0u32; size].into_boxed_slice();
        for idx in 0..image.len() {
            let mut slot = hash_path(image.entry(idx).path) & mask;
            while table[slot as usize] != 0 {
                slot = (slot + 1) & mask;
            }
            table[slot as usize] = idx + 1;
        }
        Ok(Box::leak(Box::new(ImageMount {
            id,
            image,
            name: name.into(),
            file_len,
            slots,
            wq: WaitQ::new(),
            cached_bytes: AtomicU64::new(0),
            host_reads: AtomicU64::new(0),
            table,
            mask,
        })))
    }

    /// Entry whose literal path (relative to the image root) is `rel`.
    #[inline]
    pub fn find(&self, rel: &[u8]) -> Option<u32> {
        let mut slot = hash_path(rel) & self.mask;
        loop {
            let v = self.table[slot as usize];
            if v == 0 {
                return None;
            }
            if self.image.entry(v - 1).path == rel {
                return Some(v - 1);
            }
            slot = (slot + 1) & self.mask;
        }
    }

    fn chunk_len(&self, ci: usize) -> usize {
        let start = (ci as u64) << CHUNK_LOG2;
        (self.file_len - start).min(CHUNK as u64) as usize
    }

    /// Load chunk `ci` on this thread. Err(EAGAIN) if this thread has no handle.
    pub fn load(&self, ci: usize) -> R<*const u8> {
        let slot = self.slots.get(ci).ok_or(EIO)?;
        loop {
            let s = slot.load(Acquire);
            if s > LOADING {
                return Ok(s as *const u8);
            }
            if s == ABSENT {
                if slot.compare_exchange(ABSENT, LOADING, AcqRel, Acquire).is_err() {
                    continue;
                }
                let len = self.chunk_len(ci);
                let mut buf = Vec::<u8>::with_capacity(len);
                let r = host_read_exact(self.id, (ci as u64) << CHUNK_LOG2, unsafe {
                    core::slice::from_raw_parts_mut(buf.as_mut_ptr(), len)
                });
                match r {
                    Ok(()) => {
                        unsafe { buf.set_len(len) };
                        let p = Box::leak(buf.into_boxed_slice()).as_ptr();
                        slot.store(p as usize, Release);
                        self.cached_bytes.fetch_add(len as u64, Relaxed);
                        self.host_reads.fetch_add(1, Relaxed);
                        self.wq.wake_all();
                        return Ok(p);
                    }
                    Err(e) => {
                        slot.store(ABSENT, Release);
                        self.wq.wake_all();
                        return Err(e);
                    }
                }
            }
            // Another instance is loading it.
            if !crate::thread::can_block() {
                core::hint::spin_loop();
                continue;
            }
            let seq = self.wq.seq();
            if slot.load(Acquire) == LOADING {
                self.wq.wait(seq, 50.0);
            }
        }
    }

    /// Chunk pointer, faulting it in. A thread without a handle asks the
    /// supervisor; if it also cannot block (the page) it gets EAGAIN and
    /// retries after `BAT_FAULT_WORD` changes.
    fn chunk(&self, ci: usize) -> R<*const u8> {
        let s = self.slots.get(ci).ok_or(EIO)?.load(Acquire);
        if s > LOADING {
            return Ok(s as *const u8);
        }
        match self.load(ci) {
            Err(EAGAIN) => {}
            other => return other,
        }
        crate::proc::supervisor_request(crate::proc::Work::Fault { image: self.id, chunk: ci as u32 });
        if !crate::thread::can_block() {
            return Err(EAGAIN);
        }
        let mut waited = 0;
        loop {
            let seq = self.wq.seq();
            let s = self.slots[ci].load(Acquire);
            if s > LOADING {
                return Ok(s as *const u8);
            }
            if waited > 200 {
                return Err(EIO);
            }
            self.wq.wait(seq, 50.0);
            waited += 1;
        }
    }

    pub fn read_at(&self, mut off: u64, dst: &mut [u8]) -> R<()> {
        if off + dst.len() as u64 > self.file_len {
            return Err(EIO);
        }
        let mut done = 0;
        while done < dst.len() {
            let ci = (off >> CHUNK_LOG2) as usize;
            let within = (off & (CHUNK as u64 - 1)) as usize;
            let n = (CHUNK - within).min(dst.len() - done);
            let p = self.chunk(ci)?;
            unsafe { core::ptr::copy_nonoverlapping(p.add(within), dst.as_mut_ptr().add(done), n) };
            done += n;
            off += n as u64;
        }
        Ok(())
    }
}
