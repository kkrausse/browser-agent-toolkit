// Stand-in for Node modules that have no meaning in a browser Worker
// (child_process, module, vm, sqlite, worker_threads, perf_hooks, tty, net...).
// The opencode TUI imports them statically but only reaches them through
// features a remote-only browser client does not have; calling one throws
// with a name instead of failing somewhere obscure.
const unavailable = (name: string) => () => {
  throw new Error(`wasm-term: node API ${name} is not available in the browser client`)
}

export const spawn = unavailable("child_process.spawn")
export const spawnSync = unavailable("child_process.spawnSync")
export const exec = unavailable("child_process.exec")
export const execFile = unavailable("child_process.execFile")
export const execSync = unavailable("child_process.execSync")
export const execFileSync = unavailable("child_process.execFileSync")
export const fork = unavailable("child_process.fork")

export const createRequire = () => {
  const require = unavailable("module.createRequire()()") as unknown as { resolve: () => never }
  require.resolve = unavailable("require.resolve")
  return require
}
export const registerHooks = unavailable("module.registerHooks")
export const builtinModules: string[] = []
export const isBuiltin = () => false

export const Script = unavailable("vm.Script")
export const SourceTextModule = unavailable("vm.SourceTextModule")
export const createContext = unavailable("vm.createContext")
export const runInContext = unavailable("vm.runInContext")

export const DatabaseSync = unavailable("sqlite.DatabaseSync")
export const Worker = unavailable("worker_threads.Worker")
export const isMainThread = true
export const parentPort = null
export const workerData = undefined

export const performance = globalThis.performance
export const monitorEventLoopDelay = () => ({ enable() {}, disable() {}, reset() {}, mean: 0, max: 0, percentile: () => 0 })

export const isatty = () => true
export const connect = unavailable("net.connect")
export const createConnection = unavailable("net.createConnection")
export const createServer = unavailable("net.createServer")

export default {
  DatabaseSync, Script, Worker, builtinModules, connect, createConnection, createContext, createRequire,
  createServer, exec, execFile, execFileSync, execSync, fork, isBuiltin, isMainThread, isatty,
  monitorEventLoopDelay, parentPort, performance, registerHooks, runInContext, spawn, spawnSync, workerData,
}
