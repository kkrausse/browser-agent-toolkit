#!/usr/bin/env bash
# Serve the example from the private tree (see sync.sh) on PORT (default 4120), in the background.
#   bench/startup/serve.sh [port] [tree]   (re)start;   bench/startup/serve.sh stop [port]
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
if [ "${1:-}" = stop ]; then port=${2:-4120}; else port=${1:-4120}; fi
pidfile=$root/target-perf/serve-$port.pid
if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; rm -f "$pidfile"; fi
[ "${1:-}" = stop ] && exit 0
cd "$root/target-perf/${2:-tree}/examples/todo-app"
# The example reads its own .env.local, so the model catalog is delivered as in the real demo. The driver never sends a chat message.
NODE_ENV=production PORT=$port setsid nohup bun server.ts > "$root/target-perf/serve-$port.log" 2>&1 &
echo $! > "$pidfile"
for _ in $(seq 50); do curl -sf -o /dev/null "http://127.0.0.1:$port/editing-policy" && exit 0; sleep 0.1; done
echo "server did not start; see target-perf/serve-$port.log" >&2; exit 1
