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
installNodeGlobals({ fs: createNodeFs(createVfs(), { cwd: () => "/" }), process })
