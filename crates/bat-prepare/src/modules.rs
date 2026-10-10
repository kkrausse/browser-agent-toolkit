//! Adapter between the packer's transform hook and `bat-modules`.
//!
//! `bat-modules` is not wired in yet (its public API was not available when this was
//! written; see docs/design/decisions.md). `transform()` returns `None`, the image
//! then carries no compiled bodies and no program script is emitted.

use crate::pack::Transform;

/// Identifies the transform implementation in fingerprints.
pub const TRANSFORM_VERSION: &str = "none";

pub fn transform() -> Option<Box<Transform<'static>>> {
    None
}
