// Builtin module table for one process: TypeScript builtins from the registry
// plus Node's own lib (vendored under third_party/node, shipped as a separate
// classic script so the browser code-caches it). Nothing is instantiated until
// it is first required.
import type { Runtime } from '../process/runtime'
import { factories } from './registry'

type NodeFactory = (exports: any, require: (id: string) => any, module: { exports: any }, process: any, internalBinding: (name: string) => any, primordials: any) => void

interface NodeLib {
  factories: Record<string, NodeFactory>
  primordials: any
  createBufferBinding(): any
  uv: Record<string, unknown>
  constants: { os: unknown; fs: unknown; crypto: unknown }
}

/** Ids that exist only for the vendored lib's own use. */
const isInternal = (id: string) => id.startsWith('internal/')

/** Public ids that are spelled `node:x` only. */
const SCHEME_ONLY = new Set(['sqlite', 'sea', 'test', 'test/reporters'])

export interface Builtins {
  require(id: string): any
  /** Canonical id (without `node:`) if `specifier` names a builtin a guest may load. */
  canonical(specifier: string): string | undefined
  names(): string[]
  loaded(id: string): boolean
}

export function createBuiltins(rt: Runtime): Builtins {
  const cache = new Map<string, { exports: any }>()
  let lib: NodeLib | undefined
  let internalBinding: ((name: string) => any) | undefined
  const g = rt.host.global

  Object.defineProperty(g, '__bat_nodelib', {
    value: (l: NodeLib) => {
      lib = l
    },
    writable: true,
    configurable: true,
  })

  function nodelib(): NodeLib {
    if (!lib) {
      rt.host.importScripts(rt.config.nodelibUrl)
      if (!lib) throw new Error(`runtime: ${rt.config.nodelibUrl} did not register the Node lib`)
    }
    return lib
  }

  function makeInternalBinding(l: NodeLib) {
    const ALL_PROPERTIES = 0
    const ONLY_ENUMERABLE = 2
    const isIndex = (k: string) => /^(?:0|[1-9]\d*)$/.test(k) && Number(k) <= 0xffffffff
    const symbols = {
      owner_symbol: Symbol('owner_symbol'),
      async_id_symbol: Symbol('async_id_symbol'),
      trigger_async_id_symbol: Symbol('trigger_async_id_symbol'),
    }
    const bindings: Record<string, any> = {
      util: {
        constants: { ALL_PROPERTIES, ONLY_ENUMERABLE },
        getOwnNonIndexProperties(obj: object, filter: number) {
          const out: (string | symbol)[] = []
          for (const k of Object.getOwnPropertyNames(obj)) {
            if (isIndex(k)) continue
            if (filter !== ONLY_ENUMERABLE || Object.getOwnPropertyDescriptor(obj, k)!.enumerable) out.push(k)
          }
          for (const s of Object.getOwnPropertySymbols(obj)) {
            if (filter !== ONLY_ENUMERABLE || Object.getOwnPropertyDescriptor(obj, s)!.enumerable) out.push(s)
          }
          return out
        },
        isInsideNodeModules: () => false,
        getCallSites(frameCount: number) {
          const target: { stack?: any } = {}
          const prevPrepare = (Error as any).prepareStackTrace
          const prevLimit = Error.stackTraceLimit
          try {
            Error.stackTraceLimit = frameCount
            ;(Error as any).prepareStackTrace = (_e: unknown, sites: unknown) => sites
            Error.captureStackTrace(target, bindings.util.getCallSites)
            return (target.stack || []).slice(0, frameCount).map((s: any) => ({
              functionName: s.getFunctionName() || '',
              scriptId: '',
              scriptName: s.getScriptNameOrSourceURL() || s.getFileName() || '',
              lineNumber: s.getLineNumber() || 0,
              columnNumber: s.getColumnNumber() || 0,
              column: s.getColumnNumber() || 0,
            }))
          } finally {
            ;(Error as any).prepareStackTrace = prevPrepare
            Error.stackTraceLimit = prevLimit
          }
        },
        privateSymbols: { untransferable_object_private_symbol: Symbol('untransferable_object') },
      },
      config: { hasIntl: false },
      symbols,
      uv: l.uv,
      constants: { ...l.constants, zlib: {} },
      trace_events: { getCategoryEnabledBuffer: () => new Uint8Array(1), trace() {} },
    }
    let buffer: any
    return (name: string) => {
      if (name === 'buffer') return (buffer ??= l.createBufferBinding())
      if (Object.prototype.hasOwnProperty.call(bindings, name)) return bindings[name]
      throw new Error(`internalBinding('${name}') is not provided by this runtime`)
    }
  }

  function requireBuiltin(spec: string): any {
    const id = spec.startsWith('node:') ? spec.slice(5) : spec
    const hit = cache.get(id)
    if (hit) return hit.exports
    const module = { exports: {} as any }
    const reg = factories.get(id)
    if (reg) {
      cache.set(id, module)
      try {
        const out = reg.factory(rt)
        if (out !== undefined) module.exports = out
      } catch (e) {
        cache.delete(id)
        throw e
      }
      return module.exports
    }
    const l = nodelib()
    const factory = l.factories[id]
    if (!factory) {
      const e = new Error(`No such built-in module: ${spec}`) as Error & { code: string }
      e.code = 'ERR_UNKNOWN_BUILTIN_MODULE'
      throw e
    }
    // Registered before it runs so that cycles see the partial exports, as in Node.
    cache.set(id, module)
    try {
      factory(module.exports, requireBuiltin, module, rt.process, (internalBinding ??= makeInternalBinding(l)), l.primordials)
    } catch (e) {
      cache.delete(id)
      throw e
    }
    return module.exports
  }

  function has(id: string): boolean {
    if (factories.has(id)) return true
    return !isInternal(id) && Object.prototype.hasOwnProperty.call(nodelib().factories, id)
  }

  return {
    require: requireBuiltin,
    canonical(specifier) {
      if (specifier.startsWith('node:')) {
        const id = specifier.slice(5)
        return has(id) && !factories.get(id)?.opts.hidden ? id : undefined
      }
      if (specifier.charCodeAt(0) === 46 /* . */ || specifier.charCodeAt(0) === 47 /* / */) return undefined
      if (SCHEME_ONLY.has(specifier) || factories.get(specifier)?.opts.schemeOnly || factories.get(specifier)?.opts.hidden) return undefined
      return has(specifier) ? specifier : undefined
    },
    names() {
      const out = new Set<string>()
      for (const [name, { opts }] of factories) if (!opts.hidden) out.add(opts.schemeOnly || SCHEME_ONLY.has(name) ? `node:${name}` : name)
      for (const name of Object.keys(nodelib().factories)) if (!isInternal(name)) out.add(name)
      return [...out].sort()
    },
    loaded: (id) => cache.has(id),
  }
}
