// The opencode TUI as an ordinary Node program: `node main.js` on a terminal, with Node's own
// process, fs and fetch (no wasm-term machine underneath). Written for the toolkit runtime
// (../../../runtime), whose kernel has the pty; it also runs under a real Node 24.
//
// Everything it loads sits next to it (see build/build-site.ts, --target=node):
//   main.js  tui.js  opentui.wasm  parser.worker.js  tree-sitter.wasm  assets/
//
//   OPENCODE_SERVER_URL        the server (default http://127.0.0.1:4096)
//   OPENCODE_SERVER_PASSWORD   its HTTP Basic password
//   OPENCODE_DIRECTORY         the project directory on the server's machine
//   OPENCODE_TUI_LOG           a file the TUI's log is appended to (default: only errors, to stderr at exit)
import { appendFileSync, readFileSync, writeSync } from "node:fs"
import path from "node:path"
import { bootOpentuiWasm } from "../src/boot"
import { ASSET_BASE_GLOBAL } from "../src/shims/opentui-runtime-assets"

const here = import.meta.dirname
const env = process.env
const globals = globalThis as Record<string, any>

// The two Bun globals the TUI touches outside conditional imports
// (migration-overlay.tsx: Bun.sleep; prompt/local-attachment.ts: Bun.file).
globals.Bun ??= {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  file: () => ({ exists: async () => false, size: 0 }),
}
// Tree-sitter's worker script, runtime and grammars are files here; OpenTUI is given their paths.
globals[ASSET_BASE_GLOBAL] = here + path.sep
env.OTUI_TREE_SITTER_WORKER_PATH ??= path.join(here, "parser.worker.js")

const logFile = env.OPENCODE_TUI_LOG
const log = (level: string, message: string, tags?: unknown) => {
  if (!logFile) return
  let detail = ""
  try {
    detail = tags === undefined ? "" : JSON.stringify(tags)
  } catch {
    detail = String(tags)
  }
  appendFileSync(logFile, `${level} ${message} ${detail}\n`)
}

// The renderer writes frames to fd 1 from inside a call: the bytes are a view of its memory,
// so they are written before the call returns.
await bootOpentuiWasm(readFileSync(path.join(here, "opentui.wasm")), {
  write: (fd, bytes) => void writeSync(fd === 2 ? 2 : 1, bytes),
})

// Only now: the TUI bundle reads the wasm core while its modules are evaluated.
const app = (await import(path.join(here, "tui.js"))) as typeof import("./worker-app")
await app.start({
  serverUrl: env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096",
  password: env.OPENCODE_SERVER_PASSWORD || undefined,
  directory: env.OPENCODE_DIRECTORY || undefined,
  prompt: env.OPENCODE_PROMPT || undefined,
  log,
})
process.exit(0)
