// First import of the tree-sitter worker bundle: what OpenTUI's
// parser.worker.ts expects from Node, in a plain browser Worker. It only
// needs a scratch filesystem (a cache for fetched grammars and queries), so
// it gets a private in-memory one; nothing here touches the machine.
import { Buffer } from "node:buffer"
import { createNodeFs } from "../../../host/node/fs"
import { installNodeGlobals } from "../../../host/node/globals"
import { createVfs } from "../../../host/vfs"

const globals = globalThis as Record<string, any>
// No `versions.node`: web-tree-sitter must take its browser path (fetch + instantiateStreaming).
const process = { env: {}, argv: [], platform: "linux", arch: "wasm32", versions: {}, cwd: () => "/", nextTick: queueMicrotask }
globals.process = process
globals.Buffer ??= Buffer
const fs = createNodeFs(createVfs(), { cwd: () => "/" })
installNodeGlobals({ fs, process })

// parser.worker.ts stores each grammar in its cache directory and then hands
// web-tree-sitter the cache *path*. Outside Node web-tree-sitter loads a
// string with fetch(), which would ask the web server for that path. So
// fetch() of a path that exists in the scratch filesystem is answered from it.
const browserFetch = globalThis.fetch.bind(globalThis)
globals.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === "string" && input.startsWith("/") && fs.existsSync(input)) {
    return Promise.resolve(new Response(fs.readFileSync(input), { headers: { "Content-Type": "application/wasm" } }))
  }
  return browserFetch(input, init)
}
