#!/bin/sh
# Build the esbuild transform for the guest: packages/guest-shims/esbuild/lib/bat_esbuild.wasm.
# Size-optimised release (profile in wasm/Cargo.toml), panics abort, 8 MiB stack (the
# parser recurses on deeply nested input), wasm-opt when installed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/target-tools}/wasm-build"
export RUSTFLAGS="-C link-arg=-zstack-size=8388608 -C target-feature=+bulk-memory,+mutable-globals,+sign-ext,+nontrapping-fptoint"
cd "$here/wasm"
cargo build --release --target wasm32-unknown-unknown
built="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/bat_tools_wasm.wasm"
out="${1:-$root/packages/guest-shims/esbuild/lib/bat_esbuild.wasm}"
mkdir -p "$(dirname "$out")"
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Os --enable-bulk-memory --enable-mutable-globals --enable-sign-ext \
    --enable-nontrapping-float-to-int "$built" -o "$out"
else
  cp "$built" "$out"
fi
ls -l "$out"
