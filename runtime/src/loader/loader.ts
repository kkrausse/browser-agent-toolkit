// The module loader: a port of the reference loader in
// crates/bat-modules/harness/loader.mjs (docs/design/module-format.md is the
// contract) onto the kernel.
//
//   image file      → its precompiled function body, copied out of shared
//                     memory once and evaluated with a sourceURL
//   program script  → the function `__bat_define` registered for the path
//   overlay file    → transformed by the bat-modules Wasm, cached by content
//   resolution      → the kernel's Rust resolver
//
// Everything is synchronous except `import()` and modules with top-level await.
import { decodeFacts, FLAG_CODE_IS_SOURCE, type Facts } from '../../../crates/bat-modules/js/facts'
import type { Builtins } from '../node/builtins'
import type { Runtime } from '../process/runtime'
import { createResolver, RESOLVE_DIR, RESOLVE_IMPORT, type PackageType, type Resolver } from './resolve'
import { createTransformer, type Transformer } from './transform'

const NEW = 0
const LINKING = 1
const LINKED = 2
const EVALUATING = 3
const EVALUATED = 4
const FAILED = 5

const FACT_FAILED = 1 << 30
const FACT_IN_PROGRAM = 0x80000000

const WRAP_CJS = '(function (exports, require, module, __filename, __dirname, __bat) {'
const WRAP_ESM = '(function* (__bat) {'
const WRAP_ESM_ASYNC = '(async function* (__bat) {'

type Kind = '' | 'cjs' | 'esm' | 'json' | 'builtin'

export interface ModuleRecord {
  id: string
  /** File path without query. */
  path: string
  kind: Kind
  state: number
  facts: Facts | undefined
  fn: Function | undefined
  module: any
  namespace: any
  generator: any
  deps: ModuleRecord[]
  stars: any[]
  pending: Promise<void> | undefined
  error: unknown
  facade: any
  /** CommonJS: names present on the interop namespace. */
  synced: boolean
}

export interface Loader {
  records: Map<string, ModuleRecord>
  resolver: Resolver
  transformer: Transformer
  Module: any
  /** Run the entry file. Synchronous for CommonJS; the promise settles when an ES module graph finished. */
  runMain(path: string): Promise<unknown> | undefined
  /** Evaluate source text as the main module (`node -e`, stdin). */
  runSource(source: string, name: string, kind?: 'cjs' | 'esm'): Promise<unknown> | undefined
  import(specifier: string, parentId: string): Promise<any>
  require(specifier: string, parentId: string): any
  createRequire(parentId: string): any
  /** Resolve to a filename (or `node:x`). mode: 'import' | 'require'. */
  resolve(specifier: string, parentId: string, mode: 'import' | 'require', options?: { paths?: string[] }): string
  /** Compile function-body text as CommonJS at `filename` and run it against `module` (Module.prototype._compile). */
  compileCjs(source: string, filename: string, module: any): any
  main(): any
  /** URL of the program script that contains `path`, if it is not loaded yet. */
  programUrl(path: string): string | undefined
  /** URLs of the named program scripts that are configured and not loaded yet; they count as loaded from here on. */
  programUrls(names: string[]): string[]
  stats: Record<string, number>
}

