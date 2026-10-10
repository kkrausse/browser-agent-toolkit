#!/usr/bin/env bash
# Build and package what the dev page serves (dist/site/, see package.ts):
#   default  the wasm-ship profile (opt-level "s", fat LTO, stripped), then wasm-opt -Oz
#   names    the wasm profile: quick to build, name section kept (profiling, readable traps)
# usage: scripts/ship.sh [--names-only]
#   --names-only   rebuild and repackage only the names build (2 minutes instead of 30)
# The LTO link alone takes about 15 minutes and 13 GB; wasm-opt 2 to 3 minutes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/env.sh"
"$here/build.sh"
if [ "${1:-}" = "--names-only" ]; then
  cd "$PORT_DIR" && exec bun scripts/package.ts names=dist/codex.wasm
fi
PROFILE=wasm-ship "$here/build.sh"
wasm_opt="$WASM_TERM_DIR/vendor/tools/binaryen/bin/wasm-opt"
if [ ! -x "$wasm_opt" ]; then
  mkdir -p "$WASM_TERM_DIR/vendor/tools"
  curl -sL https://github.com/WebAssembly/binaryen/releases/download/version_123/binaryen-version_123-x86_64-linux.tar.gz | tar xz -C "$WASM_TERM_DIR/vendor/tools"
  mv "$WASM_TERM_DIR/vendor/tools/binaryen-version_123" "$WASM_TERM_DIR/vendor/tools/binaryen"
fi
# The features rustc's wasm32-wasip1 target emits; wasm-opt must not introduce others.
BINARYEN_CORES="$CARGO_BUILD_JOBS" "$wasm_opt" -Oz \
  --enable-bulk-memory --enable-bulk-memory-opt --enable-sign-ext --enable-mutable-globals \
  --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types --enable-call-indirect-overlong \
  "$PORT_DIR/dist/codex-ship.wasm" -o "$PORT_DIR/dist/codex-ship-opt.wasm"
ls -l "$PORT_DIR/dist/codex-ship.wasm" "$PORT_DIR/dist/codex-ship-opt.wasm"
cd "$PORT_DIR" && bun scripts/package.ts default=dist/codex-ship-opt.wasm names=dist/codex.wasm
