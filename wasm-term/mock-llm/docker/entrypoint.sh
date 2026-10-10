#!/usr/bin/env bash
# Container entrypoint; the first argument picks the role (see compose.yaml).
set -euo pipefail
ROLE="${1:?role: workspace-init | mock | tls | opencode | codex | edge}"
shift
DIR=/opt/mock-llm
# Fixed path (created in the Dockerfile, agent-owned, a named volume at runtime).
# Clients send their own cwd to the server, so this path is part of the contract.
WORKSPACE=/tmp/wasm-term-workspace

# A throwaway project for the agents to run tools in: its own git repo, on a
# named volume shared by the opencode and codex containers. Run once by the
# workspace-init service before either starts.
ensure_workspace() {
  if [ ! -d "$WORKSPACE/.git" ]; then
    mkdir -p "$WORKSPACE"
    printf 'hello from the wasm-term mock workspace\n' > "$WORKSPACE/hello.txt"
    git -C "$WORKSPACE" init -q
    git -C "$WORKSPACE" add hello.txt
    git -C "$WORKSPACE" -c user.name=mock -c user.email=mock@invalid commit -q -m "mock workspace"
  fi
}

case "$ROLE" in
  workspace-init)
    ensure_workspace
    ;;
  mock)
    exec env MOCK_LLM_HOST=0.0.0.0 MOCK_LLM_PORT=4791 bun "$DIR/server.ts"
    ;;
  tls)
    # TLS in front of the mock, with a certificate authority made here and now (tls-front.sh).
    exec bash "$DIR/tls-front.sh"
    ;;
  opencode)
    mkdir -p "$HOME/.config/opencode"
    cp "$DIR/opencode.config.json" "$HOME/.config/opencode/opencode.json"
    cors=()
    for origin in ${MOCK_CORS_ORIGINS:-}; do cors+=(--cors "$origin"); done
    cd "$WORKSPACE"
    exec opencode serve --hostname 0.0.0.0 --port 4792 --print-logs --log-level "${OPENCODE_LOG_LEVEL:-info}" "${cors[@]}" "$@"
    ;;
  codex)
    export CODEX_HOME="$HOME/.codex"
    mkdir -p "$CODEX_HOME"
    cp "$DIR/codex.config.toml" "$CODEX_HOME/config.toml"
    cd "$WORKSPACE"
    # app-server stays on loopback inside the container (it has no auth and
    # rejects any request with an Origin header). Two listeners face the network:
    #   4793 raw TCP forward       -> what `codex --remote` connects to
    #   4796 Origin-stripping tap  -> what a browser connects to; frames are logged
    codex app-server --listen ws://127.0.0.1:14793 "$@" &
    bun "$DIR/tcp-forward.ts" 4793=127.0.0.1:14793 &
    TAP_HOST=0.0.0.0 bun "$DIR/tap-proxy.ts" 4796 ws://127.0.0.1:14793 &
    wait -n
    exit 1
    ;;
  edge)
    # The only container with a leg outside the internal network. It holds no
    # tool and no config; it just copies bytes for the published ports.
    exec bun "$DIR/tcp-forward.ts" 4791=mock:4791 4792=opencode:4792 4793=codex:4793 4796=codex:4796 4797=tls:4797 4798=tls:4798
    ;;
  *)
    echo "unknown role $ROLE" >&2
    exit 2
    ;;
esac
