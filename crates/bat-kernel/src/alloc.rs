//! The kernel heap: dlmalloc over `memory.grow`, behind a kernel lock so the
//! page never futex-waits (wasi-libc's malloc lock would) and so the kill gate
//! covers allocation.

use crate::lock::RawLock;
use core::alloc::{GlobalAlloc, Layout};
use core::cell::UnsafeCell;
use core::ffi::c_void;
use core::sync::atomic::{AtomicU32, AtomicUsize, Ordering::*};

struct Pages;

/// Bumped whenever memory grows; the host binding compares it to decide when
/// its typed-array views are stale.
#[no_mangle]
pub static BAT_MEM_GEN: AtomicU32 = AtomicU32::new(0);

const PAGE: u64 = 65536;
/// Pages added by one `memory.grow`, where the memory may grow at all: 64 MiB.
const GROW_PAGES: u64 = 1024;

extern "C" {
    static __heap_base: u8;
}

/// End of what has been handed to dlmalloc (0: nothing yet, the heap starts at `__heap_base`).
/// Written under the allocator lock.
static BRK: AtomicUsize = AtomicUsize::new(0);
/// The memory's declared maximum in pages, told by the host (`bat_mem_configure`).
static MAX_PAGES: AtomicU32 = AtomicU32::new(65536);
/// Bytes handed out and not freed, and the most that ever was.
static IN_USE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
/// Allocations refused or failed for want of memory.
static REFUSED: AtomicU32 = AtomicU32::new(0);
static GROWS: AtomicU32 = AtomicU32::new(0);

fn heap_start() -> usize {
    (core::ptr::addr_of!(__heap_base) as usize + PAGE as usize - 1) & !(PAGE as usize - 1)
}

unsafe impl dlmalloc::Allocator for Pages {
    /// Address space for dlmalloc, from a break that starts at `__heap_base`. The memory is
    /// created at its full size by default (docs/design/decisions.md, "the kernel memory has
    /// a fixed size"), so this is arithmetic; `memory.grow` runs only for an embedder that
    /// asked for a memory smaller than its maximum. Then it grows rarely, in GROW_PAGES
    /// steps: each grow invalidates every JS view, and in WebKit each grow of a shared
    /// memory is a chance to crash the tab (JavaScriptCore walks every instance attached to
    /// the memory, and one that a terminated worker is in the middle of destroying makes it
    /// read a null pointer; docs/experiments/2026-10-11-webkit.md, section 9).
    fn alloc(&self, size: usize) -> (*mut u8, usize, u32) {
        // At least 1 MiB at a time, so that dlmalloc's segments are few and adjoin.
        let bytes = (size as u64).div_ceil(PAGE).max(16) * PAGE;
        let brk = match BRK.load(Relaxed) {
            0 => heap_start(),
            b => b,
        } as u64;
        let end = brk + bytes;
        let have = core::arch::wasm32::memory_size(0) as u64 * PAGE;
        if end > have {
            let needed = (end - have).div_ceil(PAGE);
            let room = (MAX_PAGES.load(Relaxed) as u64).saturating_sub(have / PAGE);
            if needed > room {
                return (core::ptr::null_mut(), 0, 0);
            }
            let mut pages = needed.max(GROW_PAGES).min(room);
            let mut prev = core::arch::wasm32::memory_grow(0, pages as usize);
            if prev == usize::MAX && pages > needed {
                // The tab's own limit is nearer than the declared one: what was asked for.
                pages = needed;
                prev = core::arch::wasm32::memory_grow(0, pages as usize);
            }
            if prev == usize::MAX {
                return (core::ptr::null_mut(), 0, 0);
            }
            GROWS.fetch_add(1, Relaxed);
            BAT_MEM_GEN.fetch_add(1, SeqCst);
        }
        // `end` is at most 4 GiB; a break at exactly 4 GiB would read as "nothing yet".
        if end > u32::MAX as u64 {
            return (core::ptr::null_mut(), 0, 0);
        }
        BRK.store(end as usize, Relaxed);
        (brk as usize as *mut u8, bytes as usize, 0)
    }
    fn remap(&self, _: *mut u8, _: usize, _: usize, _: bool) -> *mut u8 {
        core::ptr::null_mut()
    }
    fn free_part(&self, _: *mut u8, _: usize, _: usize) -> bool {
        false
    }
    fn free(&self, _: *mut u8, _: usize) -> bool {
        false
    }
    fn can_release_part(&self, _: u32) -> bool {
        false
    }
    fn allocates_zeros(&self) -> bool {
        true
    }
    fn page_size(&self) -> usize {
        65536
    }
}

