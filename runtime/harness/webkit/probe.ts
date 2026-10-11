// Which of the platform features the runtime needs does Playwright's WebKit have?
//   bun runtime/harness/webkit/probe.ts
// Prints one JSON object. `second` is the answer to the main question: can a file have two
// sync access handles at once (it cannot: WebKit ignores `mode`, handles are exclusive).
import { webkit } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const worker = `self.onmessage = async () => {
  const out: any = {}
  try {
    const d = await navigator.storage.getDirectory()
    const f = await d.getFileHandle('probe', { create: true })
    let h: any; try { h = await (f as any).createSyncAccessHandle(); out.plain = true } catch (e) { out.plain = String(e); h = await (f as any).createSyncAccessHandle({ mode: 'readwrite-unsafe' }) }
    out.sync = true; out.mode = (h as any).mode ?? null
    try { const h2 = await (f as any).createSyncAccessHandle({ mode: 'readwrite-unsafe' }); out.second = true; h2.close() } catch (e) { out.second = String(e) }
    h.close()
  } catch (e) { out.sync = String(e) }
  try { new WebAssembly.Memory({ initial: 64, maximum: 65536, shared: true }); out.mem4g = true } catch (e) { out.mem4g = String(e) }
  out.waitAsync = typeof (Atomics as any).waitAsync
  try { new Worker('/w.js', { type: 'module' }); out.nested = true } catch (e) { out.nested = String(e) }
  try { new Request('/', { method: 'POST', body: new ReadableStream(), duplex: 'half' } as any); out.reqStream = true } catch (e) { out.reqStream = String(e) }
  self.postMessage(out)
}`
const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(worker)
const h = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
const srv = Bun.serve({ port: 0, fetch(r) {
  const p = new URL(r.url).pathname
  if (p === '/w.js') return new Response(js, { headers: { ...h, 'content-type': 'text/javascript' } })
  return new Response('<!doctype html><title>p</title>', { headers: { ...h, 'content-type': 'text/html' } })
} })
const b = await webkit.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bat-probe-')))
const page = await b.newPage()
await page.goto(`http://localhost:${srv.port}/`)
const r = await page.evaluate(() => new Promise((res) => {
  const base: any = { ua: navigator.userAgent, coi: crossOriginIsolated, sab: typeof SharedArrayBuffer, locks: !!navigator.locks, sw: !!navigator.serviceWorker, zstd: (() => { try { new DecompressionStream('zstd' as any); return true } catch { return false } })() }
  const w = new Worker('/w.js', { type: 'module' }); w.onmessage = (e) => res({ ...base, ...e.data }); w.onerror = (e) => res({ ...base, workerError: e.message }); w.postMessage(0)
  setTimeout(() => res({ ...base, timeout: true }), 8000)
}))
console.log(JSON.stringify(r, null, 1))
await b.close(); srv.stop(true)
