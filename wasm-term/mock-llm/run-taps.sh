#!/usr/bin/env bash
# Logging reverse proxies in front of both servers (foreground):
#   http://127.0.0.1:4795 -> opencode serve  (HTTP + SSE)   log: .state/logs/opencode-tap.log
#   ws://127.0.0.1:4796   -> codex app-server (WebSocket)   log: .state/logs/codex-tap.log
# The codex one also drops the Origin header, which is what lets a browser connect.
set -euo pipefail
source "$(dirname "$0")/env.sh"
bun "$MOCK_LLM_DIR/tap-proxy.ts" "$OPENCODE_TAP_PORT" "http://127.0.0.1:$OPENCODE_PORT" "$LOG_DIR/opencode-tap.log" &
trap 'kill %1 2>/dev/null || true' EXIT
bun "$MOCK_LLM_DIR/tap-proxy.ts" "$CODEX_TAP_PORT" "ws://127.0.0.1:$CODEX_PORT" "$LOG_DIR/codex-tap.log"