pub fn set_max_pages(pages: u32) {
    MAX_PAGES.store(pages.clamp(1, 65536), Relaxed);
}

/// Bytes the heap may ever hold: from its start to the memory's maximum.
fn capacity() -> u64 {
    (MAX_PAGES.load(Relaxed) as u64 * PAGE).saturating_sub(heap_start() as u64)
}

/// What stays free for the small allocations that cannot fail.
fn reserve() -> u64 {
    (capacity() / 16).min(16 << 20)
}

/// Would `bytes` more leave the reserve intact? (The count is of bytes asked for; what
/// dlmalloc loses to its own bookkeeping and to fragmentation comes out of the reserve.)
pub fn can_take(bytes: usize) -> bool {
    IN_USE.load(Relaxed) as u64 + bytes as u64 + reserve() <= capacity()
}

fn put_mib(out: &mut [u8], at: &mut usize, bytes: u64) {
    let tenths = bytes * 10 / (1 << 20);
    let mut digits = [0u8; 12];
    let mut n = 0;
    let mut whole = tenths / 10;
    loop {
        digits[n] = b'0' + (whole % 10) as u8;
        n += 1;
        whole /= 10;
        if whole == 0 {
            break;
        }
    }
    while n > 0 {
        n -= 1;
        out[*at] = digits[n];
        *at += 1;
    }
    out[*at] = b'.';
    out[*at + 1] = b'0' + (tenths % 10) as u8;
    *at += 2;
}

/// An allocation of `bytes` was refused (`failed`: it failed outright). Logged the first
/// time and then every 64th, without allocating.
pub fn note_refused(bytes: usize, failed: bool) {
    let n = REFUSED.fetch_add(1, Relaxed);
    if n % 64 != 0 {
        return;
    }
    let mut line = [0u8; 320];
    let mut at = 0;
    let put = |s: &[u8], at: &mut usize, line: &mut [u8]| {
        line[*at..*at + s.len()].copy_from_slice(s);
        *at += s.len();
    };
    put(b"bat kernel: out of memory: ", &mut at, &mut line);
    put_mib(&mut line, &mut at, IN_USE.load(Relaxed) as u64);
    put(b" of ", &mut at, &mut line);
    put_mib(&mut line, &mut at, capacity());
    put(b" MiB in use, ", &mut at, &mut line);
    put_mib(&mut line, &mut at, bytes as u64);
    put(if failed { b" MiB more could not be had. " } else { b" MiB more was refused (ENOSPC/ENOMEM). " }, &mut at, &mut line);
    put(b"Files the programs write, pipes and the image cache live in this memory; its size is the runtime's boot option kernelMemory.pages.", &mut at, &mut line);
    crate::sys::log(3, unsafe { core::str::from_utf8_unchecked(&line[..at]) });
}

/// out: size of the memory, its maximum, start of the heap, break, bytes in use, peak of
/// bytes in use, refusals, grows. All f64; sizes in bytes.
pub fn stats(out: &mut [f64; 8]) {
    out[0] = core::arch::wasm32::memory_size(0) as f64 * PAGE as f64;
    out[1] = MAX_PAGES.load(Relaxed) as f64 * PAGE as f64;
    out[2] = heap_start() as f64;
    out[3] = BRK.load(Relaxed).max(heap_start()) as f64;
    out[4] = IN_USE.load(Relaxed) as f64;
    out[5] = PEAK.load(Relaxed) as f64;
    out[6] = REFUSED.load(Relaxed) as f64;
    out[7] = GROWS.load(Relaxed) as f64;
}

#[inline]
fn took(bytes: usize) {
    let now = IN_USE.fetch_add(bytes, Relaxed) + bytes;
    if now > PEAK.load(Relaxed) {
        PEAK.store(now, Relaxed);
    }
}

pub struct KernelAlloc {
    lock: RawLock,
    inner: UnsafeCell<dlmalloc::Dlmalloc<Pages>>,
}
unsafe impl Sync for KernelAlloc {}

