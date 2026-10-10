# Sourced by the launchers. Defines the ports, the isolated homes under
# wasm-term/.state/ for the host-side native TUI clients, and their network guard. Nothing here may point at the user's real state.
MOCK_LLM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
STATE_DIR="${WASM_TERM_STATE_DIR:-$(cd "$MOCK_LLM_DIR/.." && pwd)/.state}"
LOG_DIR="$STATE_DIR/logs"
WORKSPACE_DIR=/tmp/wasm-term-workspace

MOCK_LLM_PORT=4791
OPENCODE_PORT=4792
CODEX_PORT=4793
EGRESS_TRAP_PORT=4794
OPENCODE_TAP_PORT=4795
CODEX_TAP_PORT=4796
MOCK_TLS_PORT=4797
MOCK_TLS_UNTRUSTED_PORT=4798
# Not a secret: fixed so the server, the native client and a browser client agree.
# opencode serve generates a random password when none is given; it cannot be turned off.
MOCK_OPENCODE_PASSWORD="${MOCK_OPENCODE_PASSWORD:-wasm-term-mock}"

mkdir -p "$LOG_DIR"

# The servers run in containers and work in /tmp/wasm-term-workspace on a docker
# volume. A native TUI sends its own cwd to the server as the project path, so
# the client launchers cd into an empty host directory of the same name. It is
# only a name: it is not mounted into any container and no tool ever runs in it.
ensure_workspace() {
  mkdir -p "$WORKSPACE_DIR"
}

# For the host-side clients: any non-loopback HTTP(S) request goes to the egress
# trap port. With run-egress-trap.sh running it is refused and logged; without
# it the connection is refused outright, so it fails closed either way. Real provider keys that might be in the caller's shell are dropped.
guard_network() {
  export HTTP_PROXY="http://127.0.0.1:$EGRESS_TRAP_PORT" HTTPS_PROXY="http://127.0.0.1:$EGRESS_TRAP_PORT"
  export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" ALL_PROXY="$HTTP_PROXY" all_proxy="$HTTP_PROXY"
  export NO_PROXY="127.0.0.1,localhost,::1" no_proxy="127.0.0.1,localhost,::1"
  unset OPENAI_API_KEY OPENAI_BASE_URL OPENAI_ORG_ID CODEX_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN \
    ANTHROPIC_BASE_URL OPENROUTER_API_KEY GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY \
    GROQ_API_KEY XAI_API_KEY MISTRAL_API_KEY DEEPSEEK_API_KEY AZURE_OPENAI_API_KEY GITHUB_TOKEN GH_TOKEN \
    AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE OPENCODE_API_KEY \
    OPENCODE_SERVER_PASSWORD OPENCODE_PASSWORD
}

opencode_env() {
  local root="$STATE_DIR/opencode"
  export XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" XDG_STATE_HOME="$root/state" XDG_CACHE_HOME="$root/cache"
  mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
  # opencode's scratch dir is $TMPDIR/opencode (shared /tmp/opencode otherwise).
  export TMPDIR="$root/tmp"
  mkdir -p "$TMPDIR"
  export OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1
  export OPENCODE_SERVER_PASSWORD="$MOCK_OPENCODE_PASSWORD"
}

# The server and the TUI get separate homes so the baseline matches a browser
# client, which cannot see the server's CODEX_HOME. $1 is "server" or "client".
codex_env() {
  export CODEX_HOME="$STATE_DIR/codex-$1"
  mkdir -p "$CODEX_HOME"
}
