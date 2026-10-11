// Replaces OpenTUI's `#opentui/runtime-assets` (packages/core/src/platform/
// runtime-assets.{bun,node}.ts), which locates the per-platform native
// library package and the tree-sitter assets on disk.
//
// In the browser the tree-sitter assets are URLs next to the guest module
// (host/guest.ts publishes the base); the parser worker fetches them. Under
// Bun (demos, OpenTUI's test suite) there is no base and the paths are
// labels, as before. The "library path" is always only a label:
// src/wasm-ffi.ts ignores it.

export const WASM_LIBRARY_PATH = "/wasm-term/opentui.wasm"
export const ASSET_BASE_GLOBAL = "__wasmTermOpentuiAssets"

const base = () => ((globalThis as Record<string, unknown>)[ASSET_BASE_GLOBAL] as string | undefined) ?? "/wasm-term/"

export async function resolveNativeLibraryPath(): Promise<string> {
  return WASM_LIBRARY_PATH
}

/** `relativePath` is e.g. "assets/markdown/highlights.scm". */
export function resolveDefaultParserAsset(relativePath: string, _fallbackPath: URL): Promise<string> {
  return Promise.resolve(`${base()}${relativePath}`)
}

export function resolveDefaultTreeSitterWorkerPath(_fallbackPath: URL): string {
  return `${base()}parser.worker.js`
}

export function resolveTreeSitterWasm(): Promise<string> {
  return Promise.resolve(`${base()}tree-sitter.wasm`)
}
