#!/usr/bin/env bash
# Isolated `opencode serve` on 127.0.0.1:4792, model provider pointed at mock-llm.
# Extra args are passed to `opencode serve` (e.g. --cors http://localhost:4790).
set -euo pipefail
source "$(dirname "$0")/env.sh"
guard_network
opencode_env
ensure_workspace
cp "$MOCK_LLM_DIR/opencode.config.json" "$XDG_CONFIG_HOME/opencode/opencode.json"
cd "$WORKSPACE_DIR"
exec opencode serve --hostname 127.0.0.1 --port "$OPENCODE_PORT" --print-logs --log-level "${OPENCODE_LOG_LEVEL:-info}" "$@"
