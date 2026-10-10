#!/bin/sh
# Build the transform for the browser: crates/bat-modules/js/bat_modules.wasm.
# Size-optimised release (profile in wasm/Cargo.toml), panics abort, 8 MiB
# stack (the parser recurses on deeply nested input), wasm-opt when installed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/target-modules}/wasm-build"
export RUSTFLAGS="-C link-arg=-zstack-size=8388608 -C target-feature=+bulk-memory,+mutable-globals,+sign-ext,+nontrapping-fptoint"
cd "$here/wasm"
cargo build --release --target wasm32-unknown-unknown
out="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/bat_modules_wasm.wasm"
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Os --enable-bulk-memory --enable-mutable-globals --enable-sign-ext \
    --enable-nontrapping-float-to-int "$out" -o "$here/js/bat_modules.wasm"
else
  cp "$out" "$here/js/bat_modules.wasm"
fi
ls -l "$here/js/bat_modules.wasm"
