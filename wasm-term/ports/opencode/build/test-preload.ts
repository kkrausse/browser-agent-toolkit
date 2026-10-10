// `bun test --preload` hook: runs OpenTUI's own test suite against the wasm
// core instead of libopentui.so. See NOTES.md ("Upstream tests on wasm").
import path from "node:path"
import { plugin } from "bun"
import { bootOpentuiWasm } from "../src/boot"
import { opentuiWasmPlugin } from "./opentui-wasm-plugin"

await bootOpentuiWasm(await Bun.file(path.resolve(import.meta.dir, "../dist/opentui.wasm")).arrayBuffer(), {
  write() {},
})
plugin(opentuiWasmPlugin())