const dirname = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}
const extname = (p: string): string => {
  const slash = p.lastIndexOf('/')
  const dot = p.lastIndexOf('.')
  return dot > slash + 1 ? p.slice(dot) : ''
}
export const pathToFileURL = (path: string): string => {
  const q = path.indexOf('?')
  const file = q < 0 ? path : path.slice(0, q)
  return `file://${encodeURI(file).replace(/[?#]/g, encodeURIComponent)}${q < 0 ? '' : path.slice(q)}`
}
export const fileURLToPath = (url: string): string => {
  const u = url.slice(url.startsWith('file:///') ? 7 : url.startsWith('file://localhost/') ? 16 : 5)
  const cut = u.search(/[?#]/)
  return decodeURIComponent(cut < 0 ? u : u.slice(0, cut))
}

export function createLoader(rt: Runtime, builtins: Builtins): Loader {
  const kernel = rt.kernel
  const g = rt.host.global
  const records = new Map<string, ModuleRecord>()
  const resolver = createResolver(kernel)
  const transformer = createTransformer(rt)
  const decoder = new TextDecoder()
  const indirectEval = g.eval as (code: string) => any
  let main: ModuleRecord | undefined
  /** path -> package type, learned from resolution. */
  const scopeTypes = new Map<string, PackageType>()
  const stats: Record<string, number> = {
    modules: 0, cjs: 0, esm: 0, json: 0, builtin: 0, compiled: 0, sourceAsCode: 0, transformed: 0, fromProgram: 0,
    readMs: 0, compileMs: 0, programMs: 0, programs: 0, bytes: 0,
  }

  // ---- program scripts ----
  const defined = new Map<string, Function>()
  Object.defineProperty(g, '__bat_define', {
    value: (path: string, fn: Function) => {
      defined.set(path, fn)
    },
    writable: true,
    configurable: true,
  })
  let programOf: Map<string, string> | undefined
  const programLoaded = new Set<string>()
  function programName(path: string): string | undefined {
    if (!programOf) {
      programOf = new Map()
      const names = kernel.imageNames()
      for (let id = 0; id < names.length; id++) {
        if (names[id] === undefined) continue
        const section = kernel.imageSection(id, 2)
        if (!section) continue
        try {
          for (const p of JSON.parse(decoder.decode(section)) as { name: string; modules: string[] }[]) {
            for (const m of p.modules) programOf.set(m, p.name)
          }
        } catch {
          // an unreadable list only means no program is used
        }
      }
    }
    return programOf.get(path)
  }
  function programFunction(path: string): Function | undefined {
    const have = defined.get(path)
    if (have) return have
    const name = programName(path)
    if (name === undefined || programLoaded.has(name)) return undefined
    programLoaded.add(name)
    const url = rt.config.programs[name]
    if (!url) return undefined
    const t0 = performance.now()
    try {
      rt.host.importScripts(url)
    } catch (e) {
      rt.process?.emitWarning?.(`program script ${name} failed to load (${(e as Error).message}); falling back to the image`)
      return undefined
    }
    stats.programMs += performance.now() - t0
    stats.programs++
    rt.mark(`program ${name}`)
    return defined.get(path)
  }

  // ---- Module (the object guest code sees as `module`) ----
  class Module {
    id: string
    filename: string | null
    path: string
    exports: any = {}
    loaded = false
    children: Module[] = []
    paths: string[]
    parent: Module | null | undefined
    constructor(id = '', parent?: Module | null) {
      this.id = id
      this.filename = id || null
      this.path = id ? dirname(id) : ''
      this.parent = parent
      this.paths = id ? nodeModulePaths(this.path) : []
    }
    require(specifier: string) {
      return requireFrom(this.id, specifier)
    }
    _compile(source: string, filename: string) {
      return compileCjs(source, filename, this)
    }
    get isPreloading() {
      return false
    }
  }
  function nodeModulePaths(from: string): string[] {
    const out: string[] = []
    let dir = from
    for (;;) {
      if (!dir.endsWith('/node_modules')) out.push(dir === '/' ? '/node_modules' : `${dir}/node_modules`)
      if (dir === '/') break
      dir = dirname(dir)
    }
    return out
  }

  function newNamespace(): any {
    const namespace = Object.create(null)
    Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' })
    return namespace
  }

  // ---- resolution ----
  function resolve(specifier: string, parentId: string, mode: 'import' | 'require', options?: { paths?: string[] }): string {
    const builtin = builtins.canonical(specifier)
    if (builtin !== undefined) return `node:${builtin}`
    if (specifier.startsWith('node:')) {
      throw Object.assign(new Error(`No such built-in module: ${specifier}`), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' })
    }
    let query = ''
    const c = specifier.charCodeAt(0)
    if (c === 46 || c === 47 || specifier.startsWith('file:')) {
      const q = specifier.search(/[?#]/)
      if (q >= 0) {
        query = specifier.slice(q)
        specifier = specifier.slice(0, q)
      }
    } else if (mode === 'import' && /^(https?|data|blob):/.test(specifier)) {
      throw Object.assign(new Error(`Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol '${specifier.slice(0, specifier.indexOf(':') + 1)}'`), { code: 'ERR_UNSUPPORTED_ESM_URL_SCHEME' })
    }
    const flags = mode === 'import' ? RESOLVE_IMPORT : 0
    const q = parentId.indexOf('?')
    const parent = q < 0 ? parentId : parentId.slice(0, q)
    if (options?.paths) {
      let last: unknown
      for (const p of options.paths) {
        try {
          const r = resolver.resolve(specifier, p.startsWith('/') ? p : `${kernel.getcwd()}/${p}`, flags | RESOLVE_DIR)
          scopeTypes.set(r.path, r.type)
          return r.path
        } catch (e) {
          last = e
        }
      }
      throw last ?? Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
    }
    const r = resolver.resolve(specifier, parent, parent.endsWith('/') ? flags | RESOLVE_DIR : flags)
    scopeTypes.set(r.path, r.type)
    return r.path + query
  }

  function packageTypeOf(path: string): PackageType {
    if (scopeTypes.has(path)) return scopeTypes.get(path)
    const type = resolver.packageScope(path)?.type
    scopeTypes.set(path, type)
    return type
  }

  // ---- source ----
  function compile(wrapper: string, code: string, id: string): Function {
    const t0 = performance.now()
    try {
      return indirectEval(`${wrapper}${code}\n})\n//# sourceURL=${id.startsWith('/') ? pathToFileURL(id).slice(7) : id}`)
    } finally {
      stats.compileMs += performance.now() - t0
    }
  }

  function source(record: ModuleRecord): void {
    const path = record.path
    const t0 = performance.now()
    const rc = kernel.statRaw(path)
    if (rc < 0) {
      throw Object.assign(new Error(`Cannot find module '${path}'`), { code: 'MODULE_NOT_FOUND' })
    }
    const word = kernel.st.facts
    const overlay = kernel.st.dev === 0
    let code: string | undefined
    let facts: Facts | undefined
    if (!overlay && word !== 0 && !(word & FACT_FAILED)) {
      // A start-up program (loaded before the entry) already holds this image module's function.
      const ready = defined.get(path)
      if (ready && !(word & FACT_IN_PROGRAM)) {
        record.facts = factsOf(path, word)
        record.kind = record.facts.kind === 'esm' ? 'esm' : 'cjs'
        record.fn = ready
        stats.fromProgram++
        return
      }
      if (word & FACT_IN_PROGRAM) {
        const fn = programFunction(path)
        if (fn) {
          record.facts = factsOf(path, word)
          record.kind = record.facts.kind === 'esm' ? 'esm' : 'cjs'
          record.fn = fn
          stats.fromProgram++
          return
        }
      } else {
        const r = kernel.readModule(path)!
        stats.bytes += r.data.length
        if (r.compiled) {
          code = decoder.decode(r.data)
          stats.compiled++
        } else if (word & FLAG_CODE_IS_SOURCE) {
          code = decoder.decode(r.data)
          if (code.charCodeAt(0) === 0xfeff) code = code.slice(1)
          stats.sourceAsCode++
        } else {
          // No stored body: transform the original.
          const out = transformer.transform(r.data, path, { packageType: packageTypeOf(path) })
          code = out.code
          facts = out.facts
          stats.transformed++
        }
        facts ??= factsOf(path, word)
      }
    }
    if (code === undefined) {
      const data = kernel.readFile(path)
      stats.bytes += data.length
      const out = transformer.transform(data, path, { packageType: packageTypeOf(path) })
      code = out.code
      facts = out.facts
      stats.transformed++
    }
    stats.readMs += performance.now() - t0
    record.facts = facts!
    record.kind = facts!.kind === 'esm' ? 'esm' : 'cjs'
    record.fn = compile(record.kind === 'cjs' ? WRAP_CJS : facts!.async ? WRAP_ESM_ASYNC : WRAP_ESM, code, record.id)
  }

  /** Facts of an image module: the word from the entry, the lists from its blob when asked for. */
  function factsOf(path: string, word: number): Facts {
    const facts = decodeFacts(word)
    if (facts.kind !== 'cjs') return facts
    // Export names of CommonJS are only needed when an ES module imports it: read the blob then.
    let lists: Facts | undefined
    const load = () => (lists ??= decodeFacts(word, readFactsBlob(path)))
    Object.defineProperty(facts, 'exports', { get: () => load().exports, configurable: true })
    Object.defineProperty(facts, 'reexports', { get: () => load().reexports, configurable: true })
    return facts
  }
  let blobBuf = 0
  function readFactsBlob(path: string): Uint8Array | undefined {
    const x = kernel.x
    if (!x.bat_module_facts) return undefined
    const u8 = () => kernel.inst.u8()
    const bytes = new TextEncoder().encode(path)
    blobBuf ||= x.bat_alloc(8192 + 65536) >>> 0
    u8().set(bytes, blobBuf)
    let rc: number = x.bat_module_facts(blobBuf, bytes.length, blobBuf + 8192, 65536)
    if (rc === -34) {
      const need = new DataView(u8().buffer).getUint32(blobBuf + 8192, true)
      const p = x.bat_alloc(need) >>> 0
      try {
        rc = x.bat_module_facts(blobBuf, bytes.length, p, need)
        return rc > 0 ? u8().slice(p, p + rc) : undefined
      } finally {
        x.bat_free(p, need)
      }
    }
    return rc > 0 ? u8().slice(blobBuf + 8192, blobBuf + 8192 + rc) : undefined
  }

  // ---- records ----
  function load(id: string, parent?: ModuleRecord): ModuleRecord {
    let record = records.get(id)
    if (record) return record
    const q = id.indexOf('?')
    const hash = id.indexOf('#')
    const cut = q < 0 ? hash : hash < 0 ? q : Math.min(q, hash)
    const path = id.startsWith('/') && cut >= 0 ? id.slice(0, cut) : id
    record = {
      id, path, kind: '', state: NEW, facts: undefined, fn: undefined, module: undefined, namespace: undefined,
      generator: undefined, deps: [], stars: [], pending: undefined, error: undefined, facade: undefined, synced: false,
    }
    stats.modules++
    if (id.startsWith('node:')) {
      record.kind = 'builtin'
      record.module = { exports: builtins.require(id) }
      record.state = EVALUATED
      stats.builtin++
      records.set(id, record)
      return record
    }
    records.set(id, record)
    try {
      record.module = new Module(path, parent?.module ?? null)
      if (id !== path) record.module.id = id
      const ext = extname(path)
      if (ext === '.json') {
        record.kind = 'json'
        stats.json++
        return record
      }
      if (ext === '.node') {
        throw Object.assign(new Error(`Native addons are not supported in this runtime: cannot load '${path}'. Use a WebAssembly or JavaScript build of the package.`), { code: 'ERR_DLOPEN_FAILED' })
      }
      if (ext === '.wasm') {
        throw Object.assign(new TypeError(`Unknown file extension ".wasm" for ${path}`), { code: 'ERR_UNKNOWN_FILE_EXTENSION' })
      }
      const hook = extensions[ext]
      if (hook && !defaultExtensions.has(hook)) {
        // A guest registered its own compiler for this extension (pirates, ts-node, jiti).
        record.kind = 'cjs'
        record.fn = () => hook(record!.module, path)
        record.facts = decodeFacts(1)
        return record
      }
      source(record)
      stats[record.kind]++
      if (record.kind === 'esm') record.namespace = newNamespace()
      return record
    } catch (error) {
      records.delete(id)
      throw error
    }
  }

  // ---- the `__bat` object ----
  class Context {
    record: ModuleRecord
    _meta: any
    constructor(record: ModuleRecord) {
      this.record = record
    }
    exports(getters: Record<string, () => unknown>) {
      const namespace = this.record.namespace
      for (const name in getters) Object.defineProperty(namespace, name, { get: getters[name], enumerable: true })
    }
    link(specifier: string) {
      const record = this.record
      try {
        const dep = load(resolve(specifier, record.id, 'import'), record)
        record.deps.push(dep)
        return namespaceOf(dep)
      } catch (error) {
        record.error ??= error
        return newNamespace()
      }
    }
    star(namespace: any) {
      this.record.stars.push(namespace)
    }
    import(specifier: unknown) {
      return importFrom(this.record.id, String(specifier))
    }
    get meta() {
      const record = this.record
      return (this._meta ??= {
        __proto__: null,
        dirname: dirname(record.path),
        filename: record.path,
        main: record === main,
        resolve: (specifier: string) => {
          const id = resolve(String(specifier), record.id, 'import')
          return id.startsWith('/') ? pathToFileURL(id) : id
        },
        url: pathToFileURL(record.id),
      })
    }
  }

  // ---- namespaces and interop ----
  function namespaceOf(record: ModuleRecord): any {
    if (record.namespace) return record.namespace
    const namespace = (record.namespace = newNamespace())
    const whole = { get: () => record.module.exports, enumerable: true }
    Object.defineProperty(namespace, 'default', whole)
    Object.defineProperty(namespace, 'module.exports', whole)
    for (const name of cjsExportNames(record, new Set())) defineInterop(namespace, record, name)
    if (record.state === EVALUATED) syncNamespace(record)
    return namespace
  }
  function defineInterop(namespace: any, record: ModuleRecord, name: string) {
    if (name in namespace) return
    Object.defineProperty(namespace, name, { get: () => record.module.exports?.[name], enumerable: true, configurable: true })
  }
  /**
   * After a CommonJS module ran, expose the enumerable names it really has in
   * addition to the statically detected ones. Node stops at the static list;
   * being wider costs nothing and keeps `import { x }` working where the
   * detection (or a missing facts blob) fell short.
   */
  function syncNamespace(record: ModuleRecord) {
    const namespace = record.namespace
    if (!namespace || record.synced || record.kind === 'esm') return
    record.synced = true
    const exports = record.module.exports
    if (exports === null || (typeof exports !== 'object' && typeof exports !== 'function')) return
    for (const name of Object.keys(exports)) defineInterop(namespace, record, name)
  }
  function cjsExportNames(record: ModuleRecord, seen: Set<ModuleRecord>): string[] {
    if (seen.has(record)) return []
    seen.add(record)
    if (record.kind === 'builtin') return Object.keys(Object(record.module.exports))
    if (record.kind !== 'cjs' || !record.facts) return []
    const names = [...record.facts.exports]
    for (const specifier of record.facts.reexports) {
      try {
        names.push(...cjsExportNames(load(resolve(specifier, record.id, 'require'), record), seen))
      } catch {
        // An unresolvable re-export contributes no names; require() will report it.
      }
    }
    return names
  }
  function requireView(record: ModuleRecord): any {
    const namespace = record.namespace
    if ('module.exports' in namespace) return namespace['module.exports']
    if (!('default' in namespace) || '__esModule' in namespace) return namespace
    if (!record.facade) {
      record.facade = newNamespace()
      for (const name of Object.keys(namespace)) {
        Object.defineProperty(record.facade, name, { get: () => namespace[name], enumerable: true })
      }
      Object.defineProperty(record.facade, '__esModule', { value: true })
    }
    return record.facade
  }

  // ---- ESM ----
  function link(record: ModuleRecord): void {
    if (record.kind !== 'esm' || record.state !== NEW) return
    record.state = LINKING
    record.generator = record.fn!.call(undefined, new Context(record))
    const prelude = record.generator.next()
    if (record.facts!.async) prelude.catch(() => {})
    if (record.error) {
      record.state = FAILED
      records.delete(record.id)
      throw record.error
    }
    for (const dep of record.deps) link(dep)
    for (const from of record.stars) {
      for (const name of Object.keys(from)) {
        if (name === 'default' || name === 'module.exports' || name in record.namespace) continue
        Object.defineProperty(record.namespace, name, { get: () => from[name], enumerable: true })
      }
    }
    record.state = LINKED
  }

  function evaluate(record: ModuleRecord): Promise<void> | undefined {
    if (record.kind !== 'esm') return void runCjs(record)
    if (record.state === FAILED) throw record.error
    if (record.state >= EVALUATING) return record.pending
    record.state = EVALUATING
    const fail = (error: unknown): never => {
      record.state = FAILED
      record.error = error
      record.pending = undefined
      throw error
    }
    try {
      let waits: Promise<void>[] | undefined
      for (const dep of record.deps) {
        const wait = evaluate(dep)
        if (wait) (waits ??= []).push(wait)
      }
      const body = () => (record.facts!.async ? record.generator.next() : void record.generator.next())
      const running: Promise<unknown> | undefined = waits ? Promise.all(waits).then(body) : body()
      if (!running) {
        record.state = EVALUATED
        record.generator = undefined
        return undefined
      }
      record.pending = running.then(() => {
        record.state = EVALUATED
        record.pending = undefined
        record.generator = undefined
      }, fail)
      record.pending.catch(() => {})
      return record.pending
    } catch (error) {
      return fail(error)
    }
  }

  function hasAsync(record: ModuleRecord, seen = new Set<ModuleRecord>()): boolean {
    if (record.kind !== 'esm' || seen.has(record)) return false
    seen.add(record)
    if (record.state === EVALUATED) return false
    return record.facts!.async || record.pending !== undefined || record.deps.some((dep) => hasAsync(dep, seen))
  }

  // ---- CommonJS ----
  function runCjs(record: ModuleRecord): void {
    if (record.state !== NEW) return
    record.state = EVALUATING
    const module = record.module
    try {
      if (record.kind === 'json') {
        let text = kernel.readText(record.path)
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        try {
          module.exports = JSON.parse(text)
        } catch (e) {
          ;(e as Error).message = `${record.path}: ${(e as Error).message}`
          throw e
        }
      } else {
        const require = makeRequire(record.id, module)
        record.fn!.call(module.exports, module.exports, require, module, record.path, module.path, new Context(record))
      }
      module.loaded = true
      record.state = EVALUATED
      record.fn = undefined
      if (record.namespace) syncNamespace(record)
    } catch (error) {
      records.delete(record.id)
      throw error
    }
  }

  const defaultExtensions = new Set<Function>()
  const extensions: Record<string, (module: any, filename: string) => void> = Object.create(null)
  for (const ext of ['.js', '.json', '.node']) {
    const fn = (module: any, filename: string) => {
      module.exports = requireFrom(filename, filename)
    }
    defaultExtensions.add(fn)
    extensions[ext] = fn
  }

  const cache = new Proxy(Object.create(null), {
    get: (_, id) => (typeof id === 'string' ? records.get(id)?.module : undefined),
    set: (_, id, module) => {
      if (typeof id !== 'string') return false
      // Pre-seeding the cache (proxyquire, mocks): a finished CommonJS record with these exports.
      records.set(id, {
        id, path: id, kind: 'cjs', state: EVALUATED, facts: decodeFacts(1), fn: undefined, module, namespace: undefined,
        generator: undefined, deps: [], stars: [], pending: undefined, error: undefined, facade: undefined, synced: false,
      })
      return true
    },
    has: (_, id) => typeof id === 'string' && records.has(id),
    deleteProperty: (_, id) => (typeof id === 'string' && records.delete(id)) || true,
    ownKeys: () => [...records.keys()].filter((k) => !k.startsWith('node:')),
    getOwnPropertyDescriptor: (_, id) =>
      typeof id === 'string' && records.has(id) ? { value: records.get(id)!.module, enumerable: true, configurable: true, writable: true } : undefined,
  })

  function makeRequire(parentId: string, module?: any): any {
    const require: any = (specifier: string) => {
      if (typeof specifier !== 'string') {
        throw Object.assign(new TypeError(`The "id" argument must be of type string. Received ${specifier === null ? 'null' : typeof specifier}`), { code: 'ERR_INVALID_ARG_TYPE' })
      }
      return requireFrom(parentId, specifier, module)
    }
    require.resolve = (specifier: string, options?: { paths?: string[] }) => {
      const id = resolve(String(specifier), parentId, 'require', options)
      return id.startsWith('node:') && !String(specifier).startsWith('node:') ? id.slice(5) : id
    }
    require.resolve.paths = (specifier: string) =>
      builtins.canonical(specifier) !== undefined ? null : /^\.\.?\//.test(specifier) ? [dirname(parentId)] : nodeModulePaths(dirname(parentId))
    require.cache = cache
    require.extensions = extensions
    Object.defineProperty(require, 'main', { get: () => main?.module, enumerable: true, configurable: true })
    return require
  }

  function requireFrom(parentId: string, specifier: string, parentModule?: any): any {
    const id = resolve(specifier, parentId, 'require')
    let record = records.get(id)
    if (!record) {
      record = load(id, parentModule ? ({ module: parentModule } as ModuleRecord) : undefined)
      if (parentModule && record.module instanceof Module) parentModule.children.push(record.module)
    }
    if (record.kind !== 'esm') {
      if (record.state === NEW) runCjs(record)
      return record.module.exports
    }
    link(record)
    if (hasAsync(record)) {
      throw Object.assign(new Error(`require() cannot be used on an ESM graph with top-level await. Use import() instead. To see where the top-level await comes from, use --experimental-print-required-tla.\n  From ${parentId} \n  Requiring ${record.id}`), { code: 'ERR_REQUIRE_ASYNC_MODULE' })
    }
    evaluate(record)
    return requireView(record)
  }

  async function importFrom(parentId: string, specifier: string): Promise<any> {
    await null // import() never evaluates anything synchronously
    return importNow(parentId, specifier)
  }
  function importNow(parentId: string, specifier: string): any {
    const record = load(resolve(specifier, parentId, 'import'))
    if (record.kind === 'esm') {
      link(record)
      const wait = evaluate(record)
      if (wait) return wait.then(() => record.namespace)
      return record.namespace
    }
    runCjs(record)
    return namespaceOf(record)
  }

  function compileCjs(sourceText: string, filename: string, module: any): any {
    const out = transformer.transform(sourceText, /\.[cm]?[jt]sx?$/.test(filename) ? filename : `${filename}.js`, { forceKind: 'cjs' })
    const fn = compile(WRAP_CJS, out.code, filename)
    const record = records.get(filename) ?? ({ id: filename, path: filename, module } as ModuleRecord)
    const require = makeRequire(filename, module)
    return fn.call(module.exports, module.exports, require, module, filename, dirname(filename), new Context(record))
  }

  function start(record: ModuleRecord): Promise<unknown> | undefined {
    main = record
    if (record.kind === 'esm') {
      link(record)
      return evaluate(record)
    }
    runCjs(record)
    return undefined
  }

  const loader: Loader = {
    records,
    resolver,
    transformer,
    Module,
    stats,
    runMain(path) {
      const cwd = kernel.getcwd()
      const id = resolver.resolve(path.startsWith('/') ? path : `./${path}`, `${cwd === '/' ? '' : cwd}/`, RESOLVE_DIR)
      scopeTypes.set(id.path, id.type)
      return start(load(id.path))
    },
    runSource(sourceText, name, kind) {
      const cwd = kernel.getcwd()
      const id = `${cwd === '/' ? '' : cwd}/${name}`
      const out = transformer.transform(sourceText, `${id}.${kind === 'esm' ? 'mjs' : 'js'}`, kind ? { forceKind: kind } : {})
      const record: ModuleRecord = {
        id, path: id, kind: out.facts.kind === 'esm' ? 'esm' : 'cjs', state: NEW, facts: out.facts, fn: undefined, module: new Module(id, null),
        namespace: undefined, generator: undefined, deps: [], stars: [], pending: undefined, error: undefined, facade: undefined, synced: false,
      }
      record.fn = compile(record.kind === 'cjs' ? WRAP_CJS : out.facts.async ? WRAP_ESM_ASYNC : WRAP_ESM, out.code, name)
      if (record.kind === 'esm') record.namespace = newNamespace()
      records.set(id, record)
      return start(record)
    },
    import: (specifier, parentId) => importFrom(parentId, specifier),
    require: (specifier, parentId) => requireFrom(parentId, specifier),
    createRequire: (parentId) => makeRequire(parentId),
    resolve,
    compileCjs,
    main: () => main?.module,
    programUrls(names) {
      const urls: string[] = []
      for (const name of names) {
        const url = rt.config.programs[name]
        if (!url || programLoaded.has(name)) continue
        programLoaded.add(name)
        stats.programs++
        urls.push(url)
      }
      return urls
    },
    programUrl(path) {
      let real = path
      try {
        real = kernel.realpath(path)
      } catch {
        return undefined
      }
      const name = programName(real)
      if (name === undefined || programLoaded.has(name) || defined.has(real)) return undefined
      programLoaded.add(name)
      stats.programs++
      return rt.config.programs[name]
    },
  }
  ;(Module as any)._extensions = extensions
  ;(Module as any)._cache = cache
  ;(Module as any)._nodeModulePaths = nodeModulePaths
  return loader
}
