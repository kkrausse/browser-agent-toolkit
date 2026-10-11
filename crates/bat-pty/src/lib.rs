//! A pty pair and its line discipline, as plain single-owner Rust: no host
//! calls, no globals, time passed in. Unit-tested natively (`cargo test`).
//!
//! The toolkit's kernel embeds it (`crates/bat-kernel`, `tty.rs`: behind a
//! lock in shared memory, with wait queues). It began as part of wasm-term's
//! kernel (branch `wasm-term`: one worker's private instance behind a C ABI).

pub mod pty;
pub mod termios;

#[cfg(test)]
mod tests;
