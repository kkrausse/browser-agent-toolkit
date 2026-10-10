// Bun bundler plugin: points OpenTUI's FFI seam at the wasm backend.
//
// A handful of source edits, each an exact-match replacement that fails the build if
// upstream moved the anchor (so an OpenTUI upgrade cannot silently go native):
//
//   1. core/src/platform/ffi.ts      requireModule("bun:ffi") -> the wasm backend
//   2. bun-ffi-structs/dist/index.js import("bun:ffi")        -> the wasm backend
//                                    pointer size 8           -> 4 (wasm32)
//   3. core/src/zig.ts               existsSync(libPath)      -> true; one hand-read pointer
//   4. core/src/zig-structs.ts       four usize fields: u64   -> u32
//
// plus two module replacements: `#opentui/runtime-assets` -> src/shims/opentui-runtime-assets.ts
// and core/src/lib/host-clipboard.native.ts -> src/shims/host-clipboard.ts.
import type { BunPlugin } from "bun"
import path from "node:path"

const HERE = path.resolve(import.meta.dir, "..")
export const OPENTUI_ROOT = path.resolve(HERE, "../../vendor/opentui")
export const WASM_FFI_GLOBAL = "__wasmTermOpentuiFfi"

interface Edit {
  find: string
  replace: string
}

function applyEdits(file: string, source: string, edits: Edit[]): string {
  let out = source
  for (const edit of edits) {
    if (!out.includes(edit.find)) {
      throw new Error(`opentui-wasm-plugin: anchor not found in ${file}:\n  ${edit.find}`)
    }
    out = out.replace(edit.find, edit.replace)
  }
  return out
}

const BACKEND = `(globalThis.${WASM_FFI_GLOBAL} ?? (() => { throw new Error("wasm-term: OpenTUI wasm backend was not initialised before @opentui/core was evaluated") })())`

export function opentuiWasmPlugin(): BunPlugin {
  return {
    name: "opentui-wasm",
    setup(build) {
      build.onResolve({ filter: /^#opentui\/runtime-assets$/ }, () => ({
        path: path.join(HERE, "src/shims/opentui-runtime-assets.ts"),
      }))

      // The native host-clipboard backend is not in the wasm build.
      build.onLoad({ filter: /[\\/]core[\\/]src[\\/]lib[\\/]host-clipboard\.native\.ts$/ }, async () => ({
        loader: "ts",
        contents: await Bun.file(path.join(HERE, "src/shims/host-clipboard.ts")).text(),
      }))

      build.onLoad({ filter: /[\\/]core[\\/]src[\\/]platform[\\/]ffi\.ts$/ }, async (args) => ({
        loader: "ts",
        contents: applyEdits(args.path, await Bun.file(args.path).text(), [
          { find: `const isBun =\n  typeof process !== "undefined" &&`, replace: `const isBun =\n  true ||` },
          { find: `requireModule("bun:ffi") as BunFfiBackend`, replace: `${BACKEND} as BunFfiBackend` },
        ]),
      }))

      build.onLoad({ filter: /[\\/]bun-ffi-structs[\\/]dist[\\/]index\.js$/ }, async (args) => ({
        loader: "js",
        contents: applyEdits(args.path, await Bun.file(args.path).text(), [
          { find: `var backend = await loadBackend();`, replace: `var backend = createBunBackend(${BACKEND});` },
          {
            find: `var pointerSize = process.arch === "x64" || process.arch === "arm64" ? 8 : 4;`,
            replace: `var pointerSize = 4;`,
          },
          {
            find: `var isBun = typeof process !== "undefined" && "bun" in process.versions;`,
            replace: `var isBun = true;`,
          },
        ]),
      }))

      build.onLoad({ filter: /[\\/]core[\\/]src[\\/]zig\.ts$/ }, async (args) => ({
        loader: "ts",
        contents: applyEdits(args.path, await Bun.file(args.path).text(), [
          { find: `if (!existsSync(targetLibPath)) {`, replace: `if (false) {` },
          // No top-level await anywhere in the graph: Bun's bundler misorders
          // module initialisation around TLA in import cycles ("The superclass
          // is not a constructor"), and the wasm backend is synchronous anyway.
          {
            find: `targetLibPath = await resolveNativeLibraryPath()`,
            replace: `void resolveNativeLibraryPath; targetLibPath = "/wasm-term/opentui.wasm"`,
          },
          // Hand-read pointer field: 4 bytes on wasm32, and the next field follows immediately.
          {
            find: `toPointer(data.getBigUint64(sources.arrayOffset, true))`,
            replace: `toPointer(data.getUint32(sources.arrayOffset, true))`,
          },
        ]),
      }))

      // Struct fields declared "u64" in TypeScript that are `usize` in the Zig
      // extern structs (text-buffer.zig StyledChunk, lib.zig ExternalCapabilities):
      // 4 bytes on wasm32. Every other "u64" field is a real u64 in Zig.
      build.onLoad({ filter: /[\\/]core[\\/]src[\\/]zig-structs\.ts$/ }, async (args) => ({
        loader: "ts",
        contents: applyEdits(args.path, await Bun.file(args.path).text(), [
          { find: `["text_len", "u64", { lengthOf: "text" }]`, replace: `["text_len", "u32", { lengthOf: "text" }]` },
          { find: `["link_len", "u64", { lengthOf: "link" }]`, replace: `["link_len", "u32", { lengthOf: "link" }]` },
          {
            find: `["term_name_len", "u64", { lengthOf: "term_name" }]`,
            replace: `["term_name_len", "u32", { lengthOf: "term_name" }]`,
          },
          {
            find: `["term_version_len", "u64", { lengthOf: "term_version" }]`,
            replace: `["term_version_len", "u32", { lengthOf: "term_version" }]`,
          },
        ]),
      }))
    },
  }
}
