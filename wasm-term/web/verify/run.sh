#!/usr/bin/env bash
# Runs a browser verification against the dev server (bun web/server.ts).
#   web/verify/run.sh [terminal-functions|opencode|opencode-perf|codex|codex-local] [--session <browser-control session>]
# `opencode`, `codex` and `codex-local` also need the containerised backend: mock-llm/up.sh.
# `codex-local` runs once per network transport: CODEX_LOCAL_NET="tunnel fetch" (the default), or one of them.
# For the tunnel pass it starts a second dev server on loopback (CODEX_LOCAL_CAPTURE_PORT, default 4789) with
# TCP_RELAY_CAPTURE=1, which keeps what its TCP relay carried to the mock so the script can look for plaintext in it.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
name="terminal-functions"
if [[ $# -gt 0 && "$1" != --* ]]; then name="$1"; shift; fi
script="$(mktemp --suffix=.js)"
import_zip="$(mktemp --suffix=.zip)"
capture_pid=""
trap 'rm -f "$script" "$import_zip"; [ -n "$capture_pid" ] && kill "$capture_pid" 2>/dev/null' EXIT
# An archive for the launcher's "Import .zip" (codex-local): one top folder, deflated entries, a .git directory to be left out.
python3 -I - "$import_zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("my-project-main/top.md", "# imported\n\nfrom a zip\n")
    z.writestr("my-project-main/imported/notes.txt", "imported by the verify script\n")
    z.writestr("my-project-main/imported/big.txt", "0123456789" * 6000)
    z.writestr("my-project-main/.git/HEAD", "ref: refs/heads/main\n")
PY
run() { # <net> <capture base> [browser-control args...]
local net="$1" capture="$2"; shift 2
{
  echo "const NET = \"$net\";"
  echo "const CAPTURE_BASE = \"$capture\";"
  echo "const BASE = \"${WASM_TERM_URL:-http://127.0.0.1:4790}\";"
  echo "const SHOTS = \"$root/docs/screenshots\";"
  echo "const ROOT = \"$root\";"
  # codex-local: only with CODEX_LOCAL_REAL_AUTH=1 does it ask the real auth host for a device code.
  echo "const REAL_AUTH = \"${CODEX_LOCAL_REAL_AUTH:-0}\" === \"1\";"
  echo "const IMPORT_ZIP = \"$import_zip\";"
  # WASM_TERM_BUILD=names runs a packaged guest's other build (codex, codex-local: the one with wasm names).
  echo "const BUILD_QUERY = \"${WASM_TERM_BUILD:+&build=$WASM_TERM_BUILD}\";"
  cat "$root/web/verify/$name.js"
} > "$script"
mkdir -p "$root/docs/screenshots"
browser-control execute "$@" --file "$script"
}
if [ "$name" != codex-local ]; then
  run "" "" "$@"
  exit
fi
for net in ${CODEX_LOCAL_NET:-tunnel fetch}; do
  capture=""
  if [ "$net" = tunnel ]; then
    port="${CODEX_LOCAL_CAPTURE_PORT:-4789}"
    PORT="$port" TCP_RELAY_CAPTURE=1 TCP_RELAY_QUIET=1 HTTP_RELAY_QUIET=1 bun "$root/web/server.ts" >/dev/null 2>&1 &
    capture_pid=$!
    for _ in $(seq 1 40); do curl -fsS -o /dev/null "http://127.0.0.1:$port/guests.json" 2>/dev/null && break; sleep 0.25; done
    capture="http://127.0.0.1:$port"
  fi
  echo "== codex-local, net=$net"
  run "$net" "$capture" "$@"
  if [ -n "$capture_pid" ]; then kill "$capture_pid" 2>/dev/null || true; capture_pid=""; fi
done
