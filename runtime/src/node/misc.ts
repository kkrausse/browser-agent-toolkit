// Small builtins: thin, stubbed, or importable-but-unsupported.
import type { Runtime } from '../process/runtime'
import { createConsole } from '../process/globals'
import { constants as fsConstants } from './fs'
import { SIGNALS } from './process'
import { registerBuiltin, unsupported } from './registry'

registerBuiltin('process', (rt) => rt.process)

registerBuiltin('timers', (rt) => {
  const l: any = rt.loop
  const timers: any = {
    setTimeout: l.setTimeout, setInterval: l.setInterval, setImmediate: l.setImmediate,
    clearTimeout: l.clearTimeout, clearInterval: l.clearTimeout, clearImmediate: l.clearImmediate,
    active: (t: any) => t?.refresh?.(), unenroll: (t: any) => l.clearTimeout(t), enroll() {},
  }
  Object.defineProperty(timers, 'promises', { enumerable: true, configurable: true, get: () => rt.require('timers/promises') })
  return timers
})

registerBuiltin('tty', (rt) => {
  const fail = (): never => {
    throw Object.assign(new Error('TTY initialization failed: no terminal is attached to this process'), { code: 'ERR_TTY_INIT_FAILED' })
  }
  void rt
  return {
    isatty: () => false,
    ReadStream: function ReadStream() { fail() },
    WriteStream: function WriteStream() { fail() },
  }
})

registerBuiltin('console', (rt) => {
  const c = createConsole(rt, rt.ctl!)
  function Console(this: any, stdout: any, stderr?: any) {
    const o = stdout && typeof stdout.write !== 'function' ? stdout : { stdout, stderr }
    const inst = createConsole(rt, rt.ctl!, { stdout: o.stdout, stderr: o.stderr ?? o.stdout })
    if (!new.target) return inst
    Object.assign(this, inst)
  }
  const out = Object.assign(Object.create(null), rt.host.global.console, c)
  Object.defineProperty(out, 'Console', { value: Console, enumerable: false, configurable: true, writable: true })
  return out
})

registerBuiltin('constants', (rt) => ({ ...rt.require('os').constants.errno, ...SIGNALS, ...fsConstants }))

registerBuiltin('perf_hooks', (rt) => {
  const g = rt.host.global
  class PerformanceObserver {
    static supportedEntryTypes: string[] = []
    observe() {}
    disconnect() {}
    takeRecords() { return [] }
  }
  const histogram = () => ({ min: 0, max: 0, mean: 0, stddev: 0, exceeds: 0, percentiles: new Map(), percentile: () => 0, reset() {}, enable: () => true, disable: () => true, record() {}, recordDelta() {} })
  return {
    performance: g.performance,
    PerformanceObserver: g.PerformanceObserver ?? PerformanceObserver,
    PerformanceEntry: g.PerformanceEntry,
    PerformanceMark: g.PerformanceMark,
    PerformanceMeasure: g.PerformanceMeasure,
    monitorEventLoopDelay: histogram,
    createHistogram: histogram,
    constants: { NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16 },
  }
})

