//! wasm-term kernel: the pty pair and line discipline of the emulated machine.
//!
//! `pty` and `termios` are plain Rust and are unit-tested natively
//! (`cargo test`). `wasm` is the C-ABI surface the TypeScript host calls when
//! the crate is built for `wasm32-unknown-unknown`.

pub mod pty;
pub mod termios;
pub mod wasm;

#[cfg(test)]
mod tests;
