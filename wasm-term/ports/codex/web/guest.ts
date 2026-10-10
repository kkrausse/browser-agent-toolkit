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

// The same TUI with the embedded app-server and agent core in the module
// (main/src/local.rs): nothing behind it but the page server's pass-through
// HTTP relay. Built by `BIN=local scripts/ship.sh` into dist/site-local/.
export const codexLocalGuest: WasmGuest = {
  name: "codex-local",
  kind: "wasm",
  description: "codex-cli 0.162.0 entirely in this tab: TUI, app-server and agent core (wasm32-wasip1). Model and sign-in requests leave through this page's relay; files live in the tab",
  site: join(import.meta.dir, "../dist/site-local"),
  build: "cd wasm-term/ports/codex && BIN=local scripts/ship.sh",
  params: [
    { query: "backend", env: "CODEX_WASM_BACKEND", label: "Backend", default: "mock", hint: "mock = the scripted model server from mock-llm, no sign-in, no tokens. openai = the real service: sign in with ChatGPT (device code) or an API key in the TUI. mock-auth = codex's real sign-in flow against mock-llm's fake auth server" },
    { query: "relay", env: "WASM_TERM_HTTP_RELAY", label: "HTTP relay", default: "/proxy/http", url: true, hint: "/proxy/http = this page's server forwards the program's HTTP requests to an allowlist of hosts (web/server.ts). Empty = the browser fetches them directly, which only works for servers that allow this page's origin (CORS)" },
    { query: "dir", env: "CODEX_WASM_CWD", label: "Project directory", default: "/home/user/project", hint: "a directory in this tab's filesystem; kept across reloads when it is below /home/user/project" },
    { query: "seed", env: "CODEX_WASM_SEED", label: "Seed a sample project", default: "1", hint: "1 = write a few sample files into the project directory if it is empty; 0 = leave it empty" },
  ],
  env: { TERM_PROGRAM: "ghostty", CODEX_HOME: "/home/user/.codex" },
  // Where sign-in leaves its tokens or API key (cli_auth_credentials_store = "file").
  credentials: ["/home/user/.codex/auth.json"],
  // CODEX_HOME (config.toml, auth.json, history.jsonl, sessions/) and the project. Not scratch, logs, or SQLite files (never opened here; they would be rewritten whole on every change).
  persist: { roots: ["/home/user/.codex", "/home/user/project"], exclude: ["/home/user/.codex/tmp/", "/home/user/.codex/log/", ".sqlite", "/thread-writer-locks/"] },
};
