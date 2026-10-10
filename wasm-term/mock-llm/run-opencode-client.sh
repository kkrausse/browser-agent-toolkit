#!/usr/bin/env bash
# Native opencode TUI attached to the containerised server (./up.sh), never the
# background service. This runs the HOST's opencode binary, as a client only
# (--server), with its own XDG homes under .state/.
# OPENCODE_SERVER_URL overrides the target, e.g. the tap proxy on :4795.
# Extra args are passed to `opencode` (e.g. --prompt "hello", --auto).
set -euo pipefail
source "$(dirname "$0")/env.sh"
guard_network
opencode_env
ensure_workspace
cd "$WORKSPACE_DIR"
exec opencode --server "${OPENCODE_SERVER_URL:-http://127.0.0.1:$OPENCODE_PORT}" "$@"
