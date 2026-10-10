#!/usr/bin/env bash
# Build the kernel wasm (stable Rust). Output:
#   target-kernel/wasm32-wasip1-threads/release/bat_kernel.wasm
# Debug info is dropped (function names are kept for stack traces); the
# workspace profile keeps it for native crates.
set -euo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-../../target-kernel}"
CARGO_PROFILE_RELEASE_DEBUG=false CARGO_PROFILE_RELEASE_STRIP=debuginfo \
  cargo build --release --target wasm32-wasip1-threads "$@"
ls -la "$CARGO_TARGET_DIR/wasm32-wasip1-threads/release/bat_kernel.wasm"
