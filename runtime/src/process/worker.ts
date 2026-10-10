// Entry of the process worker bundle (a classic script: `importScripts` is how
// program scripts and the Node lib are loaded, and module workers do not have
// it). kerneld creates these workers and keeps one warm spare. This file
// speaks kerneld's protocol (attach / images / run → ready / exited / error)
// and, between "kernel attached" and "guest entry running", does:
//
//   in the spare, before a pid exists      on `run` (the measured path)
//   ─────────────────────────────────      ───────────────────────────
//   attach kernel, open image handles      bind to the pid, read argv/env/cwd
//   create loop, process, globals          parse node's command line
//   importScripts(node lib)                start the loop, run the entry
//   instantiate the common builtins
//   start compiling the Wasm helpers
//
// Configuration arrives in the worker URL's fragment (processWorkerUrl()).
import { attachKernel, type KernelInstance } from '../kernel/attach'
import { createKernel, type Kernel, type ProcInfo } from '../kernel/kernel'
import { openImageHandle, preopenImage, type SyncHandle } from '../kernel/opfs'
import { createLoader, type Loader } from '../loader/loader'
import { createBuiltins, type Builtins } from '../node/builtins'
import '../node/index'
import { createProcess, type ProcessControl } from '../node/process'
import { parseConfig } from './config'
import { installGlobals } from './globals'
import { createLoop, type LoopInternals } from './loop'
import type { Runtime } from './runtime'
import { createShell, SHELL_EXEC } from './sh'
import { trace, traceCommand, traceEnable } from '../trace'

const g: any = globalThis
// Everything the runtime needs from the worker scope, taken before the guest can see or change it.
const host = {
  global: g,
  importScripts: g.importScripts.bind(g) as (...urls: string[]) => void,
  postMessage: g.postMessage.bind(g) as (message: unknown) => void,
  addEventListener: g.addEventListener.bind(g) as typeof addEventListener,
  fetch: g.fetch.bind(g) as typeof fetch,
  setTimeout: g.setTimeout.bind(g) as typeof setTimeout,
  clearTimeout: g.clearTimeout.bind(g) as typeof clearTimeout,
  queueMicrotask: g.queueMicrotask.bind(g) as typeof queueMicrotask,
  MessageChannel: g.MessageChannel as typeof MessageChannel,
  Worker: g.Worker as typeof Worker,
  XMLHttpRequest: g.XMLHttpRequest as typeof XMLHttpRequest,
  location: { href: String(g.location.href), origin: String(g.location.origin) },
}
const config = parseConfig(host.location.href)
if (config.trace) traceEnable('process')
// What this process loaded so far, on request (bench/startup records start-up module sets from it).
traceCommand('modules', () => {
  if (pid && loader) trace('modules', { pid, argv: rt.process?.argv, modules: [...loader.records.values()].filter((r) => r.kind === 'cjs' || r.kind === 'esm').map((r) => r.path) })
})

let inst: KernelInstance
let kernel: Kernel
let namespace = 'default'
const handles: (SyncHandle | undefined)[] = []
let rt: Runtime
let loop: LoopInternals
let ctl: ProcessControl
let builtins: Builtins
let loader: Loader
let warm = false
let pid = 0
let runAt = 0
const marks: [string, number][] = []

async function openImages() {
  const names = kernel.imageNames()
  for (let id = 0; id < names.length; id++) {
    const name = names[id]
    if (name !== undefined && !handles[id]) {
      try {
        handles[id] = await openImageHandle(namespace, name)
      } catch (e) {
        // Reads fall back to the supervisor proxy.
        console.warn(`process worker: no handle for image ${name}: ${e}`)
      }
    }
  }
}

const wasmModules = new Map<string, WebAssembly.Module>()
function wasmModule(name: string): WebAssembly.Module {
  let m = wasmModules.get(name)
  if (m) return m
  const url = config.wasm[name]
  if (!url) throw new Error(`runtime: no Wasm module configured for '${name}'`)
  // Not compiled yet (cold worker, or the spare was used before the prefetch finished): do it now, blocking.
  const xhr = new host.XMLHttpRequest()
  xhr.open('GET', url, false)
  xhr.responseType = 'arraybuffer'
  xhr.send()
  if (xhr.status !== 200) throw new Error(`runtime: ${url}: HTTP ${xhr.status}`)
  m = new WebAssembly.Module(xhr.response as ArrayBuffer)
  wasmModules.set(name, m)
  return m
}
function prefetchWasm() {
  for (const [name, url] of Object.entries(config.wasm)) {
    if (!url || wasmModules.has(name)) continue
    WebAssembly.compileStreaming(host.fetch(url)).then(
      (m) => {
        if (!wasmModules.has(name)) wasmModules.set(name, m)
      },
      () => {},
    )
  }
}

