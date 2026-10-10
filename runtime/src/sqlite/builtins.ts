// Registers `node:sqlite` with the process runtime (see runtime/src/node/registry.ts).
// The engine is the Wasm helper named `sqlite` in RuntimeConfig.wasm
// (runtime/src/sqlite/sqlite3.wasm); `rt.wasmModule` compiles it once per worker.
import { registerBuiltin } from '../node/registry'
import { createKernelBackend } from './backend-kernel'
import { createSqliteModule } from './node-sqlite'

registerBuiltin(
  'sqlite',
  (rt) =>
    createSqliteModule(
      createKernelBackend(rt.kernel, { cwd: () => rt.process.cwd() }),
      { wasm: () => rt.wasmModule('sqlite') },
    ),
  { schemeOnly: true },
)
