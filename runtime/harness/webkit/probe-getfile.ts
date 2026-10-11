// Can a worker read an OPFS file through `getFile()` + `FileReaderSync` while another worker
// holds the file's only sync access handle and is appending to it? (The first download of an
// image in WebKit: the writer's handle excludes every other handle.)
//   bun runtime/harness/webkit/probe-getfile.ts [webkit|chromium]
// Prints one JSON object:
//   unflushed     a fresh getFile() sees bytes written and not flushed
//   staleOld      a File taken BEFORE a later append still reads the bytes it covered
//   staleSize     ... and its size is the size at the time it was taken
//   contentOk     bytes read back are the bytes written
//   getFileMs     median ms of one getFile()
//   read128Ms     median ms of one 128 KiB FileReaderSync read of a slice
//   afterClose    a File taken while the writer was open still reads after the writer closed
import { webkit, chromium } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const worker = `
const BLOCK = 1 << 20
const fill = (i: number) => { const b = new Uint8Array(BLOCK); for (let j = 0; j < BLOCK; j += 4096) b[j] = (i * 31 + (j >> 12)) & 255; return b }
const med = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]
self.onmessage = async (e) => {
  const d = await navigator.storage.getDirectory()
  if (e.data.role === 'writer') {
    const f = await d.getFileHandle('arriving', { create: true })
    const h = await (f as any).createSyncAccessHandle()
    h.truncate(0)
    let n = 0
    self.onmessage = (m) => {
      if (m.data === 'append') { h.write(fill(n), { at: n * BLOCK }); n++; self.postMessage({ wrote: n }) }
      else if (m.data === 'flush') { h.flush(); self.postMessage({ flushed: true }) }
      else if (m.data === 'close') { h.close(); self.postMessage({ closed: true }) }
    }
    self.postMessage({ ready: true })
    return
  }
  // reader
  const out: any = {}
  const ask = (what: string) => new Promise<void>((res) => { const ch = new BroadcastChannel('probe'); ch.onmessage = (m) => { if (m.data.done === what) { ch.close(); res() } }; ch.postMessage({ ask: what }) })
  const rs = new (self as any).FileReaderSync()
  const read = (file: File, at: number, len: number) => new Uint8Array(rs.readAsArrayBuffer(file.slice(at, at + len)))
  try {
    const fh = await d.getFileHandle('arriving')
    try { const h2 = await (fh as any).createSyncAccessHandle(); out.secondHandle = true; h2.close() } catch (e) { out.secondHandle = String(e) }
    await ask('append')
    const f1 = await fh.getFile()
    out.unflushed = f1.size === BLOCK
    out.sizeAfter1 = f1.size
    const a = read(f1, 0, 1 << 17)
    out.contentOk = a.length === (1 << 17) && a[0] === 0 && a[4096] === 1 && a[8192] === 2
    await ask('append')
    // f1 is now stale: the file grew behind it.
    out.staleSize = f1.size
    try { const b = read(f1, 4096 * 5, 1 << 17); out.staleOld = b.length === (1 << 17) && b[0] === 5 } catch (e) { out.staleOld = String(e) }
    try { const c = read(f1, BLOCK - 4096, 1 << 17); out.stalePastEnd = c.length } catch (e) { out.stalePastEnd = String(e) }
    const f2 = await fh.getFile()
    out.sizeAfter2 = f2.size
    try { const c = read(f2, BLOCK, 4096); out.secondBlock = c[0] === 31 } catch (e) { out.secondBlock = String(e) }
    for (let i = 0; i < 30; i++) await ask('append')
    const gets: number[] = []
    let f3 = f2
    for (let i = 0; i < 50; i++) { const t = performance.now(); f3 = await fh.getFile(); gets.push(performance.now() - t) }
    out.getFileMs = med(gets)
    const reads: number[] = []
    let ok = true
    for (let i = 0; i < 200; i++) { const at = i * (1 << 17); const t = performance.now(); const b = read(f3, at, 1 << 17); reads.push(performance.now() - t); if (b.length !== (1 << 17) || b[0] !== (((at >> 20) * 31 + ((at & (BLOCK - 1)) >> 12)) & 255)) ok = false }
    out.read128Ms = med(reads)
    out.read128Max = Math.max(...reads)
    out.read128Ok = ok
    // Reads racing appends: 100 reads through one stale File while the writer keeps appending.
    let raced = 0, racedFail = ''
    for (let i = 0; i < 20; i++) { await ask('append'); try { const b = read(f3, i * (1 << 17), 1 << 17); if (b.length === (1 << 17)) raced++ } catch (e) { racedFail = String(e) } }
    out.racedOk = raced; out.racedFail = racedFail
    await ask('flush')
    await ask('close')
    try { const b = read(f3, 0, 4096); out.afterClose = b.length === 4096 } catch (e) { out.afterClose = String(e) }
    try { const h3 = await (fh as any).createSyncAccessHandle(); out.handleAfterClose = h3.getSize(); h3.close() } catch (e) { out.handleAfterClose = String(e) }
  } catch (e) { out.error = String((e as any)?.stack ?? e) }
  self.postMessage(out)
}`
const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(worker)
const h = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
const srv = Bun.serve({ port: 0, fetch(r) {
  const p = new URL(r.url).pathname
  if (p === '/w.js') return new Response(js, { headers: { ...h, 'content-type': 'text/javascript' } })
  return new Response('<!doctype html><title>p</title>', { headers: { ...h, 'content-type': 'text/html' } })
} })
const engine = process.argv[2] === 'chromium' ? chromium : webkit
const b = await engine.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bat-probe-')))
const page = await b.newPage()
await page.goto(`http://localhost:${srv.port}/`)
const r = await page.evaluate(() => new Promise((res) => {
  const writer = new Worker('/w.js', { type: 'module' })
  const ch = new BroadcastChannel('probe')
  let pending = ''
  ch.onmessage = (m) => { pending = m.data.ask; if (pending) writer.postMessage(pending) }
  writer.onmessage = (e) => {
    if (e.data.ready) {
      const reader = new Worker('/w.js', { type: 'module' })
      reader.onmessage = (m) => res({ ua: navigator.userAgent, ...m.data })
      reader.onerror = (m) => res({ readerError: m.message })
      reader.postMessage({ role: 'reader' })
    } else if (pending) { const what = pending; pending = ''; ch.postMessage({ done: what }) }
  }
  writer.onerror = (m) => res({ writerError: m.message })
  writer.postMessage({ role: 'writer' })
  setTimeout(() => res({ timeout: true }), 20000)
}))
console.log(JSON.stringify(r, null, 1))
await b.close(); srv.stop(true)
