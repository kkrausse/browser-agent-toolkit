#!/usr/bin/env bun
// First-ever open of the TODO example's editor, n times, in the already-running Chrome
// (browser-control CLI). Every sample uses an origin this browser has never seen
// (`http://fo-<stamp>-<i>.localhost:<port>`): empty OPFS, no service worker, and nothing of
// it in the HTTP cache, without clearing the cache other tabs rely on. Afterwards the
// origin's storage is removed again (an image is 240 MB).
//
//   bench/first-open/sync.sh prepare && bench/first-open/serve.sh 4130
//   bun bench/first-open/proxy.ts --port 4131 --upstream 4130 --mbit 50 &
//   bun bench/first-open/run.ts --label after-local --port 4130 --n 3 [--reopen 2]
//   bun bench/first-open/run.ts --label after-50mbit --port 4131 --n 3
//
// --reopen k: after each first open, k more opens on the same origin (page reloaded), so
// first open and reopen are compared at the same machine load.
// All times are milliseconds after the click on "Open editor". No chat message is sent.
// Output: bench/first-open/out/<label>.json
import { $ } from 'bun'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : (process.argv[i + 1] ?? 'true')
}
const port = arg('port', '4130')!
const session = arg('session', 'bat-gaps')!
const label = arg('label', 'run')!
const n = Number(arg('n', '3'))
const reopens = Number(arg('reopen', '0'))
const timeout = Number(arg('timeout', '240000'))
const out = arg('out', join(import.meta.dir, 'out', `${label}.json`))!
const load = () => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number)

async function execute<T>(code: string): Promise<T> {
  const text = await $`browser-control execute --json --session ${session} ${code}`.quiet().nothrow().text()
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`browser-control: ${text.slice(0, 2000)}`)
  }
  if (!parsed.ok) throw new Error(`browser-control: ${JSON.stringify(parsed.error ?? parsed.text ?? parsed).slice(0, 2000)}`)
  return JSON.parse(parsed.value)
}

/** One open on `origin`: load, click, wait for the app in the preview and for the chat, read the marks, exit. */
const openCode = (origin: string) => `
const origin = ${JSON.stringify(origin)}
await page.goto(origin + '/')
await page.bringToFront()
const button = page.getByRole('button', { name: 'Open editor' })
await button.waitFor()
await page.waitForTimeout(800)
await page.evaluate(() => {
  localStorage.setItem('bat-trace', '1')
  document.addEventListener('click', () => { window.__clickAt ??= performance.now() }, { capture: true })
})
await button.click()
const done = () => {
  const has = (name) => performance.getEntriesByName('bat:' + name).length > 0
  if (document.querySelector('.todo-editor [role=alert]')) return 'failed'
  return has('chat.ready') && has('preview.visible') ? 'ok' : false
}
const outcome = await (await page.waitForFunction(done, null, { timeout: ${timeout}, polling: 50 })).jsonValue()
// The image may still be arriving after the editor is usable: wait for it, so its time is known.
await page.waitForFunction(() => !window.__batBoot || window.__batBoot.imageComplete !== undefined || window.__batBoot.image !== undefined, null, { timeout: ${timeout}, polling: 100 }).catch(() => {})
await page.waitForFunction(() => !window.__batBoot || !('imageArriving' in window.__batBoot) || window.__batBoot.imageArriving === false, null, { timeout: ${timeout}, polling: 100 }).catch(() => {})
const result = await page.evaluate(() => {
  const click = window.__clickAt
  const steps = {}
  for (const m of performance.getEntriesByType('mark')) if (m.name.startsWith('bat:') && !(m.name.slice(4) in steps)) steps[m.name.slice(4)] = Math.round((m.startTime - click) * 10) / 10
  const boot = {}
  for (const [k, v] of Object.entries(window.__batBoot ?? {})) boot[k] = typeof v === 'number' ? Math.round(v * 10) / 10 : v
  const transfer = {}
  return { steps, boot, isolated: crossOriginIsolated, error: document.querySelector('.todo-editor [role=alert]')?.textContent ?? undefined, log: document.querySelector('.todo-editor details pre')?.textContent?.split('\\n').slice(-30) }
})
await page.getByRole('button', { name: 'Exit' }).click()
await page.getByRole('button', { name: 'Open editor' }).waitFor({ timeout: 30000 })
await page.waitForFunction(() => !document.querySelector('.todo-editor'), null, { timeout: 30000 })
return JSON.stringify({ outcome, ...result })
`

/** Remove everything the origin stored, and report what was there. */
const cleanCode = (origin: string) => `
await page.goto(${JSON.stringify(origin)} + '/')
const stored = await page.evaluate(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
  for (const k of await caches.keys()) await caches.delete(k)
  const root = await navigator.storage.getDirectory()
  const files = []
  const walk = async (dir, prefix) => { for await (const [name, h] of dir.entries()) { if (h.kind === 'directory') await walk(h, prefix + name + '/'); else files.push([prefix + name, (await h.getFile()).size]) } }
  await walk(root, '')
  for (let attempt = 0; ; attempt++) {
    try {
      for await (const name of root.keys()) await root.removeEntry(name, { recursive: true })
      break
    } catch (e) {
      if (attempt > 50) throw e
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  localStorage.clear()
  return files
})
await page.goto('about:blank')
return JSON.stringify(stored)
`

