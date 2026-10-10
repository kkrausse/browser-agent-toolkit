//! Immutable file-tree image. See `docs/design/image-format.md` for the byte layout.
//!
//! The reader ([`Image`]) is `no_std`, allocation-free and borrows the "head" of the
//! image (header + entry table + string pool + in-head sections). Bodies are fetched
//! through a caller-supplied positioned read. The writer (`writer` module) needs `std`.
#![cfg_attr(not(feature = "std"), no_std)]

mod reader;
pub use reader::*;

#[cfg(feature = "std")]
pub mod writer;
