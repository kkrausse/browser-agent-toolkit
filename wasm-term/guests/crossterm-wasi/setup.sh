#!/usr/bin/env bash
# Produces crossterm-wasi/crossterm/: the crossterm fork codex pins, plus a
# wasm32-wasip1 backend for wasm-term. The result is what guests/Cargo.toml
# patches in as `crossterm`.
#
#   ./setup.sh            build crossterm/ (no-op if it exists)
#   ./setup.sh --force    rebuild it from scratch
#
# The port is three layers, so it can be re-applied to a newer revision:
#   1. mechanical.sh   cfg(unix) -> cfg(any(unix, target_os = "wasi")), by sed
#   2. wasi.patch      ~20 changed lines: module selection and `use` lines
#   3. overlay/        new files: src/wasi_compat.rs, src/event/stream_wasi.rs
set -euo pipefail
cd "$(dirname "$0")"

REPO="${CROSSTERM_REPO:-https://github.com/openai-oss-forks/crossterm}"
# Same revision as [patch.crates-io] in codex-rs/Cargo.toml.
REV="${CROSSTERM_REV:-ed1cdab335221515706178d68495bba2aed1924f}"

if [ "${1:-}" = "--force" ]; then rm -rf crossterm; fi
if [ -d crossterm ]; then
  echo "crossterm-wasi/crossterm already exists (use --force to rebuild)"
  exit 0
fi

git clone --quiet "$REPO" crossterm
git -C crossterm checkout --quiet "$REV"
./mechanical.sh crossterm
# Committed inside the clone so that `git -C crossterm diff` is exactly
# wasi.patch. To change the patch: edit files in crossterm/, then
#   git -C crossterm diff > wasi.patch
# (overlay files are untracked there; copy edits back to overlay/ by hand).
git -C crossterm -c user.name=wasm-term -c user.email=wasm-term@localhost commit --quiet -am "wasm-term: mechanical cfg(unix) widening"
git -C crossterm apply ../wasi.patch
cp -R overlay/. crossterm/
echo "crossterm-wasi/crossterm ready at $REV + wasi backend"
