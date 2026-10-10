#!/usr/bin/env bash
# Pack the TODO example's node_modules (Bun isolated-linker layout) into one
# image for the kernel benchmarks. Output goes to bench/dist/ (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:-/home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit/examples/todo-app/node_modules}"
BIN="${BAT_PREPARE:-target-prepare/release/bat-prepare}"
if [ ! -x "$BIN" ]; then
  CARGO_TARGET_DIR=target-kernel cargo build --release -p bat-prepare
  BIN=target-kernel/release/bat-prepare
fi
mkdir -p bench/dist
"$BIN" pack "$SRC" --out bench/dist/todo-node-modules.batimg
"$BIN" info bench/dist/todo-node-modules.batimg | head -20
# A deterministic list of paths for the stat/read benchmark: every 7th file under 64 KiB.
bun bench/paths.ts "$SRC" > bench/dist/paths.json
ls -la bench/dist
