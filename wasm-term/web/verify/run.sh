#!/usr/bin/env bash
# Runs a browser verification against the dev server (bun web/server.ts).
#   web/verify/run.sh [terminal-functions|opencode|opencode-perf|codex|codex-local|codex-static] [--session <browser-control session>]
# `opencode`, `codex` and `codex-local` also need the containerised backend: mock-llm/up.sh.
# `codex-local` runs once per network transport: CODEX_LOCAL_NET="tunnel fetch" (the default), or one of them.
# For the tunnel pass it starts a second dev server on loopback (CODEX_LOCAL_CAPTURE_PORT, default 4789) with
# TCP_RELAY_CAPTURE=1, which keeps what its TCP relay carried to the mock so the script can look for plaintext in it.
# `codex-static` does not use the dev server: it runs the static build (ports/codex/scripts/static.sh) behind a plain
# file server, web/static-serve.sh's by default: CODEX_STATIC_ALLOWED (http://localhost:8002, an origin the ChatGPT
# backend and the mock accept), CODEX_STATIC_REFUSED (http://127.0.0.1:8002, the same server under an origin they
# refuse). It starts one more file server itself, on loopback CODEX_STATIC_SUBPATH_PORT (4788), for the directory
# below a path. CODEX_STATIC_REAL=1 adds a few unauthenticated requests to the real hosts.
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
static_pid=""
static_consts() {
  [ "$name" = codex-static ] || return 0
  local allowed="${CODEX_STATIC_ALLOWED:-http://localhost:8002}" dir="$root/ports/codex/dist/static" port="${CODEX_STATIC_SUBPATH_PORT:-4788}"
  [ -f "$dir/index.html" ] || { echo "no $dir: run ports/codex/scripts/static.sh" >&2; exit 1; }
  curl -fsS -o /dev/null "$allowed/" || { echo "nothing serves $allowed: run web/static-serve.sh up" >&2; exit 1; }
  # The directory again, below a path: the parent directory behind another plain file server.
  python3 -m http.server "$port" --bind 127.0.0.1 --directory "$(dirname "$dir")" >/dev/null 2>&1 &
  static_pid=$!
  trap 'rm -f "$script" "$import_zip"; kill "$static_pid" 2>/dev/null' EXIT
  for _ in $(seq 1 40); do curl -fsS -o /dev/null "http://127.0.0.1:$port/static/" 2>/dev/null && break; sleep 0.25; done
  echo "const ALLOWED = \"$allowed\";"
  echo "const REFUSED = \"${CODEX_STATIC_REFUSED:-http://127.0.0.1:8002}\";"
  echo "const SUBPATH = \"http://localhost:$port/static\";"
  echo "const REAL = \"${CODEX_STATIC_REAL:-0}\" === \"1\";"
  echo "const SERVER_HEADERS = $(curl -sI "$allowed/index.html" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))');"
}
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
static_consts >> "$script.head"; cat "$script.head" "$script" > "$script.all"; mv "$script.all" "$script"; rm -f "$script.head"
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
