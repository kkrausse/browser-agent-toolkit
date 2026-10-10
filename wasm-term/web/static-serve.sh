#!/usr/bin/env bash
# Serves the static codex-local build (ports/codex/dist/static, from ports/codex/scripts/static.sh) on loopback with a
# plain file server, as a systemd user unit that survives logout. Nothing but files: no headers, no relay.
#   web/static-serve.sh up      write and start wasm-term-codex-static.service on 127.0.0.1:$PORT (default 8002)
#   web/static-serve.sh down    stop it, disable it and delete the unit file
# 8002 because http://localhost:8002 is one of the origins chatgpt.com accepted on 2026-10-10 (NOTES.md, section 12):
# on this machine the page works with a ChatGPT sign-in as it is, and from another machine through
#   ssh -L 3000:127.0.0.1:8002 <this machine>     then http://localhost:3000/ there.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
unit=wasm-term-codex-static.service
file="$HOME/.config/systemd/user/$unit"
port="${PORT:-8002}"
dir="${STATIC_DIR:-$root/ports/codex/dist/static}"
case "${1:-}" in
  up)
    [ -f "$dir/index.html" ] || { echo "no $dir/index.html: run ports/codex/scripts/static.sh" >&2; exit 1; }
    mkdir -p "$(dirname "$file")"
    cat > "$file" <<UNIT
[Unit]
Description=wasm-term codex-local, static files (127.0.0.1:$port; plain python3 http.server, no relay)

[Service]
ExecStart=/usr/bin/python3 -m http.server $port --bind 127.0.0.1 --directory $dir
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now "$unit"
    systemctl --user restart "$unit"
    echo "http://localhost:$port/  ($unit; remove with: $0 down)"
    ;;
  down)
    systemctl --user disable --now "$unit" 2>/dev/null || true
    rm -f "$file"
    systemctl --user daemon-reload
    echo "removed $unit"
    ;;
  *) echo "usage: $0 up|down" >&2; exit 1 ;;
esac
