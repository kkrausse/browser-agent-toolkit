//! M0 spike exports: prove that several instances over one memory really share
//! Rust state under a Rust lock and can block and wake each other. Kept as a
//! permanent self-check (bench/spike.html).

use crate::lock::{Mutex, WaitQ};
use std::collections::BTreeMap;
use core::sync::atomic::{AtomicU32, Ordering::*};

struct Shared {
    counter: u64,
    map: BTreeMap<u32, u32>,
}
static SHARED: Mutex<Shared> = Mutex::new(Shared { counter: 0, map: BTreeMap::new() });
static GATE: WaitQ = WaitQ::new();
static GATE_VALUE: AtomicU32 = AtomicU32::new(0);

/// `n` lock/increment/unlock rounds on a plain (non-atomic) counter.
#[no_mangle]
pub extern "C" fn bat_spike_count(n: u32) {
    for _ in 0..n {
        let mut s = SHARED.lock();
        let v = s.counter;
        core::hint::black_box(&v);
        s.counter = v + 1;
    }
}
/// Insert keys base..base+n, then remove the odd ones.
#[no_mangle]
pub extern "C" fn bat_spike_map(base: u32, n: u32) {
    for i in 0..n {
        SHARED.lock().map.insert(base + i, crate::thread::current().map(|t| t.tid).unwrap_or(0));
    }
    for i in (1..n).step_by(2) {
        SHARED.lock().map.remove(&(base + i));
    }
}
#[no_mangle]
pub extern "C" fn bat_spike_counter() -> f64 {
    SHARED.lock().counter as f64
}
#[no_mangle]
pub extern "C" fn bat_spike_map_len() -> u32 {
    SHARED.lock().map.len() as u32
}
#[no_mangle]
pub extern "C" fn bat_spike_reset() {
    let mut s = SHARED.lock();
    s.counter = 0;
    s.map.clear();
    GATE_VALUE.store(0, SeqCst);
}
/// Block until another instance calls `bat_spike_open`; returns its value.
#[no_mangle]
pub extern "C" fn bat_spike_block() -> u32 {
    loop {
        let seq = GATE.seq();
        let v = GATE_VALUE.load(SeqCst);
        if v != 0 {
            return v;
        }
        GATE.wait(seq, -1.0);
    }
}
#[no_mangle]
pub extern "C" fn bat_spike_open(v: u32) {
    GATE_VALUE.store(v, SeqCst);
    GATE.wake_all();
}
