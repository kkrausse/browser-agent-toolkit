// The guest-visible `process` object. Created once per worker, in the warm
// spare, before a pid exists: everything that depends on the launch (argv, env,
// cwd, pid, stdio) is filled in by `adopt` when the spawn arrives.
import { POLLHUP, POLLIN, type ProcInfo } from '../kernel/kernel'
import type { LoopInternals } from '../process/loop'
import type { Runtime } from '../process/runtime'

export const SIGNALS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9,
  SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18,
  SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGWINCH: 28,
}
export const SIGNAL_NAMES: Record<number, string> = Object.fromEntries(Object.entries(SIGNALS).map(([k, v]) => [v, k]))
/** Signals whose default action ends the process. */
const FATAL = new Set([1, 2, 3, 6, 13, 14, 15, 10, 12])

export interface ProcessControl {
  process: any
  /** Bind the process to its launch. */
  adopt(pid: number, info: ProcInfo, argv: string[], execArgv: string[]): void
  /** Run exit handlers and end the process. Does not return. */
  exit(code?: number): never
  uncaught(error: unknown, origin?: string): void
  unhandledRejection(reason: unknown, promise: Promise<unknown>): void
  rejectionHandled(promise: Promise<unknown>): void
  signal(sig: number): void
  beforeExit(): void
  /** Called by the loader when the main module settled. */
  mainSettled(): void
  drained(): void
  /** Write text to an fd without going through a stream (console fast path, fatal errors). */
  writeFd(fd: number, text: string): void
  /** True once `process.stdout`/`stderr` was materialised (so console must go through it). */
  streamFor(fd: 1 | 2): any | undefined
}

const encoder = new TextEncoder()

