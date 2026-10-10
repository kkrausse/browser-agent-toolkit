//! Tool backends for the guest, as plain Rust with no I/O.
//!
//! [`esbuild`] is the transform behind the `esbuild` shim package
//! (`packages/guest-shims/esbuild`): esbuild's `transform` for the `js`, `jsx`,
//! `ts` and `tsx` loaders, done with oxc. The Wasm build is in `wasm/`.

pub mod esbuild;
