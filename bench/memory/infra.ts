#!/usr/bin/env bun
// Chrome's own memory-infra dump of an example's tab, which says what is inside
// `partition_alloc`, `malloc` and V8 (the shared browser-control relay does not deliver
// traces, so this launches a Chrome of its own: own profile in out/.run, own debugging
// port, headless, killed at the end).
//
//   bench/memory/serve.sh
//   bun bench/memory/infra.ts --example todo [--turns 2] [--idle 30] [--label x] [--port 4887]
//   bun bench/memory/infra.ts --example terminal
//   bun bench/memory/infra.ts --print bench/memory/out/infra-x.json [--depth 4] [--min 1]
//
// Output: out/infra-<label>.json { meta, points: [{ name, pid, rollup, allocators: { path: bytes } }] }
// and, on stdout, the allocator tree of the renderer that hosts the tab at each point (MB).
// A dump is taken at "open" (10 s after ready), after the turns, and after --idle seconds.
import { chromium } from 'playwright'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : (process.argv[i + 1] ?? 'true') }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mbOf = (bytes: number) => Math.round(bytes / 104857.6) / 10

function print(points: any[], depth: number, min: number) {
  for (const point of points) {
    console.log(`\n## ${point.name}: renderer ${point.pid}, PSS + swap ${mbOf((point.rollup.pss + point.rollup.swap) * 1024)} MB, RSS ${mbOf(point.rollup.rss * 1024)} MB`)
    const entries = Object.entries(point.allocators as Record<string, Record<string, number>>)
    const rows = entries.filter(([path, attrs]) => path.split('/').length <= depth && Math.max(attrs.size ?? 0, attrs.effective_size ?? 0) >= min * 1048576).sort(([a], [b]) => a.localeCompare(b))
    for (const [path, attrs] of rows) {
      const parts = path.split('/')
      const extra = Object.entries(attrs).filter(([k]) => !['size', 'effective_size'].includes(k) && /size|bytes/.test(k)).map(([k, v]) => `${k} ${mbOf(v)}`).join(', ')
      console.log(`${'  '.repeat(parts.length - 1)}${parts.at(-1)}  ${mbOf(attrs.size ?? 0)}${attrs.effective_size !== undefined && attrs.effective_size !== attrs.size ? ` (effective ${mbOf(attrs.effective_size)})` : ''}${extra ? `  [${extra}]` : ''}`)
    }
  }
}
if (arg('print')) {
  print(JSON.parse(readFileSync(arg('print')!, 'utf8')).points, Number(arg('depth', '4')), Number(arg('min', '1')))
  process.exit(0)
}

