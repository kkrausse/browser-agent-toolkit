#!/usr/bin/env bash
# Startup measurements run from a private copy of the worktree, so another agent's builds
# (runtime/dist, packages/toolkit/dist, examples/todo-app/.editor) never change what is
# being measured mid-run:  <worktree>/target-perf/tree
#
#   bench/startup/sync.sh            copy sources (no build)
#   bench/startup/sync.sh setup      copy, then `bun run setup` there (cargo → target-perf)
#   bench/startup/sync.sh js         copy, then runtime bundles + toolkit only
#   bench/startup/sync.sh prepare    copy, js, then prepare + build the example
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tree=$root/target-perf/tree
mkdir -p "$tree"
rsync -a --delete \
  --exclude '/target-*' --exclude '/target' --exclude '.git' --exclude '.editor' \
  --exclude '/runtime/dist' --exclude '/packages/toolkit/dist' --exclude '/examples/todo-app/build' \
  --exclude '/examples/todo-app/.react-router' --exclude '/bench/startup/out' \
  "$root/" "$tree/"
export CARGO_TARGET_DIR=$root/target-perf
export BAT_PREPARE=$CARGO_TARGET_DIR/release/bat-prepare
export BAT_OPENCODE_DIR=$root/.runtime/opencode-2.0.3
export BAT_RUNTIME_DIR=$tree/runtime/dist
export BAT_KERNEL_WASM=$CARGO_TARGET_DIR/wasm32-wasip1-threads/release/bat_kernel.wasm
cd "$tree"
js() {
  bun runtime/build.ts
  bun runtime/src/host/build.ts
  (cd packages/toolkit && bun run build)
}
case "${1:-}" in
  setup) bun scripts/setup.ts ;;
  js) js ;;
  prepare) js; (cd examples/todo-app && bun run prepare:editor && bun run build) ;;
  '') ;;
  *) echo "unknown: $1" >&2; exit 2 ;;
esac
