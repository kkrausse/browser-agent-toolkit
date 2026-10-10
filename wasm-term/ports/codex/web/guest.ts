// How the wasm-term dev page (../../../web) offers this port: where the
// packaged module is, which settings the launcher asks for, what survives a
// reload. The module itself is built by scripts/build.sh and packaged by
// scripts/package.ts (dist/site/).
import { join } from "node:path";
import type { WasmGuest } from "../../../web/guests";

export const codexGuest: WasmGuest = {
  name: "codex",
  kind: "wasm",
  description: "codex-cli 0.162.0 TUI (the Rust TUI, wasm32-wasip1), attached to a remote `codex app-server`",
  site: join(import.meta.dir, "../dist/site"),
  build: "cd wasm-term/ports/codex && scripts/build.sh && scripts/ship.sh",
  // Defaults are the token-free backend from wasm-term/mock-llm (mock-llm/up.sh).
  params: [
    // A path = same origin: the dev server's WebSocket relay to the proxy in front of the app-server (web/server.ts, CODEX_UPSTREAM).
    { query: "remote", env: "CODEX_REMOTE_ADDR", label: "App server", default: "/proxy/codex", url: "ws", hint: "/proxy/codex = through this page's server (works from any device); or ws://HOST:PORT of a proxy in front of `codex app-server --listen` that this browser can reach (the app-server itself refuses browsers: it rejects any request with an Origin header)" },
    { query: "dir", env: "CODEX_WASM_CWD", label: "Project directory", default: "/tmp/wasm-term-workspace", hint: "a path on the server's machine: what the TUI reports as its working directory" },
    { query: "sandbox", args: ["-c", 'sandbox_mode="{}"'], label: "Sandbox mode", default: "danger-full-access", hint: "danger-full-access for the mock backend (its container cannot run codex's sandbox); workspace-write there only to see approval prompts; empty = the server's own setting" },
  ],
  // What the terminal really is; codex picks keyboard flags and notification style from it.
  // CODEX_HOME is pinned so that it stays where `persist` looks even when the page passes another HOME.
  env: { TERM_PROGRAM: "ghostty", CODEX_HOME: "/home/user/.codex" },
  // CODEX_HOME: config.toml, history.jsonl. Not its scratch or log directories.
  persist: { roots: ["/home/user/.codex"], exclude: ["/home/user/.codex/tmp/", "/home/user/.codex/log/"] },
};
