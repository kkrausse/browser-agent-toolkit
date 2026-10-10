// Bun bundler plugin: points OpenTUI's FFI seam at the wasm backend.
//
// Three source edits, each an exact-match replacement that fails the build if
// upstream moved the anchor (so an OpenTUI upgrade cannot silently go native):
//
//   1. core/src/platform/ffi.ts      requireModule("bun:ffi") -> the wasm backend
//   2. bun-ffi-structs/dist/index.js import("bun:ffi")        -> the wasm backend
//                                    pointer size 8           -> 4 (wasm32)
//   3. core/src/zig.ts               existsSync(libPath)      -> true
//
// plus one module redirect: `#opentui/runtime-assets` -> src/shims/opentui-runtime-assets.ts.
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
          {
            find: `if (typeof process !== "undefined" && "bun" in process.versions) {\n    return createBunBackend(await importModule("bun:ffi"));`,
            replace: `if (true) {\n    return createBunBackend(${BACKEND});`,
          },
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
        ]),
      }))
    },
  }
}
