//! The only place that talks to the host. On wasm these are imports from the
//! `bat` module supplied by the TypeScript binding; natively they are small
//! std-backed stand-ins so kernel logic can be exercised with `cargo test`.

#[cfg(target_arch = "wasm32")]
mod imp {
    #[link(wasm_import_module = "bat")]
    extern "C" {
        fn host_wait(addr: *const u32, expect: u32, timeout_ms: f64) -> i32;
        fn host_notify(addr: *const u32, count: u32) -> u32;
        fn host_log(level: u32, ptr: *const u8, len: usize);
        fn host_now_ms() -> f64;
        fn host_image_read(image: u32, offset: f64, ptr: *mut u8, len: usize) -> i32;
    }

    /// `memory.atomic.wait32` through `Atomics.wait`. The stable toolchain does
    /// not expose the instruction (stdarch_wasm_atomic_wait is unstable), and
    /// this is only reached on slow paths. Returns 0 woken, 1 value differed,
    /// 2 timed out. Never call on a thread that cannot block.
    pub fn wait(addr: *const u32, expect: u32, timeout_ms: f64) -> i32 {
        unsafe { host_wait(addr, expect, timeout_ms) }
    }
    pub fn notify(addr: *const u32, count: u32) -> u32 {
        unsafe { host_notify(addr, count) }
    }
    pub fn log(level: u32, msg: &str) {
        unsafe { host_log(level, msg.as_ptr(), msg.len()) }
    }
    pub fn now_ms() -> f64 {
        unsafe { host_now_ms() }
    }
    pub fn image_read(image: u32, offset: u64, buf: &mut [u8]) -> i32 {
        unsafe { host_image_read(image, offset as f64, buf.as_mut_ptr(), buf.len()) }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use std::sync::{Condvar, Mutex};
    use std::time::Duration;
    static M: Mutex<()> = Mutex::new(());
    static CV: Condvar = Condvar::new();

    pub fn wait(addr: *const u32, expect: u32, timeout_ms: f64) -> i32 {
        let a = unsafe { &*(addr as *const core::sync::atomic::AtomicU32) };
        let g = M.lock().unwrap();
        if a.load(core::sync::atomic::Ordering::SeqCst) != expect {
            return 1;
        }
        if timeout_ms < 0.0 {
            let _g = CV.wait(g).unwrap();
            0
        } else {
            let (_g, r) = CV
                .wait_timeout(g, Duration::from_micros((timeout_ms * 1000.0) as u64))
                .unwrap();
            if r.timed_out() {
                2
            } else {
                0
            }
        }
    }
    pub fn notify(_addr: *const u32, _count: u32) -> u32 {
        let _g = M.lock().unwrap();
        CV.notify_all();
        0
    }
    pub fn log(level: u32, msg: &str) {
        eprintln!("[kernel:{level}] {msg}");
    }
    pub fn now_ms() -> f64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    }
    type Reader = Box<dyn Fn(u32, u64, &mut [u8]) -> i32 + Send + Sync>;
    static READER: Mutex<Option<Reader>> = Mutex::new(None);
    pub fn set_image_reader(r: Reader) {
        *READER.lock().unwrap() = Some(r);
    }
    pub fn image_read(image: u32, offset: u64, buf: &mut [u8]) -> i32 {
        match READER.lock().unwrap().as_ref() {
            Some(r) => r(image, offset, buf),
            None => -5,
        }
    }
}

pub use imp::*;
