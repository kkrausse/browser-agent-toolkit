// What does `memory.grow` of an unshared WebAssembly memory cost, by memory size?
//   bun runtime/harness/webkit/probe-memgrow.ts
// Prints, per start size, the ms of 64 one-page grows (what a C or Rust allocator does when its
// heap fills: sbrk by 64 KiB) and of one grow by the same 4 MiB, first with no other memory in
// the process and then with 8 others alive. In Playwright's Linux WebKit only the first few
// memories of a process grow in place; for the rest a grow allocates anew and copies, so its
// cost is proportional to the size of the memory: many small grows are slow, one large grow
// is not.
import { webkit } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
const worker = `self.onmessage = () => {
  const out = []
  // JavaScriptCore gives only the first few memories of a process the kind that grows in place.
  const held = []
  for (const before of [0, 8]) for (const max of [65536, undefined]) for (const mb of [4, 16, 64]) {
    while (held.length < before) held.push(new WebAssembly.Memory({ initial: 1, maximum: 65536 }))
    const touch = (m) => { const u = new Uint8Array(m.buffer); for (let i = 0; i < u.length; i += 4096) u[i] = 1 }
    const a = new WebAssembly.Memory({ initial: mb * 16, maximum: max }); touch(a)
    let t = performance.now(); for (let i = 0; i < 64; i++) a.grow(1); const small = performance.now() - t
    const b = new WebAssembly.Memory({ initial: mb * 16, maximum: max }); touch(b)
    t = performance.now(); b.grow(64); const large = performance.now() - t
    out.push({ memoriesBefore: before, max: max ?? 'none', startMiB: mb, grow64x1pageMs: Math.round(small * 10) / 10, grow1x64pagesMs: Math.round(large * 100) / 100 })
  }
  postMessage(out)
}`
const srv = Bun.serve({ port: 0, fetch(r) {
  if (new URL(r.url).pathname === '/w.js') return new Response(worker, { headers: { ...h, 'content-type': 'text/javascript' } })
  return new Response('<!doctype html><title>p</title>', { headers: { ...h, 'content-type': 'text/html' } })
} })
const b = await webkit.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bat-probe-')))
const page = await b.newPage()
await page.goto(`http://localhost:${srv.port}/`)
console.log(JSON.stringify(await page.evaluate(() => new Promise((res) => { const w = new Worker('/w.js'); w.onmessage = (e) => res(e.data); w.onerror = (e) => res({ error: e.message }); w.postMessage(0) })), null, 1))
await b.close(); srv.stop(true)
