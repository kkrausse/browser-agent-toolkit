#!/usr/bin/env bash
# Regenerate ports/codex/patches/ from the port branches in wasm-term/vendor/.
set -euo pipefail
source "$(dirname "$0")/env.sh"
out="$PORT_DIR/patches"
rm -rf "$out"; mkdir -p "$out"
export_repo() { # <repo dir> <base ref> <out subdir>
  mkdir -p "$out/$3"
  git -C "$1" format-patch -q --no-signature --zero-commit -N -o "$out/$3" "$2..wasm-term-port"
}
export_repo "$CODEX_SRC" "$CODEX_UPSTREAM_TAG" codex
export_repo "$WASM_TERM_DIR/vendor/crossterm" ed1cdab335221515706178d68495bba2aed1924f crossterm
export_repo "$WASM_TERM_DIR/vendor/tokio" upstream tokio
for dir in "$WASM_TERM_DIR"/vendor/forks/*/; do
  export_repo "$dir" upstream "forks/$(basename "$dir")"
done
find "$out" -name '*.patch' | sort | sed "s|$PORT_DIR/||"
