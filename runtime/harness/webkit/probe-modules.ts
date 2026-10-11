// Do Wasm modules compiled separately in each worker cost each worker memory in WebKit?
//   bun runtime/harness/webkit/probe-modules.ts [workers=8]
// A process worker of the runtime compiles four runtime modules itself (bat_modules,
// bat_node_native, sqlite3, bat_sh: `prefetchWasm` in runtime/src/process/worker.ts), where
// the kernel module is compiled once and posted. Three pages, each in a browser of its own,
// with N workers that hold the four modules: compiled in every worker from the same bytes,
// compiled once on the page and posted, or no modules at all. The web process's
// Pss + swap is read from /proc after the workers have settled. Modules are compiled, not
// instantiated: what running their functions adds (JavaScriptCore compiles a function when it
// is first called) is not in these numbers.
import { webkit } from 'playwright'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const count = Number(process.argv[2] ?? 8)
const dist = resolve(import.meta.dir, '../../dist')
const names = ['bat_modules.wasm', 'bat_node_native.wasm', 'sqlite3.wasm', 'bat_sh.wasm']
const h = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
const worker = `self.onmessage = async (e) => {
  if (e.data.compile) self.held = await Promise.all(e.data.compile.map((url) => WebAssembly.compileStreaming(fetch(url))))
  else self.held = e.data.modules ?? []
  postMessage(self.held.length)
}`
const srv = Bun.serve({ port: 0, fetch(r) {
  const path = new URL(r.url).pathname
  if (path === '/w.js') return new Response(worker, { headers: { ...h, 'content-type': 'text/javascript' } })
  if (path.endsWith('.wasm')) return new Response(Bun.file(join(dist, path.slice(1))), { headers: { ...h, 'content-type': 'application/wasm' } })
  return new Response('<!doctype html><title>p</title>', { headers: { ...h, 'content-type': 'text/html' } })
} })
const scratch = resolve(import.meta.dir, '../../../bench/memory/out/.run')
mkdirSync(scratch, { recursive: true })
const field = (text: string, name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0)

async function variant(mode: 'none' | 'compiled in each worker' | 'compiled once and posted') {
  const profile = mkdtempSync(join(scratch, 'probe-modules-'))
  const b = await webkit.launchPersistentContext(profile)
  try {
    const page = await b.newPage()
    await page.goto(`http://localhost:${srv.port}/`)
    await page.evaluate(async ({ mode, names, count }) => {
      const modules = mode === 'compiled once and posted' ? await Promise.all(names.map((n) => WebAssembly.compileStreaming(fetch('/' + n)))) : undefined
      ;(globalThis as any).held = { modules, workers: [] as Worker[] }
      for (let i = 0; i < count; i++) {
        const w = new Worker('/w.js')
        ;(globalThis as any).held.workers.push(w)
        await new Promise((res, rej) => { w.onmessage = res; w.onerror = (e) => rej(Error(e.message)); w.postMessage(mode === 'compiled in each worker' ? { compile: names.map((n) => '/' + n) } : { modules }) })
      }
    }, { mode, names, count })
    await new Promise((r) => setTimeout(r, 4000))
    const all = readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number)
    const parent = (pid: number) => { try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]) } catch { return 0 } }
    const mine = new Set<number>([process.pid])
    for (let changed = true; changed; ) { changed = false; for (const pid of all) if (!mine.has(pid) && mine.has(parent(pid))) { mine.add(pid); changed = true } }
    const web = [...mine].filter((pid) => { try { return /WebProcess/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8')) } catch { return false } }).sort((a, b) => b - a)[0]!
    const r = readFileSync(`/proc/${web}/smaps_rollup`, 'utf8')
    return { mode, workers: count, pssSwapMiB: Math.round((field(r, 'Pss') + field(r, 'Swap')) / 102.4) / 10, rssMiB: Math.round(field(r, 'Rss') / 102.4) / 10 }
  } finally {
    await b.close()
    rmSync(profile, { recursive: true, force: true })
  }
}
const rows = []
for (const round of [1, 2]) for (const mode of ['none', 'compiled in each worker', 'compiled once and posted'] as const) rows.push({ round, ...(await variant(mode)) })
console.log(JSON.stringify({ wasmBytes: names.map((n) => Bun.file(join(dist, n)).size).reduce((a, b) => a + b, 0), load: readFileSync('/proc/loadavg', 'utf8').split(' ')[0], rows }, null, 1))
srv.stop(true)
