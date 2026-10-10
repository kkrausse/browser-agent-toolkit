#!/usr/bin/env bun
// Startup driver: opens the TODO example's editor n times in the already-running Chrome
// (browser-control CLI) and writes every step and sub-step as JSON, with the machine's load
// average beside each sample.
//
//   bench/startup/sync.sh prepare && bench/startup/serve.sh 4120
//   bun bench/startup/run.ts --label before [--reopen 5] [--fresh 5] [--trace] [--max-load 14]
//
// A sample is: load the page, wait until it is idle, click "Open editor", wait for the
// preview to show the app and for the chat to be ready, read the marks, click "Exit".
//   reopen  the dependency image and the workspace are already in this browser
//   fresh   origin storage (OPFS, service worker, Cache Storage, localStorage) emptied first;
//           the browser's HTTP cache is left alone (clearing it would hit every other tab)
// All times are milliseconds after the click. No chat message is ever sent.
//
// Output: bench/startup/out/<label>.json  { meta, samples[], summary }
//   steps   the toolkit's steps and user-timing marks (`bat:*`), ms after the click
//   boot    the runtime's own boot timings (ms, relative to bootRuntime's start)
//   trace   with --trace: marks from kerneld, the process workers and guests (`src`, `name`, `ms`, `data`)
//   stages  the budget table's five rows, derived from the steps
import { $ } from 'bun'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : (process.argv[i + 1] ?? 'true')
}
const flag = (name: string) => process.argv.includes(`--${name}`)
const port = arg('port', '4120')!
const session = arg('session', 'bat-perf')!
const label = arg('label', 'run')!
const reopen = Number(arg('reopen', '5'))
const fresh = Number(arg('fresh', '0'))
const trace = flag('trace')
const maxLoad = Number(arg('max-load', '0'))
const settleMs = Number(arg('settle', '800'))
const out = arg('out', join(import.meta.dir, 'out', `${label}.json`))!
const origin = `http://127.0.0.1:${port}`

const load = () => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitForLoad() {
  if (!maxLoad) return
  for (let i = 0; i < 120 && load()[0] > maxLoad; i++) await sleep(5000)
}

async function execute<T>(code: string): Promise<T> {
  const text = await $`browser-control execute --json --session ${session} ${code}`.quiet().nothrow().text()
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`browser-control: ${text.slice(0, 2000)}`)
  }
  if (!parsed.ok) throw new Error(`browser-control: ${JSON.stringify(parsed.error ?? parsed).slice(0, 2000)}`)
  return JSON.parse(parsed.value)
}

/** Runs in browser-control: one open, from page load to marks collected and the editor closed again. */
const sampleCode = (kind: 'fresh' | 'reopen') => `
const origin = ${JSON.stringify(origin)}, kind = ${JSON.stringify(kind)}, trace = ${trace}, settle = ${settleMs}
await page.goto(origin + '/')
if (kind === 'fresh') {
  await page.evaluate(async () => {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
    for (const k of await caches.keys()) await caches.delete(k)
    const root = await navigator.storage.getDirectory()
    for await (const name of root.keys()) await root.removeEntry(name, { recursive: true })
    localStorage.clear()
  })
  await page.goto(origin + '/')
  const left = await page.evaluate(async () => { const names = []; for await (const n of (await navigator.storage.getDirectory()).keys()) names.push(n); return names })
  if (left.length) throw new Error('origin storage not empty: ' + left)
}
await page.bringToFront()
await page.evaluate((on) => { if (on) localStorage.setItem('bat-trace', '1'); else localStorage.removeItem('bat-trace') }, trace)
const button = page.getByRole('button', { name: 'Open editor' })
await button.waitFor()
await page.waitForTimeout(settle)
const before = await page.evaluate(() => {
  document.addEventListener('click', () => { window.__clickAt ??= performance.now() }, { capture: true })
  return { visibility: document.visibilityState, focused: document.hasFocus(), isolated: crossOriginIsolated }
})
await button.click()
const done = () => {
  const has = (name) => performance.getEntriesByName('bat:' + name).length > 0
  if (document.querySelector('.todo-editor [role=alert]')) return 'failed'
  return has('chat.ready') && has('preview.visible') ? 'ok' : false
}
const outcome = await (await page.waitForFunction(done, null, { timeout: 180000, polling: 50 })).jsonValue()
const result = await page.evaluate(() => {
  const click = window.__clickAt
  const steps = {}
  for (const m of performance.getEntriesByType('mark')) if (m.name.startsWith('bat:') && !(m.name.slice(4) in steps)) steps[m.name.slice(4)] = Math.round((m.startTime - click) * 10) / 10
  const zero = performance.timeOrigin + click
  const marks = (window.__batTrace ?? []).map((m) => ({ src: m.src, name: m.name, ms: Math.round((m.t - zero) * 10) / 10, data: m.data })).sort((a, b) => a.ms - b.ms)
  const boot = {}
  for (const [k, v] of Object.entries(window.__batBoot ?? {})) boot[k] = typeof v === 'number' ? Math.round(v * 10) / 10 : v
  return { steps, trace: marks, boot, error: document.querySelector('.todo-editor [role=alert]')?.textContent ?? undefined, log: document.querySelector('.todo-editor details pre')?.textContent?.split('\\n').slice(-40) }
})
await page.getByRole('button', { name: 'Exit' }).click()
await page.getByRole('button', { name: 'Open editor' }).waitFor({ timeout: 30000 })
await page.waitForFunction(() => !document.querySelector('.todo-editor'), null, { timeout: 30000 })
return JSON.stringify({ outcome, before, ...result })
`

