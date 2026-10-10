#!/usr/bin/env bash
# Recreate the patched source trees under wasm-term/vendor/ from upstream plus
# ports/codex/patches/. Safe to re-run: existing directories are left alone.
#
# Pins (bump these, re-run, fix what no longer applies, then export-patches.sh):
#   codex      openai/codex               tag rust-v0.162.0
#   crossterm  openai-oss-forks/crossterm rev ed1cdab (the rev codex-rs/Cargo.toml patches in)
#   tokio      crates.io 1.52.3           (the version in codex-rs/Cargo.lock)
#   forks      crates.io, versions in scripts/forks.txt (from codex-rs/Cargo.lock)
set -euo pipefail
source "$(dirname "$0")/env.sh"
V="$WASM_TERM_DIR/vendor"
am() { # <repo> <patch dir>
  if ls "$2"/*.patch >/dev/null 2>&1; then
    git -C "$1" -c user.name=port -c user.email=port@local am -q "$2"/*.patch
  fi
}
if [ ! -d "$CODEX_SRC" ]; then
  git clone -q --depth 1 --branch "$CODEX_UPSTREAM_TAG" https://github.com/openai/codex "$CODEX_SRC"
  git -C "$CODEX_SRC" tag -f "$CODEX_UPSTREAM_TAG" HEAD >/dev/null
  # Populate ~/.cargo/registry so the crates.io forks below can be copied.
  (cd "$CODEX_SRC/codex-rs" && cargo fetch -q)
  git -C "$CODEX_SRC" checkout -q -b wasm-term-port
  am "$CODEX_SRC" "$PORT_DIR/patches/codex"
fi
if [ ! -d "$V/crossterm" ]; then
  git clone -q https://github.com/openai-oss-forks/crossterm "$V/crossterm"
  git -C "$V/crossterm" checkout -q -b wasm-term-port ed1cdab335221515706178d68495bba2aed1924f
  am "$V/crossterm" "$PORT_DIR/patches/crossterm"
fi
fork() { # <name> <version> [dest]
  local dest="${3:-$V/forks/$1}"
  [ -d "$dest" ] && return 0
  local src; src=$(ls -d "$HOME"/.cargo/registry/src/index.crates.io-*/"$1-$2" | head -1)
  mkdir -p "$(dirname "$dest")"; cp -r "$src" "$dest"
  ( cd "$dest" && rm -f .cargo-ok Cargo.toml.orig && git init -q && git add -A -f \
    && git -c user.name=port -c user.email=port@local commit -qm "$1 $2 (crates.io)" \
    && git branch -m upstream && git checkout -q -b wasm-term-port )
  local patches="$PORT_DIR/patches/forks/$1"; [ "$dest" = "$V/tokio" ] && patches="$PORT_DIR/patches/tokio"
  am "$dest" "$patches"
}
fork tokio 1.52.3 "$V/tokio"
# crates.io leaves with a WASI arm added: "<name> <version>" per line.
while read -r name version; do
  [ -n "$name" ] && fork "$name" "$version"
done < "$PORT_DIR/scripts/forks.txt"
if [ ! -d "$WASI_SDK_PATH" ]; then
  mkdir -p "$V/tools"
  curl -sL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz | tar xz -C "$V/tools"
  mv "$V/tools/wasi-sdk-34.0-x86_64-linux" "$WASI_SDK_PATH"
fi
echo "ready: $CODEX_SRC (branch wasm-term-port)"