registerBuiltin('dns', (rt) => {
  // Loopback only: names the kernel's socket namespace can reach resolve to 127.0.0.1; nothing else resolves.
  const local = (host: string) => host === 'localhost' || host === '' || host.endsWith('.localhost') || /^127\./.test(host) || host === '0.0.0.0' || host === '::1' || host === 'host.internal'
  const isIp = (h: string) => /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')
  const notFound = (host: string, syscall: string) => Object.assign(new Error(`${syscall} ENOTFOUND ${host}`), { code: 'ENOTFOUND', errno: -3008, syscall, hostname: host })
  function lookupSync(host: string, options: any): any {
    const o = typeof options === 'number' ? { family: options } : options ?? {}
    if (!local(host) && !isIp(host)) throw notFound(host, 'getaddrinfo')
    const address = isIp(host) && host !== '::1' ? host : o.family === 6 ? '::1' : '127.0.0.1'
    const family = address.includes(':') ? 6 : 4
    return o.all ? [{ address, family }] : { address, family }
  }
  function lookup(host: string, options: any, cb?: any) {
    if (typeof options === 'function') {
      cb = options
      options = {}
    }
    let r: any
    try {
      r = lookupSync(host, options)
    } catch (e) {
      return void rt.loop.nextTick(cb, e)
    }
    if (Array.isArray(r)) rt.loop.nextTick(cb, null, r)
    else rt.loop.nextTick(cb, null, r.address, r.family)
  }
  const resolve4 = (host: string, cb: any) => (local(host) ? rt.loop.nextTick(cb, null, ['127.0.0.1']) : rt.loop.nextTick(cb, notFound(host, 'queryA')))
  const promises = {
    lookup: async (host: string, options?: any) => lookupSync(host, options),
    resolve: async (host: string) => { if (!local(host)) throw notFound(host, 'queryA'); return ['127.0.0.1'] },
    resolve4: async (host: string) => { if (!local(host)) throw notFound(host, 'queryA'); return ['127.0.0.1'] },
    resolve6: async (host: string) => { if (!local(host)) throw notFound(host, 'queryAaaa'); return ['::1'] },
    setServers() {}, getServers: () => ['127.0.0.1'], setDefaultResultOrder() {}, getDefaultResultOrder: () => 'verbatim',
    Resolver: class { setServers() {} getServers() { return ['127.0.0.1'] } cancel() {} },
  }
  return {
    lookup, resolve: resolve4, resolve4, resolve6: (host: string, cb: any) => (local(host) ? rt.loop.nextTick(cb, null, ['::1']) : rt.loop.nextTick(cb, notFound(host, 'queryAaaa'))),
    reverse: (_ip: string, cb: any) => rt.loop.nextTick(cb, null, ['localhost']),
    lookupService: (_a: string, _p: number, cb: any) => rt.loop.nextTick(cb, null, 'localhost', 'http'),
    setServers() {}, getServers: () => ['127.0.0.1'], setDefaultResultOrder() {}, getDefaultResultOrder: () => 'verbatim',
    Resolver: promises.Resolver, promises,
    ADDRCONFIG: 1024, V4MAPPED: 2048, ALL: 256, NODATA: 'ENODATA', NOTFOUND: 'ENOTFOUND', SERVFAIL: 'ESERVFAIL', TIMEOUT: 'ETIMEOUT', CONNREFUSED: 'ECONNREFUSED',
  }
})
registerBuiltin('dns/promises', (rt) => rt.require('dns').promises)

registerBuiltin('sea', () => ({
  isSea: () => false,
  getAsset: () => unsupported('node:sea', 'getAsset'),
  getAssetAsBlob: () => unsupported('node:sea', 'getAssetAsBlob'),
  getRawAsset: () => unsupported('node:sea', 'getRawAsset'),
  getAssetKeys: () => [],
}), { schemeOnly: true })

registerBuiltin('v8', (rt) => ({
  getHeapStatistics: () => {
    const m = rt.process.memoryUsage()
    return { total_heap_size: m.heapTotal, total_heap_size_executable: 0, total_physical_size: m.heapTotal, total_available_size: 2 ** 31, used_heap_size: m.heapUsed, heap_size_limit: 2 ** 32, malloced_memory: 0, peak_malloced_memory: 0, does_zap_garbage: 0, number_of_native_contexts: 1, number_of_detached_contexts: 0, total_global_handles_size: 0, used_global_handles_size: 0, external_memory: 0 }
  },
  getHeapSpaceStatistics: () => [],
  getHeapSnapshot: () => unsupported('v8', 'getHeapSnapshot'),
  writeHeapSnapshot: () => unsupported('v8', 'writeHeapSnapshot'),
  setFlagsFromString() {},
  cachedDataVersionTag: () => 0,
  serialize: (v: unknown) => rt.require('buffer').Buffer.from(JSON.stringify(v)),
  deserialize: (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)),
  setHeapSnapshotNearHeapLimit() {},
  startupSnapshot: { isBuildingSnapshot: () => false, addSerializeCallback() {}, addDeserializeCallback() {}, setDeserializeMainFunction() {} },
  isStringOneByteRepresentation: (s: string) => !/[^\x00-\xff]/.test(s),
}))

