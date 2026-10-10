#!/usr/bin/env bash
# Native codex TUI attached to the isolated app-server.
# CODEX_REMOTE_ADDR overrides the target, e.g. the tap proxy on ws://127.0.0.1:4796.
# Extra args are passed to `codex` (e.g. a prompt, --no-alt-screen).
set -euo pipefail
source "$(dirname "$0")/env.sh"
guard_network
codex_env client
ensure_workspace
# Seed once: the TUI writes its own keys (e.g. [tui] screen_reader_detection_done) back to this file.
[ -f "$CODEX_HOME/config.toml" ] || cp "$MOCK_LLM_DIR/codex.client.config.toml" "$CODEX_HOME/config.toml"
cd "$WORKSPACE_DIR"
exec codex --remote "${CODEX_REMOTE_ADDR:-ws://127.0.0.1:$CODEX_PORT}" "$@"
