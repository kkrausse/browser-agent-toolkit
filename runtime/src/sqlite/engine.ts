// The SQLite engine: sqlite3.wasm (built by native/build.sh from the SQLite
// amalgamation plus native/bat_sqlite.c) instantiated synchronously, with the
// "bat" imports bound to an FsBackend. One instance per process, created on
// the first use.
import type { FsBackend } from './backend'

/** Compiled module, its bytes, or a function returning either (called once, lazily). */
export type WasmSource = WebAssembly.Module | BufferSource | (() => WebAssembly.Module | BufferSource)

export interface EngineStats {
  /** ms spent in `new WebAssembly.Module` (0 when a compiled module was handed in). */
  compileMs: number
  /** ms spent in `new WebAssembly.Instance` plus `_initialize`. */
  instantiateMs: number
}

export interface FunctionEntry {
  call?: (ctx: number, argc: number, argv: number) => void
  step?: (ctx: number, state: number, argc: number, argv: number, inverse: boolean) => void
  final?: (ctx: number, state: number, isFinal: boolean) => void
  authorize?: (action: number, a: string | null, b: string | null, c: string | null, d: string | null) => number
}

export type Engine = ReturnType<typeof instantiate>

const OPEN_READONLY = 0x1
const OPEN_READWRITE = 0x2
const OPEN_CREATE = 0x4
const OPEN_EXCLUSIVE = 0x10
const OPEN_MAIN_DB = 0x100

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function createEngine(backend: FsBackend, source: WasmSource): { get(): Engine; stats: EngineStats } {
  let engine: Engine | undefined
  const stats: EngineStats = { compileMs: 0, instantiateMs: 0 }
  return {
    stats,
    get() {
      if (engine) return engine
      let s = typeof source === 'function' ? source() : source
      if (!(s instanceof WebAssembly.Module)) {
        const t = performance.now()
        s = new WebAssembly.Module(s)
        stats.compileMs = performance.now() - t
      }
      const t = performance.now()
      engine = instantiate(backend, s)
      stats.instantiateMs = performance.now() - t
      return engine
    },
  }
}

