#!/usr/bin/env bash
# Optional, host side, foreground: logging reverse proxy in front of the
# containerised opencode server (HTTP + SSE), for seeing what a client sends.
#   http://127.0.0.1:4795 -> http://127.0.0.1:4792     log: .state/logs/opencode-tap.log
# Use it with OPENCODE_SERVER_URL=http://127.0.0.1:4795 run-opencode-client.sh.
# The codex equivalent runs inside the codex container on :4796; read it with
# `docker compose logs -f codex`.
set -euo pipefail
source "$(dirname "$0")/env.sh"
exec bun "$MOCK_LLM_DIR/tap-proxy.ts" "$OPENCODE_TAP_PORT" "http://127.0.0.1:$OPENCODE_PORT" "$LOG_DIR/opencode-tap.log"
