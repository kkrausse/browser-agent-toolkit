#!/usr/bin/env bash
# Start (or stop) the servers the memory bench needs, in the background:
#   plain TODO example, scripted model        :$TODO_PORT   (default 4871)
#   scripted model (plain app's files)        :$MOCK_PORT   (default 4872)
#   terminal example, development build       :$TERM_PORT   (default 4873; needs examples/terminal-app/dist-dev)
#   full-stack TODO example, scripted model   :$FULL_PORT   (default 4874; needs examples/todo-fullstack built)
#   scripted model (full-stack app's files)   :$FULL_MOCK_PORT (default 4875)
#   bench/memory/serve.sh        (re)start      bench/memory/serve.sh stop
# The examples must be prepared and built first (bun run setup; then in each example
# `bun run prepare:editor && bun run build`, for the terminal example with OUT_DIR=dist-dev).
# The TODO examples are served by their own server.ts, with EDITOR_MODEL_BASE_URL pointing
# at the scripted model of the terminal example (examples/terminal-app/mock-model.ts), so
# no model is ever called. For the full-stack app: --example todo --todo-port $FULL_PORT.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
run=$root/bench/memory/out/.run; mkdir -p "$run"
todo=${TODO_PORT:-4871}; mock=${MOCK_PORT:-4872}; term=${TERM_PORT:-4873}; full=${FULL_PORT:-4874}; fullmock=${FULL_MOCK_PORT:-4875}
for name in todo mock term full fullmock; do
  if [ -f "$run/$name.pid" ]; then kill "$(cat "$run/$name.pid")" 2>/dev/null || true; rm -f "$run/$name.pid"; fi
done
[ "${1:-}" = stop ] && exit 0
cd "$root/examples/terminal-app"
PORT=$mock DIAG_FILE=$run/diag.jsonl setsid nohup bun mock-model.ts > "$run/mock.log" 2>&1 & echo $! > "$run/mock.pid"
PORT=$fullmock MOCK_TODO=fullstack DIAG_FILE=$run/diag-full.jsonl setsid nohup bun mock-model.ts > "$run/fullmock.log" 2>&1 & echo $! > "$run/fullmock.pid"
if [ -d dist-dev ]; then PORT=$term setsid nohup bun server.ts dist-dev > "$run/term.log" 2>&1 & echo $! > "$run/term.pid"; fi
cd "$root/examples/todo-app"
NODE_ENV=production PORT=$todo EDITOR_MODEL_API_KEY=scripted EDITOR_MODEL_BASE_URL=http://127.0.0.1:$mock/v1 setsid nohup bun server.ts > "$run/todo.log" 2>&1 & echo $! > "$run/todo.pid"
if [ -d "$root/examples/todo-fullstack/build/client" ]; then
  cd "$root/examples/todo-fullstack"
  NODE_ENV=production PORT=$full EDITOR_MODEL_API_KEY=scripted EDITOR_MODEL_BASE_URL=http://127.0.0.1:$fullmock/v1 setsid nohup bun server.ts > "$run/full.log" 2>&1 & echo $! > "$run/full.pid"
fi
for _ in $(seq 80); do curl -sf -o /dev/null "http://127.0.0.1:$todo/editor/manifest.json" && exit 0; sleep 0.1; done
echo "TODO server did not start; see $run/todo.log" >&2; exit 1
