//! The kernel heap: dlmalloc over `memory.grow`, behind a kernel lock so the
//! page never futex-waits (wasi-libc's malloc lock would) and so the kill gate
//! covers allocation.

use crate::lock::RawLock;
use core::alloc::{GlobalAlloc, Layout};
use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicU32, Ordering::*};

struct Pages;

/// Bumped whenever memory grows; the host binding compares it to decide when
/// its typed-array views are stale.
#[no_mangle]
pub static BAT_MEM_GEN: AtomicU32 = AtomicU32::new(0);

unsafe impl dlmalloc::Allocator for Pages {
    fn alloc(&self, size: usize) -> (*mut u8, usize, u32) {
        let pages = size.div_ceil(65536);
        // Grow in at least 1 MiB steps: each grow invalidates every JS view.
        let pages = pages.max(16);
        let prev = core::arch::wasm32::memory_grow(0, pages);
        if prev == usize::MAX {
            return (core::ptr::null_mut(), 0, 0);
        }
        BAT_MEM_GEN.fetch_add(1, SeqCst);
        ((prev * 65536) as *mut u8, pages * 65536, 0)
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
        self.lock.unlock();
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        self.lock.lock();
        (*self.inner.get()).free(p, l.size(), l.align());
        self.lock.unlock();
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        self.lock.lock();
        let p = (*self.inner.get()).calloc(l.size(), l.align());
        self.lock.unlock();
        p
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        self.lock.lock();
        let p = (*self.inner.get()).realloc(p, l.size(), l.align(), new);
        self.lock.unlock();
        p
    }
}
