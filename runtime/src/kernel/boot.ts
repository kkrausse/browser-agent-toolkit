// Page-side boot: create the shared memory, attach the page's own instance
// (non-blocking), start kerneld. After this the page calls the kernel
// directly; kerneld is only asked for things that need a worker (OPFS sync
// handles) or that are its job (spawning).
import { attachKernel, createKernelMemory } from './attach'
import { createKernel, type Kernel } from './kernel'

export interface BootOptions {
  /** URL of the kernel wasm. */
  wasmUrl: string
  /** URLs of the bundled worker scripts (kerneld.ts and process-worker.ts). */
  kerneldUrl: string
  processWorkerUrl: string
  /** Module exporting `run(ctx)`: what a spawned process executes. */
  runnerUrl?: string
  /** OPFS namespace: images and the persisted overlay live under bat/<namespace>/. */
  namespace?: string
  /** Persist the overlay to OPFS (takes the one-writer Web Lock). Default false. */
  persist?: boolean
  /** Directories whose contents are never persisted (caches). */
  noPersist?: string[]
  warmSpare?: boolean
}

export interface BootedKernel {
  kernel: Kernel
  module: WebAssembly.Module
  memory: WebAssembly.Memory
  /** RPC to the supervisor worker. */
  kerneld<T = any>(op: string, args?: unknown): Promise<T>
  /** Download an image into OPFS unless it is already there. */
  storeImage(name: string, url: string): Promise<{ bytes: number; ms: number; cached: boolean }>
  /** Mount a stored image at `path`. */
  mountImage(name: string, path: string): Promise<{ id: number; entries: number; ms: number; openHandleMs: number; indexMs: number }>
  restored?: { snapshotSeq: number; seq: number; journalFrames: number; journalBytes: number; ms: number }
  timings: { compileMs: number; attachMs: number; kerneldMs: number }
  close(): void
}

export async function bootKernel(opts: BootOptions): Promise<BootedKernel> {
  if (!crossOriginIsolated) throw new Error('kernel: the page is not cross-origin isolated (COOP/COEP headers missing)')
  const t0 = performance.now()
  const module = await WebAssembly.compileStreaming(fetch(opts.wasmUrl))
  const t1 = performance.now()
  const memory = createKernelMemory()
  const inst = await attachKernel({ module, memory, canBlock: false, first: true })
  const kernel = createKernel(inst)
  const t2 = performance.now()

  const worker = new Worker(opts.kerneldUrl, { type: 'module', name: 'kerneld' })
  let nextId = 1
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  worker.onmessage = (e) => {
    const { id, ok, value, error, code } = e.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (ok) p.resolve(value)
    else p.reject(Object.assign(new Error(error), { code }))
  }
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`kerneld crashed: ${e.message}`))
    pending.clear()
  }
  const kerneld = <T,>(op: string, args?: unknown) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, op, args })
    })
  const init = await kerneld<{ pid: number; restored?: BootedKernel['restored'] }>('init', {
    module,
    memory,
    namespace: opts.namespace ?? 'default',
    persist: opts.persist ?? false,
    noPersist: opts.noPersist ?? [],
    processWorkerUrl: new URL(opts.processWorkerUrl, location.href).href,
    runnerUrl: opts.runnerUrl ? new URL(opts.runnerUrl, location.href).href : '',
    warmSpare: opts.warmSpare ?? true,
  })
  const t3 = performance.now()
  // Release the one-writer lock promptly on reload/navigation instead of
  // whenever the browser gets around to tearing the old document down.
  addEventListener('pagehide', () => worker.terminate())
  return {
    kernel,
    module,
    memory,
    kerneld,
    storeImage: (name, url) => kerneld('storeImage', { name, url: new URL(url, location.href).href }),
    mountImage: (name, path) => kerneld('mount', { name, path }),
    restored: init.restored,
    timings: { compileMs: t1 - t0, attachMs: t2 - t1, kerneldMs: t3 - t2 },
    close: () => worker.terminate(),
  }
}
