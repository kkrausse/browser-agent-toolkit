#!/usr/bin/env bash
# Runs a browser verification against the dev server (bun web/server.ts).
#   web/verify/run.sh [terminal-functions|opencode] [--session <browser-control session>]
# `opencode` also needs the containerised backend: mock-llm/up.sh.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
name="terminal-functions"
if [[ $# -gt 0 && "$1" != --* ]]; then name="$1"; shift; fi
script="$(mktemp --suffix=.js)"
trap 'rm -f "$script"' EXIT
{
  echo "const BASE = \"${WASM_TERM_URL:-http://127.0.0.1:4790}\";"
  echo "const SHOTS = \"$root/docs/screenshots\";"
  echo "const ROOT = \"$root\";"
  cat "$root/web/verify/$name.js"
} > "$script"
mkdir -p "$root/docs/screenshots"
browser-control execute "$@" --file "$script"
