#!/usr/bin/env bash
# Bring the whole thing up and leave it up, reachable from the tailnet:
#   1. the token-free backend in Docker (mock-llm/up.sh), loopback only;
#   2. the dev server as the systemd user unit wasm-term-web.service
#      (127.0.0.1:4790; survives logout because the user has lingering enabled);
#   3. one tailnet-only `tailscale serve` HTTPS entry in front of the dev server.
# The page reaches its backends through the dev server's /proxy/ paths, so this
# one HTTPS port is all that faces the tailnet. Never funnel, nothing public.
# Take it down with web/serve-down.sh. Safe to run again: each step is skipped
# when already in place.
#   WASM_TERM_HTTPS_PORT=4790   the tailnet HTTPS port
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
source "$here/serve-env.sh"

# 1. backend. Left alone when it already answers: up.sh would rebuild and may recreate containers in use.
if curl -fsS -o /dev/null --max-time 2 -u "opencode:${MOCK_OPENCODE_PASSWORD:-wasm-term-mock}" http://127.0.0.1:4792/api/info 2>/dev/null; then
  echo "backend: already up (127.0.0.1:4792)"
else
  "$root/mock-llm/up.sh"
fi

# 2. dev server
bun="$(command -v bun)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
cat > "$unit_dir/$WASM_TERM_UNIT" <<UNIT
[Unit]
Description=wasm-term dev server (127.0.0.1:$WASM_TERM_PORT, tailnet HTTPS :$WASM_TERM_HTTPS_PORT)

[Service]
Type=simple
WorkingDirectory=$here
ExecStart=$bun server.ts
Environment=PATH=$(dirname "$bun"):/usr/local/bin:/usr/bin:/bin
Environment=HOST=127.0.0.1
Environment=PORT=$WASM_TERM_PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
if ! systemctl --user is-active --quiet "$WASM_TERM_UNIT"; then
  holder="$(ss -ltnpH "sport = :$WASM_TERM_PORT" 2>/dev/null | grep -oP 'pid=\K\d+' | head -1 || true)"
  if [ -n "$holder" ]; then
    echo "port $WASM_TERM_PORT is held by pid $holder (a dev server started by hand?). Stop it and run this again." >&2
    exit 1
  fi
fi
systemctl --user enable --quiet "$WASM_TERM_UNIT"
systemctl --user restart "$WASM_TERM_UNIT"
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null --max-time 2 "$WASM_TERM_TARGET/guests.json" 2>/dev/null && break
  sleep 0.5
done
curl -fsS -o /dev/null --max-time 2 "$WASM_TERM_TARGET/guests.json" || { echo "dev server did not come up: journalctl --user -u $WASM_TERM_UNIT" >&2; exit 1; }
echo "dev server: $WASM_TERM_UNIT active ($WASM_TERM_TARGET)"

# 3. tailnet HTTPS. Only ever our own port; an entry that points elsewhere is not ours to replace.
current="$(serve_entry)"
if [ "$current" = "$WASM_TERM_TARGET" ]; then
  echo "tailscale serve: entry already present"
elif [ -n "$current" ]; then
  echo "tailscale serve already has HTTPS port $WASM_TERM_HTTPS_PORT -> $current; choose another with WASM_TERM_HTTPS_PORT." >&2
  exit 1
else
  serve_config --bg --https="$WASM_TERM_HTTPS_PORT" "$WASM_TERM_TARGET"
  echo "tailscale serve: added HTTPS $WASM_TERM_HTTPS_PORT -> $WASM_TERM_TARGET (tailnet only)"
fi

url="$(tailnet_url)"
echo
echo "open:  $url/                  launcher"
echo "       $url/?guest=opencode   opencode TUI against the mock backend"
echo "down:  $here/serve-down.sh"
