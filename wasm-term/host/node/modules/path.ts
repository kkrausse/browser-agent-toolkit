// node:path with the `posix`/`win32` namespaces Bun's browser polyfill omits.
// The emulated machine is POSIX; `win32` exists only so code that references
// it at module scope loads, and behaves as posix.
import * as base from "node:path"
// @ts-ignore the polyfill is an ES module at bundle time
export * from "node:path"
const api = { ...base, posix: undefined as unknown, win32: undefined as unknown }
api.posix = api
api.win32 = api
export const posix = api
export const win32 = api
export default api
