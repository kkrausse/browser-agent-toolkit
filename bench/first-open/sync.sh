#!/usr/bin/env bash
# Startup measurements run from a private copy of the worktree, so another agent's builds
# (runtime/dist, packages/toolkit/dist, examples/todo-app/.editor) never change what is
# being measured mid-run:  <worktree>/target-gaps/tree
#
#   bench/first-open/sync.sh            copy sources (no build)
#   bench/first-open/sync.sh setup      copy, then `bun run setup` there (cargo → target-gaps)
#   bench/first-open/sync.sh js         copy, then runtime bundles + toolkit only
#   bench/first-open/sync.sh prepare    copy, js, then prepare + build the example
#   TREE=base REF=<commit> bench/first-open/sync.sh prepare    a second tree at a committed state,
#       for interleaved A/B runs (serve.sh <port> base; run.ts --ports 4120,4121)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tree=$root/target-gaps/${TREE:-tree}
mkdir -p "$tree"
excludes=(--exclude '/target-*' --exclude '/target' --exclude '.git' --exclude '.editor'
  --exclude '/runtime/dist' --exclude '/packages/toolkit/dist' --exclude '/examples/todo-app/build'
  --exclude '/examples/todo-app/.react-router' --exclude '/bench/startup/out' --exclude '/bench/first-open/out')
if [ -n "${REF:-}" ]; then
  # A committed state (for A/B runs): tracked files of $REF, plus the untracked inputs a build needs.
  stage=$(mktemp -d)
  git -C "$root" archive "$REF" | tar -x -C "$stage"
  rsync -a --delete "${excludes[@]}" --exclude node_modules --exclude '/crates/*/js/*.wasm' --exclude '/packages/guest-shims/**/*.wasm' --exclude '/examples/todo-app/.env.local' "$stage/" "$tree/"
  rm -rf "$stage"
  rsync -a "${excludes[@]}" --include '*/' --include 'node_modules/***' --include '/crates/*/js/*.wasm' --include '/packages/guest-shims/**/*.wasm' --include '/examples/todo-app/.env.local' --exclude '*' --prune-empty-dirs "$root/" "$tree/"
else
  rsync -a --delete "${excludes[@]}" "$root/" "$tree/"
fi
export CARGO_TARGET_DIR=$root/target-gaps
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
