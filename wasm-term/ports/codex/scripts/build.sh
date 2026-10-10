#!/usr/bin/env bash
# Build the browser module: ports/codex/main -> dist/codex.wasm (wasm32-wasip1).
# usage: [PROFILE=wasm|wasm-small] scripts/build.sh [extra cargo args...]
#   wasm        quick to rebuild, names kept for trap backtraces (dist/codex.wasm)
#   wasm-small  opt-level "s", stripped (dist/codex-small.wasm)
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$CODEX_SRC/codex-rs"
# The TUI leans on deep stacks (natively: a 16 MiB main thread); wasm's default is 1 MiB.
STACK_BYTES="${STACK_BYTES:-33554432}"
PROFILE="${PROFILE:-wasm}"
out=codex.wasm; [ "$PROFILE" = wasm ] || out="codex-${PROFILE#wasm-}.wasm"
cargo rustc -p codex-wasm-term --bin codex-wasm-term --target "$WASM_TARGET" --profile "$PROFILE" "$@" -- \
  -C link-arg=-zstack-size="$STACK_BYTES"
mkdir -p "$PORT_DIR/dist"
cp "$CARGO_TARGET_DIR/$WASM_TARGET/$PROFILE/codex-wasm-term.wasm" "$PORT_DIR/dist/$out"
ls -l "$PORT_DIR/dist/$out"