function instantiate(backend: FsBackend, module: WebAssembly.Module) {
  let memory: WebAssembly.Memory
  let u8 = new Uint8Array(0)
  let u32 = new Uint32Array(0)
  let f64 = new Float64Array(0)
  let dv = new DataView(u8.buffer)
  /** Views die when the memory grows; any call into Wasm may grow it. */
  const refresh = () => {
    if (u8.byteLength !== 0) return
    u8 = new Uint8Array(memory.buffer)
    u32 = new Uint32Array(memory.buffer)
    f64 = new Float64Array(memory.buffer)
    dv = new DataView(memory.buffer)
  }
  const cstr = (p: number): string => {
    refresh()
    let end = p
    while (u8[end] !== 0) end++
    return text(p, end - p)
  }
  /** UTF-8 at p..p+n as a string. */
  const text = (p: number, n: number): string => {
    if (n <= 24) {
      let s = ''
      let i = 0
      for (; i < n; i++) {
        const c = u8[p + i]
        if (c > 127) break
        s += String.fromCharCode(c)
      }
      if (i === n) return s
    }
    return decoder.decode(u8.subarray(p, p + n))
  }

  const functions = new Map<number, FunctionEntry>()
  let nextFunctionId = 1
  /** An exception thrown by guest code under a Wasm frame; rethrown once SQLite has unwound. */
  let pending: { error: unknown } | undefined
  const guard = (fn: () => void, ctx: number) => {
    try {
      fn()
    } catch (error) {
      if (!pending) pending = { error }
      x.sqlite3_result_error(ctx, emptyString, 0)
    }
  }

  const imports = {
    bat: {
      open(zName: number, flags: number, pOut: number): number {
        try {
          const path = cstr(zName)
          const want = { readOnly: (flags & OPEN_READONLY) !== 0, create: (flags & OPEN_CREATE) !== 0, exclusive: (flags & OPEN_EXCLUSIVE) !== 0 }
          let fd: number
          let out = want.readOnly ? OPEN_READONLY : OPEN_READWRITE
          try {
            fd = backend.open(path, want)
          } catch (e) {
            const code = (e as { code?: string }).code
            // A database that cannot be written is opened read-only, as the unix VFS does.
            if (want.readOnly || !(flags & OPEN_MAIN_DB) || (code !== 'EACCES' && code !== 'EROFS' && code !== 'EPERM')) return -1
            fd = backend.open(path, { readOnly: true, create: false, exclusive: false })
            out = OPEN_READONLY
          }
          refresh()
          dv.setInt32(pOut, out, true)
          return fd
        } catch {
          return -1
        }
      },
      close(fd: number): number {
        try {
          backend.close(fd)
          return 0
        } catch {
          return -1
        }
      },
      read(fd: number, p: number, n: number, off: number): number {
        try {
          refresh()
          return backend.read(fd, u8.subarray(p, p + n), off)
        } catch {
          return -1
        }
      },
      write(fd: number, p: number, n: number, off: number): number {
        try {
          refresh()
          backend.write(fd, u8.subarray(p, p + n), off)
          return 0
        } catch (e) {
          const code = (e as { code?: string }).code
          return code === 'ENOSPC' || code === 'EDQUOT' || code === 'ENOMEM' ? -2 : -1
        }
      },
      truncate(fd: number, size: number): number {
        try {
          backend.truncate(fd, size)
          return 0
        } catch {
          return -1
        }
      },
      sync(fd: number, flags: number): number {
        try {
          backend.sync(fd, (flags & 0x10) !== 0)
          return 0
        } catch {
          return -1
        }
      },
      size(fd: number): number {
        try {
          return backend.size(fd)
        } catch {
          return -1
        }
      },
      delete(zName: number): number {
        try {
          return backend.delete(cstr(zName)) ? 0 : 1
        } catch {
          return -1
        }
      },
      access(zName: number, flags: number): number {
        try {
          const path = cstr(zName)
          return (flags === 1 ? backend.writable(path) : backend.exists(path)) ? 1 : 0
        } catch {
          return 0
        }
      },
      fullpath(zName: number, nOut: number, zOut: number): number {
        try {
          const bytes = encoder.encode(backend.fullPath(cstr(zName)))
          if (bytes.length + 1 > nOut) return -1
          refresh()
          u8.set(bytes, zOut)
          u8[zOut + bytes.length] = 0
          return 0
        } catch {
          return -1
        }
      },
      random(n: number, p: number): void {
        refresh()
        crypto.getRandomValues(u8.subarray(p, p + n))
      },
      now: () => Date.now(),
      devchar: () => backend.deviceCharacteristics,
      func_call(id: number, ctx: number, argc: number, argv: number): void {
        guard(() => functions.get(id)!.call!(ctx, argc, argv), ctx)
      },
      func_destroy(id: number): void {
        functions.delete(id)
      },
      agg_step(id: number, ctx: number, state: number, argc: number, argv: number, inverse: number): void {
        guard(() => functions.get(id)!.step!(ctx, state, argc, argv, inverse !== 0), ctx)
      },
      agg_final(id: number, ctx: number, state: number, isFinal: number): void {
        guard(() => functions.get(id)!.final!(ctx, state, isFinal !== 0), ctx)
      },
      authorize(id: number, action: number, a: number, b: number, c: number, d: number): number {
        try {
          const s = (p: number) => (p ? cstr(p) : null)
          return functions.get(id)!.authorize!(action, s(a), s(b), s(c), s(d))
        } catch (error) {
          if (!pending) pending = { error }
          return 1 // SQLITE_DENY
        }
      },
    },
  }

  const instance = new WebAssembly.Instance(module, imports)
  const x = instance.exports as Record<string, (...args: any[]) => any>
  memory = instance.exports.memory as WebAssembly.Memory
  x._initialize()
  refresh()

  /** 16 bytes for out-pointers, and a NUL byte that serves as the empty C string. */
  const out: number = x.sqlite3_malloc(24)
  const emptyString = out + 16
  u8[emptyString] = 0

  /** A NUL-terminated copy of `s` in Wasm memory; the caller frees it. Sets `lastLen`. */
  let lastLen = 0
  const allocString = (s: string): number => {
    const n = s.length
    let cap = n <= 4096 ? n * 3 : n + 64
    let p: number = x.sqlite3_malloc(cap + 1)
    if (!p) throw new RangeError('SQLite: out of memory')
    refresh()
    let { read, written } = encoder.encodeInto(s, u8.subarray(p, p + cap))
    if (read! < n) {
      // Non-ASCII beyond the estimate: grow once to the worst case for the rest.
      const rest = s.slice(read)
      cap = written! + rest.length * 3
      p = x.sqlite3_realloc(p, cap + 1)
      if (!p) throw new RangeError('SQLite: out of memory')
      refresh()
      written! += encoder.encodeInto(rest, u8.subarray(p + written!, p + cap)).written!
    }
    u8[p + written!] = 0
    lastLen = written!
    return p
  }
  const allocBytes = (b: Uint8Array): number => {
    const p: number = x.sqlite3_malloc(b.length || 1)
    if (!p) throw new RangeError('SQLite: out of memory')
    refresh()
    u8.set(b, p)
    return p
  }

  let rowBuf = 0
  let rowCap = 0
  /** Scratch for bat_row: 16 bytes per column. */
  const rowBuffer = (columns: number): number => {
    if (columns > rowCap) {
      if (rowBuf) x.sqlite3_free(rowBuf)
      rowCap = Math.max(columns, 32)
      rowBuf = x.sqlite3_malloc(rowCap * 16)
      if (!rowBuf) throw new RangeError('SQLite: out of memory')
    }
    return rowBuf
  }

  return {
    x,
    out,
    refresh,
    cstr,
    text,
    allocString,
    allocBytes,
    rowBuffer,
    get lastLen() { return lastLen },
    get u8() { refresh(); return u8 },
    get u32() { refresh(); return u32 },
    get f64() { refresh(); return f64 },
    get dv() { refresh(); return dv },
    addFunction(entry: FunctionEntry): number {
      const id = nextFunctionId++
      functions.set(id, entry)
      return id
    },
    removeFunction(id: number): void {
      functions.delete(id)
    },
    /** Throw what a guest callback threw during the last call into SQLite, if anything. */
    takePending(): { error: unknown } | undefined {
      const p = pending
      pending = undefined
      return p
    },
  }
}
