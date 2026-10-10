#!/bin/sh
# Prepare the TODO example's guest tree end to end.
#   crates/bat-prepare/prepare-todo.sh [out-dir] [extra bat-prepare app flags]
# Inputs (override with the environment):
#   BAT_TODO_APP      app directory; default examples/todo-app
#   BAT_OPENCODE_DIR  directory holding the pinned OpenCode server.js and tree-sitter wasm
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$repo/target-prepare}
out=${1:-$CARGO_TARGET_DIR/prepared/todo}
[ $# -gt 0 ] && shift
export BAT_OPENCODE_DIR=${BAT_OPENCODE_DIR:-$repo/.runtime/opencode-2.0.3}
app=${BAT_TODO_APP:-}
if [ -z "$app" ]; then
  app=$repo/examples/todo-app
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
