// The page side of the runtime: `bootRuntime(options) → RuntimeHost`, the one
// module the toolkit imports (`packages/toolkit/src/runtime-host.ts` is the
// contract; the types are restated here so the runtime builds on its own).
//
// Every asset is fetched relative to this module's URL, so the directory the
// build emits (`host.js`, worker scripts, Wasm, `sw.js`) can be served from
// anywhere, normally `<base>runtime/` beside the manifest.
import { bootKernel, type BootedKernel } from '../kernel/boot'
import { K_DIR, K_FILE, type Kernel } from '../kernel/kernel'
import { createOutbox } from '../net/client'
import { EAGAIN, getCodec } from '../net/codec'
import { processWorkerUrl } from '../process/config'
import { DEFAULT_CONFIG } from '../process/runtime'
import type { ToServiceWorker } from './bridge-protocol'
import { createEndpoints } from './endpoint'
import type { StoreImageResult } from './image'
import { createReactor } from './reactor'

export interface Launch {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  programs?: string[]
}
export interface BootProgress {
  phase: 'image' | 'kernel' | 'mount' | 'service-worker' | 'ready'
  /** Image download only: decoded bytes so far and the image size. */
  loaded?: number
  total?: number
  /** True when the image was already in this browser. */
  cached?: boolean
}
export interface BootOptions {
  manifestUrl: string
  manifest: unknown
  signal?: AbortSignal
  /** Not part of the toolkit contract: boot phases and image download progress. */
  onProgress?(progress: BootProgress): void
  /** Not part of the toolkit contract: overrides for harnesses. */
  namespace?: string
  persist?: boolean
  serviceWorker?: boolean
  trace?: boolean
}
export interface FileStat {
  isFile: boolean
  isDirectory: boolean
  size: number
  mtimeMs: number
}
export interface RuntimeFs {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  stat(path: string): Promise<FileStat>
  readdir(path: string): Promise<string[]>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  watch(path: string, listener: (event: { paths: string[] }) => void): () => void
}
export interface RuntimeProcess {
  readonly pid: number
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<{ code: number | null; signal: string | null }>
  write(data: Uint8Array | string): void
  closeStdin(): void
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void
}
export interface RuntimeEndpoint {
  readonly url: string
  fetch(path: string, init?: RequestInit): Promise<Response>
  ready(signal?: AbortSignal): Promise<void>
}
export interface RuntimeHost {
  readonly fs: RuntimeFs
  readonly hostOrigin: string
  spawn(launch: Launch): Promise<RuntimeProcess>
  endpoint(port: number): RuntimeEndpoint
  setHostPaths(port: number, prefixes: readonly string[]): void
  flush(): Promise<void>
  close(): Promise<void>
  /** Not part of the toolkit contract: boot timings (ms) and the kernel, for harnesses. */
  readonly timings: Record<string, number | boolean>
  readonly kernel: Kernel
}

interface Manifest {
  image?: { file: string; bytes?: number; sha256?: string; mount?: string }
  programs?: { name: string; file: string }[]
}

/** How a guest names the page's own server (see net/fetch.ts). */
export const HOST_ALIAS = 'host.internal'
const OUTPUT_KEEP = 1 << 20
const encoder = new TextEncoder()

function busy(cause?: unknown): Error {
  return Object.assign(new Error('This workspace is already open in another tab.', { cause }), { code: 'STORAGE_BUSY' })
}

/** RPC to a worker that answers `{ id, ok, value | error }` and may send `{ id, progress }` first. */
function rpc(worker: Worker) {
  let next = 1
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; progress?: (p: any) => void }>()
  worker.onmessage = (e) => {
    const m = e.data
    const p = pending.get(m.id)
    if (!p) return
    if (m.progress) return void p.progress?.(m.progress)
    pending.delete(m.id)
    if (m.ok) p.resolve(m.value)
    else p.reject(Object.assign(new Error(m.error), { code: m.code, name: m.name ?? 'Error' }))
  }
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`runtime worker crashed: ${e.message}`))
    pending.clear()
  }
  return {
    call<T>(op: string, args?: unknown, transfer: Transferable[] = [], progress?: (p: any) => void): Promise<T> & { id: number } {
      const id = next++
      const promise = new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject, progress })) as Promise<T> & { id: number }
      promise.id = id
      worker.postMessage({ id, op, args }, transfer)
      return promise
    },
  }
}

