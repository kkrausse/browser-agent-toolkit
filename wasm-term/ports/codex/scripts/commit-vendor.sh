#!/usr/bin/env bash
# Commit whatever is dirty in each patched tree under vendor/ onto its
# wasm-term-port branch, then regenerate patches/.
# usage: scripts/commit-vendor.sh "<message>"
set -euo pipefail
source "$(dirname "$0")/env.sh"
msg="${1:?message}"
for dir in "$CODEX_SRC" "$WASM_TERM_DIR/vendor/crossterm" "$WASM_TERM_DIR/vendor/tokio" "$WASM_TERM_DIR"/vendor/forks/*/; do
  [ -n "$(git -C "$dir" status --porcelain)" ] || continue
  git -C "$dir" add -A
  git -C "$dir" -c user.name=port -c user.email=port@local commit -qm "wasi: $msg"
  echo "committed $(basename "$dir")"
done
"$(dirname "$0")/export-patches.sh" >/dev/null
