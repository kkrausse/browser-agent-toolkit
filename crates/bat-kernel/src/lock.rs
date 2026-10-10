//! Kernel locks. All kernel state lives in shared memory, so every lock is a
//! word in that memory. Workers block with a futex wait; a thread that may not
//! block (the page) spins instead. Critical sections are short by rule: no
//! host call that can block and no waiting while a lock is held.
//!
//! Kill gate: a worker can be `terminate()`d by the supervisor at any wasm
//! back-edge, which would leave a held lock held forever. Each thread counts
//! the locks it holds in shared memory (`Thread::lock_depth`); the supervisor
//! sets `Thread::dying` and waits for the depth to read zero before it
//! terminates the worker. A dying thread that tries to take its first lock
//! parks instead.

use crate::sys;
use crate::thread;
use core::cell::UnsafeCell;
use core::ops::{Deref, DerefMut};
use core::sync::atomic::{AtomicU32, Ordering::*};

const SPINS: u32 = 200;

#[inline]
fn gate_enter() {
    if let Some(t) = thread::current() {
        let d = t.lock_depth.load(Relaxed);
        t.lock_depth.store(d + 1, SeqCst);
        if d == 0 && t.dying.load(SeqCst) != 0 {
            t.lock_depth.store(0, SeqCst);
            thread::park_forever();
        }
    }
}

#[inline]
fn gate_leave() {
    if let Some(t) = thread::current() {
        let d = t.lock_depth.load(Relaxed);
        t.lock_depth.store(d.wrapping_sub(1), Release);
    }
}

/// 0 free, 1 held, 2 held with (possible) waiters.
pub struct RawLock(AtomicU32);

impl RawLock {
    pub const fn new() -> Self {
        RawLock(AtomicU32::new(0))
    }
    #[inline]
    pub fn lock(&self) {
        gate_enter();
        if self.0.compare_exchange(0, 1, Acquire, Relaxed).is_err() {
            self.lock_slow();
        }
    }
    #[cold]
    fn lock_slow(&self) {
        for _ in 0..SPINS {
            if self.0.load(Relaxed) == 0 && self.0.compare_exchange(0, 1, Acquire, Relaxed).is_ok() {
                return;
            }
            core::hint::spin_loop();
        }
        let can_block = thread::can_block();
        loop {
            if self.0.swap(2, Acquire) == 0 {
                return;
            }
            if can_block {
                sys::wait(self.0.as_ptr(), 2, -1.0);
            } else {
                core::hint::spin_loop();
            }
        }
    }
    #[inline]
    pub fn unlock(&self) {
        if self.0.swap(0, Release) == 2 {
            sys::notify(self.0.as_ptr(), 1);
        }
        gate_leave();
    }
}

pub struct Mutex<T> {
    raw: RawLock,
    data: UnsafeCell<T>,
}
unsafe impl<T: Send> Sync for Mutex<T> {}
unsafe impl<T: Send> Send for Mutex<T> {}

impl<T> Mutex<T> {
    pub const fn new(v: T) -> Self {
        Mutex { raw: RawLock::new(), data: UnsafeCell::new(v) }
    }
    #[inline]
    pub fn lock(&self) -> MutexGuard<'_, T> {
        self.raw.lock();
        MutexGuard { m: self }
    }
}
pub struct MutexGuard<'a, T> {
    m: &'a Mutex<T>,
}
impl<T> Deref for MutexGuard<'_, T> {
    type Target = T;
    #[inline]
    fn deref(&self) -> &T {
        unsafe { &*self.m.data.get() }
    }
}
impl<T> DerefMut for MutexGuard<'_, T> {
    #[inline]
    fn deref_mut(&mut self) -> &mut T {
        unsafe { &mut *self.m.data.get() }
    }
}
impl<T> Drop for MutexGuard<'_, T> {
    #[inline]
    fn drop(&mut self) {
        self.m.raw.unlock();
    }
}

/// Reader/writer lock for read-mostly state (the VFS tree).
/// Word: bit 31 writer held, bit 30 someone is waiting, low bits reader count.
const W: u32 = 1 << 31;
const WAIT: u32 = 1 << 30;
const RMASK: u32 = WAIT - 1;

pub struct RwLock<T> {
    s: AtomicU32,
    /// Bumped on every release that had waiters; waiters sleep on it.
    seq: AtomicU32,
    data: UnsafeCell<T>,
}
unsafe impl<T: Send + Sync> Sync for RwLock<T> {}
unsafe impl<T: Send> Send for RwLock<T> {}

