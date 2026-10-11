//! wasm-term kernel: the pty pair and line discipline of the emulated machine.
//!
//! `pty` and `termios` are the `bat-pty` crate (`crates/bat-pty`, plain Rust,
//! unit-tested natively there). `wasm` is the C-ABI surface the TypeScript
//! host calls when this crate is built for `wasm32-unknown-unknown`.

pub use bat_pty::{pty, termios};
pub mod wasm;
