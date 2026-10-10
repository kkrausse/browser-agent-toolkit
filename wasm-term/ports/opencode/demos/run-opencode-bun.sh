#!/usr/bin/env bash
# The opencode TUI on the wasm OpenTUI core, hosted by Bun, attached to the
# isolated mock-backed server from ../../mock-llm (start run-mock.sh and
# run-opencode-server.sh first). Uses its own XDG homes under .state/, never
# the user's opencode state.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
source "$HERE/../../mock-llm/env.sh"
guard_network
ensure_workspace
root="$STATE_DIR/opencode-wasm-client"
export XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" XDG_STATE_HOME="$root/state" XDG_CACHE_HOME="$root/cache"
export TMPDIR="$root/tmp"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$TMPDIR"
export OPENCODE_SERVER_URL="${OPENCODE_SERVER_URL:-http://127.0.0.1:$OPENCODE_PORT}"
export OPENCODE_SERVER_PASSWORD="$MOCK_OPENCODE_PASSWORD"
export WASM_TERM_TUI_LOG="${WASM_TERM_TUI_LOG:-$LOG_DIR/opencode-wasm-client.log}"
cd "$WORKSPACE_DIR"
exec bun "$HERE/demos/run-bun.ts" "$HERE/dist/opencode-tui.bun.js"
