// Dev server for the opencode TUI in the browser, on :4798.
//
// It serves wasm-term's own page (../../web/index.html + client.ts, bundled
// unchanged) and swaps in the JS-program worker for `/worker.js`:
//
//   /worker.js                  host/worker-main.ts (kernel pty + process shim + wasm core boot)
//   /guests/opencode.wasm       dist/opentui.wasm   (OpenTUI's Zig core)
//   /opencode-tui.browser.js    dist/…              (the opencode TUI bundle)
//
// Open:
//   http://localhost:4798/?guest=opencode&env=OPENCODE_SERVER_URL=http://127.0.0.1:4792&env=OPENCODE_SERVER_PASSWORD=wasm-term-mock
//
// The same three routes plus a per-guest `workerUrl` are what ../../web needs
// to offer this guest on :4790 (see NOTES.md, "Glue for :4790").
import { existsSync } from "node:fs"
import { basename, join } from "node:path"

const here = join(import.meta.dir, "..")
const root = join(here, "../..")
const webDir = join(root, "web")
const port = Number(process.env.PORT ?? 4798)
const kernelWasm = join(root, "kernel/target/wasm32-unknown-unknown/release/wasm_term_kernel.wasm")
const ghosttyWasm = Bun.resolveSync("@random/ghostty-web/ghostty-vt.wasm", webDir)

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
}

function respond(body: BodyInit | null, type: string, status = 200): Response {
  return new Response(body, { status, headers: { ...isolation, "Content-Type": type } })
}

function file(path: string, type: string): Response {
  if (!existsSync(path)) return respond(`Not built: ${path}\n`, "text/plain", 404)
  return respond(Bun.file(path), type)
}

async function bundle(entry: string, name: string): Promise<Blob> {
  const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", sourcemap: "inline" })
  if (!result.success) throw new AggregateError(result.logs, `bundling ${name} failed`)
  return result.outputs.find((output) => basename(output.path).endsWith(".js"))!
}

let client = await bundle(join(webDir, "client.ts"), "client")
let worker = await bundle(join(here, "host/worker-main.ts"), "worker")

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port,
  idleTimeout: 120,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/" || path === "/index.html") {
      client = await bundle(join(webDir, "client.ts"), "client")
      worker = await bundle(join(here, "host/worker-main.ts"), "worker")
      return file(join(webDir, "index.html"), "text/html; charset=utf-8")
    }
    if (path === "/client.js") return respond(client, "text/javascript")
    if (path === "/worker.js") return respond(worker, "text/javascript")
    if (path === "/ghostty-vt.wasm") return file(ghosttyWasm, "application/wasm")
    if (path === "/kernel.wasm") return file(kernelWasm, "application/wasm")
    if (path === "/guests/opencode.wasm") return file(join(here, "dist/opentui.wasm"), "application/wasm")
    if (path === "/opencode-tui.browser.js") return file(join(here, "dist/opencode-tui.browser.js"), "text/javascript")
    if (path === "/opencode-tui.browser.js.map") return file(join(here, "dist/opencode-tui.browser.js.map"), "application/json")
    return respond("Not found\n", "text/plain", 404)
  },
})
console.log(`opencode-in-browser dev server: http://localhost:${server.port}/?guest=opencode`)