function finish(code: number): never {
  loop.stop()
  try {
    if (config.trace || rt.process.env?.BAT_TRACE) {
      const report = { pid, marks, loader: loader.stats, resolve: loader.resolver.stats, resolveKernel: loader.resolver.kernelStats(), transform: loader.transformer.stats, loop: loop.stats }
      ctl.writeFd(2, `[bat-trace] ${JSON.stringify(report, (_k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v))}\n`)
    }
  } catch {
    // tracing must not change the exit
  }
  kernel.exit(code)
  // No 'exited' message: kerneld already learns of the exit from the kernel (supervisor event 3) and
  // retires the worker. Sending the message as well makes kerneld retire the same worker twice when the
  // kernel event wins the race, and the second retire frees the thread record a second time five
  // seconds later, which corrupts the kernel heap (seen as the page spinning forever on a lock).
  // Nothing may run after exit. kerneld terminates this worker; until then, sleep.
  const never = new Int32Array(new SharedArrayBuffer(4))
  for (;;) Atomics.wait(never, 0, 0)
}

/** Everything that does not depend on which process this worker becomes. */
function warmUp() {
  if (warm) return
  loop = createLoop(host)
  rt = {
    kernel,
    config,
    loop,
    process: undefined,
    require: (id: string) => builtins.require(id),
    wasmModule,
    host: { ...host, global: g },
    mark: (name: string) => {
      marks.push([name, performance.now() - runAt])
      trace(name, { pid, loader: loader ? { ...loader.stats } : undefined })
    },
    marks,
  }
  builtins = createBuiltins(rt)
  rt.builtins = builtins
  ctl = createProcess(rt, loop, finish)
  rt.process = ctl.process
  loader = createLoader(rt, builtins)
  rt.loader = loader
  rt.ctl = ctl
  installGlobals(rt, loop, ctl)
  host.addEventListener('unhandledrejection', (ev: any) => {
    ev.preventDefault()
    ctl.unhandledRejection(ev.reason, ev.promise)
  })
  host.addEventListener('rejectionhandled', (ev: any) => ctl.rejectionHandled(ev.promise))
  host.addEventListener('error', (ev: any) => {
    ev.preventDefault()
    ctl.uncaught(ev.error ?? new Error(ev.message))
  })
  for (const id of config.prewarm) {
    try {
      builtins.require(id)
    } catch (e) {
      console.warn(`prewarm ${id}: ${e}`)
    }
  }
  prefetchWasm()
  warm = true
}

interface Launch {
  script?: string
  evalSource?: string
  print?: boolean
  inputType?: 'esm' | 'cjs'
  args: string[]
  execArgv: string[]
  preload: { kind: 'require' | 'import'; id: string }[]
  conditions: string[]
  version?: boolean
}

function isNode(exec: string): boolean {
  const base = exec.slice(exec.lastIndexOf('/') + 1)
  return exec === config.execPath || base === 'node' || base === 'nodejs'
}

function parseLaunch(info: ProcInfo): Launch {
  const l: Launch = { args: [], execArgv: [], preload: [], conditions: [] }
  const opts = (list: string[], fromEnv: boolean): number => {
    let i = 0
    for (; i < list.length; i++) {
      const a = list[i]
      if (a === '--') {
        i++
        break
      }
      if (!a.startsWith('-') || a === '-') break
      const eq = a.indexOf('=')
      const name = eq < 0 ? a : a.slice(0, eq)
      const value = () => (eq >= 0 ? a.slice(eq + 1) : list[++i])
      if (!fromEnv) l.execArgv.push(a)
      if (name === '-e' || name === '--eval') l.evalSource = value()
      else if (name === '-p' || name === '--print' || name === '-pe') {
        l.evalSource = value()
        l.print = true
      } else if (name === '-r' || name === '--require') l.preload.push({ kind: 'require', id: value() })
      else if (name === '--import') l.preload.push({ kind: 'import', id: value() })
      else if (name === '--input-type') l.inputType = value() === 'module' ? 'esm' : 'cjs'
      else if (name === '-C' || name === '--conditions') l.conditions.push(value())
      else if (name === '-v' || name === '--version') l.version = true
      else if (['--loader', '--experimental-loader', '--title', '--max-old-space-size', '--stack-trace-limit', '--env-file', '--watch-path', '--inspect-port', '--unhandled-rejections', '--dns-result-order', '--stack-size', '--disable-warning'].includes(name) && eq < 0 && name !== '--max-old-space-size') i++
      // every other flag (--no-warnings, --enable-source-maps, --experimental-*, --inspect, …) is accepted and ignored
    }
    return i
  }
  if (info.env.NODE_OPTIONS) opts(info.env.NODE_OPTIONS.split(/\s+/).filter(Boolean), true)
  if (isNode(info.exec)) {
    const rest = info.argv.slice(1)
    const i = opts(rest, false)
    if (l.evalSource === undefined && i < rest.length) {
      l.script = rest[i]
      l.args = rest.slice(i + 1)
    } else l.args = rest.slice(i)
  } else {
    l.script = info.exec
    l.args = info.argv.slice(1)
  }
  return l
}