interface Sample {
  kind: 'fresh' | 'reopen'
  load: number[]
  outcome: string
  before: { visibility: string; focused: boolean }
  steps: Record<string, number>
  boot: Record<string, number | boolean>
  trace: { src: string; name: string; ms: number; data?: any }[]
  stages: Record<string, number>
  error?: string
  log?: string[]
}

function stages(s: Record<string, number>): Record<string, number> {
  const d = (a: string, b: string) => (s[a] === undefined || s[b] === undefined ? NaN : Math.round((s[a] - s[b]) * 10) / 10)
  return {
    'click → booted (manifest, runtime import, boot, mount)': s.boot ?? NaN,
    'boot + mount (bootRuntime alone)': d('boot', 'manifest'),
    'vite spawn → listening': d('preview.listening', 'preview.spawn'),
    'vite spawn → app visible': d('preview.visible', 'preview.spawn'),
    'opencode spawn → attached': d('agent.ready', 'agent.spawn'),
    'opencode spawn → chat ready': d('chat.ready', 'agent.spawn'),
    'whole open (click → app visible and chat ready)': Math.max(s['preview.visible'] ?? NaN, s['chat.ready'] ?? NaN),
  }
}

const stat = (xs: number[]) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return undefined
  const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
  return { n: v.length, median: Math.round(median * 10) / 10, min: v[0], max: v[v.length - 1] }
}
function summarize(samples: Sample[]) {
  const table = (pick: (s: Sample) => Record<string, number>) => {
    const names = [...new Set(samples.flatMap((s) => Object.keys(pick(s))))]
    return Object.fromEntries(names.map((name) => [name, stat(samples.map((s) => pick(s)[name]))]))
  }
  return { n: samples.length, load1: stat(samples.map((s) => s.load[0])), stages: table((s) => s.stages), steps: table((s) => s.steps), boot: table((s) => Object.fromEntries(Object.entries(s.boot).filter(([, v]) => typeof v === 'number')) as Record<string, number>) }
}

const samples: Sample[] = []
const plan: ('fresh' | 'reopen')[] = [...Array(fresh).fill('fresh'), ...Array(reopen).fill('reopen')]
// A reopen needs something to reopen: when no fresh sample precedes, one unrecorded open first.
if (!fresh && reopen && !flag('no-prime')) {
  await execute(sampleCode('reopen'))
  console.error('primed')
}
for (const [i, kind] of plan.entries()) {
  await waitForLoad()
  const before = load()
  let r: any
  try {
    r = await execute<any>(sampleCode(kind))
  } catch (e) {
    console.error(`sample ${i + 1} (${kind}) failed: ${(e as Error).message}`)
    continue
  }
  const sample: Sample = { kind, load: before, ...r, stages: stages(r.steps) }
  samples.push(sample)
  const st = sample.stages
  console.error(
    `${String(i + 1).padStart(2)} ${kind.padEnd(6)} load ${before[0].toFixed(1).padStart(5)}  ${r.outcome}  boot ${st['click → booted (manifest, runtime import, boot, mount)']}  listen +${st['vite spawn → listening']}  visible +${st['vite spawn → app visible']}  agent +${st['opencode spawn → attached']}  whole ${st['whole open (click → app visible and chat ready)']}${r.before.visibility !== 'visible' || !r.before.focused ? '  (TAB NOT VISIBLE/FOCUSED)' : ''}${r.error ? `  ERROR ${r.error}` : ''}`,
  )
}

const commit = (await $`git -C ${join(import.meta.dir, '../..')} rev-parse --short HEAD`.quiet().nothrow().text()).trim()
const result = {
  meta: { label, date: new Date().toISOString(), commit, origin, trace, settleMs, chrome: 'headed on Xvfb, driven by browser-control' },
  summary: { fresh: summarize(samples.filter((s) => s.kind === 'fresh' && s.outcome === 'ok')), reopen: summarize(samples.filter((s) => s.kind === 'reopen' && s.outcome === 'ok')) },
  samples,
}
mkdirSync(dirname(out), { recursive: true })
await Bun.write(out, JSON.stringify(result, null, 1))
for (const kind of ['fresh', 'reopen'] as const) {
  const s = result.summary[kind]
  if (!s.n) continue
  console.log(`\n${kind}: n=${s.n}, load1 median ${s.load1?.median} (${s.load1?.min}–${s.load1?.max})`)
  for (const [name, v] of Object.entries(s.stages)) if (v) console.log(`  ${name.padEnd(56)} ${String(v.median).padStart(7)}  (${v.min}–${v.max})`)
}
console.log(`\n${out}`)
