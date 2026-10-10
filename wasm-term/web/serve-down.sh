#!/usr/bin/env bash
# Undo web/serve-up.sh: remove the one `tailscale serve` entry it added, stop
# and disable the dev server unit, stop the Docker backend. Other
# `tailscale serve` entries are never touched.
#   serve-down.sh --keep-backend   leave the containers running
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
source "$here/serve-env.sh"

current="$(serve_entry)"
if [ "$current" = "$WASM_TERM_TARGET" ]; then
  serve_config --https="$WASM_TERM_HTTPS_PORT" off
  echo "tailscale serve: removed HTTPS $WASM_TERM_HTTPS_PORT"
elif [ -n "$current" ]; then
  echo "tailscale serve: HTTPS $WASM_TERM_HTTPS_PORT points at $current, not ours; left alone" >&2
else
  echo "tailscale serve: no entry on HTTPS $WASM_TERM_HTTPS_PORT"
fi

unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$WASM_TERM_UNIT"
if [ -e "$unit_file" ]; then
  systemctl --user disable --now --quiet "$WASM_TERM_UNIT" || true
  rm -f "$unit_file"
  systemctl --user daemon-reload
  echo "dev server: $WASM_TERM_UNIT stopped and removed"
else
  echo "dev server: no unit installed"
fi

if [ "${1:-}" = "--keep-backend" ]; then
  echo "backend: left running (mock-llm/down.sh stops it)"
else
  "$root/mock-llm/down.sh"
  echo "backend: stopped"
fi
