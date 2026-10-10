#!/bin/sh
# Build the Tailwind scanner for the guest:
#   packages/guest-shims/tailwindcss-oxide/tailwindcss-oxide.wasm
# Plain wasm32-wasip1 (no threads, no shared memory), size-optimised release
# (profile in Cargo.toml), panics abort, wasm-opt when installed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/target-tools/oxide}"
export RUSTFLAGS="-C target-feature=+bulk-memory,+mutable-globals,+sign-ext,+nontrapping-fptoint"
cd "$here"
cargo build --release --locked --target wasm32-wasip1
built="$CARGO_TARGET_DIR/wasm32-wasip1/release/bat_oxide_wasm.wasm"
out="$root/packages/guest-shims/tailwindcss-oxide/tailwindcss-oxide.wasm"
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory --enable-mutable-globals --enable-sign-ext \
    --enable-nontrapping-float-to-int "$built" -o "$out"
else
  cp "$built" "$out"
fi
ls -l "$out"
