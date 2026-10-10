#!/usr/bin/env bash
# Isolated `codex app-server` on ws://127.0.0.1:4793, model provider pointed at mock-llm.
# Extra args are passed to `codex app-server` (e.g. -c approval_policy="never").
set -euo pipefail
source "$(dirname "$0")/env.sh"
guard_network
codex_env server
ensure_workspace
cp "$MOCK_LLM_DIR/codex.config.toml" "$CODEX_HOME/config.toml"
cd "$WORKSPACE_DIR"
exec codex app-server --listen "ws://127.0.0.1:$CODEX_PORT" "$@"