const example = arg('example', 'todo') as 'todo' | 'terminal'
const label = arg('label', example)!
const port = Number(arg('port', '4887'))
const todoPort = arg('todo-port', '4871')!, mockPort = arg('mock-port', '4872')!, termPort = arg('term-port', '4873')!
const url = arg('url', example === 'todo' ? `http://127.0.0.1:${todoPort}/` : `http://127.0.0.1:${termPort}/?model=${encodeURIComponent(`http://127.0.0.1:${mockPort}/v1`)}&diag=0`)!
const turns = Number(arg('turns', '2')), idle = Number(arg('idle', '30'))
const run = join(import.meta.dir, 'out', '.run')
mkdirSync(run, { recursive: true })
const profile = mkdtempSync(join(run, 'infra-chrome-'))
const chrome = Bun.spawn(['/opt/google/chrome/chrome', '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' })
const points: any[] = []
try {
  let browser
  for (let i = 0; ; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break } catch (e) { if (i > 50) throw e; await sleep(200) } }
  const context = browser.contexts()[0]!
  const page = context.pages()[0] ?? (await context.newPage())
  const field = (text: string, name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0)
  const rollup = (pid: number) => { const r = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'); return { rss: field(r, 'Rss'), pss: field(r, 'Pss'), swap: field(r, 'Swap') } }

  /** One detailed memory-infra dump of every process; returns per pid the allocator dumps, flattened. */
  async function dump(name: string) {
    const session = await browser!.newBrowserCDPSession()
    const events: any[] = []
    session.on('Tracing.dataCollected', (e: any) => events.push(...e.value))
    const done = new Promise<void>((resolve) => session.once('Tracing.tracingComplete', () => resolve()))
    await session.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } } } as any)
    const requested = await session.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed' } as any) as any
    await session.send('Tracing.end')
    await Promise.race([done, sleep(60000)])
    await session.detach()
    const byPid = new Map<number, Record<string, Record<string, number>>>()
    for (const event of events) {
      const allocators = event.args?.dumps?.allocators
      if (event.ph !== 'v' || !allocators) continue
      const into = byPid.get(event.pid) ?? byPid.set(event.pid, {}).get(event.pid)!
      for (const [path, value] of Object.entries(allocators as Record<string, any>)) {
        const attrs: Record<string, number> = {}
        for (const [key, attr] of Object.entries((value.attrs ?? {}) as Record<string, any>)) if (attr.type === 'scalar' && attr.units === 'bytes') attrs[key] = parseInt(attr.value, 16)
        into[path] = attrs
      }
    }
    // The tab's renderer: the process with the most V8 isolates (the runtime's workers), then the largest.
    const score = (allocators: Record<string, Record<string, number>>) => new Set(Object.keys(allocators).filter((path) => path.startsWith('v8/')).map((path) => path.split('/').slice(0, 3).join('/'))).size * 1e12 + Object.entries(allocators).filter(([path]) => !path.includes('/')).reduce((sum, [, attrs]) => sum + (attrs.size ?? 0), 0)
    const [pid, allocators] = [...byPid.entries()].sort((a, b) => score(b[1]) - score(a[1]))[0] ?? []
    if (!pid) throw Error(`no process dump in the trace (${events.length} events, success ${requested?.success})`)
    points.push({ name, pid, load: readFileSync('/proc/loadavg', 'utf8').split(' ')[0], rollup: rollup(pid), allocators })
    console.error(`[infra] ${name}: renderer ${pid}, ${Object.keys(allocators!).length} allocator dumps`)
  }

  await page.addInitScript(() => { try { localStorage.setItem('bat-memory-stats', '1') } catch {} })
  await page.goto(url, { waitUntil: 'load' })
  if (example === 'todo') {
    await page.getByRole('button', { name: 'Open editor', exact: true }).click()
    await page.waitForFunction(() => {
      const frame = document.querySelector('.todo-editor-preview iframe') as HTMLIFrameElement | null
      let preview = false; try { preview = !!frame?.contentDocument?.querySelector('main input:not(:disabled)') } catch {}
      return preview && !!document.querySelector('.todo-editor-chat textarea') && /^Ready/.test(document.querySelector('.todo-editor-panel > footer [role=status]')?.textContent ?? '')
    }, null, { timeout: 300000 })
  } else {
    await page.waitForFunction(() => { const bat = (window as any).batTerminal; return !!bat?.terminal && bat.terminal.screen().some((line: string) => /Ask anything|ctrl\+p commands/.test(line)) }, null, { timeout: 300000 })
  }
  await sleep(10000)
  await dump('open')
  const prompts = ['set the heading to "Memory A"', 'hello', 'Give this app a dark theme with a violet accent, and show how many todos are left under the list.', 'set the heading to "Memory B"', 'set the heading to "Memory C"', 'hello again'].slice(0, turns)
  for (const prompt of prompts) {
    if (example === 'todo') {
      const done = () => page.evaluate(() => (document.querySelector('.todo-editor-chat [role=log]') as HTMLElement | null)?.innerText.match(/SCRIPTED-[A-Z]+-DONE/g)?.length ?? 0)
      const before = await done()
      await page.locator('.todo-editor-chat textarea').first().click(); await page.keyboard.type(prompt); await page.keyboard.press('Enter')
      for (const end = Date.now() + 120000; (await done()) <= before && Date.now() < end; ) await sleep(200)
    } else {
      await page.locator('#terminal').click(); await sleep(300); await page.keyboard.type(prompt); await page.keyboard.press('Enter')
      let busy = false, idleSince = 0
      for (const end = Date.now() + 120000; Date.now() < end; ) {
        const working = await page.evaluate(() => (window as any).batTerminal.terminal.screen().some((line: string) => line.includes('esc interrupt')))
        if (working) { busy = true; idleSince = 0 } else if (busy) { idleSince ||= Date.now(); if (Date.now() - idleSince > 1500) break }
        await sleep(150)
      }
    }
    await sleep(1500)
  }
  if (prompts.length) { await sleep(3000); await dump('turns') }
  if (idle) { await sleep(idle * 1000); await dump('idle') }
  // --buffers: every ArrayBuffer of 256 KiB and more that each worker's heap holds, by size
  // (Runtime.queryObjects; it crashed Chrome on the terminal example's page, so ask for it there knowingly).
  if (arg('buffers')) {
    const found: any[] = []
    for (const worker of page.workers()) {
      const session = (worker as any)._connection.toImpl(worker).existingExecutionContext?.delegate?._client
      if (!session) continue
      const call = (method: string, params?: unknown) => Promise.race([session.send(method, params), sleep(30000).then(() => { throw Error(`${method} timed out`) })]) as Promise<any>
      try {
        const identity = (await call('Runtime.evaluate', { expression: '(() => { try { return (globalThis.process?.argv ?? []).slice(1, 3).join(" ") } catch { return "" } })()', returnByValue: true })).result.value
        const entry: any = { url: worker.url().replace(/^https?:\/\/[^/]+/, ''), identity, heap: await call('Runtime.getHeapUsage') }
        for (const [kind, prototype] of [['ArrayBuffer', 'Object.getPrototypeOf(new Uint8Array(1).buffer)'], ['views', 'Object.getPrototypeOf(Uint8Array.prototype)']] as const) {
          const proto = await call('Runtime.evaluate', { expression: prototype })
          const objects = await call('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId })
          const value = await call('Runtime.callFunctionOn', { objectId: objects.objects.objectId, returnByValue: true, functionDeclaration: 'function () { const seen = new Set(); const sizes = []; for (const o of this) { try { const b = ArrayBuffer.isView(o) ? o.buffer : o; if (seen.has(b)) continue; seen.add(b); if (typeof SharedArrayBuffer === "function" && b instanceof SharedArrayBuffer) continue; sizes.push(b.byteLength) } catch {} } return { count: sizes.length, total: sizes.reduce((a, b) => a + b, 0), large: sizes.filter(n => n >= 262144).sort((a, b) => b - a).slice(0, 40) } }' })
          await call('Runtime.releaseObject', { objectId: objects.objects.objectId }).catch(() => {})
          entry[kind] = value.result?.value ?? { count: 0, total: 0, large: [], failed: value.exceptionDetails?.exception?.description ?? value.exceptionDetails?.text ?? 'no value' }
        }
        found.push(entry)
      } catch (error) { found.push({ url: worker.url(), error: String(error) }) }
    }
    points.at(-1).buffers = found
    for (const entry of found) console.error(`[infra] ${entry.url?.slice(-24)} ${entry.identity ?? ''}: ${entry.error ?? `ArrayBuffers ${entry.ArrayBuffer.count}, ${mbOf(entry.ArrayBuffer.total)} MB, large: ${entry.ArrayBuffer.large.map(mbOf).join(' ')}; buffers behind views ${entry.views.count}, ${mbOf(entry.views.total)} MB, large: ${entry.views.large.map(mbOf).join(' ')}${entry.views.failed ? ` (${String(entry.views.failed).slice(0, 200)})` : ''}; backing stores ${mbOf(entry.heap.backingStorageSize)} MB`}`)
  }
  // --snapshot TEXT: a V8 heap snapshot of the worker whose argv contains TEXT, reduced to its
  // nodes of 512 KiB and more with the chain of objects that holds each (what a large buffer is).
  if (arg('snapshot')) {
    for (const worker of page.workers()) {
      const session = (worker as any)._connection.toImpl(worker).existingExecutionContext?.delegate?._client
      if (!session) continue
      const identity = (await session.send('Runtime.evaluate', { expression: '(() => { try { return (globalThis.process?.argv ?? []).slice(1, 3).join(" ") } catch { return "" } })()', returnByValue: true })).result.value as string
      if (!identity.includes(arg('snapshot')!)) continue
      const chunks: string[] = []
      const onChunk = (e: any) => chunks.push(e.chunk)
      session.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
      await session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false })
      session.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
      const snap = JSON.parse(chunks.join(''))
      const meta = snap.snapshot.meta, nf = meta.node_fields.length, ef = meta.edge_fields.length
      const nodeTypes = meta.node_types[0], edgeTypes = meta.edge_types[0]
      const [nType, nName, nSelf, nEdges] = ['type', 'name', 'self_size', 'edge_count'].map((f) => meta.node_fields.indexOf(f))
      const [eType, eName, eTo] = ['type', 'name_or_index', 'to_node'].map((f) => meta.edge_fields.indexOf(f))
      const count = snap.nodes.length / nf
      const retainer = new Map<number, { from: number; edge: string }>()
      let edge = 0
      for (let n = 0; n < count; n++) {
        for (let k = 0; k < snap.nodes[n * nf + nEdges]; k++, edge++) {
          const to = snap.edges[edge * ef + eTo] / nf, type = edgeTypes[snap.edges[edge * ef + eType]]
          if (type === 'weak' || retainer.has(to)) continue
          const name = snap.edges[edge * ef + eName]
          retainer.set(to, { from: n, edge: type === 'element' || type === 'hidden' ? `[${name}]` : String(snap.strings[name]).slice(0, 60) })
        }
      }
      const describe = (n: number) => `${nodeTypes[snap.nodes[n * nf + nType]]} ${String(snap.strings[snap.nodes[n * nf + nName]]).slice(0, 70)}`
      const large: any[] = []
      let total = 0
      for (let n = 0; n < count; n++) {
        const size = snap.nodes[n * nf + nSelf]
        total += size
        if (size < 524288) continue
        const chain: string[] = []
        for (let at = n, depth = 0; depth < 7 && retainer.has(at); depth++) { const r = retainer.get(at)!; chain.push(`${r.edge} of ${describe(r.from)}`); at = r.from }
        large.push({ mb: mbOf(size), node: describe(n), heldBy: chain })
      }
      large.sort((a, b) => b.mb - a.mb)
      points.at(-1).snapshot = { identity, nodes: count, totalMb: mbOf(total), large }
      console.error(`[infra] heap snapshot of ${identity}: ${count} nodes, ${mbOf(total)} MB; nodes of 0.5 MB and more:`)
      for (const item of large.slice(0, 25)) console.error(`[infra]   ${item.mb} MB  ${item.node}\n[infra]       ${item.heldBy.slice(0, 5).join('\n[infra]       ')}`)
    }
  }
  points.at(-1).runtime = await page.evaluate(() => (globalThis as any).__batMemory?.() ?? null).catch(() => null)
  await browser.close().catch(() => {})
} finally {
  chrome.kill()
  await chrome.exited
  rmSync(profile, { recursive: true, force: true })
}
const out = join(import.meta.dir, 'out', `infra-${label}.json`)
writeFileSync(out, JSON.stringify({ meta: { example, url, label, at: new Date().toISOString(), git: (await Bun.$`git -C ${import.meta.dir} rev-parse --short HEAD`.quiet().text()).trim() }, points }))
print(points, Number(arg('depth', '3')), Number(arg('min', '2')))
console.error(`[infra] wrote ${out}`)
