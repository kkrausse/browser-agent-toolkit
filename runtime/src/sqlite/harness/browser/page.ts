// Page side of the browser check: boot the kernel with OPFS persistence,
// compile sqlite3.wasm once, hand both to a worker that plays the guest
// process, and publish its report as `window.__result`.
//
//   /?ns=<name>&phase=bench    fresh namespace: timings, then leave a database with
//                              one committed and one open transaction, flushed
//   /?ns=<name>&phase=verify   after a reload: the overlay is restored from OPFS;
//                              check the database
import { bootKernel } from '../../../kernel/boot'

const out = document.getElementById('out')!
const q = new URLSearchParams(location.search)
const namespace = `sqlite-${q.get('ns') ?? 'default'}`
const phase = q.get('phase') ?? 'bench'

async function main() {
  const boot = await bootKernel({
    wasmUrl: '/kernel.wasm',
    kerneldUrl: '/runtime/src/kernel/kerneld.ts',
    processWorkerUrl: '/runtime/src/kernel/process-worker.ts',
    namespace,
    persist: true,
    warmSpare: false,
  })
  const t0 = performance.now()
  const response = await fetch('/sqlite3.wasm')
  const bytes = Number(response.headers.get('content-length') ?? 0)
  const sqliteModule = await WebAssembly.compileStreaming(response)
  const compileStreamingMs = performance.now() - t0
  const worker = new Worker('/runtime/src/sqlite/harness/browser/worker.ts', { type: 'module' })
  const report = await new Promise<any>((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data)
    worker.onerror = (e) => reject(new Error(e.message))
    worker.postMessage({ module: boot.module, memory: boot.memory, sqliteModule, phase, prewarm: q.get('prewarm') === '1', sync: q.get('sync') ?? 'request' })
  })
  const kerneld = await boot.kerneld('stats').catch((e: Error) => String(e))
  return {
    phase,
    namespace,
    userAgent: navigator.userAgent,
    restored: boot.restored,
    kernelBoot: boot.timings,
    sqliteWasm: { bytes, compileStreamingMs },
    ...report,
    kerneld,
  }
}

main().then(
  (r) => {
    ;(window as any).__result = r
    out.textContent = JSON.stringify(r, null, 2)
  },
  (e) => {
    ;(window as any).__result = { error: String(e?.stack ?? e) }
    out.textContent = String(e?.stack ?? e)
  },
)
