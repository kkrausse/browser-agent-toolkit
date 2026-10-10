#!/bin/sh
# Build the guest shell: crates/bat-sh/js/bat_sh.wasm.
# Plain wasm32-unknown-unknown cdylib (no wasm-bindgen), size-optimised release
# (profile in wasm/Cargo.toml), panics abort, wasm-opt when installed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/target-runtime/sh-wasm}"
export RUSTFLAGS="-C target-feature=+bulk-memory,+mutable-globals,+sign-ext,+nontrapping-fptoint"
cd "$here/wasm"
cargo build --release --target wasm32-unknown-unknown
out="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/bat_sh_wasm.wasm"
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O2 --enable-bulk-memory --enable-mutable-globals --enable-sign-ext \
    --enable-nontrapping-float-to-int "$out" -o "$here/js/bat_sh.wasm"
else
  cp "$out" "$here/js/bat_sh.wasm"
fi
ls -l "$here/js/bat_sh.wasm"
