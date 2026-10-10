#!/usr/bin/env bash
# Count workspace crates in codex-tui's wasm dependency graph whose metadata
# has been produced by a successful check. Prints "<ok> of <total>" and the
# names still missing.
source "$(dirname "$0")/env.sh"
cd "$CODEX_SRC/codex-rs"
deps="$CARGO_TARGET_DIR/$WASM_TARGET/debug/deps"
all=$(cargo tree -p codex-tui --target "$WASM_TARGET" -e normal --prefix none -f '{p}' 2>/dev/null \
  | grep "$CODEX_SRC" | awk '{print $1}' | sort -u)
ok=0; total=0; missing=()
for c in $all; do
  total=$((total+1))
  if ls "$deps/lib${c//-/_}"-*.rmeta >/dev/null 2>&1; then ok=$((ok+1)); else missing+=("$c"); fi
done
echo "$ok of $total workspace crates check for $WASM_TARGET"
printf '%s\n' "${missing[@]}" | tr '\n' ' '; echo
