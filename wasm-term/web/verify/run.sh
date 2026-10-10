#!/usr/bin/env bash
# Runs the browser verification against the dev server (bun web/server.ts).
#   web/verify/run.sh [--session <browser-control session>]
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$(mktemp --suffix=.js)"
trap 'rm -f "$script"' EXIT
{
  echo "const BASE = \"${WASM_TERM_URL:-http://127.0.0.1:4790}\";"
  echo "const SHOTS = \"$root/docs/screenshots\";"
  cat "$root/web/verify/terminal-functions.js"
} > "$script"
mkdir -p "$root/docs/screenshots"
browser-control execute "$@" --file "$script"
