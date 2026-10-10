# Shared by serve-up.sh and serve-down.sh (sourced).
# The one tailnet-facing piece is an HTTPS port of `tailscale serve` that
# proxies to the dev server on loopback. Override with WASM_TERM_HTTPS_PORT.
WASM_TERM_PORT="${WASM_TERM_PORT:-4790}"
WASM_TERM_HTTPS_PORT="${WASM_TERM_HTTPS_PORT:-4790}"
WASM_TERM_UNIT="wasm-term-web.service"
WASM_TERM_TARGET="http://127.0.0.1:$WASM_TERM_PORT"

# What `tailscale serve` currently proxies "/" of our HTTPS port to; empty when the port is unused.
serve_entry() {
  tailscale serve status --json 2>/dev/null | python3 -c '
import json, sys
port = sys.argv[1]
try:
    config = json.load(sys.stdin)
except ValueError:
    config = {}
for host, web in (config.get("Web") or {}).items():
    if host.endswith(":" + port):
        print((web.get("Handlers") or {}).get("/", {}).get("Proxy", "other"))
' "$WASM_TERM_HTTPS_PORT"
}

tailnet_url() {
  local name
  name="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
  echo "https://$name:$WASM_TERM_HTTPS_PORT"
}

# Changing the serve config needs root unless the user is tailscale's operator
# (`sudo tailscale set --operator=$USER`, not done here): try plain, then sudo.
serve_config() {
  tailscale serve "$@" >/dev/null 2>&1 || sudo tailscale serve "$@" >/dev/null
}