// Importable, unusable: the guests import these and only touch them on paths the browser cannot serve.
function inspector(rt: Runtime): any {
  const EventEmitter = rt.require('events')
  class Session extends EventEmitter {
    connect() {}
    connectToMainThread() {}
    disconnect() {}
    post(_method: string, params?: any, cb?: any) {
      const done = typeof params === 'function' ? params : cb
      const err = Object.assign(new Error('The inspector is not available in this runtime'), { code: 'ERR_INSPECTOR_NOT_AVAILABLE' })
      if (typeof done === 'function') rt.loop.nextTick(done, err)
      else return Promise.reject(err)
    }
  }
  return { Session, open() {}, close() {}, url: () => undefined, waitForDebugger: () => unsupported('inspector', 'waitForDebugger'), console: rt.host.global.console, Network: {} }
}
registerBuiltin('inspector', inspector)
registerBuiltin('inspector/promises', inspector)

registerBuiltin('http2', () => {
  const no = (what: string) => () => unsupported('http2', what)
  return {
    constants: { HTTP2_HEADER_STATUS: ':status', HTTP2_HEADER_METHOD: ':method', HTTP2_HEADER_PATH: ':path', HTTP2_HEADER_AUTHORITY: ':authority', HTTP2_HEADER_SCHEME: ':scheme', HTTP2_HEADER_CONTENT_TYPE: 'content-type', HTTP2_HEADER_CONTENT_LENGTH: 'content-length', NGHTTP2_CANCEL: 8, NGHTTP2_NO_ERROR: 0 },
    connect: no('connect'), createServer: no('createServer'), createSecureServer: no('createSecureServer'),
    getDefaultSettings: () => ({}), getPackedSettings: no('getPackedSettings'), getUnpackedSettings: no('getUnpackedSettings'),
    sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders'),
    Http2ServerRequest: class Http2ServerRequest {}, Http2ServerResponse: class Http2ServerResponse {},
  }
})

registerBuiltin('tls', () => {
  const no = (what: string) => () => unsupported('tls', what)
  return {
    connect: no('connect'), createServer: no('createServer'), createSecureContext: no('createSecureContext'),
    TLSSocket: class TLSSocket { constructor() { unsupported('tls', 'TLSSocket') } },
    Server: class Server { constructor() { unsupported('tls', 'Server') } },
    SecureContext: class SecureContext {},
    checkServerIdentity: () => undefined, getCiphers: () => [], rootCertificates: [],
    getCACertificates: () => [], DEFAULT_ECDH_CURVE: 'auto', DEFAULT_MAX_VERSION: 'TLSv1.3', DEFAULT_MIN_VERSION: 'TLSv1.2', DEFAULT_CIPHERS: '', CLIENT_RENEG_LIMIT: 3, CLIENT_RENEG_WINDOW: 600,
  }
})

registerBuiltin('cluster', (rt) => {
  const EventEmitter = rt.require('events')
  const c = new EventEmitter()
  return Object.assign(c, { isPrimary: true, isMaster: true, isWorker: false, workers: {}, settings: {}, fork: () => unsupported('cluster', 'fork'), setupPrimary() {}, setupMaster() {}, disconnect() {}, SCHED_NONE: 1, SCHED_RR: 2 })
})

registerBuiltin('domain', (rt) => {
  const EventEmitter = rt.require('events')
  class Domain extends EventEmitter {
    members: unknown[] = []
    add() {}
    remove() {}
    bind(fn: unknown) { return fn }
    intercept(fn: unknown) { return fn }
    run(fn: (...a: any[]) => any, ...args: unknown[]) { return fn(...args) }
    enter() {}
    exit() {}
    dispose() {}
  }
  return { Domain, create: () => new Domain(), createDomain: () => new Domain(), active: null }
})