const stat = (xs: number[]) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return undefined
  const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
  return { n: v.length, median: Math.round(median), min: Math.round(v[0]), max: Math.round(v[v.length - 1]) }
}

const proxyStats = async (reset = false) => {
  try {
    if (reset) return void (await fetch(`http://127.0.0.1:${port}/__proxy/reset`, { method: 'POST' }))
    const r = await fetch(`http://127.0.0.1:${port}/__proxy/stats`)
    return r.ok && r.headers.get('content-type')?.includes('json') ? ((await r.json()) as { mbit: number; bytes: Record<string, number> }) : undefined
  } catch {
    return undefined
  }
}

const stamp = Date.now().toString(36)
const samples: any[] = []
for (let i = 0; i < n; i++) {
  const origin = `http://fo-${stamp}-${i}.localhost:${port}`
  await proxyStats(true)
  for (let k = 0; k <= reopens; k++) {
    const kind = k === 0 ? 'first' : 'reopen'
    const before = load()
    let r: any
    try {
      r = await execute<any>(openCode(origin))
    } catch (e) {
      console.error(`sample ${i} ${kind} failed: ${(e as Error).message}`)
      break
    }
    const wire = k === 0 ? await proxyStats() : undefined
    const wireBytes = wire ? Object.values(wire.bytes).reduce((a, b) => a + b, 0) : undefined
    const whole = Math.max(r.steps['preview.visible'] ?? NaN, r.steps['chat.ready'] ?? NaN)
    samples.push({ kind, origin, load: before, whole, wireBytes, wire: wire?.bytes, ...r })
    console.error(`${i} ${kind.padEnd(6)} load ${before[0].toFixed(1).padStart(5)}  ${r.outcome}  boot ${r.steps.boot}  visible ${r.steps['preview.visible']}  chat ${r.steps['chat.ready']}  image ${r.boot.image ?? '?'}${r.boot.imageComplete !== undefined ? ` complete ${r.boot.imageComplete}` : ''}${wireBytes ? `  wire ${(wireBytes / 1e6).toFixed(1)} MB` : ''}${r.error ? `  ERROR ${r.error}` : ''}`)
  }
  const stored = await execute<[string, number][]>(cleanCode(origin)).catch((e) => (console.error(`clean failed: ${e.message}`), []))
  samples.filter((s) => s.origin === origin).forEach((s) => (s.stored = stored))
}

const summary: Record<string, any> = {}
for (const kind of ['first', 'reopen']) {
  const mine = samples.filter((s) => s.kind === kind && s.outcome === 'ok')
  if (!mine.length) continue
  const names = [...new Set(mine.flatMap((s) => Object.keys(s.steps)))]
  summary[kind] = {
    n: mine.length,
    load1: stat(mine.map((s) => s.load[0])),
    whole: stat(mine.map((s) => s.whole)),
    wireMB: stat(mine.map((s) => (s.wireBytes ?? NaN) / 1e6)),
    steps: Object.fromEntries(names.map((name) => [name, stat(mine.map((s) => s.steps[name]))])),
    boot: Object.fromEntries(['kernel', 'image', 'imageHead', 'imageComplete', 'mounted', 'total'].map((name) => [name, stat(mine.map((s) => s.boot[name]))])),
  }
}
const commit = (await $`git -C ${join(import.meta.dir, '../..')} rev-parse --short HEAD`.quiet().nothrow().text()).trim()
mkdirSync(dirname(out), { recursive: true })
await Bun.write(out, JSON.stringify({ meta: { label, port, date: new Date().toISOString(), commit, chrome: 'headed on Xvfb, browser-control' }, summary, samples }, null, 1))
for (const [kind, s] of Object.entries(summary)) {
  console.log(`\n${label} ${kind}: n=${s.n} load1 ${s.load1?.median} (${s.load1?.min}–${s.load1?.max})  whole open ${s.whole?.median} (${s.whole?.min}–${s.whole?.max})${s.wireMB ? `  wire ${s.wireMB.median} MB` : ''}`)
  for (const name of ['manifest', 'boot', 'preview.listening', 'preview.visible', 'agent.ready', 'chat.ready']) if (s.steps[name]) console.log(`  ${name.padEnd(20)} ${String(s.steps[name].median).padStart(7)}  (${s.steps[name].min}–${s.steps[name].max})`)
  for (const [name, v] of Object.entries(s.boot)) if (v) console.log(`  boot.${name.padEnd(15)} ${String((v as any).median).padStart(7)}  (${(v as any).min}–${(v as any).max})`)
}
console.log(`\n${out}`)
