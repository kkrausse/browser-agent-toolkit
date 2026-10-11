#!/usr/bin/env bash
# Start (or stop) the three servers the memory bench needs, in the background:
#   TODO example with the scripted model   :$TODO_PORT  (default 4871)
#   scripted model (terminal example's)    :$MOCK_PORT  (default 4872)
#   terminal example, development build    :$TERM_PORT  (default 4873; needs examples/terminal-app/dist-dev)
#   bench/memory/serve.sh        (re)start      bench/memory/serve.sh stop
# The examples must be prepared and built first (bun run setup; then in each example
# `bun run prepare:editor && bun run build`).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
run=$root/bench/memory/out/.run; mkdir -p "$run"
todo=${TODO_PORT:-4871}; mock=${MOCK_PORT:-4872}; term=${TERM_PORT:-4873}
for name in todo mock term; do
  if [ -f "$run/$name.pid" ]; then kill "$(cat "$run/$name.pid")" 2>/dev/null || true; rm -f "$run/$name.pid"; fi
done
[ "${1:-}" = stop ] && exit 0
cd "$root/examples/terminal-app"
PORT=$mock DIAG_FILE=$run/diag.jsonl setsid nohup bun mock-model.ts > "$run/mock.log" 2>&1 & echo $! > "$run/mock.pid"
if [ -d dist-dev ]; then PORT=$term setsid nohup bun server.ts dist-dev > "$run/term.log" 2>&1 & echo $! > "$run/term.pid"; fi
cd "$root/examples/todo-app"
PORT=$todo MOCK_URL=http://127.0.0.1:$mock/v1 setsid nohup bun "$root/bench/memory/todo-server.ts" > "$run/todo.log" 2>&1 & echo $! > "$run/todo.pid"
for _ in $(seq 50); do curl -sf -o /dev/null "http://127.0.0.1:$todo/editing-policy" && exit 0; sleep 0.1; done
echo "TODO server did not start; see $run/todo.log" >&2; exit 1
