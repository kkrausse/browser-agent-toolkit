#!/usr/bin/env bun
// Measurements for docs/experiments/2026-10-09-node-runtime.md, taken in the
// harness page through browser-control. Prints one JSON object per scenario;
// each carries the 1-minute load average before and after.
//
//   bun runtime/harness/measure.ts [spawn] [cold] [typescript] [vite] [program]
//
// With no arguments every scenario runs. The harness server must serve the
// current build (bun runtime/build.ts).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.BAT_HARNESS_PORT ?? 4102)
const SESSION = process.env.BAT_HARNESS_SESSION ?? 'bat-node'
const ORIGIN = `http://127.0.0.1:${PORT}`
const here = import.meta.dir
const want = process.argv.slice(2)
const on = (name: string) => want.length === 0 || want.includes(name)
const only = process.env.BAT_PROGRAM_VARIANT

function browser(code: string): any {
  const file = join(mkdtempSync(join(tmpdir(), 'bat-measure-')), 'exec.js')
  writeFileSync(file, code)
  const r = spawnSync('browser-control', ['execute', '--json', '--session', SESSION, '--file', file], { encoding: 'utf8', maxBuffer: 256 << 20 })
  let parsed: any
  try {
    parsed = JSON.parse(r.stdout.trim())
  } catch {
    throw new Error(`browser-control: ${r.stdout || r.stderr}`)
  }
  if (!parsed.ok) throw new Error(`browser-control: ${JSON.stringify(parsed.error ?? parsed).slice(0, 1500)}`)
  return parsed.value
}
/** Load the page with `query` and wait until the kernel is up. */
const load = (query: string) => browser(`await page.goto(${JSON.stringify(`${ORIGIN}/?${query}`)}); return await page.evaluate(async () => await window.batHarness.ready)`)
/** Run `fn` (source of an async function taking the harness) in the page. */
const inPage = (fn: string, arg: unknown = null) => browser(`return await page.evaluate(async (arg) => { const h = window.batHarness; await h.ready; return await (${fn})(h, arg) }, ${JSON.stringify(arg)})`)

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const r = (v: number) => Math.round(v * 100) / 100
  return { n: s.length, min: r(s[0]), median: r(s[Math.floor(s.length / 2)]), max: r(s[s.length - 1]), all: xs.map(r) }
}
const report = (name: string, before: number, data: unknown) => console.log(JSON.stringify({ scenario: name, load1: [Math.round(before * 100) / 100, Math.round(loadavg()[0] * 100) / 100], ...(data as object) }))

const guest = (name: string) => readFileSync(join(here, 'guests', name), 'utf8')

// One spawn: spawn request on the page -> first guest statement, and -> exit seen by the page.
const SPAWN = `async (h, n) => {
  const out = []
  for (let i = 0; i < n; i++) {
    await h.spare()
    await new Promise((r) => setTimeout(r, 150))
    const r = await h.run({ args: ['-e', 'console.log(performance.timeOrigin + performance.now())'], trace: true })
    const mark = (name) => (r.trace.marks.find((m) => m[0] === name) || [])[1]
    out.push({ firstStatement: Number(r.stdout) - r.spawnedAt, total: r.ms, warm: mark('warm'), inWorkerToEntry: mark('entry') })
  }
  return out
}`