/** The process is the shell (crates/bat-sh): no loader, no event loop, just the Wasm program on descriptors 0..2. */
function runShell(info: ProcInfo): never {
  rt.mark('shell')
  const r = createShell(rt).run({ argv: info.argv, env: info.env, cwd: info.cwd || kernel.getcwd(), stdio: [0, 1, 2], asProcess: true })
  kernel.exit(r.signal ? 128 + r.signal : r.status)
  // As in finish(): kerneld learns of the exit from the kernel and terminates this worker.
  const never = new Int32Array(new SharedArrayBuffer(4))
  for (;;) Atomics.wait(never, 0, 0)
}

function run(info: ProcInfo) {
  if (info.exec === SHELL_EXEC) runShell(info)
  // Not inherited: a child is another program.
  const startupPrograms = (info.env.BAT_PROGRAMS ?? '').split(',').filter(Boolean)
  delete info.env.BAT_PROGRAMS
  const launch = parseLaunch(info)
  let script = launch.script
  if (script !== undefined && script !== '-' && !script.startsWith('/')) {
    const cwd = kernel.getcwd()
    script = `${cwd === '/' ? '' : cwd}/${script}`
  }
  ctl.adopt(pid, info, [config.execPath, ...(script !== undefined ? [script] : []), ...launch.args], launch.execArgv)
  if (launch.conditions.length) loader.resolver.setConditions(launch.conditions)
  rt.mark('adopted')
  loop.start(kernel, {
    uncaught: (e) => ctl.uncaught(e),
    beforeExit: () => ctl.beforeExit(),
    drained: () => ctl.drained(),
    signal: (s) => ctl.signal(s),
  })
  // Held until the entry's synchronous part has run, so an early empty turn is not mistaken for the end.
  loop.ref()
  // Program scripts are fetched with import() (as modules), not importScripts(): measured in Chrome 154,
  // only that path gets a V8 code cache (docs/experiments/2026-10-09-node-runtime.md). They are loaded
  // before the entry runs: the one that holds the entry itself, and the start-up module sets the launch
  // names (BAT_PROGRAMS, set by the host from `launch.programs`). Programs met later, during synchronous
  // loading, still use importScripts.
  if (config.programLoad !== 'importScripts' && script !== undefined && script !== '-') {
    const own = loader.programUrl(script)
    const urls = [...(own ? [own] : []), ...loader.programUrls(startupPrograms)]
    if (urls.length || preloading) {
      rt.mark('entry')
      const label = (url: string) => `program ${url.slice(url.lastIndexOf('/') + 1, url.lastIndexOf('-'))}`.replace('program program-', 'program ')
      void Promise.all([
        // What this worker began loading while it was a spare.
        preloading,
        ...urls.map((url) =>
          (importModule(url) as Promise<unknown>).then(
            () => rt.mark(label(url)),
            (e) => {
              // The entry's own program is required; a start-up set is only a faster way to the same modules.
              if (url === own) throw e
              ctl.process.emitWarning?.(`start-up program ${label(url)} failed to load (${(e as Error)?.message}); loading from the image`)
            },
          ),
        ),
      ]).then(
        () => startEntry(launch, script, true),
        (e) => {
          ctl.mainSettled()
          ctl.uncaught(e)
          loop.unref()
        },
      )
      return
    }
  }
  startEntry(launch, script, false)
}