registerBuiltin('wasi', () => ({
  WASI: class WASI {
    constructor() {
      unsupported('wasi', 'WASI')
    }
  },
}))

registerBuiltin('repl', () => ({ start: () => unsupported('repl', 'start'), builtinModules: [] }))
registerBuiltin('trace_events', () => ({ createTracing: () => ({ enable() {}, disable() {}, enabled: false, categories: '' }), getEnabledCategories: () => undefined }))
registerBuiltin('dgram', () => ({ createSocket: () => unsupported('dgram', 'createSocket'), Socket: class Socket {} }))

// `vm`: one realm. Scripts run in the process's own global context; contexts are objects whose
// properties are visible to the code through `with` (enough for config loaders and template engines).
registerBuiltin('vm', (rt) => {
  const g = rt.host.global
  const indirectEval = g.eval
  const contexts = new WeakSet<object>()
  const sourceUrl = (o: any) => {
    const name = typeof o === 'string' ? o : o?.filename
    return name ? `\n//# sourceURL=${name}` : ''
  }
  // `import()` inside evaluated code has no module to resolve against: route it through the loader from the cwd.
  const prepare = (code: string): string => {
    if (!/\bimport\s*\(/.test(code)) return code
    Object.defineProperty(g, '__bat_import', { value: (s: unknown) => rt.loader!.import(String(s), `${rt.kernel.getcwd()}/`), configurable: true, writable: true })
    try {
      return rt.loader!.transformer.transform(code, 'vm.cjs', { forceKind: 'cjs', dynamicImport: '__bat_import' }).code
    } catch {
      return code
    }
  }
  function runInThisContext(code: string, options?: any) {
    return indirectEval(prepare(String(code)) + sourceUrl(options))
  }
  function runInContext(code: string, context: any, options?: any) {
    if (context === g || context === undefined) return runInThisContext(code, options)
    // Top-level `var`/function declarations become properties of the context, as in a real context.
    const fn = new g.Function('__bat_ctx', `with (__bat_ctx) { return eval(${JSON.stringify(prepare(String(code)) + sourceUrl(options))}) }`)
    const scope = new Proxy(context, {
      has: () => true,
      get: (t, key) => (key === Symbol.unscopables ? undefined : key in t ? t[key] : g[key]),
      set: (t, key, value) => {
        t[key] = value
        return true
      },
    })
    return fn.call(context, scope)
  }
  class Script {
    #code: string
    #options: any
    constructor(code: string, options?: any) {
      this.#code = String(code)
      this.#options = options
      // Syntax errors surface at construction, as in Node.
      new g.Function(this.#code.includes('import') || this.#code.includes('await') ? '' : this.#code)
    }
    runInThisContext(options?: any) {
      return runInThisContext(this.#code, { ...asOptions(this.#options), ...asOptions(options) })
    }
    runInContext(context: any, options?: any) {
      return runInContext(this.#code, context, { ...asOptions(this.#options), ...asOptions(options) })
    }
    runInNewContext(context: any = {}, options?: any) {
      return runInContext(this.#code, context, { ...asOptions(this.#options), ...asOptions(options) })
    }
    createCachedData() {
      return rt.require('buffer').Buffer.alloc(0)
    }
    get cachedDataRejected() {
      return false
    }
  }
  const asOptions = (o: any) => (typeof o === 'string' ? { filename: o } : o ?? {})
  return {
    Script,
    runInThisContext,
    runInContext,
    runInNewContext: (code: string, context: any = {}, options?: any) => runInContext(code, context, options),
    createContext: (o: any = {}) => {
      contexts.add(o)
      return o
    },
    isContext: (o: any) => contexts.has(o),
    compileFunction: (code: string, params: string[] = [], options?: any) => new g.Function(...params, prepare(String(code)) + sourceUrl(options)),
    measureMemory: async () => ({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } }),
    constants: { USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('USE_MAIN_CONTEXT_DEFAULT_LOADER'), DONT_CONTEXTIFY: Symbol('DONT_CONTEXTIFY') },
    SourceTextModule: class SourceTextModule { constructor() { unsupported('vm', 'SourceTextModule') } },
    SyntheticModule: class SyntheticModule { constructor() { unsupported('vm', 'SyntheticModule') } },
  }
})

// `readline`: line input over a stream (questions, line events, async iteration). No terminal editing.
function readline(rt: Runtime): any {
  const EventEmitter = rt.require('events')
  class Interface extends EventEmitter {
    input: any
    output: any
    terminal = false
    line = ''
    cursor = 0
    closed = false
    history: string[] = []
    #prompt = '> '
    #buffer = ''
    #question: ((answer: string) => void) | undefined
    #decoder: any
    #onData: (chunk: any) => void
    #onEnd: () => void
    constructor(input: any, output?: any) {
      super()
      const o = input && typeof input.on !== 'function' ? input : { input, output }
      this.input = o.input
      this.output = o.output
      this.#prompt = o.prompt ?? '> '
      const { StringDecoder } = rt.require('string_decoder')
      this.#decoder = new StringDecoder('utf8')
      this.#onData = (chunk) => {
        this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk)
        let i
        while ((i = this.#buffer.search(/\r?\n|\r(?!\n)/)) >= 0 && !(this.#buffer[i] === '\r' && i === this.#buffer.length - 1)) {
          const line = this.#buffer.slice(0, i)
          this.#buffer = this.#buffer.slice(i + (this.#buffer[i] === '\r' && this.#buffer[i + 1] === '\n' ? 2 : 1))
          this.#line(line)
          if (this.closed) return
        }
      }
      this.#onEnd = () => {
        if (this.#buffer) {
          const rest = this.#buffer
          this.#buffer = ''
          this.#line(rest)
        }
        this.close()
      }
      if (this.input) {
        this.input.on('data', this.#onData)
        this.input.on('end', this.#onEnd)
        this.input.resume?.()
      }
      o.signal?.addEventListener('abort', () => this.close(), { once: true })
    }
    #line(line: string) {
      const q = this.#question
      if (q) {
        this.#question = undefined
        q(line)
      } else this.emit('line', line)
    }
    setPrompt(p: string) { this.#prompt = p }
    getPrompt() { return this.#prompt }
    prompt() { this.output?.write(this.#prompt) }
    question(query: string, options: any, cb?: (answer: string) => void) {
      if (typeof options === 'function') cb = options
      if (this.closed) throw Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' })
      this.output?.write(query)
      this.#question = cb
    }
    write(data: any) { if (typeof data === 'string') this.#onData(data) }
    pause() { this.input?.pause?.(); this.emit('pause'); return this }
    resume() { this.input?.resume?.(); this.emit('resume'); return this }
    close() {
      if (this.closed) return
      this.closed = true
      this.input?.removeListener?.('data', this.#onData)
      this.input?.removeListener?.('end', this.#onEnd)
      this.input?.pause?.()
      this.emit('close')
    }
    getCursorPos() { return { rows: 0, cols: this.cursor } }
    [Symbol.asyncIterator]() {
      const lines: string[] = []
      let wake: (() => void) | undefined
      this.on('line', (l: string) => { lines.push(l); wake?.() })
      this.on('close', () => wake?.())
      const self = this
      return (async function* () {
        for (;;) {
          while (lines.length) yield lines.shift()!
          if (self.closed) return
          await new Promise<void>((r) => (wake = r))
        }
      })()
    }
    [Symbol.dispose]() { this.close() }
  }
  const esc = (stream: any, s: string, cb?: () => void) => {
    stream?.write?.(s)
    cb?.()
    return true
  }
  const api: any = {
    Interface,
    createInterface: (input: any, output?: any) => new Interface(input, output),
    clearLine: (stream: any, dir: number, cb?: () => void) => esc(stream, dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K', cb),
    clearScreenDown: (stream: any, cb?: () => void) => esc(stream, '\x1b[0J', cb),
    cursorTo: (stream: any, x: number, y?: any, cb?: () => void) => {
      if (typeof y === 'function') { cb = y; y = undefined }
      return esc(stream, typeof y === 'number' ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`, cb)
    },
    moveCursor: (stream: any, dx: number, dy: number, cb?: () => void) => esc(stream, (dx < 0 ? `\x1b[${-dx}D` : dx > 0 ? `\x1b[${dx}C` : '') + (dy < 0 ? `\x1b[${-dy}A` : dy > 0 ? `\x1b[${dy}B` : ''), cb),
    emitKeypressEvents() {},
  }
  api.promises = {
    Interface,
    createInterface: (input: any, output?: any) => {
      const rl: any = new Interface(input, output)
      const question = rl.question.bind(rl)
      rl.question = (query: string) => new Promise<string>((resolve) => question(query, resolve))
      return rl
    },
  }
  return api
}
registerBuiltin('readline', readline)
registerBuiltin('readline/promises', (rt) => rt.require('readline').promises)
registerBuiltin('assert/strict', (rt) => rt.require('assert').strict ?? rt.require('assert'))
registerBuiltin('util/types', (rt) => rt.require('util').types)
registerBuiltin('path/posix', (rt) => rt.require('path').posix)
registerBuiltin('path/win32', (rt) => rt.require('path').win32)
registerBuiltin('stream/web', (rt) => {
  const g = rt.host.global
  const out: Record<string, unknown> = {}
  for (const name of ['ReadableStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader', 'ReadableStreamDefaultController', 'ReadableByteStreamController', 'ReadableStreamBYOBRequest', 'WritableStream', 'WritableStreamDefaultWriter', 'WritableStreamDefaultController', 'TransformStream', 'TransformStreamDefaultController', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'TextEncoderStream', 'TextDecoderStream', 'CompressionStream', 'DecompressionStream']) {
    if (g[name] !== undefined) out[name] = g[name]
  }
  return out
})

// Placeholders for modules that other parts of the tree provide (`runtime/src/net`, `…/sqlite`). A later
// registerBuiltin of the same name replaces these. They load, and say what is missing when used.
for (const name of ['net', 'http', 'https', 'sqlite']) {
  registerBuiltin(name, (rt) => {
    const said = new Set<string>()
    const missing = (what: string) => () => {
      // Programs often catch and re-wrap this; say it once on stderr so the first missing piece is visible.
      if (!said.has(what)) {
        said.add(what)
        rt.ctl?.writeFd(2, `[bat] node:${name} is not available in this build: ${what} was called\n`)
      }
      throw Object.assign(new Error(`node:${name} is not available in this build of the runtime (${what} was called)`), { code: 'ERR_BAT_MODULE_UNAVAILABLE' })
    }
    const EventEmitter = rt.require('events')
    if (name === 'sqlite') return { DatabaseSync: class DatabaseSync { constructor() { missing('new DatabaseSync')() } }, StatementSync: class StatementSync {}, constants: {} }
    const base: any = {
      createServer: missing('createServer'), connect: missing('connect'), createConnection: missing('createConnection'), request: missing('request'), get: missing('get'),
      isIP: (s: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : s.includes(':') ? 6 : 0), isIPv4: (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s), isIPv6: (s: string) => s.includes(':'),
      Socket: class Socket extends EventEmitter { constructor() { super(); missing('new Socket')() } },
      Server: class Server extends EventEmitter { constructor() { super(); missing('new Server')() } },
      Agent: class Agent { constructor(public options: unknown = {}) {} destroy() {} },
      METHODS: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'], STATUS_CODES: { 200: 'OK', 404: 'Not Found', 500: 'Internal Server Error' },
      IncomingMessage: class IncomingMessage {}, ServerResponse: class ServerResponse {}, OutgoingMessage: class OutgoingMessage {}, ClientRequest: class ClientRequest {},
      maxHeaderSize: 16384, validateHeaderName() {}, validateHeaderValue() {},
    }
    base.globalAgent = new base.Agent()
    return base
  }, name === 'sqlite' ? { schemeOnly: true } : {})
}
