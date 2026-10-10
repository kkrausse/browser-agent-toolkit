#!/usr/bin/env bash
# codex-local as a directory of static files and a tarball of it: dist/static/, dist/wasm-term-codex-static.tgz.
# No server code in it. By default the program's requests go from the tab straight to OpenAI (net=direct);
# TCP_RELAY=wss://host/tcp bakes in a standalone blind relay (web/tcp-relay-main.ts) and makes net=tunnel the default.
# usage: scripts/static.sh [output directory]      after `BIN=local scripts/ship.sh` and `bun run build` in web/
#   PLAIN=1   ship uncompressed files instead of `.gz` inflated by the page's service worker
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/../dist/static}"
(cd "$here/../../../web" && bun static.ts "$out")
out="$(cd "$out" && pwd)"
tar -C "$(dirname "$out")" -czf "$(dirname "$out")/wasm-term-codex-static.tgz" --transform "s,^$(basename "$out"),wasm-term-codex-static," "$(basename "$out")"
ls -l "$(dirname "$out")/wasm-term-codex-static.tgz"
