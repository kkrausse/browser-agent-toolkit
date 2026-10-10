// How the wasm-term dev page (../../../web) offers this port: which directory
// to serve, which settings the launcher asks for, what survives a reload.
import { join } from "node:path"
import type { JsGuest } from "../../../web/guests"

export const opencodeGuest: JsGuest = {
  name: "opencode",
  kind: "js",
  description: "opencode 2.0.26 TUI, attached to a remote `opencode serve`",
  dir: join(import.meta.dir, "../dist/site"),
  build: "cd wasm-term/ports/opencode && bun run build:native && bun run build:tui",
  // Defaults are the token-free backend from wasm-term/mock-llm (mock-llm/up.sh).
  params: [
    { query: "server", env: "OPENCODE_SERVER_URL", label: "Server URL", default: "http://127.0.0.1:4792", hint: "an `opencode serve` this browser can reach; it must allow this page's origin (--cors)" },
    { query: "password", env: "OPENCODE_SERVER_PASSWORD", label: "Password", default: "wasm-term-mock", secret: true, hint: "OPENCODE_SERVER_PASSWORD of the server (user is always opencode)" },
    { query: "dir", env: "OPENCODE_DIRECTORY", label: "Project directory", default: "/tmp/wasm-term-workspace", hint: "a path on the server's machine; empty = the directory the server runs in" },
  ],
  // The client's XDG config and state: settings, theme, prompt history, tabs.
  // Not its data dir (only a log) or cache; lock directories never outlive a session.
  persist: {
    roots: ["/home/user/.config/opencode", "/home/user/.local/state/opencode"],
    exclude: ["/locks/"],
  },
}
