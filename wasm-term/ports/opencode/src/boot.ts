// Loads the wasm core and publishes it where the bundled OpenTUI expects it.
// Must finish before any module that imports @opentui/core is evaluated, so
// entries import this file first and `await` nothing else before it.
import { createWasmFfi, type WasmFfi, type WasmFfiHost } from "./wasm-ffi"

export const WASM_FFI_GLOBAL = "__wasmTermOpentuiFfi"

export async function bootOpentuiWasm(wasm: BufferSource, host: WasmFfiHost): Promise<WasmFfi> {
  const ffi = await createWasmFfi(wasm, host)
  ;(globalThis as Record<string, unknown>)[WASM_FFI_GLOBAL] = ffi
  return ffi
}