export async function bootRuntime(options: BootOptions): Promise<RuntimeHost> {
  const t0 = performance.now()
  const manifest = options.manifest as Manifest
  if (!manifest?.image?.file) throw new Error('The prepared manifest has no runtime image')
  options.signal?.throwIfAborted()
  const asset = (name: string) => new URL(name, import.meta.url).href
  const prepared = (name: string) => new URL(name, options.manifestUrl).href
  const progress = (p: BootProgress) => {
    try {
      options.onProgress?.(p)
    } catch {
      // observer failure
    }
  }
  // One workspace per mount point of the editor on this origin.
  const namespace = options.namespace ?? (new URL(options.manifestUrl).pathname.replace(/\/[^/]*$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'default')
  const image = manifest.image
  const timings: Record<string, number | boolean> = {}

  // The bridge worker starts first: it downloads the image while the kernel boots.
  const netdWorker = new Worker(asset('bat-netd.js'), { type: 'module', name: 'bat-netd' })
  const netd = rpc(netdWorker)
  progress({ phase: 'image' })
  const download = netd.call<StoreImageResult>(
    'storeImage',
    { namespace, name: image.file, url: prepared(image.file), bytes: image.bytes, sha256: image.sha256, nativeWasmUrl: asset('bat_node_native.wasm') },
    [],
    (p) => progress({ phase: 'image', loaded: p.loaded, total: p.total, cached: false }),
  )
  download.catch(() => {})

  const programs: Record<string, string> = {}
  for (const p of manifest.programs ?? []) programs[p.name] = prepared(p.file)
  let booted: BootedKernel
  try {
    booted = await bootKernel({
      wasmUrl: asset('kernel.wasm'),
      kerneldUrl: asset('bat-kerneld.js'),
      processWorkerUrl: processWorkerUrl(asset('bat-process.js'), {
        nodelibUrl: 'bat-nodelib.js',
        wasm: { modules: 'bat_modules.wasm', native: 'bat_node_native.wasm', sqlite: 'sqlite3.wasm' },
        programs,
        // The routed global `fetch` exists in every process before guest code runs.
        prewarm: [...DEFAULT_CONFIG.prewarm, 'bat:net-globals'],
        trace: options.trace,
      }),
      processWorkerType: 'classic',
      namespace,
      persist: options.persist ?? true,
      noPersist: ['/.bat', '/tmp'],
      warmSpare: true,
    } as Parameters<typeof bootKernel>[0])
  } catch (e) {
    void netd.call('cancel', { id: download.id })
    netdWorker.terminate()
    if ((e as any)?.code === 'EBUSY') throw busy(e)
    throw new Error(`kernel boot failed: ${(e as Error).message}`, { cause: e })
  }
  timings.kernel = performance.now() - t0
  progress({ phase: 'kernel' })

  const lifetime = new AbortController()
  let closing: Promise<void> | undefined
  const teardown = () => {
    lifetime.abort(new Error('The runtime is closed'))
    booted.close()
    netdWorker.terminate()
  }
  let kernel: Kernel
  try {
    const stored = await Promise.race([
      download,
      new Promise<never>((_, reject) => options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true })),
    ])
    timings.image = performance.now() - t0
    timings.imageCached = stored.cached
    progress({ phase: 'image', loaded: stored.bytes, total: stored.bytes, cached: stored.cached })
    const mounted = await booted.mountImage(image.file, image.mount ?? '/').catch((e) => {
      throw new Error(`mounting ${image.file} failed: ${e.message}`, { cause: e })
    })
    timings.mount = mounted.ms
    kernel = booted.kernel
    for (const dir of ['/tmp', '/workspace', '/bin', '/usr/local/bin', '/home/user', '/.bat']) kernel.mkdir(dir, { recursive: true })
    progress({ phase: 'mount' })
    await netd.call('attach', { module: booted.module, memory: booted.memory })
    // Images of other hashes are dead weight once this one is mounted.
    void netd.call('collectImages', { namespace, keep: image.file }).catch(() => {})
  } catch (e) {
    void netd.call('cancel', { id: download.id })
    teardown()
    throw e
  }
  timings.mounted = performance.now() - t0

  const reactor = createReactor(kernel)
  const codec = getCodec(kernel)
  const { endpoint } = createEndpoints({ kernel, io: reactor }, location.origin, lifetime.signal)
  const live = (): void => {
    if (lifetime.signal.aborted) throw new Error('The runtime is closed')
  }

  // ---- service worker ----
  const hostPaths: Record<number, string[]> = {}
  let serviceWorker: ServiceWorker | undefined
  const toWorker = (m: ToServiceWorker, transfer: Transferable[] = []) => serviceWorker?.postMessage(m, transfer)
  const sendPort = (target: ServiceWorker) => {
    const channel = new MessageChannel()
    void netd.call('port', { port: channel.port1 }, [channel.port1])
    target.postMessage({ t: 'bat-port', port: channel.port2, hostPaths } satisfies ToServiceWorker, [channel.port2])
  }
  const onWorkerMessage = (e: MessageEvent) => {
    // The worker was restarted by the browser and lost its port.
    if (e.data?.t === 'bat-need-port' && !lifetime.signal.aborted && e.source) sendPort(e.source as ServiceWorker)
  }
  if (options.serviceWorker !== false && 'serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register(asset('sw.js'), { scope: '/preview/', updateViaCache: 'none' })
      const activated = (worker: ServiceWorker) =>
        new Promise<ServiceWorker>((resolve, reject) => {
          if (worker.state === 'activated') return resolve(worker)
          worker.addEventListener('statechange', () => {
            if (worker.state === 'activated') resolve(worker)
            else if (worker.state === 'redundant') reject(new Error('The preview service worker failed to install'))
          })
        })
      // The frame must not navigate before a worker controls the scope: wait for activation here.
      serviceWorker = await activated(registration.installing ?? registration.waiting ?? registration.active!)
      navigator.serviceWorker.addEventListener('message', onWorkerMessage)
      navigator.serviceWorker.startMessages()
      sendPort(serviceWorker)
      registration.addEventListener('updatefound', () => {
        const next = registration.installing
        if (next) {
          void activated(next).then((worker) => {
            if (lifetime.signal.aborted) return
            serviceWorker = worker
            sendPort(worker)
          }, () => {})
        }
      })
    } catch (e) {
      teardown()
      throw new Error(`The preview service worker could not be registered: ${(e as Error).message}`, { cause: e })
    }
    timings.serviceWorker = performance.now() - t0
    progress({ phase: 'service-worker' })
  }

  // ---- filesystem facade ----
  // The page cannot block: an image body that is not cached yet is faulted in by kerneld and the call retried.
  const io = <T,>(fn: () => T): Promise<T> => {
    try {
      live()
    } catch (e) {
      return Promise.reject(e)
    }
    return kernel.retrying(fn)
  }
  const removeTree = (path: string): void => {
    const st = kernel.tryStat(path, true)
    if (!st) return
    if (st.kind === K_DIR) {
      for (const entry of kernel.readdir(path)) removeTree(`${path === '/' ? '' : path}/${entry.name}`)
      kernel.rmdir(path)
    } else kernel.unlink(path)
  }
  const fs: RuntimeFs = {
    readFile: (path) => io(() => kernel.readFile(path)),
    writeFile: (path, data) => io(() => kernel.writeFile(path, data)),
    stat: (path) =>
      io(() => {
        const st = kernel.stat(path)
        return { isFile: st.kind === K_FILE, isDirectory: st.kind === K_DIR, size: st.size, mtimeMs: st.mtimeMs }
      }),
    readdir: (path) => io(() => kernel.readdir(path).map((e) => e.name)),
    mkdir: (path) => io(() => kernel.mkdir(path, { recursive: true })),
    remove: (path) => io(() => removeTree(path)),
    rename: (from, to) => io(() => kernel.rename(from, to)),
    watch(path, listener) {
      live()
      const root = kernel.realpath(path)
      const id = kernel.watchAdd(root, true)
      let batch = new Set<string>()
      let timer: ReturnType<typeof setTimeout> | undefined
      reactor.onWatch(id, (_kind, rel) => {
        batch.add(rel ? `${root === '/' ? '' : root}/${rel}` : root)
        timer ??= setTimeout(() => {
          timer = undefined
          const paths = [...batch]
          batch = new Set()
          try {
            listener({ paths })
          } catch (e) {
            console.error(e)
          }
        }, 20)
      })
      let active = true
      const stop = () => {
        if (!active) return
        active = false
        if (timer) clearTimeout(timer)
        reactor.offWatch(id)
        kernel.watchRemove(id)
      }
      lifetime.signal.addEventListener('abort', stop, { once: true })
      return stop
    },
  }

  // ---- processes ----
  const processes = new Map<number, RuntimeProcess>()
  /** A pipe's read end as a stream. Reads eagerly so the child never blocks on a slow consumer; keeps the newest bytes. */
  function output(fd: number): ReadableStream<Uint8Array> {
    kernel.setNonblock(fd, true)
    let queue: Uint8Array[] = []
    let queued = 0
    let ended = false
    let wake: (() => void) | undefined
    const end = () => {
      if (ended) return
      ended = true
      reactor.off(fd)
      try {
        kernel.close(fd)
      } catch {
        // already closed
      }
      wake?.()
    }
    const pump = () => {
      while (!ended) {
        const r = codec.read(fd)
        if (typeof r === 'number') {
          if (r !== -EAGAIN) end()
          break
        }
        queue.push(r)
        queued += r.length
        while (queued > OUTPUT_KEEP && queue.length > 1) queued -= queue.shift()!.length
      }
      wake?.()
    }
    reactor.on(fd, 1 | 16, pump)
    lifetime.signal.addEventListener('abort', end, { once: true })
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (queue.length === 0 && !ended) await new Promise<void>((resolve) => (wake = resolve))
        wake = undefined
        if (queue.length) {
          const chunks = queue
          queue = []
          queued = 0
          for (const c of chunks) controller.enqueue(c)
        } else controller.close()
      },
      cancel: end,
    })
  }

  async function spawn(launch: Launch): Promise<RuntimeProcess> {
    live()
    if (!launch.argv?.length) throw new Error('spawn: empty argv')
    const child = kernel.spawn({ exec: launch.argv[0], argv: launch.argv, env: launch.env ?? {}, cwd: launch.cwd ?? '/', stdio: ['pipe', 'pipe', 'pipe'] })
    const [stdinFd, stdoutFd, stderrFd] = child.stdio
    kernel.setNonblock(stdinFd, true)
    let stdinOpen = true
    let wantOut = false
    const closeIn = () => {
      if (!stdinOpen) return
      stdinOpen = false
      reactor.off(stdinFd)
      try {
        kernel.close(stdinFd)
      } catch {
        // already closed
      }
    }
    const stdin = createOutbox(codec, stdinFd, (on) => {
      wantOut = on
      if (stdinOpen) {
        if (on) reactor.on(stdinFd, 4 | 8, () => stdin.flush())
        else reactor.off(stdinFd)
      }
    })
    void wantOut
    let gone = false
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      reactor.onChild(child.pid, (status) => {
        gone = true
        processes.delete(child.pid)
        closeIn()
        try {
          kernel.waitpid(child.pid, true)
        } catch {
          // already reaped
        }
        if (status === 128 + 9) resolve({ code: null, signal: 'SIGKILL' })
        else if (status === 128 + 15) resolve({ code: null, signal: 'SIGTERM' })
        else if (status === 128 + 2) resolve({ code: null, signal: 'SIGINT' })
        else resolve({ code: status, signal: null })
      })
    })
    const proc: RuntimeProcess = {
      pid: child.pid,
      stdout: output(stdoutFd),
      stderr: output(stderrFd),
      exited,
      write(data) {
        if (stdinOpen && !gone) stdin.write(typeof data === 'string' ? encoder.encode(data) : data)
      },
      closeStdin() {
        if (stdinOpen) stdin.write('', false, closeIn)
      },
      kill(signal = 'SIGTERM') {
        if (gone) return
        try {
          kernel.kill(child.pid, signal === 'SIGKILL' ? 9 : 15)
        } catch {
          // already gone
        }
      },
    }
    processes.set(child.pid, proc)
    return proc
  }

  const host: RuntimeHost = {
    fs,
    hostOrigin: `${location.protocol}//${HOST_ALIAS}${location.port ? `:${location.port}` : ''}`,
    spawn,
    endpoint,
    setHostPaths(port, prefixes) {
      hostPaths[port] = [...prefixes]
      toWorker({ t: 'bat-host-paths', hostPaths })
    },
    flush: () => {
      try {
        live()
      } catch (e) {
        return Promise.reject(e)
      }
      return kernel.flush()
    },
    close() {
      return (closing ??= (async () => {
        const running = [...processes.values()]
        for (const p of running) p.kill('SIGKILL')
        await Promise.race([Promise.all(running.map((p) => p.exited)), new Promise((r) => setTimeout(r, 2000))])
        await kernel.flush().catch(() => {})
        toWorker({ t: 'bat-closed' })
        navigator.serviceWorker?.removeEventListener('message', onWorkerMessage)
        reactor.stop()
        teardown()
      })())
    },
    timings,
    kernel,
  }
  options.signal?.addEventListener('abort', () => void host.close(), { once: true })
  if (options.signal?.aborted) {
    await host.close()
    throw options.signal.reason
  }
  // Leaving the page releases the workspace for the next tab at once.
  addEventListener('pagehide', () => toWorker({ t: 'bat-closed' }))
  timings.total = performance.now() - t0
  progress({ phase: 'ready' })
  return host
}
