// Module resolution: a thin binding over the kernel's Rust resolver
// (crates/bat-kernel/src/resolve.rs, kernel-abi.md "Resolver"). Resolution is
// one Wasm call; the kernel caches results for every process and invalidates
// them by the overlay generation. On top of that this file keeps a per-process
// map so a repeated specifier does not even encode its strings again.
import type { Kernel } from '../kernel/kernel'

export const RESOLVE_IMPORT = 1
export const RESOLVE_DIR = 2
export const RESOLVE_PRESERVE_SYMLINKS = 4

export type PackageType = 'module' | 'commonjs' | undefined

export interface Resolved {
  path: string
  /** `type` of the package.json that governs the resolved file. */
  type: PackageType
}

export interface Resolver {
  /** Resolve a non-builtin specifier. Throws Node-shaped errors. */
  resolve(specifier: string, importer: string, flags: number): Resolved
  /** Nearest package.json for a path (file or directory). */
  packageScope(path: string): { path: string; type: PackageType } | undefined
  setConditions(extra: string[]): void
  stats: { calls: number; hits: number; ms: number; failures: number }
  kernelStats(): Record<string, number> | undefined
}

const TYPES: PackageType[] = [undefined, 'commonjs', 'module']
const SCRATCH = 3 * 8192 + 256

export function createResolver(kernel: Kernel): Resolver {
  const x = kernel.x
  const inst = kernel.inst
  const base: number = x.bat_alloc(SCRATCH) >>> 0
  const specP = base
  const impP = base + 8192
  const outP = base + 16384
  const condP = base + 24576
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  // Node 24 has `module-sync` on for both require and import.
  let condKey = 'module-sync'
  let condLen = 0
  const cache = new Map<string, Resolved | Error>()
  let cacheGen = kernel.overlayGeneration()
  const stats = { calls: 0, hits: 0, ms: 0, failures: 0 }
  const priv = new Uint8Array(8192)
  let condsWritten = false

  const put = (s: string, at: number, cap: number): number => {
    const u8 = inst.u8()
    const n = s.length
    if (n <= cap) {
      let i = 0
      for (; i < n; i++) {
        const c = s.charCodeAt(i)
        if (c > 127) break
        u8[at + i] = c
      }
      if (i === n) return n
    }
    const bytes = encoder.encode(s)
    if (bytes.length > cap) throw Object.assign(new Error(`ENAMETOOLONG: ${s.slice(0, 80)}…`), { code: 'ENAMETOOLONG' })
    u8.set(bytes, at)
    return bytes.length
  }
  const text = (ptr: number, len: number): string => {
    const u8 = inst.u8()
    priv.set(u8.subarray(ptr, ptr + len))
    return decoder.decode(priv.subarray(0, len))
  }

  function notFound(specifier: string, importer: string, flags: number, rc: number): Error {
    const esm = (flags & RESOLVE_IMPORT) !== 0
    let e: Error & { code?: string; requireStack?: string[] }
    if (rc === -13) {
      e = new Error(
        specifier.startsWith('#')
          ? `Package import specifier "${specifier}" is not defined imported from ${importer}`
          : `Package subpath '${specifier}' is not defined by "exports" (imported from ${importer})`,
      )
      e.code = specifier.startsWith('#') ? 'ERR_PACKAGE_IMPORT_NOT_DEFINED' : 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    } else if (rc === -22) {
      e = new TypeError(`Invalid module "${specifier}" imported from ${importer}`)
      e.code = 'ERR_INVALID_MODULE_SPECIFIER'
    } else if (esm) {
      const bare = !/^[./]|^file:/.test(specifier)
      e = new Error(`Cannot find ${bare ? 'package' : 'module'} '${specifier}' imported from ${importer}`)
      e.code = 'ERR_MODULE_NOT_FOUND'
    } else {
      e = new Error(`Cannot find module '${specifier}'\nRequire stack:\n- ${importer}`)
      e.code = 'MODULE_NOT_FOUND'
      e.requireStack = [importer]
    }
    return e
  }

  function resolve(specifier: string, importer: string, flags: number): Resolved {
    stats.calls++
    const gen = kernel.overlayGeneration()
    if (gen !== cacheGen) {
      cache.clear()
      cacheGen = gen
    }
    // Relative specifiers depend on the importer's directory only; so does the node_modules walk.
    const dir = flags & RESOLVE_DIR ? importer : importer.slice(0, importer.lastIndexOf('/') + 1)
    const key = `${flags}${condKey}\0${dir}\0${specifier}`
    const hit = cache.get(key)
    if (hit !== undefined) {
      stats.hits++
      if (hit instanceof Error) throw notFound(specifier, importer, flags, (hit as any).rc)
      return hit
    }
    const t0 = performance.now()
    if (!condsWritten) {
      condLen = put(condKey, condP, 256)
      condsWritten = true
    }
    const sl = put(specifier, specP, 8192)
    const il = put(importer, impP, 8192)
    const rc: number = x.bat_resolve(specP, sl, impP, il, flags, condP, condLen, outP, 8192)
    stats.ms += performance.now() - t0
    if (rc < 0) {
      stats.failures++
      cache.set(key, Object.assign(new Error('unresolved'), { rc }))
      throw notFound(specifier, importer, flags, rc)
    }
    const u8 = inst.u8()
    const out: Resolved = { type: TYPES[u8[outP]], path: text(outP + 1, rc - 1) }
    cache.set(key, out)
    return out
  }

  function packageScope(path: string) {
    const rc: number = x.bat_package_scope(specP, put(path, specP, 8192), outP, 8192)
    if (rc < 0) return undefined
    const u8 = inst.u8()
    return { type: TYPES[u8[outP]], path: text(outP + 1, rc - 1) }
  }

  return {
    resolve,
    packageScope,
    setConditions(extra) {
      condKey = ['module-sync', ...extra].join(',')
      condLen = put(condKey, condP, 256)
      cache.clear()
    },
    stats,
    kernelStats() {
      if (!x.bat_resolve_stats) return undefined
      x.bat_resolve_stats(outP)
      const f = new Float64Array(8)
      const dv = inst.dv()
      for (let i = 0; i < 8; i++) f[i] = dv.getFloat64(outP + i * 8, true)
      return { calls: f[0], cacheHits: f[1], stats: f[2], packageReads: f[3], packageCacheHits: f[4], ns: f[5], resultEntries: f[6], packageEntries: f[7] }
    },
  }
}
