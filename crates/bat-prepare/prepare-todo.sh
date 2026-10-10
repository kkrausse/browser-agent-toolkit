#!/bin/sh
# Prepare the TODO example's guest tree end to end.
#   crates/bat-prepare/prepare-todo.sh [out-dir] [extra bat-prepare app flags]
# Inputs (override with the environment):
#   BAT_TODO_APP      app directory; default examples/todo-app (a member of this repo's Bun
#                     workspace), or the old toolkit's example if that does not exist yet
#   BAT_OPENCODE_DIR  directory holding the pinned OpenCode server.js and tree-sitter wasm
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
old=${BAT_OLD_TOOLKIT:-/home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$repo/target-prepare}
out=${1:-$CARGO_TARGET_DIR/prepared/todo}
[ $# -gt 0 ] && shift
export BAT_OPENCODE_DIR=${BAT_OPENCODE_DIR:-$old/vivari/.runtime/opencode-release-2.0.3/.runtime/opencode-bun-server}
app=${BAT_TODO_APP:-}
if [ -z "$app" ]; then
  if [ -f "$repo/examples/todo-app/package.json" ]; then app=$repo/examples/todo-app; else app=$old/examples/todo-app; fi
fi
bin=$CARGO_TARGET_DIR/release/bat-prepare
if [ -z "${BAT_PREPARE_NO_BUILD:-}" ]; then
  (cd "$repo" && cargo build --release -q -p bat-prepare)
fi
sources=""
for s in src vite.config.ts react-router.config.ts tsconfig.json package.json; do
  [ -e "$app/$s" ] && sources="$sources --source $s"
done
# shellcheck disable=SC2086
exec "$bin" app "$app" -o "$out" $sources "$@"