/** Spare: start loading the program scripts the next process of this worker is expected to name. */
let preloading: Promise<unknown> | undefined
function preloadPrograms(names: string[]) {
  if (config.programLoad === 'importScripts') return
  const urls = loader.programUrls(names)
  if (!urls.length) return
  const t0 = performance.now()
  preloading = Promise.all(urls.map((url) => (importModule(url) as Promise<unknown>).catch((e) => console.warn(`program script ${url} failed to load: ${e}`)))).then(() => trace('worker.programs', { names, ms: performance.now() - t0 }))
}

// `import()` must not be seen by the bundler, and a classic worker script may use it.
const importModule = new Function('u', 'return import(u)') as (url: string) => Promise<unknown>

function startEntry(launch: Launch, script: string | undefined, marked: boolean) {
  try {
    if (launch.version) {
      ctl.writeFd(1, `${config.version}\n`)
      ctl.exit(0)
    }
    const cwd = kernel.getcwd()
    const base = `${cwd === '/' ? '' : cwd}/`
    for (const p of launch.preload) {
      if (p.kind === 'require') loader.require(p.id, base)
      else void loader.import(p.id, base)
    }
    let pending: Promise<unknown> | undefined
    if (!marked) rt.mark('entry')
    if (launch.evalSource !== undefined) {
      if (launch.print) {
        // The value of the script is the value of a direct eval inside a CommonJS wrapper (so `require` is in scope).
        pending = loader.runSource(`module.exports = eval(${JSON.stringify(launch.evalSource)})`, '[eval]', 'cjs')
        g.console.log(loader.main().exports)
      } else pending = loader.runSource(launch.evalSource, '[eval]', launch.inputType)
    } else if (script === undefined || script === '-') {
      // No script: the program is read from stdin.
      const chunks: Uint8Array[] = []
      const buf = new Uint8Array(65536)
      for (;;) {
        const n = kernel.read(0, buf)
        if (n <= 0) break
        chunks.push(buf.slice(0, n))
      }
      const text = chunks.map((c) => new TextDecoder().decode(c)).join('')
      pending = text.trim() ? loader.runSource(text, '[stdin]', launch.inputType) : undefined
    } else {
      pending = loader.runMain(script)
    }
    rt.mark('entry-returned')
    if (pending) {
      pending.then(
        () => ctl.mainSettled(),
        (e) => {
          ctl.mainSettled()
          ctl.uncaught(e)
        },
      )
    } else ctl.mainSettled()
  } catch (e) {
    ctl.mainSettled()
    ctl.uncaught(e)
  } finally {
    loop.unref()
  }
  loop.drainTicks()
}

host.addEventListener('message', (async (e: MessageEvent) => {
  const m = e.data
  if (!m || typeof m.type !== 'string') return
  try {
    if (m.type === 'attach') {
      e.stopImmediatePropagation()
      namespace = m.namespace
      for (const name of m.images ?? []) preopenImage(namespace, name)
      inst = await attachKernel({
        module: m.module,
        memory: m.memory,
        canBlock: true,
        host: {
          imageRead(image, offset, dst) {
            const h = handles[image]
            return h ? h.read(dst, { at: offset }) : -11
          },
        },
      })
      kernel = createKernel(inst)
      trace('worker.attached')
      await openImages()
      host.postMessage({ type: 'ready', thread: inst.thread, tid: inst.tid })
      // After `ready`, so a spawn that is already waiting is not held up by more than this one step.
      try {
        warmUp()
      } catch (err) {
        console.error('process worker warm-up failed (will retry at spawn):', err)
      }
      if (warm && m.programs?.length) preloadPrograms(m.programs)
      trace('worker.warm')
    } else if (m.type === 'images') {
      e.stopImmediatePropagation()
      await openImages()
    } else if (m.type === 'run') {
      e.stopImmediatePropagation()
      runAt = performance.now()
      pid = m.pid
      if (kernel.x.bat_proc_attach(pid) < 0) throw new Error(`no such process ${pid}`)
      if (handles.length < kernel.imageNames().length) await openImages()
      marks.push(['warm', warm ? 1 : 0])
      warmUp()
      rt.mark('runtime')
      const info = kernel.procInfo(pid)
      run(info)
    }
  } catch (err) {
    const text = `${(err as Error)?.stack ?? err}\n`
    if (pid) {
      try {
        kernel.write(2, new TextEncoder().encode(text))
      } catch {
        // nowhere to write
      }
      try {
        kernel.exit(1)
      } catch {
        // already gone
      }
    } else host.postMessage({ type: 'error', error: text })
  }
}) as any)
