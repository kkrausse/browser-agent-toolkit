#!/usr/bin/env bash
# cargo check the codex TUI lib for the wasm target and summarise failures.
# usage: scripts/check.sh [label] [extra cargo args...]
set -u
source "$(dirname "$0")/env.sh"
label="${1:-latest}"; shift || true
log="$WASM_TERM_DIR/vendor/check-$WASM_TARGET-$label.log"
cd "$CODEX_SRC/codex-rs"
cargo check -p codex-tui --lib --target "$WASM_TARGET" --keep-going --message-format short "$@" >"$log" 2>&1
echo "exit=$? log=$log"
echo "units started: $(grep -cE '^\s+(Checking|Compiling)' "$log")"
grep -E "^error: could not compile|^error: failed to run custom build" "$log" | sed -E 's/ due to.*//; s/^error: //' | sort | uniq -c
grep -E "^(warning|error).*(generated|could not compile)" "$log" | cut -c1-200 | tail -3
