#!/usr/bin/env bash
# Start the scripted model server (4791) and the egress trap (4794) in the foreground.
set -euo pipefail
source "$(dirname "$0")/env.sh"
EGRESS_TRAP_PORT=$EGRESS_TRAP_PORT EGRESS_TRAP_LOG="$LOG_DIR/egress-trap.log" bun "$MOCK_LLM_DIR/egress-trap.ts" &
trap 'kill %1 2>/dev/null || true' EXIT
MOCK_LLM_PORT=$MOCK_LLM_PORT MOCK_LLM_LOG="$LOG_DIR/mock-llm.log" bun "$MOCK_LLM_DIR/server.ts"
