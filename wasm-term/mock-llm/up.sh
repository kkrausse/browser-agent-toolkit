#!/usr/bin/env bash
# Build (first time) and start the containerised backend, then wait until every
# published port answers. Nothing from the host's opencode/codex is used.
#   MOCK_CORS_ORIGINS="http://my-host:4790 https://other"  extra origins for opencode's CORS
#   MOCK_BIND=0.0.0.0                                      publish beyond loopback (default 127.0.0.1)
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

# A port held by something else (typically an old host-side launcher) makes
# `docker compose up` fail half-way; say who holds it instead.
for port in $MOCK_LLM_PORT $OPENCODE_PORT $CODEX_PORT $CODEX_TAP_PORT $MOCK_TLS_PORT $MOCK_TLS_UNTRUSTED_PORT; do
  holder="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'users:\(\("\K[^"]+' | head -1 || true)"
  if [ -n "$holder" ] && [ "$holder" != "docker-proxy" ]; then
    echo "port $port is held by a host process ($holder). If it is an old mock-llm launcher, run mock-llm/stop.sh first." >&2
    exit 1
  fi
done

docker compose up -d --build --quiet-pull "$@"

auth="opencode:$MOCK_OPENCODE_PASSWORD"
# Probe the published address (loopback when published on every interface).
host="${MOCK_BIND:-127.0.0.1}"
[ "$host" = "0.0.0.0" ] && host=127.0.0.1
wait_for() { # name, curl args...
  local name="$1"; shift
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null --max-time 2 "$@" 2>/dev/null; then echo "ready: $name"; return 0; fi
    sleep 0.5
  done
  echo "not ready after 30s: $name (docker compose logs)" >&2
  return 1
}
wait_for "mock model      http://$host:$MOCK_LLM_PORT/v1" "http://$host:$MOCK_LLM_PORT/health"
wait_for "opencode serve  http://$host:$OPENCODE_PORT  (Basic $auth)" -u "$auth" "http://$host:$OPENCODE_PORT/api/info"
wait_for "codex app-server ws://$host:$CODEX_PORT  (native TUI)" "http://$host:$CODEX_PORT/readyz"
wait_for "codex for browsers ws://$host:$CODEX_TAP_PORT  (Origin stripped)" "http://$host:$CODEX_TAP_PORT/readyz"
# The test CA of this start of the TLS front, for whoever has to trust it (web/server.ts serves it
# to the page as /test/mock-ca.pem; a program gets it only with a mock backend). A certificate, not a key.
mkdir -p "$STATE_DIR/mock-tls"
docker compose exec -T tls cat /tmp/mock-tls/ca.pem > "$STATE_DIR/mock-tls/ca.pem.new" && mv "$STATE_DIR/mock-tls/ca.pem.new" "$STATE_DIR/mock-tls/ca.pem"
wait_for "mock over TLS   https://mock-llm.test (127.0.0.1:$MOCK_TLS_PORT, CA $STATE_DIR/mock-tls/ca.pem)" \
  --cacert "$STATE_DIR/mock-tls/ca.pem" --resolve "mock-llm.test:$MOCK_TLS_PORT:$host" "https://mock-llm.test:$MOCK_TLS_PORT/health"
echo "workspace inside the containers: $WORKSPACE_DIR"