export function createProcess(rt: Runtime, loop: LoopInternals, finish: (code: number) => never): ProcessControl {
  const kernel = rt.kernel
  // Node's own lib reads `process` while it loads, and `process` is an EventEmitter from that lib:
  // the object exists first and becomes an emitter once its identity fields are in place.
  const proc: any = {}
  rt.process = proc

  let cwd: string | undefined
  let exiting = false
  let mainPending = true
  const startMs = performance.now()
  const version = rt.config.version

  function writeFd(fd: number, text: string) {
    const bytes = encoder.encode(text)
    let off = 0
    try {
      while (off < bytes.length) off += kernel.write(fd, off ? bytes.subarray(off) : bytes)
    } catch {
      // The reader is gone; there is nowhere to report it.
    }
  }

  function exit(code?: number): never {
    if (code !== undefined) proc.exitCode = code
    if (!exiting) {
      exiting = true
      proc._exiting = true
      let c = +(proc.exitCode ?? 0) | 0
      try {
        proc.emit('exit', c)
      } catch (e) {
        writeFd(2, `${describe(e)}\n`)
        c = c || 1
      }
      c = +(proc.exitCode ?? c) | 0
      finish(c)
    }
    finish(+(proc.exitCode ?? 0) | 0)
  }

  function describe(e: unknown): string {
    if (e && typeof e === 'object' && typeof (e as Error).stack === 'string') {
      const err = e as Error & { code?: string }
      let s = err.stack!
      // V8 only includes the message captured at construction.
      if (err.message && !s.includes(err.message)) s = `${err.name}: ${err.message}\n${s}`
      const extra = Object.keys(err).filter((k) => k !== 'stack' && k !== 'message')
      if (extra.length) {
        try {
          const fields = extra.map((k) => `  ${k}: ${rt.require('util').inspect((err as any)[k], { depth: 1 })}`)
          s += ` {\n${fields.join(',\n')}\n}`
        } catch {
          // best effort
        }
      }
      if (err.cause !== undefined) s += `\n  [cause]: ${describe(err.cause)}`
      return s
    }
    try {
      return rt.require('util').inspect(e)
    } catch {
      return String(e)
    }
  }

  let captureCallback: ((e: unknown) => void) | null = null
  function uncaught(error: unknown, origin = 'uncaughtException') {
    if (exiting) return
    if (captureCallback) {
      captureCallback(error)
      return
    }
    try {
      proc.emit('uncaughtExceptionMonitor', error, origin)
      if (proc.listenerCount('uncaughtException') > 0) {
        proc.emit('uncaughtException', error, origin)
        return
      }
    } catch (e) {
      error = e
    }
    writeFd(2, `${origin === 'unhandledRejection' && !(error instanceof Error) ? 'Uncaught ' : ''}${describe(error)}\n\nNode.js ${version}\n`)
    proc.exitCode = proc.exitCode || 1
    exit(proc.exitCode === 0 ? 1 : proc.exitCode)
  }
  function unhandledRejection(reason: unknown, promise: Promise<unknown>) {
    if (exiting) return
    if (proc.listenerCount('unhandledRejection') > 0) {
      loop.call(() => proc.emit('unhandledRejection', reason, promise))
      return
    }
    if (!(reason instanceof Error)) {
      const e = new Error(
        `This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${safeString(reason)}".`,
      ) as Error & { code: string }
      e.name = 'UnhandledPromiseRejection'
      e.code = 'ERR_UNHANDLED_REJECTION'
      uncaught(e, 'unhandledRejection')
    } else uncaught(reason, 'unhandledRejection')
  }
  function safeString(v: unknown) {
    try {
      return rt.require('util').inspect(v)
    } catch {
      return String(v)
    }
  }

  function signal(sig: number) {
    const name = SIGNAL_NAMES[sig]
    if (name && proc.listenerCount(name) > 0) {
      loop.call(() => proc.emit(name, name, sig))
      return
    }
    if (FATAL.has(sig)) {
      // Default action: die by the signal, without running exit handlers (as the OS would).
      exiting = true
      finish(128 + sig)
    }
  }

  // ---- static identity ----
  proc.title = 'node'
  proc.version = version
  proc.versions = {
    node: version.slice(1), v8: '13.6.233.10-node.28', uv: '1.51.0', zlib: '1.3.1', brotli: '1.1.0', ares: '1.34.5',
    modules: '137', nghttp2: '1.66.0', napi: '10', llhttp: '9.3.0', openssl: '3.5.2', unicode: '16.0', bat: '0.1.0',
  }
  proc.arch = 'wasm32'
  proc.platform = 'linux'
  proc.release = { name: 'node', sourceUrl: '', headersUrl: '', lts: 'Krypton' }
  proc.config = { target_defaults: {}, variables: { napi_build_version: '10', node_shared: false } }
  proc.features = { inspector: false, debug: false, uv: true, ipv6: false, tls_alpn: false, tls_sni: false, tls_ocsp: false, tls: false, typescript: 'strip', require_module: true }
  proc.execPath = rt.config.execPath
  proc.execArgv = []
  proc.argv = ['node']
  proc.argv0 = 'node'
  proc.env = {}
  proc.pid = 0
  proc.ppid = 0
  proc.exitCode = undefined
  proc.allowedNodeEnvironmentFlags = new Set<string>()
  proc.report = { getReport: () => ({ header: { glibcVersionRuntime: '2.39' }, sharedObjects: [] }), writeReport: () => '' }
  proc.noDeprecation = false
  proc.throwDeprecation = false
  proc.traceDeprecation = false
  proc.sourceMapsEnabled = false
  proc.connected = false

  proc.cwd = () => (cwd ??= kernel.getcwd() || '/')
  proc.chdir = (dir: string) => {
    try {
      kernel.chdir(String(dir))
    } catch (e: any) {
      throw rt.require('fs')[Symbol.for('bat.fs.error')]?.(e, 'chdir', dir) ?? e
    }
    cwd = undefined
  }
  proc.umask = (mask?: number) => (mask === undefined ? 0o22 : 0o22)
  proc.getuid = proc.geteuid = () => 1000
  proc.getgid = proc.getegid = () => 1000
  proc.getgroups = () => [1000]
  proc.uptime = () => (performance.now() - startMs) / 1000
  const hrtime: any = (prev?: [number, number]) => {
    const t = performance.timeOrigin + performance.now()
    let s = Math.floor(t / 1000)
    let ns = Math.floor((t - s * 1000) * 1e6)
    if (prev) {
      s -= prev[0]
      ns -= prev[1]
      if (ns < 0) {
        s--
        ns += 1e9
      }
    }
    return [s, ns]
  }
  hrtime.bigint = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6))
  proc.hrtime = hrtime
  proc.memoryUsage = Object.assign(
    () => {
      const m = (performance as any).memory
      const heapUsed = m?.usedJSHeapSize ?? 32 << 20
      const heapTotal = m?.totalJSHeapSize ?? 64 << 20
      return { rss: heapTotal + (16 << 20), heapTotal, heapUsed, external: 1 << 20, arrayBuffers: 1 << 16 }
    },
    { rss: () => ((performance as any).memory?.totalJSHeapSize ?? 64 << 20) + (16 << 20) },
  )
  proc.constrainedMemory = () => 0
  proc.availableMemory = () => 2 ** 31
  proc.cpuUsage = (prev?: { user: number; system: number }) => {
    const user = Math.round((performance.now() - startMs) * 1000)
    return prev ? { user: user - prev.user, system: 0 } : { user, system: 0 }
  }
  proc.resourceUsage = () => ({ userCPUTime: proc.cpuUsage().user, systemCPUTime: 0, maxRSS: 65536, sharedMemorySize: 0, unsharedDataSize: 0, unsharedStackSize: 0, minorPageFault: 0, majorPageFault: 0, swappedOut: 0, fsRead: 0, fsWrite: 0, ipcSent: 0, ipcReceived: 0, signalsCount: 0, voluntaryContextSwitches: 0, involuntaryContextSwitches: 0 })
  proc.nextTick = loop.nextTick
  proc.exit = exit
  proc.reallyExit = (code: number) => finish(code | 0)
  proc.abort = () => finish(134)
  proc.kill = (pid: number, sig: string | number = 'SIGTERM') => {
    const n = typeof sig === 'number' ? sig : SIGNALS[sig]
    if (n === undefined) throw Object.assign(new TypeError(`Unknown signal: ${sig}`), { code: 'ERR_UNKNOWN_SIGNAL' })
    if (pid === proc.pid || pid === 0) {
      if (n !== 0) loop.nextTick(signal, n)
      return true
    }
    if (pid < 0) {
      // A process group. The kernel has none; a child started with `detached` leads a group that
      // is exactly its descendants, so signal the process and everything below it.
      const all = kernel.procList()
      const targets = [-pid]
      for (let i = 0; i < targets.length; i++) for (const p of all) if (p.ppid === targets[i] && p.state !== 2) targets.push(p.pid)
      let found = false
      for (const target of targets.reverse()) {
        try {
          kernel.kill(target, n)
          found = true
        } catch {
          // already gone
        }
      }
      if (!found) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH', errno: -3, syscall: 'kill' })
      return true
    }
    try {
      kernel.kill(pid, n)
    } catch (e: any) {
      throw Object.assign(new Error(`kill ${e.code}`), { code: e.code, errno: -e.errno, syscall: 'kill' })
    }
    return true
  }
  proc.emitWarning = (warning: any, type?: any, code?: any) => {
    let detail: string | undefined
    if (type && typeof type === 'object') {
      detail = type.detail
      code = type.code
      type = type.type
    }
    if (typeof warning === 'string') {
      const w = new Error(warning) as Error & { code?: string; detail?: string }
      w.name = String(type || 'Warning')
      if (code) w.code = code
      if (detail) w.detail = detail
      warning = w
    }
    if (warning.name === 'DeprecationWarning') {
      if (proc.noDeprecation) return
      if (proc.throwDeprecation) throw warning
    }
    loop.nextTick(() => {
      if (proc.listenerCount('warning') > 0) proc.emit('warning', warning)
      if (proc.env.NODE_NO_WARNINGS === '1') return
      if (warning.name === 'ExperimentalWarning') return
      writeFd(2, `(node:${proc.pid}) ${warning.code ? `[${warning.code}] ` : ''}${warning.name}: ${warning.message}\n`)
    })
  }
  proc.binding = (name: string) => {
    if (name === 'natives') return {}
    if (name === 'constants') return rt.require('constants')
    if (name === 'util') return rt.require('util').types
    throw new Error(`No such module: ${name}`)
  }
  proc.setUncaughtExceptionCaptureCallback = (fn: ((e: unknown) => void) | null) => {
    captureCallback = fn
  }
  proc.hasUncaughtExceptionCaptureCallback = () => captureCallback !== null
  proc.setSourceMapsEnabled = (v: boolean) => {
    proc.sourceMapsEnabled = !!v
  }
  proc.getBuiltinModule = (id: string) => {
    try {
      return rt.require(id)
    } catch {
      return undefined
    }
  }
  proc.getActiveResourcesInfo = () => []
  proc._getActiveHandles = () => []
  proc._getActiveRequests = () => []
  proc.openStdin = () => {
    proc.stdin.resume()
    return proc.stdin
  }
  proc.loadEnvFile = (path = '.env') => {
    const text: string = rt.require('fs').readFileSync(path, 'utf8')
    for (const [k, v] of Object.entries(rt.require('util').parseEnv(text))) if (!(k in proc.env)) proc.env[k] = v
  }
  proc._rawDebug = (...args: unknown[]) => writeFd(2, `${rt.require('util').format(...args)}\n`)
  proc._tickCallback = () => loop.drainTicks()
  const EventEmitter = rt.require('events')
  Object.setPrototypeOf(proc, EventEmitter.prototype)
  EventEmitter.call(proc)
  proc.setMaxListeners(0)

  // ---- stdio, created on first touch ----
  const streams: Record<number, any> = {}
  function outStream(fd: 1 | 2) {
    const { Writable } = rt.require('stream')
    const s = new Writable({
      decodeStrings: false,
      write(chunk: any, encoding: string, cb: (e?: Error | null) => void) {
        try {
          const bytes: Uint8Array = typeof chunk === 'string' ? (encoding && encoding !== 'utf8' && encoding !== 'utf-8' ? rt.require('buffer').Buffer.from(chunk, encoding) : encoder.encode(chunk)) : chunk
          let off = 0
          while (off < bytes.length) off += kernel.write(fd, off ? bytes.subarray(off) : bytes)
          cb()
        } catch (e: any) {
          cb(Object.assign(new Error(`write ${e.code ?? e}`), { code: e.code, errno: -(e.errno ?? 0), syscall: 'write' }))
        }
      },
      // Standard streams are never closed by the program.
      final(cb: () => void) {
        cb()
      },
      destroy(err: Error | null, cb: (e?: Error | null) => void) {
        cb(err)
      },
    })
    s.fd = fd
    s._type = 'pipe'
    s._isStdio = true
    s.isTTY = false
    s.destroySoon = s.destroy
    s._handle = { fd, setBlocking() {}, getAsyncId: () => 0, ref() {}, unref() {} }
    s.on('error', (e: any) => {
      // A closed pipe on stdout ends most programs quietly.
      if (e?.code !== 'EPIPE') uncaught(e)
    })
    return s
  }
  function inStream() {
    const { Readable } = rt.require('stream')
    const Buffer = rt.require('buffer').Buffer
    let waiting = false
    const buf = new Uint8Array(65536)
    const stop = () => {
      if (waiting) {
        waiting = false
        loop.offFd(0)
        loop.unref()
      }
    }
    const pump = () => {
      while (waiting) {
        let ready: number
        try {
          ready = kernel.pollFd(0)
        } catch {
          ready = POLLHUP
        }
        if (!(ready & (POLLIN | POLLHUP))) return
        const n = kernel.readRaw(0, buf)
        if (n > 0) {
          if (!s.push(Buffer.from(buf.slice(0, n)))) stop()
        } else if (n === 0 || n !== -11) {
          stop()
          s.push(null)
        } else return
      }
    }
    const s = new Readable({
      highWaterMark: 65536,
      read() {
        if (!waiting) {
          waiting = true
          loop.ref()
          loop.onFd(0, POLLIN | POLLHUP, pump)
        }
      },
      destroy(err: Error | null, cb: (e?: Error | null) => void) {
        stop()
        cb(err)
      },
    })
    s.fd = 0
    s.isTTY = false
    s.isRaw = false
    s.setRawMode = () => s
    s.on('pause', stop)
    s.ref = () => s
    s.unref = () => {
      stop()
      return s
    }
    return s
  }
  for (const [name, fd] of [['stdout', 1], ['stderr', 2]] as const) {
    Object.defineProperty(proc, name, {
      configurable: true,
      enumerable: true,
      get: () => (streams[fd] ??= outStream(fd)),
      set(v) {
        Object.defineProperty(proc, name, { value: v, writable: true, configurable: true, enumerable: true })
        streams[fd] = v
      },
    })
  }
  Object.defineProperty(proc, 'stdin', { configurable: true, enumerable: true, get: () => (streams[0] ??= inStream()) })

  return {
    process: proc,
    adopt(pid, info, argv, execArgv) {
      proc.pid = pid
      proc.ppid = kernel.getppid()
      proc.env = info.env
      proc.argv = argv
      proc.argv0 = info.argv[0] ?? 'node'
      proc.execArgv = execArgv
      proc.title = 'node'
      if (info.env.NODE_NO_WARNINGS === '1') proc.noDeprecation = true
      cwd = undefined
    },
    exit,
    uncaught,
    unhandledRejection,
    rejectionHandled(promise) {
      if (proc.listenerCount('rejectionHandled') > 0) proc.emit('rejectionHandled', promise)
    },
    signal,
    beforeExit() {
      if (!exiting) {
        try {
          proc.emit('beforeExit', +(proc.exitCode ?? 0) | 0)
        } catch (e) {
          uncaught(e)
        }
      }
    },
    mainSettled() {
      mainPending = false
    },
    drained() {
      if (mainPending && proc.exitCode === undefined) {
        writeFd(2, 'Warning: Detected unsettled top-level await\n')
        exit(13)
      }
      exit()
    },
    writeFd,
    streamFor: (fd) => streams[fd],
  }
}
