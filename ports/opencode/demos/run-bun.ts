// Bun host for a bundled OpenTUI app: boots the wasm core with the real
// terminal as fd 1, then loads the app bundle.
//   bun demos/run-bun.ts dist/<app>.js
import path from "node:path"
import { writeSync } from "node:fs"
import { bootOpentuiWasm } from "../src/boot"

const app = process.argv[2]
if (!app) throw new Error("usage: bun demos/run-bun.ts <bundle.js>")
const ffi = await bootOpentuiWasm(
  await Bun.file(path.resolve(import.meta.dir, "../dist/opentui.wasm")).arrayBuffer(),
  { write: (fd, bytes) => void writeSync(fd === 2 ? 2 : 1, bytes) },
)
process.on("exit", () => {
  if (!process.env.WASM_FFI_STATS) return
  console.error(
    `wasm ffi: ${ffi.stats.calls} calls, ${ffi.stats.borrowedBytes} bytes borrowed, ` +
      `${ffi.memory.buffer.byteLength >> 20} MiB memory, ${ffi.stats.missingSymbols.length} missing symbols, ` +
      `unimplemented imports hit: ${[...ffi.stats.unimplementedImports].join(", ") || "none"}`,
  )
})
await import(path.resolve(app))
