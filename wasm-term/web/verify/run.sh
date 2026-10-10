#!/usr/bin/env bash
# Runs a browser verification against the dev server (bun web/server.ts).
#   web/verify/run.sh [terminal-functions|opencode|opencode-perf|codex|codex-local] [--session <browser-control session>]
# `opencode`, `codex` and `codex-local` also need the containerised backend: mock-llm/up.sh.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
name="terminal-functions"
if [[ $# -gt 0 && "$1" != --* ]]; then name="$1"; shift; fi
script="$(mktemp --suffix=.js)"
import_zip="$(mktemp --suffix=.zip)"
trap 'rm -f "$script" "$import_zip"' EXIT
# An archive for the launcher's "Import .zip" (codex-local): one top folder, deflated entries, a .git directory to be left out.
python3 -I - "$import_zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("my-project-main/top.md", "# imported\n\nfrom a zip\n")
    z.writestr("my-project-main/imported/notes.txt", "imported by the verify script\n")
    z.writestr("my-project-main/imported/big.txt", "0123456789" * 6000)
    z.writestr("my-project-main/.git/HEAD", "ref: refs/heads/main\n")
PY
{
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
