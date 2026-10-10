#!/usr/bin/env bash
# Native codex TUI attached to the containerised app-server (./up.sh). This runs the
# HOST's codex binary, as a client only, with its own CODEX_HOME under .state/.
# CODEX_REMOTE_ADDR overrides the target, e.g. the tap proxy on ws://127.0.0.1:4796.
# Extra args are passed to `codex` (e.g. a prompt, --no-alt-screen).
set -euo pipefail
source "$(dirname "$0")/env.sh"
guard_network
codex_env client
ensure_workspace
# Reseeded whenever the template is newer; the TUI writes its own keys (e.g.
# [tui] screen_reader_detection_done) back to this file.
if [ ! -f "$CODEX_HOME/config.toml" ] || [ "$MOCK_LLM_DIR/codex.client.config.toml" -nt "$CODEX_HOME/config.toml" ]; then
  cp "$MOCK_LLM_DIR/codex.client.config.toml" "$CODEX_HOME/config.toml"
fi
cd "$WORKSPACE_DIR"
exec codex --remote "${CODEX_REMOTE_ADDR:-ws://127.0.0.1:$CODEX_PORT}" "$@"
