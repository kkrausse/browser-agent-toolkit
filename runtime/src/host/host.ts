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
import type { StoreImageProgress, StoreImageResult } from './image'
import { createReactor } from './reactor'
import { trace, traceCollect } from '../trace'

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
  /** The caller's programs are up: work that was held back for them (the rest of an image download) may go on. */
  started(): void
  flush(): Promise<void>
  close(): Promise<void>
  /** Not part of the toolkit contract: boot timings (ms) and the kernel, for harnesses. */
  readonly timings: Record<string, number | boolean>
  readonly kernel: Kernel
}

interface ManifestImage {
  file: string
  bytes?: number
  sha256?: string
  mount?: string
  headBytes?: number
  firstBytes?: number
  sums?: { file: string; blockBytes: number; sha256: string }
}
interface Manifest {
  image?: ManifestImage
  /** Images mounted after `image`, in order (packages that are not from the lockfile). */
  layers?: ManifestImage[]
  programs?: { name: string; file: string }[]
  /** The prepared launch descriptions (the toolkit starts them): only their program scripts matter here. */
  launch?: Record<string, { programs?: string[] } | undefined>
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

/** One workspace per mount point of the editor on this origin. */
const namespaceOf = (manifestUrl: string) => new URL(manifestUrl).pathname.replace(/\/[^/]*$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'default'

/**
 * Delete everything this browser stores for the workspace (source edits, agent sessions,
 * caches). The dependency image stays, so the next open is a reopen, not a download.
 * Rejects with `code: 'STORAGE_BUSY'` while the workspace is open in any tab.
 */
export async function resetWorkspace(options: { manifestUrl: string; namespace?: string }): Promise<void> {
  const namespace = options.namespace ?? namespaceOf(options.manifestUrl)
  const attempt = () =>
    navigator.locks.request(`bat-kernel:${namespace}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return false
      let dir = await navigator.storage.getDirectory()
      try {
        for (const part of ['bat', namespace]) dir = await dir.getDirectoryHandle(part)
        await dir.removeEntry('overlay', { recursive: true })
      } catch (e) {
        if ((e as DOMException)?.name !== 'NotFoundError') throw e
      }
      return true
    })
  // An editor that was just closed releases its lock a moment later (its supervisor is terminating).
  let done = await attempt()
  for (let i = 0; !done && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100))
    done = await attempt()
  }
  if (!done) throw busy()
}

let kernelModule: { url: string; module: Promise<WebAssembly.Module> } | undefined
const compileKernel = (url: string) => {
  if (kernelModule?.url !== url) {
    const module = WebAssembly.compileStreaming(fetch(url))
    kernelModule = { url, module }
    // A failed fetch is retried by the next caller.
    module.catch(() => {
      if (kernelModule?.module === module) kernelModule = undefined
    })
  }
  return kernelModule.module
}

/**
 * What can be done before the user asks for the editor, without taking the workspace: this
 * module is loaded (the caller imported it) and the kernel is compiled. Call it when the
 * control that opens the editor is shown. Nothing is locked, written or spawned.
 */
export function preloadRuntime(): void {
  void compileKernel(new URL('kernel.wasm', import.meta.url).href).catch(() => {})
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
  const namespace = options.namespace ?? namespaceOf(options.manifestUrl)
  const image = manifest.image
  const timings: Record<string, number | boolean> = {}
  let tracing = options.trace
  try {
    tracing ??= localStorage.getItem('bat-trace') === '1'
  } catch {
    // storage unavailable
  }
  if (tracing) {
    traceCollect('page')
    trace('boot.start', undefined, t0)
  }
  // Always on (microseconds): user-timing marks of the boot phases, the sub-timings as `detail`.
  const timed = (name: string) => {
    try {
      performance.mark(`bat:boot.${name}`, { detail: { ...timings } })
    } catch {
      // no user timing
    }
  }

  // The bridge worker starts first: it downloads the image while the kernel boots.
  const netdWorker = new Worker(asset('bat-netd.js'), { type: 'module', name: 'bat-netd' })
  const netd = rpc(netdWorker)
  progress({ phase: 'image' })
  // Every image is fetched at once. One is usable as soon as its head is in its file
  // (at once when it is stored already); the rest of it may still be arriving then.
  const images = [image, ...(manifest.layers ?? [])]
  const kernelReady: { kernel?: Kernel } = {}
  const stores = images.map((img, index) => {
    let usable!: (u: NonNullable<StoreImageProgress['usable']>) => void
    const ready = new Promise<NonNullable<StoreImageProgress['usable']>>((resolve) => (usable = resolve))
    const state = { id: -1 }
    const done = netd.call<StoreImageResult>(
      'storeImage',
      {
        namespace,
        name: img.file,
        url: prepared(img.file),
        bytes: img.bytes,
        sha256: img.sha256,
        headBytes: img.headBytes,
        firstBytes: img.firstBytes,
        sums: img.sums && { url: prepared(img.sums.file), blockBytes: img.sums.blockBytes, sha256: img.sums.sha256 },
        nativeWasmUrl: asset('bat_node_native.wasm'),
      },
      [],
      (p: StoreImageProgress) => {
        if (p.usable) usable(p.usable)
        if (p.loaded === undefined) return
        // Readers waiting for a range of an arriving image look again.
        if (state.id >= 0) kernelReady.kernel?.x.bat_image_progress(state.id)
        if (index === 0) progress({ phase: 'image', loaded: p.loaded, total: p.total, cached: false })
      },
    )
    done.catch(() => {})
    return { img, ready: Promise.race([ready, done.then((r) => ({ file: r.file, arriving: false }))]), done, state }
  })
  // An image with a start-up order pauses after it; `started()` or this timer lets it go on.
  const resumeImages = () => void netd.call('resumeImages').catch(() => {})
  setTimeout(resumeImages, 20_000)
  const cancelDownloads = () => {
    for (const s of stores) void netd.call('cancel', { id: s.done.id })
  }

  const programs: Record<string, string> = {}
  for (const p of manifest.programs ?? []) programs[p.name] = prepared(p.file)
  const spareHints = Object.values(manifest.launch ?? {}).map((launch) => (launch?.programs ?? []).filter((name) => programs[name]))
  let booted: BootedKernel
  try {
    booted = await bootKernel({
      wasmUrl: asset('kernel.wasm'),
      module: compileKernel(asset('kernel.wasm')),
      kerneldUrl: asset('bat-kerneld.js'),
      processWorkerUrl: processWorkerUrl(asset('bat-process.js'), {
        nodelibUrl: 'bat-nodelib.js',
        wasm: { modules: 'bat_modules.wasm', native: 'bat_node_native.wasm', sqlite: 'sqlite3.wasm', sh: 'bat_sh.wasm' },
        programs,
        // The routed global `fetch` exists in every process before guest code runs.
        prewarm: [...DEFAULT_CONFIG.prewarm, 'bat:net-globals'],
        trace: tracing,
      }),
      processWorkerType: 'classic',
      namespace,
      persist: options.persist ?? true,
      noPersist: ['/.bat', '/tmp'],
      warmSpare: true,
      // The prepared launches start together: one warm worker each, already loading that
      // launch's program scripts while the kernel finishes booting.
      spares: Math.max(2, spareHints.length),
      spareHints,
      images: images.map((i) => i.file),
      trace: tracing,
    } as Parameters<typeof bootKernel>[0])
  } catch (e) {
    cancelDownloads()
    netdWorker.terminate()
    if ((e as any)?.code === 'EBUSY') throw busy(e)
    throw new Error(`kernel boot failed: ${(e as Error).message}`, { cause: e })
  }
  timings.kernel = performance.now() - t0
  Object.assign(timings, { kernelCompile: booted.timings.compileMs, kernelAttach: booted.timings.attachMs, kerneldInit: booted.timings.kerneldMs, restore: booted.restored?.ms ?? 0, journalBytes: booted.restored?.journalBytes ?? 0, snapshotBytes: booted.restored?.snapshotBytes ?? 0 })
  trace('boot.kernel')
  timed('kernel')
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
    const aborted = new Promise<never>((_, reject) => options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true }))
    let imageTrace = false
    try {
      imageTrace = localStorage.getItem('bat-image-trace') === '1'
    } catch {
      // storage unavailable
    }
    // For a start-up order (`bat-prepare order`): every image read from the first one on.
    if (imageTrace) booted.kernel.x.bat_image_trace(1)
    timings.mount = 0
    for (const [index, store] of stores.entries()) {
      const usable = await Promise.race([store.ready, aborted])
      if (index === 0) {
        // `image`: when the image could be mounted. `imageComplete` follows when a download finishes.
        timings.image = performance.now() - t0
        timings.imageCached = !usable.arriving && (await Promise.race([store.done, aborted])).cached
        timings.imageArriving = usable.arriving
        trace('boot.image')
        timed('image')
        if (!usable.arriving) progress({ phase: 'image', loaded: image.bytes, total: image.bytes, cached: timings.imageCached as boolean })
      }
      const mounted = await booted.mountImage(usable.file, store.img.mount ?? '/', usable.arriving).catch((e) => {
        throw new Error(`mounting ${store.img.file} failed: ${e.message}`, { cause: e })
      })
      timings.mount += mounted.ms
      store.state.id = mounted.id
      if (usable.arriving) {
        const settle = (state: 0 | 2) => {
          if (!lifetime.signal.aborted) booted.kernel.x.bat_image_arriving(mounted.id, state)
        }
        store.done.then(
          () => {
            settle(0)
            if (index === 0) {
              timings.imageComplete = performance.now() - t0
              timings.imageArriving = false
              timed('image-complete')
              progress({ phase: 'image', loaded: image.bytes, total: image.bytes, cached: false })
            }
          },
          (e) => {
            // Reads of what never arrived fail from here on; the guests die of them.
            settle(2)
            if (!lifetime.signal.aborted) console.error(`The download of ${store.img.file} failed while it was in use:`, e)
          },
        )
      }
    }
    kernel = booted.kernel
    kernelReady.kernel = kernel
    if (imageTrace) {
      ;(globalThis as any).__batImageTrace = (id = 0) => {
        const cap = 1 << 17
        const ptr = kernel.x.bat_alloc(cap * 8) >>> 0
        const out: number[][] = []
        for (;;) {
          const n: number = kernel.x.bat_image_trace_read(id, out.length, ptr, cap)
          const view = new Float64Array(booted.memory.buffer, ptr, n * 2)
          for (let i = 0; i < n; i++) out.push([view[i * 2], view[i * 2 + 1]])
          if (n < cap / 2) break
        }
        kernel.x.bat_free(ptr, cap * 8)
        return out
      }
    }
    for (const dir of ['/tmp', '/workspace', '/bin', '/usr/bin', '/usr/local/bin', '/home/user', '/.bat']) kernel.mkdir(dir, { recursive: true })
    // The shell is built into the runtime (process/sh.ts); these make its conventional paths exist.
    for (const path of ['/bin/sh', '/bin/bash', '/usr/bin/env']) if (kernel.kindOf(path) < 0) kernel.writeFile(path, '#!/bin/sh\n# built into the runtime\n', { mode: 0o755 })
    progress({ phase: 'mount' })
    await netd.call('attach', { module: booted.module, memory: booted.memory })
    // Images of other hashes are dead weight once these are mounted (and complete: a
    // collection must not meet a download's files half made).
    void Promise.all(stores.map((s) => s.done))
      .then(() => netd.call<string[]>('collectImages', { namespace, keep: images.map((i) => i.file) }))
      .then((removed) => {
        if (removed.length) trace('boot.images-collected', { removed })
      })
      .catch(() => {})
  } catch (e) {
    cancelDownloads()
    teardown()
    throw e
  }
  // Tracing: the page's kernel binding, for inspecting the workspace from a measuring script.
  if (tracing) (globalThis as any).__batKernel = kernel
  timings.mounted = performance.now() - t0
  trace('boot.mounted')
  timed('mounted')

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
    trace('boot.service-worker')
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
    // Start-up program scripts the process loads before its entry (process/worker.ts).
    const env = launch.programs?.length ? { ...launch.env, BAT_PROGRAMS: launch.programs.join(',') } : (launch.env ?? {})
    const child = kernel.spawn({ exec: launch.argv[0], argv: launch.argv, env, cwd: launch.cwd ?? '/', stdio: ['pipe', 'pipe', 'pipe'] })
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
    started: resumeImages,
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
        // The next open reads a snapshot instead of replaying this session's journal.
        await Promise.race([booted.kerneld('compact').catch(() => {}), new Promise((r) => setTimeout(r, 2000))])
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
  trace('boot.done')
  timed('done')
  progress({ phase: 'ready' })
  return host
}
