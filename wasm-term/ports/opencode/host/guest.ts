// The opencode TUI as a JavaScript guest of the wasm-term machine
// (../../../host/node/runtime.ts). The machine supplies process, fs, timers
// and the pty; this file adds only what is specific to opencode and OpenTUI:
// the wasm renderer core, the tree-sitter worker and its assets, the two Bun
// globals the TUI touches, and the clipboard hook.
//
// Everything this guest loads sits next to it (see build/build-site.ts):
//   guest.js  tui.js  opentui.wasm  parser.worker.js  tree-sitter.wasm  assets/
import type { JsGuestContext } from "../../../host/node/runtime"
import { bootOpentuiWasm } from "../src/boot"
import { ASSET_BASE_GLOBAL } from "../src/shims/opentui-runtime-assets"
import type { WasmTermClipboard } from "../src/shims/host-clipboard"

export async function main(context: JsGuestContext): Promise<number> {
  const { env, process } = context
  const base = new URL(".", context.guestUrl).href
  const globals = globalThis as Record<string, any>
  const debug = Boolean(env.WASM_TERM_DEBUG)
  const log = (level: string, message: string, tags?: unknown) => {
    if (!debug && level !== "error" && level !== "warn") return
    context.log(`[opencode ${level}] ${message} ${tags === undefined ? "" : safeJson(tags)}`)
  }
  self.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason
    log("error", "unhandled rejection", String(reason?.stack ?? reason))
  })

  // The two Bun globals the TUI touches outside conditional imports
  // (migration-overlay.tsx: Bun.sleep; prompt/local-attachment.ts: Bun.file).
  globals.Bun = {
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    file: () => ({ exists: async () => false, size: 0 }),
  }
  globals.__wasmTermClipboard = context.clipboard satisfies WasmTermClipboard

  // Tree-sitter (markdown concealment, syntax highlighting) runs in a nested
  // Worker. OpenTUI constructs it with `new Worker(path)`, i.e. as a classic
  // script; the bundle is an ES module, so say so.
  globals[ASSET_BASE_GLOBAL] = base
  env.OTUI_TREE_SITTER_WORKER_PATH = `${base}parser.worker.js`
  const BrowserWorker = globals.Worker as typeof Worker | undefined
  if (BrowserWorker) {
    globals.Worker = function ModuleWorker(url: string | URL, options?: WorkerOptions) {
      return new BrowserWorker(url, { ...options, type: "module" })
    }
  } else {
    log("warn", "nested Workers are not available here: no markdown concealment or syntax highlighting")
  }

  const wasm = await (await fetch(`${base}opentui.wasm`)).arrayBuffer()
  const ffi = await bootOpentuiWasm(wasm, {
    write: (fd, bytes) => process[fd === 2 ? "stderr" : "stdout"].write(bytes),
  })
  if (env.WASM_TERM_FFI_STATS) {
    // Once a second: FFI calls, bytes copied in and out for buffer arguments, pinned bytes, linear memory.
    let last = { ...ffi.stats }
    setInterval(() => {
      const now = ffi.stats
      const top = [...now.borrowedBySymbol].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, bytes]) => `${name}=${bytes}`)
      context.log(
        `[opentui ffi 1s] calls=${now.calls - last.calls} copiedBytes=${now.borrowedBytes - last.borrowedBytes} pinnedBytes=${now.pinnedBytes} memory=${ffi.memory.buffer.byteLength} top: ${top.join(" ")}`,
      )
      now.borrowedBySymbol.clear()
      last = { ...now }
    }, 1000)
  }

  // Only now: the TUI bundle reads process, the fs and the wasm core while its modules are evaluated.
  const app = (await import(/* @vite-ignore */ `${base}tui.js`)) as typeof import("./worker-app")
  await app.start({
    serverUrl: env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4792",
    password: env.OPENCODE_SERVER_PASSWORD || undefined,
    directory: env.OPENCODE_DIRECTORY || undefined,
    prompt: env.OPENCODE_PROMPT || undefined,
    log,
  })
  return 0
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
