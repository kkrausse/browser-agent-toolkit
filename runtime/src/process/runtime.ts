// The object every builtin and the loader are written against. One per
// process worker. Nothing here is visible to guest code.
import type { Kernel } from '../kernel/kernel'

export interface RuntimeConfig {
  /** Vendored Node lib bundle (classic script calling `__bat_nodelib`). */
  nodelibUrl: string
  /** Wasm helpers, fetched lazily: the module transform and the native codecs (zlib, digests). */
  wasm: { modules?: string; native?: string; [name: string]: string | undefined }
  /** Program scripts by name (manifest.programs[].name -> URL of its file). */
  programs: Record<string, string>
  /** Non-persistent overlay root for transformed workspace files. */
  cacheDir: string
  execPath: string
  /** Reported as process.version. */
  version: string
  /** Builtins to instantiate in the warm spare before a pid is assigned. */
  prewarm: string[]
  /** Write loader/boot timings to stderr at exit when set (also env BAT_TRACE=1). */
  trace?: boolean
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  nodelibUrl: 'bat-nodelib.js',
  wasm: {},
  programs: {},
  cacheDir: '/.bat/cache',
  execPath: '/usr/local/bin/node',
  version: 'v24.11.0',
  prewarm: ['events', 'path', 'buffer', 'util', 'fs', 'stream', 'url', 'module', 'os'],
}

/** What keeps the process alive and how kernel readiness reaches JS (process/loop.ts). */
export interface Loop {
  /** One more / one fewer thing keeping the process alive. */
  ref(): void
  unref(): void
  /** Run `fn` in a later turn (macrotask) while keeping the process alive. Used for async completions. */
  defer(fn: () => void): void
  /** Readiness of an fd (kernel mask: 1 readable, 4 writable, 8 error, 16 hang-up). Replaces a previous handler; does not ref. */
  onFd(fd: number, mask: number, cb: (mask: number) => void): void
  offFd(fd: number): void
  /** Exit of a direct child: cb(status). Does not ref. */
  onChild(pid: number, cb: (status: number) => void): void
  /** Records of one kernel watch id. Does not ref. */
  onWatch(id: number, cb: (kind: number, path: string) => void): void
  offWatch(id: number): void
  /** Call a guest callback from a loop turn: binds async context, drains nextTicks, routes throws to uncaughtException. */
  call(fn: (...a: any[]) => any, thisArg?: unknown, ...args: unknown[]): void
  /** Wrap a callback so it runs with the async context current now (AsyncLocalStorage). */
  bind<F extends (...a: any[]) => any>(fn: F): F
  nextTick(fn: (...a: any[]) => void, ...args: unknown[]): void
  setImmediate(fn: (...a: any[]) => void, ...args: unknown[]): unknown
  setTimeout(fn: (...a: any[]) => void, ms?: number, ...args: unknown[]): any
  /** Counters for the experiment notes. */
  stats: Record<string, number>
}

export interface Runtime {
  kernel: Kernel
  config: RuntimeConfig
  loop: Loop
  /** The guest-visible `process` object. */
  process: any
  /** Builtin require: public ids ('fs', 'node:fs') and vendored internals ('internal/errors'). */
  require(id: string): any
  /** A compiled Wasm helper by config name; compiled once per worker, synchronously if it must be. */
  wasmModule(name: string): WebAssembly.Module
  /** Worker globals the guest cannot reach. */
  host: {
    importScripts(...urls: string[]): void
    fetch: typeof fetch
    setTimeout: typeof setTimeout
    clearTimeout: typeof clearTimeout
    Worker: typeof Worker
    location: { href: string; origin: string }
    global: any
  }
  /** The module loader (loader/loader.ts) and process control (node/process.ts); set during warm-up. */
  loader?: import('../loader/loader').Loader
  builtins?: import('../node/builtins').Builtins
  ctl?: import('../node/process').ProcessControl
  /** Marks for the timing report: name -> ms since the spawn request was taken by this worker. */
  mark(name: string): void
  marks: [string, number][]
}
