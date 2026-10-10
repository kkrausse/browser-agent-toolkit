// Turn a dedicated worker's global object into a Node global object: remove
// what a Node program must not see (cheaply: delete the own properties), and
// install Node's globals. The runtime keeps the browser functions it needs in
// `host` before this runs.
import type { ProcessControl } from '../node/process'
import type { LoopInternals } from './loop'
import type { Runtime } from './runtime'

/** Worker-only or browser-only names. Programs probe these to decide "am I in a browser?". */
const HIDDEN = [
  'self', 'postMessage', 'importScripts', 'close', 'name', 'location', 'origin', 'isSecureContext', 'crossOriginIsolated',
  'onmessage', 'onmessageerror', 'onerror', 'onlanguagechange', 'onoffline', 'ononline', 'onrejectionhandled', 'onunhandledrejection',
  'WorkerGlobalScope', 'DedicatedWorkerGlobalScope', 'WorkerNavigator', 'WorkerLocation', 'Worker', 'SharedWorker',
  'XMLHttpRequest', 'XMLHttpRequestEventTarget', 'XMLHttpRequestUpload', 'FileReader', 'FileReaderSync', 'EventSource',
  'caches', 'CacheStorage', 'Cache', 'indexedDB', 'IDBFactory', 'requestAnimationFrame', 'cancelAnimationFrame',
  'createImageBitmap', 'OffscreenCanvas', 'reportError', 'fonts', 'webkitRequestFileSystem', 'webkitRequestFileSystemSync',
  'webkitResolveLocalFileSystemURL', 'webkitResolveLocalFileSystemSyncURL', 'TEMPORARY', 'PERSISTENT', 'trustedTypes',
  'ServiceWorkerRegistration', 'Notification', 'cookieStore', 'onstorage',
]

export function installGlobals(rt: Runtime, loop: LoopInternals, ctl: ProcessControl): void {
  const g = rt.host.global
  for (const name of HIDDEN) {
    try {
      if (!delete g[name]) Object.defineProperty(g, name, { value: undefined, configurable: true, writable: true })
    } catch {
      // not configurable in this browser: leave it
    }
  }
  const define = (name: string, value: unknown) => Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false })
  const lazy = (name: string, get: () => unknown) =>
    Object.defineProperty(g, name, {
      configurable: true,
      enumerable: false,
      get() {
        const value = get()
        define(name, value)
        return value
      },
      set(value) {
        define(name, value)
      },
    })

  define('global', g)
  define('process', rt.process)
  define('setTimeout', loop.setTimeout)
  define('setInterval', loop.setInterval)
  define('clearTimeout', loop.clearTimeout)
  define('clearInterval', loop.clearTimeout)
  define('setImmediate', loop.setImmediate)
  define('clearImmediate', loop.clearImmediate)
  lazy('Buffer', () => rt.require('buffer').Buffer)
  define('navigator', Object.freeze({ hardwareConcurrency: 1, language: 'en-US', languages: ['en-US'], platform: 'linux', userAgent: `Node.js/${rt.config.version.slice(1, 3)}` }))
  define('console', createConsole(rt, ctl))
  const perf: any = g.performance
  if (perf && !perf.eventLoopUtilization) {
    perf.eventLoopUtilization = () => ({ idle: 0, active: 0, utilization: 0 })
    perf.nodeTiming = { name: 'node', entryType: 'node', startTime: 0, duration: 0, nodeStart: 0, v8Start: 0, bootstrapComplete: 0, environment: 0, loopStart: 0, loopExit: -1, idleTime: 0 }
    perf.timerify = (fn: unknown) => fn
  }
}

export function createConsole(rt: Runtime, ctl: ProcessControl, streams?: { stdout: any; stderr: any }): any {
  let util: any
  const counts = new Map<string, number>()
  const timers = new Map<string, number>()
  let indent = ''
  const format = (args: unknown[]): string => {
    let text: string
    if (args.length === 1 && typeof args[0] === 'string') text = args[0]
    else text = (util ??= rt.require('util')).format(...args)
    return indent ? indent + text.replace(/\n/g, `\n${indent}`) : text
  }
  const write = (fd: 1 | 2, text: string) => {
    const stream = streams ? (fd === 1 ? streams.stdout : streams.stderr) : ctl.streamFor(fd)
    if (stream) stream.write(`${text}\n`)
    else ctl.writeFd(fd, `${text}\n`)
  }
  const out = (...args: unknown[]) => write(1, format(args))
  const err = (...args: unknown[]) => write(2, format(args))
  const console: any = {
    log: out,
    info: out,
    debug: out,
    warn: err,
    error: err,
    trace(...args: unknown[]) {
      const e = new Error(format(args))
      e.name = 'Trace'
      write(2, String(e.stack))
    },
    dir(value: unknown, options?: object) {
      write(1, (util ??= rt.require('util')).inspect(value, { customInspect: false, ...options }))
    },
    dirxml: out,
    assert(ok: unknown, ...args: unknown[]) {
      if (!ok) err(`Assertion failed${args.length ? ': ' : ''}${args.length ? format(args) : ''}`)
    },
    count(label = 'default') {
      const n = (counts.get(label) ?? 0) + 1
      counts.set(label, n)
      out(`${label}: ${n}`)
    },
    countReset(label = 'default') {
      counts.delete(label)
    },
    time(label = 'default') {
      timers.set(label, performance.now())
    },
    timeEnd(label = 'default') {
      const t = timers.get(label)
      if (t !== undefined) {
        out(`${label}: ${(performance.now() - t).toFixed(3)}ms`)
        timers.delete(label)
      }
    },
    timeLog(label = 'default', ...args: unknown[]) {
      const t = timers.get(label)
      if (t !== undefined) out(`${label}: ${(performance.now() - t).toFixed(3)}ms`, ...args)
    },
    group(...args: unknown[]) {
      if (args.length) out(...args)
      indent += '  '
    },
    groupEnd() {
      indent = indent.slice(2)
    },
    table(data: unknown) {
      out(data)
    },
    clear() {},
    timeStamp() {},
    profile() {},
    profileEnd() {},
  }
  console.groupCollapsed = console.group
  Object.defineProperty(console, 'Console', {
    configurable: true,
    enumerable: false,
    get: () => rt.require('console').Console,
  })
  return console
}
