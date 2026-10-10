#!/usr/bin/env bash
# Optional, host side, foreground: log what the native TUI CLIENTS try to reach.
# The client launchers already point HTTP(S)_PROXY at this port, so without the
# trap those requests fail anyway; with it they are also recorded in
# .state/logs/egress-trap.log. The servers do not need it: their containers
# have no route out.
set -euo pipefail
source "$(dirname "$0")/env.sh"
EGRESS_TRAP_PORT=$EGRESS_TRAP_PORT EGRESS_TRAP_LOG="$LOG_DIR/egress-trap.log" exec bun "$MOCK_LLM_DIR/egress-trap.ts"
