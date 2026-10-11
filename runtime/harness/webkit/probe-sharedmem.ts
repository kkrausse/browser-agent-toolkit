// What does a shared WebAssembly.Memory cost the WebKit web process, by how it is declared?
//   bun runtime/harness/webkit/probe-sharedmem.ts [scratch-dir]
// For each step the web process's VmSize (address space), Rss and Pss + swap are read from
// /proc, so the three questions about the kernel memory can be answered for this port:
//   - is the declared maximum reserved as address space when the memory is made?
//   - are pages that are committed (initial, or grown) but never written resident?
//   - what does a grow cost in time when the maximum was reserved?
// Playwright's Linux WebKit (WPE), not Safari: the cage sizes of iOS are not these.
import { webkit } from 'playwright'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const h = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
const srv = Bun.serve({ port: 0, fetch: () => new Response('<!doctype html><title>p</title>', { headers: { ...h, 'content-type': 'text/html' } }) })
const scratchRoot = resolve(process.argv[2] ?? join(import.meta.dir, '../../../bench/memory/out/.run'))
mkdirSync(scratchRoot, { recursive: true })
const profile = mkdtempSync(join(scratchRoot, 'probe-sharedmem-'))
const b = await webkit.launchPersistentContext(profile)
const page = await b.newPage()
await page.goto(`http://localhost:${srv.port}/`)

const field = (text: string, name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0)
/** The web process showing this page: the WebKit web process started last under this driver. */
function webProcess(): number {
  const mine = new Set<number>([process.pid])
  const all = readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number)
  const parent = (pid: number) => { try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]) } catch { return 0 } }
  for (let changed = true; changed; ) { changed = false; for (const pid of all) if (!mine.has(pid) && mine.has(parent(pid))) { mine.add(pid); changed = true } }
  const web = [...mine].filter((pid) => { try { return /WebProcess/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8')) } catch { return false } })
  return web.sort((a, b) => b - a)[0]!
}
const pid = webProcess()
const sample = () => {
  const r = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'), s = readFileSync(`/proc/${pid}/status`, 'utf8')
  return { vmSizeMiB: Math.round(field(s, 'VmSize') / 1024), rssMiB: Math.round(field(r, 'Rss') / 102.4) / 10, pssSwapMiB: Math.round((field(r, 'Pss') + field(r, 'Swap')) / 102.4) / 10 }
}
const rows: any[] = []
const step = async (name: string, code: string) => {
  let result: unknown
  try { result = await page.evaluate(code) } catch (e) { result = { error: String((e as Error).message ?? e).split('\n')[0] } }
  await new Promise((r) => setTimeout(r, 400))
  rows.push({ step: name, ...sample(), result })
}
await step('page with nothing', `1`)
await step('shared, initial 64 pages, maximum 65,536 (4 GiB)', `try { globalThis.a = new WebAssembly.Memory({ initial: 64, maximum: 65536, shared: true }); a.buffer.byteLength } catch (e) { String(e) }`)
await step('… dropped', `globalThis.a = null; 0`)
await step('shared, initial 64, maximum 4,096 (256 MiB)', `globalThis.b = new WebAssembly.Memory({ initial: 64, maximum: 4096, shared: true }); b.buffer.byteLength`)
await step('… grown by 1,024 pages (64 MiB), not written', `(() => { const t = performance.now(); b.grow(1024); return { growMs: Math.round((performance.now() - t) * 100) / 100 } })()`)
await step('… 32 MiB of it written', `(() => { const u = new Uint8Array(b.buffer); for (let i = 4 << 20; i < 36 << 20; i += 4096) u[i] = 1; return 0 })()`)
await step('shared, initial = maximum = 4,096 (256 MiB), not written', `(() => { const t = performance.now(); globalThis.c = new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true }); return { createMs: Math.round((performance.now() - t) * 100) / 100 } })()`)
await step('… 32 MiB of it written', `(() => { const u = new Uint8Array(c.buffer); for (let i = 0; i < 32 << 20; i += 4096) u[i] = 1; return 0 })()`)
await step('shared, initial = maximum = 8,192 (512 MiB), not written', `(() => { const t = performance.now(); globalThis.d = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true }); return { createMs: Math.round((performance.now() - t) * 100) / 100 } })()`)
await step('four more shared memories of maximum 65,536', `(() => { globalThis.e = []; try { for (let i = 0; i < 4; i++) e.push(new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true })); return e.length } catch (x) { return e.length + ' then ' + String(x) } })()`)
// The SQLite heap of the runtime (runtime/src/sqlite/engine.ts) is an unshared memory, one of
// many in the process, that is grown by 32 MiB at once and whose new pages are not written.
await step('twelve unshared memories of 4 MiB, written', `(() => { globalThis.f = []; for (let i = 0; i < 12; i++) { const m = new WebAssembly.Memory({ initial: 64 }); new Uint8Array(m.buffer).fill(1); f.push(m) } return f.length })()`)
await step('… the last one grown by 512 pages (32 MiB), not written', `(() => { const t = performance.now(); f[11].grow(512); return { growMs: Math.round((performance.now() - t) * 100) / 100, bytes: f[11].buffer.byteLength } })()`)
console.log(JSON.stringify({ browser: b.browser()?.version(), webProcess: pid, load: readFileSync('/proc/loadavg', 'utf8').split(' ')[0], rows }, null, 1))
await b.close(); srv.stop(true)
rmSync(profile, { recursive: true, force: true })
