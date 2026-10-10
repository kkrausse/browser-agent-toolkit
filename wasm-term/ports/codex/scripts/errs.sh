#!/usr/bin/env bash
# Print the compiler errors from a check log, paths shortened.
# usage: scripts/errs.sh <label> [max lines]
source "$(dirname "$0")/env.sh"
log="$WASM_TERM_DIR/vendor/check-$WASM_TARGET-$1.log"
grep -E "error(\[|:)" "$log" | grep -v "could not compile" | cut -c1-360 \
  | sed "s|$HOME/.cargo/registry/src/index.crates.io-[0-9a-f]*/||; s|$WASM_TERM_DIR/vendor/||" | head -"${2:-60}"
