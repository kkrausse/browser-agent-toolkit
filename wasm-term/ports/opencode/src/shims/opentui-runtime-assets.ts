// Replaces OpenTUI's `#opentui/runtime-assets` (packages/core/src/platform/
// runtime-assets.{bun,node}.ts), which locates the per-platform native
// library package and tree-sitter assets on disk. In the wasm build the
// "library path" is only a label: src/wasm-ffi.ts ignores it.

export const WASM_LIBRARY_PATH = "/wasm-term/opentui.wasm"

export async function resolveNativeLibraryPath(): Promise<string> {
  return WASM_LIBRARY_PATH
}

export function resolveDefaultParserAsset(relativePath: string, _fallbackPath: URL): Promise<string> {
  return Promise.resolve(`/wasm-term/assets/${relativePath}`)
}

export function resolveDefaultTreeSitterWorkerPath(_fallbackPath: URL): string {
  return "/wasm-term/assets/parser.worker.js"
}

export function resolveTreeSitterWasm(): Promise<string> {
  return Promise.resolve("/wasm-term/assets/tree-sitter.wasm")
}