if (on('spawn')) {
  const l = loadavg()[0]
  load('')
  const rows = inPage(SPAWN, 15)
  report('spawn, warm spare', l, { firstStatementMs: stats(rows.map((r: any) => r.firstStatement)), spawnToExitMs: stats(rows.map((r: any) => r.total)), runMessageToEntryMs: stats(rows.map((r: any) => r.inWorkerToEntry)), warm: rows.every((r: any) => r.warm === 1) })
}
if (on('cold')) {
  const l = loadavg()[0]
  load('spare=0')
  const rows = inPage(SPAWN.replace('await h.spare()', ''), 10)
  report('spawn, cold worker (no spare; worker script and Node lib from the HTTP cache)', l, { firstStatementMs: stats(rows.map((r: any) => r.firstStatement)), spawnToExitMs: stats(rows.map((r: any) => r.total)), runMessageToEntryMs: stats(rows.map((r: any) => r.inWorkerToEntry)), warm: rows.some((r: any) => r.warm === 1) })
  load('')
}
if (on('typescript')) {
  const l = loadavg()[0]
  const rows = inPage(
    `async (h, files) => {
      const out = []
      for (let i = 0; i < 6; i++) {
        await h.spare()
        const r = await h.run({ args: ['/workspace/.harness/typescript.cjs'], files, trace: true })
        out.push({ ...JSON.parse(r.stdout.split('\\n')[0]), total: r.ms, loader: r.trace.loader })
      }
      return out
    }`,
    { '/workspace/.harness/typescript.cjs': guest('typescript.cjs'), '/workspace/.harness/ts-lib.ts': guest('ts-lib.ts') },
  )
  report("require('typescript') 5.9.3 (one 9 MB CommonJS file from the image)", l, {
    requireMs: stats(rows.map((r: any) => r.requireMs)), firstRun: rows[0].requireMs, transpileMs: stats(rows.map((r: any) => r.transpileMs)), processTotalMs: stats(rows.map((r: any) => r.total)),
    loaderOfLast: rows[rows.length - 1].loader,
  })
}
if (on('vite')) {
  const l = loadavg()[0]
  const rows = inPage(
    `async (h, files) => {
      const out = []
      for (let i = 0; i < 6; i++) {
        await h.spare()
        const r = await h.run({ args: ['/workspace/.harness/vite-config.mjs'], files, trace: true, cwd: '/workspace' })
        const json = r.stdout.slice(r.stdout.indexOf('{\\n "version"'))
        out.push({ ...JSON.parse(json), total: r.ms, trace: r.trace })
      }
      return out
    }`,
    { '/workspace/.harness/vite-config.mjs': guest('vite-config.mjs') },
  )
  const last = rows[rows.length - 1].trace
  report("import('vite') 7.3.6 + resolveConfig for /workspace", l, {
    importMs: stats(rows.map((r: any) => r.importMs)), resolveConfigMs: stats(rows.map((r: any) => r.resolveConfigMs)), processTotalMs: stats(rows.map((r: any) => r.total)),
    modules: last.loader.modules, loader: last.loader,
    resolutions: stats(rows.map((r: any) => r.trace.resolve.calls)), resolutionsAnsweredByProcessMap: last.resolve.hits, resolveTotalMs: stats(rows.map((r: any) => r.trace.resolve.ms)),
    kernelResolver: last.resolveKernel, plugins: rows[0].plugins.length,
  })
}
if (on('program')) {
  // importScripts of the 27.7 MB OpenCode program script, then the entry's synchronous part.
  const LOADS = `async (h, n) => {
    const launch = h.manifest.launch.agent
    const dirs = Object.entries(launch.env).filter(([k, v]) => /HOME$|^TMPDIR$/.test(k)).map(([, v]) => v)
    const out = []
    for (let i = 0; i < n; i++) {
      await h.spare()
      // stdin is closed at once, so the server starts, sees EOF and shuts down by itself.
      const r = await h.run({ args: [launch.entry], cwd: launch.cwd, dirs, env: { ...launch.env, OPENCODE_PASSWORD: 'x', OPENCODE_DATABASE_PATH: launch.env.XDG_DATA_HOME + '/m.db' }, trace: true, timeoutMs: 60000 })
      const mark = (name) => (r.trace?.marks.find((m) => m[0] === name) || [])[1]
      out.push({ importScripts: mark('program opencode-server') - mark('entry'), entryReturned: mark('entry-returned') - mark('program opencode-server'), total: r.ms, ready: /bootstrap|READY|interrupted/.test(r.stdout + r.stderr) })
      await new Promise((r) => setTimeout(r, 1500))
    }
    return out
  }`
  const tag = Date.now().toString(36)
  const fresh = (kind: string, suffix: string) => encodeURIComponent(`/${kind}/${tag}${suffix}/`)
  const variants: [string, string][] = [
    ['import() as a module; HTTP cache, immutable (max-age=1y)', `programs=${fresh('prepared-v', 'a')}`],
    ['importScripts; HTTP cache, immutable (max-age=1y)', `pm=importScripts&programs=${fresh('prepared-v', 'b')}`],
    ['import() as a module; HTTP cache, no-cache (ETag revalidation each load)', `programs=${fresh('prepared-revalidate', 'c')}`],
    ['importScripts; HTTP cache, no-cache (ETag revalidation each load)', `pm=importScripts&programs=${fresh('prepared-revalidate', 'd')}`],
    ['importScripts; no-store (nothing cached)', `pm=importScripts&programs=${encodeURIComponent('/prepared-nocache/')}`],
    ['import() as a module; service worker, Cache Storage', `sw=1&programs=${fresh('sw-cache', 'e')}`],
    ['importScripts; service worker, Cache Storage', `pm=importScripts&sw=1&programs=${fresh('sw-cache', 'f')}`],
  ]
  for (const [name, query] of variants) {
    if (only && !name.includes(only)) continue
    const l = loadavg()[0]
    load(query)
    const first = inPage(LOADS, 6)
    // A second page load: caches that only become usable after a navigation show up here.
    load(query)
    const again = inPage(LOADS, 3)
    report(`program script (27.7 MB): ${name}`, l, {
      importScriptsMs: first.map((r: any) => Math.round(r.importScripts)),
      afterPageReloadMs: again.map((r: any) => Math.round(r.importScripts)),
      evaluateEntryMs: stats([...first, ...again].map((r: any) => r.entryReturned)),
      processTotalMs: [...first, ...again].map((r: any) => Math.round(r.total)),
      ran: [...first, ...again].every((r: any) => r.ready),
    })
  }
  load('')
}
