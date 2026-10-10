// node:sqlite for the bat runtime: SQLite compiled to Wasm, running inside the
// guest process, with a page-level VFS over an FsBackend.
//
//   const sqlite = createSqliteModule(backend, { wasm })   // the `node:sqlite` module object
//
// `backend` is createKernelBackend(kernel, …) in a process worker and
// createNodeBackend() under native Node. `wasm` is a compiled module, the bytes
// of sqlite3.wasm, or a function returning either; nothing is compiled or
// instantiated until the first database is opened, and both steps are
// synchronous.
export { createSqliteModule, type SqliteModule, type SqliteModuleOptions, type SqliteCounters } from './node-sqlite'
export { createKernelBackend, type KernelFs, type KernelBackendOptions } from './backend-kernel'
export type { FsBackend, OpenFlags } from './backend'
export type { WasmSource, EngineStats } from './engine'
