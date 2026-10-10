//! Per-instance thread state. Every worker (and the page) instantiates the
//! module over the shared memory and must give its instance a private stack
//! and TLS block before calling anything else. See docs/design/kernel-abi.md
//! "Attaching".

use crate::sys;
use core::cell::Cell;
use core::sync::atomic::{AtomicU32, Ordering::*};

#[repr(C)]
pub struct Thread {
    /// Number of kernel locks held. Read by the supervisor before terminate.
    pub lock_depth: AtomicU32, // +0
    /// Set by the supervisor: park at the next lock acquisition.
    pub dying: AtomicU32, // +4
    pub can_block: u32,   // +8
    pub tid: u32,         // +12
    pub pid: AtomicU32,   // +16
    park: AtomicU32,      // +20
    pub stack_lo: usize,  // +24
    pub stack_top: usize, // +28
    pub tls_block: usize, // +32
    pub tls_size: usize,  // +36
    pub tls_align: usize, // +40
}

thread_local! {
    static CUR: Cell<*const Thread> = const { Cell::new(core::ptr::null()) };
}

static NEXT_TID: AtomicU32 = AtomicU32::new(1);

#[inline]
pub fn current() -> Option<&'static Thread> {
    let p = CUR.with(|c| c.get());
    if p.is_null() {
        None
    } else {
        Some(unsafe { &*p })
    }
}
#[inline]
pub fn can_block() -> bool {
    current().map(|t| t.can_block != 0).unwrap_or(false)
}
#[inline]
pub fn current_pid() -> u32 {
    current().map(|t| t.pid.load(Relaxed)).unwrap_or(0)
}
pub fn park_forever() -> ! {
    let t = current().expect("thread");
    loop {
        if t.can_block != 0 {
            sys::wait(t.park.as_ptr(), 0, -1.0);
        } else {
            core::hint::spin_loop();
        }
    }
}

/// The boot lock word. The host binding takes it (CAS 0 -> 1 with `Atomics`)
/// around the window in which a fresh instance still runs on the module's
/// built-in boot stack: `bat_thread_alloc`, then installing `__stack_pointer`
/// and calling `__wasm_init_tls`.
#[no_mangle]
pub static BAT_BOOT_LOCK: AtomicU32 = AtomicU32::new(0);

fn layout(size: usize, align: usize) -> std::alloc::Layout {
    std::alloc::Layout::from_size_align(size.max(16), align.max(16)).unwrap()
}

/// Called on the boot stack, under the boot lock. Allocates the stack, TLS
/// block and Thread record for the calling instance. Returns the Thread.
#[no_mangle]
pub extern "C" fn bat_thread_alloc(stack_size: usize, tls_size: usize, tls_align: usize) -> *mut Thread {
    let stack_size = (stack_size.max(64 * 1024) + 15) & !15;
    unsafe {
        let stack = std::alloc::alloc(layout(stack_size, 16));
        let tls = std::alloc::alloc_zeroed(layout(tls_size, tls_align));
        let t = std::alloc::alloc_zeroed(std::alloc::Layout::new::<Thread>()) as *mut Thread;
        if stack.is_null() || tls.is_null() || t.is_null() {
            return core::ptr::null_mut();
        }
        (*t).tid = NEXT_TID.fetch_add(1, Relaxed);
        (*t).stack_lo = stack as usize;
        (*t).stack_top = stack as usize + stack_size;
        (*t).tls_block = tls as usize;
        (*t).tls_size = tls_size;
        (*t).tls_align = tls_align;
        t
    }
}

/// First call on the private stack and TLS. `flags` bit 0: this thread may
/// block (false on the page and in service workers).
#[no_mangle]
pub extern "C" fn bat_thread_start(t: *mut Thread, flags: u32) -> u32 {
    unsafe {
        (*t).can_block = flags & 1;
    }
    CUR.with(|c| c.set(t));
    unsafe { (*t).tid }
}

/// Free a thread's stack, TLS and record. Called by the supervisor after the
/// worker is gone (never by the thread itself: it is standing on that stack).
#[no_mangle]
pub extern "C" fn bat_thread_free(t: *mut Thread) {
    unsafe {
        let th = &*t;
        std::alloc::dealloc(th.stack_lo as *mut u8, layout(th.stack_top - th.stack_lo, 16));
        std::alloc::dealloc(th.tls_block as *mut u8, layout(th.tls_size, th.tls_align));
        std::alloc::dealloc(t as *mut u8, std::alloc::Layout::new::<Thread>());
    }
}

/// Supervisor side of the kill gate: mark the thread dying. Returns its
/// current lock depth; the caller polls `bat_thread_lock_depth` until zero,
/// then terminates the worker.
#[no_mangle]
pub extern "C" fn bat_thread_mark_dying(t: *mut Thread) -> u32 {
    unsafe {
        (*t).dying.store(1, SeqCst);
        (*t).lock_depth.load(SeqCst)
    }
}
#[no_mangle]
pub extern "C" fn bat_thread_lock_depth(t: *mut Thread) -> u32 {
    unsafe { (*t).lock_depth.load(SeqCst) }
}