impl KernelAlloc {
    pub const fn new() -> Self {
        KernelAlloc { lock: RawLock::new(), inner: UnsafeCell::new(dlmalloc::Dlmalloc::new_with_allocator(Pages)) }
    }
}

unsafe impl GlobalAlloc for KernelAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        self.lock.lock();
        let p = (*self.inner.get()).malloc(l.size(), l.align());
        if !p.is_null() {
            took(l.size());
        }
        self.lock.unlock();
        if p.is_null() {
            note_refused(l.size(), true);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        self.lock.lock();
        (*self.inner.get()).free(p, l.size(), l.align());
        IN_USE.fetch_sub(l.size(), Relaxed);
        self.lock.unlock();
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        self.lock.lock();
        let p = (*self.inner.get()).calloc(l.size(), l.align());
        if !p.is_null() {
            took(l.size());
        }
        self.lock.unlock();
        if p.is_null() {
            note_refused(l.size(), true);
        }
        p
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        self.lock.lock();
        let q = (*self.inner.get()).realloc(p, l.size(), l.align(), new);
        if !q.is_null() {
            IN_USE.fetch_sub(l.size(), Relaxed);
            took(new);
        }
        self.lock.unlock();
        if q.is_null() {
            note_refused(new.saturating_sub(l.size()), true);
        }
        q
    }
}

// The C allocation functions, over the kernel heap. wasi-libc's own are in the same archive
// member, get their memory from `sbrk` (`memory.grow`) and take a futex lock; defining all
// of them here keeps that member out of the link. Each block is preceded by its size.
const C_HEADER: usize = 16;

unsafe fn c_alloc(size: usize, zeroed: bool) -> *mut u8 {
    let Some(total) = size.checked_add(C_HEADER) else { return core::ptr::null_mut() };
    let l = Layout::from_size_align_unchecked(total, 16);
    let p = if zeroed { crate::GLOBAL.alloc_zeroed(l) } else { crate::GLOBAL.alloc(l) };
    if p.is_null() {
        return p;
    }
    (p as *mut usize).write(total);
    p.add(C_HEADER)
}
#[no_mangle]
pub unsafe extern "C" fn malloc(size: usize) -> *mut c_void {
    c_alloc(size, false) as *mut c_void
}
#[no_mangle]
pub unsafe extern "C" fn calloc(n: usize, size: usize) -> *mut c_void {
    match n.checked_mul(size) {
        Some(total) => c_alloc(total, true) as *mut c_void,
        None => core::ptr::null_mut(),
    }
}
#[no_mangle]
pub unsafe extern "C" fn free(p: *mut c_void) {
    if p.is_null() {
        return;
    }
    let base = (p as *mut u8).sub(C_HEADER);
    let total = (base as *const usize).read();
    crate::GLOBAL.dealloc(base, Layout::from_size_align_unchecked(total, 16));
}
#[no_mangle]
pub unsafe extern "C" fn realloc(p: *mut c_void, size: usize) -> *mut c_void {
    if p.is_null() {
        return c_alloc(size, false) as *mut c_void;
    }
    let base = (p as *mut u8).sub(C_HEADER);
    let total = (base as *const usize).read();
    let Some(new_total) = size.checked_add(C_HEADER) else { return core::ptr::null_mut() };
    let q = crate::GLOBAL.realloc(base, Layout::from_size_align_unchecked(total, 16), new_total);
    if q.is_null() {
        return core::ptr::null_mut();
    }
    (q as *mut usize).write(new_total);
    q.add(C_HEADER) as *mut c_void
}
#[no_mangle]
pub unsafe extern "C" fn aligned_alloc(align: usize, size: usize) -> *mut u8 {
    // Nothing in the kernel asks libc for more than 16-byte alignment.
    if align > 16 {
        return core::ptr::null_mut();
    }
    c_alloc(size, false)
}
#[no_mangle]
pub unsafe extern "C" fn posix_memalign(out: *mut *mut u8, align: usize, size: usize) -> i32 {
    let p = aligned_alloc(align, size);
    if p.is_null() {
        return crate::errno::ENOMEM;
    }
    out.write(p);
    0
}
#[no_mangle]
pub unsafe extern "C" fn malloc_usable_size(p: *mut u8) -> usize {
    if p.is_null() {
        0
    } else {
        (p.sub(C_HEADER) as *const usize).read() - C_HEADER
    }
}
