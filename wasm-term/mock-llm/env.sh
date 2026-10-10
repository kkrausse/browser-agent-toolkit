# Sourced by the launchers. Defines the isolated homes under wasm-term/.state/
# and the network guard. Nothing here may point at the user's real state.
MOCK_LLM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
STATE_DIR="${WASM_TERM_STATE_DIR:-$(cd "$MOCK_LLM_DIR/.." && pwd)/.state}"
LOG_DIR="$STATE_DIR/logs"
WORKSPACE_DIR="$STATE_DIR/workspace"

MOCK_LLM_PORT=4791
OPENCODE_PORT=4792
CODEX_PORT=4793
EGRESS_TRAP_PORT=4794
# Not a secret: fixed so the server, the native client and a browser client agree.
# opencode serve generates a random password when none is given; it cannot be turned off.
MOCK_OPENCODE_PASSWORD="${MOCK_OPENCODE_PASSWORD:-wasm-term-mock}"

mkdir -p "$LOG_DIR"

# A throwaway project for the agents to run tools in: its own git repo so
# neither tool walks up into the surrounding checkout.
ensure_workspace() {
  if [ ! -d "$WORKSPACE_DIR/.git" ]; then
    mkdir -p "$WORKSPACE_DIR"
    printf 'hello from the wasm-term mock workspace\n' > "$WORKSPACE_DIR/hello.txt"
    git -C "$WORKSPACE_DIR" init -q
    git -C "$WORKSPACE_DIR" add hello.txt
    git -C "$WORKSPACE_DIR" -c user.name=mock -c user.email=mock@invalid commit -q -m "mock workspace"
  fi
}

# Any non-loopback HTTP(S) request goes to the egress trap, which refuses and
# logs it. Real provider keys that might be in the caller's shell are dropped.
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

codex_env() {
  export CODEX_HOME="$STATE_DIR/codex"
  mkdir -p "$CODEX_HOME"
}
