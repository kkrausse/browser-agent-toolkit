// Harness page: boots the kernel, mounts the prepared TODO image, installs the
// project source, and runs guest programs as kernel processes. Driven from
// the command line (runtime/harness/cli.ts) through `window.batHarness`.
import { bootKernel, type BootedKernel } from '../src/kernel/boot'
import { POLLHUP, POLLIN, TOKEN_CHILD, type Kernel } from '../src/kernel/kernel'
import { processWorkerUrl } from '../src/process/config'

export interface RunOptions {
  /** argv after `node`. */
  args: string[]
  /** Run this guest file directly instead of `node` (exec = the path). */
  exec?: string
  cwd?: string
  env?: Record<string, string>
  /** Files to write into the overlay first: guest path -> text. */
  files?: Record<string, string>
  stdin?: string
  timeoutMs?: number
  trace?: boolean
}
export interface RunResult {
  pid: number
  code: number | null
  stdout: string
  stderr: string
  /** ms from the spawn call to the child's exit, measured on the page. */
  ms: number
  /** Epoch ms (performance.timeOrigin + now) just before the spawn call. */
  spawnedAt: number
  timedOut: boolean
  trace?: unknown
}

const out = document.getElementById('out')!
const params = new URLSearchParams(location.search)
const log = (text: string, cls = '') => {
  const line = document.createElement('div')
  line.className = cls
  line.textContent = text
  out.append(line)
}
const enc = new TextEncoder()

let boot: BootedKernel
let k: Kernel
let manifest: any
const exits = new Map<number, (status: number) => void>()
const readers = new Map<number, () => void>()

async function start() {
  out.textContent = ''
  const t0 = performance.now()
  const prepared = params.get('prepared') ?? '/prepared/'
  manifest = await (await fetch(`${prepared}manifest.json`)).json()
  // `v` distinguishes cache experiments: the same bytes under a different URL have no HTTP or code cache yet.
  const v = params.get('v')
  const asset = (name: string) => (v ? `/runtime/v/${v}/${name}` : `/runtime/${name}`)
  const programs: Record<string, string> = {}
  for (const p of manifest.programs ?? []) programs[p.name] = new URL(`${params.get('programs') ?? prepared}${p.file}`, location.href).href
  boot = await bootKernel({
    wasmUrl: '/kernel.wasm',
    kerneldUrl: asset('bat-kerneld.js'),
    processWorkerUrl: processWorkerUrl(new URL(asset('bat-process.js'), location.href).href, {
      nodelibUrl: 'bat-nodelib.js',
      wasm: { modules: 'bat_modules.wasm', native: 'bat_node_native.wasm' },
      programs,
      trace: params.has('trace'),
    }),
    processWorkerType: 'classic',
    namespace: params.get('ns') ?? 'bat-node',
    persist: false,
    noPersist: ['/.bat'],
    warmSpare: params.get('spare') !== '0',
  } as any)
  k = boot.kernel
  const t1 = performance.now()
  const stored = await boot.storeImage(manifest.image.file, `${prepared}${manifest.image.file}`)
  const t2 = performance.now()
  const mounted = await boot.mountImage(manifest.image.file, manifest.image.mount ?? '/')
  const t3 = performance.now()
  for (const dir of ['/tmp', '/workspace', '/bin', '/usr/local/bin', '/home/user', '/.bat']) k.mkdir(dir, { recursive: true })
  for (const [path, content] of Object.entries<any>(manifest.project ?? {})) {
    const target = `${manifest.workspace}${path}`
    k.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
    k.writeFile(target, typeof content === 'string' ? content : Uint8Array.from(atob(content.data), (c) => c.charCodeAt(0)))
  }
  k.runEvents((token, mask) => {
    if (token >= TOKEN_CHILD) {
      const pid = token - TOKEN_CHILD
      exits.get(pid)?.(mask)
      exits.delete(pid)
    } else readers.get(token)?.()
  })
  await boot.kerneld('spareReady')
  const t4 = performance.now()
  const timings = { bootMs: t1 - t0, storeImageMs: t2 - t1, imageCached: stored.cached, mountMs: t3 - t2, sourceAndSpareMs: t4 - t3, kernel: boot.timings, mount: mounted }
  log(`ready: ${JSON.stringify(timings)}`)
  return timings
}

