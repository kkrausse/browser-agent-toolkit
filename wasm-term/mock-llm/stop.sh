#!/usr/bin/env bash
# Stop whatever is listening on the wasm-term mock ports (4791-4796). These ports
# belong to this directory's launchers; nothing else is touched.
set -uo pipefail
for port in 4791 4792 4793 4794 4795 4796; do
  for pid in $(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u); do
    echo "stopping pid $pid on :$port ($(ps -o comm= -p "$pid"))"
    kill "$pid" 2>/dev/null || true
  done
done
