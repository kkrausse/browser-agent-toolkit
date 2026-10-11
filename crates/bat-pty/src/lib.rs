//! A pty pair and its line discipline, as plain single-owner Rust: no host
//! calls, no globals, time passed in. Unit-tested natively (`cargo test`).
//!
//! Two kernels embed it: the toolkit's (`crates/bat-kernel`, `tty.rs`: behind
//! a lock in shared memory, with wait queues) and wasm-term's
//! (`wasm-term/kernel`: one worker's private instance behind a C ABI). It
//! began as part of the latter.

pub mod pty;
pub mod termios;

#[cfg(test)]
mod tests;