function collect(fd: number) {
  const dec = new TextDecoder()
  let text = ''
  let done = false
  let wake: (() => void) | undefined
  const buf = new Uint8Array(65536)
  k.setNonblock(fd, true)
  const pump = () => {
    for (;;) {
      const n = k.readRaw(fd, buf)
      if (n > 0) text += dec.decode(buf.subarray(0, n), { stream: true })
      else {
        if (n === 0 || n !== -11) {
          done = true
          readers.delete(fd)
          try {
            k.close(fd)
          } catch {
            // closed
          }
          wake?.()
        }
        return
      }
    }
  }
  readers.set(fd, pump)
  k.subscribe(fd, POLLIN | POLLHUP)
  pump()
  return { text: () => text, finished: () => (done ? Promise.resolve() : new Promise<void>((r) => (wake = r))) }
}

async function run(o: RunOptions): Promise<RunResult> {
  for (const [path, text] of Object.entries(o.files ?? {})) {
    k.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true })
    k.writeFile(path, text)
  }
  const env = { PATH: '/workspace/node_modules/.bin:/usr/local/bin:/usr/bin:/bin', HOME: '/home/user', TMPDIR: '/tmp', ...(o.trace ? { BAT_TRACE: '1' } : {}), ...o.env }
  const spawnedAt = performance.timeOrigin + performance.now()
  const t0 = performance.now()
  const p = k.spawn({ exec: o.exec ?? 'node', argv: o.exec ? [o.exec, ...o.args] : ['node', ...o.args], env, cwd: o.cwd ?? '/workspace', stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout = collect(p.stdio[1])
  const stderr = collect(p.stdio[2])
  if (o.stdin) k.write(p.stdio[0], enc.encode(o.stdin))
  k.close(p.stdio[0])
  let timedOut = false
  const status = await new Promise<number | null>((resolve) => {
    exits.set(p.pid, resolve)
    if (o.timeoutMs) {
      setTimeout(() => {
        if (exits.has(p.pid)) {
          timedOut = true
          try {
            k.kill(p.pid, 9)
          } catch {
            // gone
          }
        }
      }, o.timeoutMs)
    }
  })
  const ms = performance.now() - t0
  await Promise.race([Promise.all([stdout.finished(), stderr.finished()]), new Promise((r) => setTimeout(r, 1000))])
  try {
    k.waitpid(p.pid, true)
  } catch {
    // reaped
  }
  let err = stderr.text()
  let trace: unknown
  const m = /\[bat-trace\] (.*)\n/.exec(err)
  if (m) {
    try {
      trace = JSON.parse(m[1])
    } catch {
      // keep it in stderr
    }
    if (trace) err = err.replace(m[0], '')
  }
  log(`pid ${p.pid} exit ${status} in ${ms.toFixed(1)} ms: node ${o.args.join(' ').slice(0, 120)}`, status === 0 ? '' : 'err')
  return { pid: p.pid, code: status, stdout: stdout.text(), stderr: err, ms, spawnedAt, timedOut, trace }
}

if (params.get('debug') === 'beat') {
  let n = 0
  setInterval(() => void fetch(`/beat?n=${n++}&procs=${encodeURIComponent(JSON.stringify(k?.procList?.() ?? []))}`).catch(() => {}), 250)
}
const ready = start()
ready.catch((e) => log(String(e?.stack ?? e), 'err'))
;(window as any).batHarness = {
  ready,
  run,
  get kernel() {
    return k
  },
  get boot() {
    return boot
  },
  get manifest() {
    return manifest
  },
  /** Wait for the warm spare (so a measurement does not include creating a worker). */
  spare: () => boot.kerneld('spareReady'),
  stats: () => boot.kerneld('stats'),
}