impl<T> RwLock<T> {
    pub const fn new(v: T) -> Self {
        RwLock { s: AtomicU32::new(0), seq: AtomicU32::new(0), data: UnsafeCell::new(v) }
    }
    #[inline]
    pub fn read(&self) -> ReadGuard<'_, T> {
        gate_enter();
        let s = self.s.load(Relaxed);
        if s & (W | WAIT) != 0 || self.s.compare_exchange_weak(s, s + 1, Acquire, Relaxed).is_err() {
            self.slow(false);
        }
        ReadGuard { l: self }
    }
    #[inline]
    pub fn write(&self) -> WriteGuard<'_, T> {
        gate_enter();
        if self.s.compare_exchange(0, W, Acquire, Relaxed).is_err() {
            self.slow(true);
        }
        WriteGuard { l: self }
    }
    fn try_once(&self, write: bool, queued: bool) -> bool {
        let s = self.s.load(Relaxed);
        if write {
            // A writer may take the lock when nobody holds it, keeping WAIT set
            // if it is one of the waiters (others may still be asleep).
            s & (W | RMASK) == 0 && self.s.compare_exchange_weak(s, s | W, Acquire, Relaxed).is_ok()
        } else {
            // Readers yield to waiting writers unless they are queued themselves.
            s & W == 0
                && (queued || s & WAIT == 0)
                && self.s.compare_exchange_weak(s, s + 1, Acquire, Relaxed).is_ok()
        }
    }
    #[cold]
    fn slow(&self, write: bool) {
        for _ in 0..SPINS {
            if self.try_once(write, false) {
                return;
            }
            core::hint::spin_loop();
        }
        let can_block = thread::can_block();
        loop {
            let seq = self.seq.load(SeqCst);
            self.s.fetch_or(WAIT, SeqCst);
            if self.try_once(write, true) {
                return;
            }
            if can_block {
                sys::wait(self.seq.as_ptr(), seq, -1.0);
            } else {
                core::hint::spin_loop();
            }
        }
    }
    #[inline]
    fn release(&self, write: bool) {
        let prev = if write { self.s.fetch_and(!(W | WAIT), Release) } else { self.s.fetch_sub(1, Release) };
        if prev & WAIT != 0 {
            self.wake(write, prev);
        }
        gate_leave();
    }
    #[cold]
    fn wake(&self, write: bool, prev: u32) {
        if !write {
            if prev & RMASK != 1 {
                return; // other readers remain; the last one wakes
            }
            self.s.fetch_and(!WAIT, SeqCst);
        }
        self.seq.fetch_add(1, SeqCst);
        sys::notify(self.seq.as_ptr(), u32::MAX);
    }
}
pub struct ReadGuard<'a, T> {
    l: &'a RwLock<T>,
}
impl<T> Deref for ReadGuard<'_, T> {
    type Target = T;
    #[inline]
    fn deref(&self) -> &T {
        unsafe { &*self.l.data.get() }
    }
}
impl<T> Drop for ReadGuard<'_, T> {
    #[inline]
    fn drop(&mut self) {
        self.l.release(false);
    }
}
pub struct WriteGuard<'a, T> {
    l: &'a RwLock<T>,
}
impl<T> Deref for WriteGuard<'_, T> {
    type Target = T;
    #[inline]
    fn deref(&self) -> &T {
        unsafe { &*self.l.data.get() }
    }
}
impl<T> DerefMut for WriteGuard<'_, T> {
    #[inline]
    fn deref_mut(&mut self) -> &mut T {
        unsafe { &mut *self.l.data.get() }
    }
}
impl<T> Drop for WriteGuard<'_, T> {
    #[inline]
    fn drop(&mut self) {
        self.l.release(true);
    }
}

/// A wait queue: a sequence word. Sleepers read it under the object's lock,
/// drop the lock, and wait for it to change; wakers bump it and notify.
pub struct WaitQ(pub AtomicU32);
impl WaitQ {
    pub const fn new() -> Self {
        WaitQ(AtomicU32::new(0))
    }
    #[inline]
    pub fn seq(&self) -> u32 {
        self.0.load(SeqCst)
    }
    /// Returns false on timeout. `timeout_ms < 0` waits forever.
    pub fn wait(&self, seq: u32, timeout_ms: f64) -> bool {
        sys::wait(self.0.as_ptr(), seq, timeout_ms) != 2
    }
    #[inline]
    pub fn wake_all(&self) {
        self.0.fetch_add(1, SeqCst);
        sys::notify(self.0.as_ptr(), u32::MAX);
    }
}
