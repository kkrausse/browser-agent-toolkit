#!/usr/bin/env bun
// Memory footprint driver: opens an example in the already-running Chrome (browser-control
// CLI), walks it through fixed points and at each one records what the tab costs, from the
// operating system's side (/proc/<pid>/smaps of the renderer that hosts the tab and of the
// renderer that hosts its service worker) and from Chrome's side (CDP on the page and on
// every worker, `performance.measureUserAgentSpecificMemory()`, `navigator.storage.estimate()`).
// No model is called: the chat talks to examples/terminal-app/mock-model.ts.
//
//   bench/memory/serve.sh
//   bun bench/memory/run.ts --example todo --kind reopen --runs 3 --label todo-reopen
//   bun bench/memory/run.ts --example todo --kind first  --runs 2 --label todo-first
//   bun bench/memory/run.ts --example terminal --kind reopen --runs 2 --label terminal-reopen
//
//   reopen  the dependency image is already in this browser's OPFS; the workspace was reset
//           and opened once in another (closed) tab, so every run starts from the same state
//   first   origin storage (OPFS, service worker, Cache Storage, localStorage) emptied in
//           another (closed) tab first: the open downloads and unpacks the image
// Every run uses a new tab, and with it a new renderer process (checked: its pid must not
// have been seen in an earlier run).
//
// Points (todo):  loaded → open (idle 10 s after "chat ready") → turn1 (one scripted turn
// that reads and edits src/home.tsx; the preview hot-updates) → turns (five more turns,
// one of them the three-edit theme script) → idle (--idle seconds later, default 180, with
// a light sample every 30 s) → exited (the editor closed, page still open).
// The terminal example boots its runtime on page load, so it has no "loaded" point.
//
// At each point: a "pre" sample of the processes, then the browser-side capture (which ends
// by forcing a garbage collection in the page and in every worker), then a "post" sample.
// "pre" is what the tab holds when left alone; "post" is the floor after collection.
//
// Output: bench/memory/out/<label>.json  { meta, runs[] }
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : (process.argv[i + 1] ?? 'true')
}
const example = arg('example', 'todo') as 'todo' | 'terminal'
const kind = arg('kind', 'reopen') as 'reopen' | 'first'
const runs = Number(arg('runs', '1'))
const label = arg('label', `${example}-${kind}`)!
const idleSeconds = Number(arg('idle', '180'))
// Runtime.queryObjects (the Wasm memories and modules of each context, and the forced
// collection) crashed the renderer of the terminal example every time it was tried (Chrome
// 154, a segfault inside the chrome binary), so it is off there: its points have no "post"
// floor and its Wasm memories come from smaps alone.
const query = arg('query', example === 'todo' ? 'on' : 'off') === 'on'
const todoPort = arg('todo-port', '4871')!, mockPort = arg('mock-port', '4872')!, termPort = arg('term-port', '4873')!
// A hostname no other tab uses: Chrome gives the site a renderer process of its own.
const host = arg('host', example === 'todo' ? 'batmem-a.localhost' : 'batmem-b.localhost')!
const base = example === 'todo' ? `http://${host}:${todoPort}/` : `http://${host}:${termPort}/?model=${encodeURIComponent(`http://127.0.0.1:${mockPort}/v1`)}&diag=0`
const out = arg('out', join(import.meta.dir, 'out', `${label}.json`))!
const scratch = mkdtempSync(join(tmpdir(), 'bat-memory-'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const load = () => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number)
const log = (...parts: unknown[]) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...parts)

// ---------------------------------------------------------------- browser-control

async function control(...args: string[]): Promise<string> {
  const child = Bun.spawn(['browser-control', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [text, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(`browser-control ${args.slice(0, 3).join(' ')}: ${(err || text).slice(0, 800)}`)
  return text
}
let serial = 0
/** Run one Playwright snippet in a session's tab; its return value must be JSON-serialisable. Large results are left in `state` and read in pieces. */
async function execute<T = any>(session: string, body: string): Promise<T> {
  const file = join(scratch, `step-${++serial}.js`)
  writeFileSync(file, `const __value = await (async () => {\n${body}\n})();\nstate.__batmem = JSON.stringify(__value ?? null);\nreturn state.__batmem.length;`)
  const run = async (path: string) => {
    const text = await control('execute', '--json', '--session', session, '--file', path)
    const envelope = JSON.parse(text)
    if (!envelope.ok || envelope.isError) throw Error(`execute: ${JSON.stringify(envelope.error ?? envelope).slice(0, 1500)}`)
    return envelope.value
  }
  const length = Number(await run(file))
  let text = ''
  const piece = join(scratch, 'piece.js')
  for (let at = 0; at < length; at += 30000) {
    writeFileSync(piece, `return state.__batmem.slice(${at}, ${at + 30000})`)
    text += await run(piece)
  }
  return JSON.parse(text)
}

// ---------------------------------------------------------------- /proc

const renderers = () => readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number).filter((pid) => {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer') } catch { return false }
})
const cpuTicks = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(fields[11]) + Number(fields[12])
  } catch { return 0 }
}
const threadNames = (pid: number): Record<string, number> => {
  const names: Record<string, number> = {}
  try { for (const tid of readdirSync(`/proc/${pid}/task`)) { const name = readFileSync(`/proc/${pid}/task/${tid}/comm`, 'utf8').trim(); names[name] = (names[name] ?? 0) + 1 } } catch { /* gone */ }
  return names
}
/** The renderer whose CPU time rose most while `work` ran; undefined unless it stands clear of the second. */
async function busiest(candidates: number[], work: () => Promise<unknown>, minTicks: number): Promise<number | undefined> {
  const before = new Map(candidates.map((pid) => [pid, cpuTicks(pid)]))
  await work()
  const ranked = candidates.map((pid) => [pid, cpuTicks(pid) - before.get(pid)!] as const).sort((a, b) => b[1] - a[1])
  const [first, second] = ranked
  return first && first[1] >= minTicks && first[1] >= 2.5 * (second?.[1] ?? 0) ? first[0] : undefined
}
/** The renderer that hosts a session's tab: the one whose CPU time follows a pattern the tab is
 * made to produce, three times one second of one busy thread and one second of rest. Other
 * sessions' tabs are busy on this machine too (some on several cores), so "the busiest" is
 * not enough; a process has to match all six intervals. */
async function rendererOf(session: string): Promise<number | undefined> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidates = renderers()
    const on = new Map<number, number[]>(), off = new Map<number, number[]>()
    for (let cycle = 0; cycle < 3; cycle++) {
      // Sampling happens in the snippet's own process, around the burn itself.
      const a = new Map(candidates.map((pid) => [pid, cpuTicks(pid)]))
      const t0 = Date.now()
      await execute(session, burnCode)
      const elapsed = (Date.now() - t0) / 1000
      const b = new Map(candidates.map((pid) => [pid, cpuTicks(pid)]))
      await sleep(1000)
      for (const pid of candidates) {
        // Ticks per second of wall time while the snippet ran (one second of it is the burn), and while resting.
        ;(on.get(pid) ?? on.set(pid, []).get(pid)!).push((b.get(pid)! - a.get(pid)!) / elapsed)
        ;(off.get(pid) ?? off.set(pid, []).get(pid)!).push(cpuTicks(pid) - b.get(pid)!)
      }
      on.set(-cycle - 1, [elapsed])
    }
    const matches = candidates.filter((pid) => {
      const burns = on.get(pid)!, rests = off.get(pid)!
      return burns.every((ticks, i) => { const expected = 100 / on.get(-i - 1)![0]!; return ticks >= 0.6 * expected && ticks <= 1.6 * expected }) && rests.every((ticks) => ticks < 35)
    })
    if (matches.length === 1) return matches[0]
    await sleep(2000)
  }
  return undefined
}

interface Rollup { rss: number; pss: number; pssAnon: number; pssFile: number; pssShmem: number; privateDirty: number; swap: number; hwm: number; threads: number }
/** kB, from smaps_rollup and status. */
function rollup(pid: number): Rollup | undefined {
  try {
    const field = (text: string, name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0)
    const r = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'), s = readFileSync(`/proc/${pid}/status`, 'utf8')
    return { rss: field(r, 'Rss'), pss: field(r, 'Pss'), pssAnon: field(r, 'Pss_Anon'), pssFile: field(r, 'Pss_File'), pssShmem: field(r, 'Pss_Shmem'), privateDirty: field(r, 'Private_Dirty'), swap: field(r, 'Swap'), hwm: field(s, 'VmHWM'), threads: field(s, 'Threads') }
  } catch { return undefined }
}

interface Region { rss: number; pss: number; swap: number; size: number; maps: number }
interface WasmMemory { committedKb: number; rssKb: number; swapKb: number; reservedKb: number }
/** smaps by what a mapping is (Chrome names its anonymous mappings), and each Wasm memory:
 * a read-write mapping at a 4 GiB boundary of the V8 sandbox followed by a reservation of
 * at least 1 GiB. Its size is the memory's `buffer.byteLength`; its Rss is what was touched. */
function smaps(pid: number): { regions: Record<string, Region>; wasmMemories: WasmMemory[] } | undefined {
  let text: string
  try { text = readFileSync(`/proc/${pid}/smaps`, 'utf8') } catch { return undefined }
  const regions: Record<string, Region> = {}
  const maps: { start: bigint; perms: string; name: string; size: number; rss: number; pss: number; swap: number }[] = []
  let current: (typeof maps)[number] | undefined
  for (const line of text.split('\n')) {
    const head = /^([0-9a-f]+)-[0-9a-f]+ (\S+) \S+ \S+ \S+\s*(.*)$/.exec(line)
    if (head) {
      const path = head[3]!
      const name = !path ? 'anon (unnamed)' : path.startsWith('/') ? (path.includes('/chrome/chrome') || path.endsWith('/chrome') ? 'file: chrome binary' : path.startsWith('/memfd:') ? `shm: ${path.slice(7).replace(/ \(deleted\)$/, '')}` : 'file: other') : path
      maps.push(current = { start: BigInt('0x' + head[1]), perms: head[2]!, name, size: 0, rss: 0, pss: 0, swap: 0 })
      continue
    }
    const value = /^(Size|Rss|Pss|Swap):\s+(\d+)/.exec(line)
    if (value && current) current[value[1]!.toLowerCase() as 'size' | 'rss' | 'pss' | 'swap'] = Number(value[2])
  }
  const wasmMemories: WasmMemory[] = []
  maps.forEach((map, i) => {
    let name = map.name
    const next = maps[i + 1]
    if (name === '[anon:v8-sandbox]' && map.perms.startsWith('rw') && (map.start & 0xffffffffn) === 0n && next?.name === '[anon:v8-sandbox]' && next.perms.startsWith('---') && next.size >= 1 << 20) {
      wasmMemories.push({ committedKb: map.size, rssKb: map.rss, swapKb: map.swap, reservedKb: map.size + next.size })
      name = '[anon:v8-sandbox] wasm memories'
    }
    const region = (regions[name] ??= { rss: 0, pss: 0, swap: 0, size: 0, maps: 0 })
    region.rss += map.rss; region.pss += map.pss; region.swap += map.swap; region.size += map.size; region.maps++
  })
  // Keep what matters; fold the long tail of small mappings into one line.
  const kept: Record<string, Region> = {}, rest: Region = { rss: 0, pss: 0, swap: 0, size: 0, maps: 0 }
  for (const [name, region] of Object.entries(regions)) {
    if (region.rss + region.swap >= 1024 || name.startsWith('[anon:')) kept[name] = region
    else { rest.rss += region.rss; rest.pss += region.pss; rest.swap += region.swap; rest.size += region.size; rest.maps += region.maps }
  }
  kept['(mappings under 1 MB each)'] = rest
  return { regions: kept, wasmMemories: wasmMemories.sort((a, b) => b.committedKb - a.committedKb) }
}

const processSample = (pids: { main: number; sw?: number }, detail: boolean) => ({
  at: Date.now(), load: load(),
  main: { ...rollup(pids.main), threadNames: detail ? threadNames(pids.main) : undefined, ...(detail ? smaps(pids.main) : {}) },
  sw: pids.sw ? { ...rollup(pids.sw), ...(detail ? { regions: smaps(pids.sw)?.regions } : {}) } : undefined,
})

// ---------------------------------------------------------------- in the browser

/** Chrome's own numbers for the page and every worker. Ends with a forced collection everywhere.
 * Every wait in here is bounded: the relay cannot cancel a snippet that never settles. */
const captureCode = `
const QUERY = ${query};
const short = url => url.replace(/#.*$/, '').replace(/^https?:\\/\\/[^/]+/, '');
const cdp = async () => {
  if (state.batmemCdp) { try { await state.batmemCdp.send('Runtime.evaluate', { expression: '1' }); return state.batmemCdp; } catch {} }
  state.batmemCdp = await context.newCDPSession(page);
  await state.batmemCdp.send('Performance.enable');
  return state.batmemCdp;
};
const pageSession = await cdp();
const targets = [{ kind: 'page', url: short(page.url()), session: pageSession }];
for (const worker of page.workers()) {
  // Playwright attached to every worker already; this is its CDP session for that worker.
  const session = worker._connection.toImpl(worker).existingExecutionContext?.delegate?._client;
  if (session) targets.push({ kind: 'worker', url: short(worker.url()), session });
}
const call = (session, method, params) => Promise.race([session.send(method, params), new Promise((_, no) => setTimeout(() => no(Error(method + ' timed out')), 20000))]);
const evaluate = async (session, expression) => (await call(session, 'Runtime.evaluate', { expression, returnByValue: true })).result.value;
const instances = async (session, prototype, describe) => {
  const proto = await call(session, 'Runtime.evaluate', { expression: prototype });
  const found = await call(session, 'Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
  const value = await call(session, 'Runtime.callFunctionOn', { objectId: found.objects.objectId, functionDeclaration: describe, returnByValue: true });
  await call(session, 'Runtime.releaseObject', { objectId: found.objects.objectId }).catch(() => {});
  return value.result.value;
};
const result = { targets: [], errors: [] };
const attempt = async (what, run) => { try { return await run(); } catch (error) { result.errors.push(what + ': ' + String(error.message ?? error).slice(0, 200)); return undefined; } };
for (const target of targets) {
  const entry = { kind: target.kind, url: target.url };
  entry.identity = await attempt('identity ' + target.url, () => evaluate(target.session, "(() => { try { const p = globalThis.process; return { name: typeof name === 'string' ? name : '', argv: p && p.argv ? p.argv.slice(0, 5).map(String) : null, pid: p ? p.pid : null, title: p ? p.title : null } } catch (e) { return { error: String(e) } } })()"));
  entry.heap = await attempt('heap ' + target.url, () => call(target.session, 'Runtime.getHeapUsage'));
  result.targets.push(entry);
}
result.metrics = await attempt('metrics', async () => Object.fromEntries((await call(pageSession, 'Performance.getMetrics')).metrics.filter(m => /^(JSHeap|Documents|Frames|Nodes|WorkerGlobalScopes|ArrayBufferContents|Resources|JSEventListeners)/.test(m.name)).map(m => [m.name, m.value])));
result.page = await page.evaluate(async () => ({
  isolated: crossOriginIsolated,
  performanceMemory: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null,
  storage: await navigator.storage.estimate(),
  serviceWorkers: (await navigator.serviceWorker.getRegistrations()).map(r => ({ scope: new URL(r.scope).pathname, state: (r.active ?? r.waiting ?? r.installing)?.state })),
  frames: [...document.querySelectorAll('iframe')].map(f => { try { return f.contentWindow.location.pathname } catch { return '(cross-origin)' } }),
}));
result.opfs = await attempt('opfs', () => page.evaluate(() => Promise.race([(async () => {
  // Sizes of what the origin keeps in OPFS, by top-level entry. A file a worker holds open exclusively cannot be read: counted as locked.
  const walk = async (dir, into, depth) => { for await (const [name, handle] of dir.entries()) { if (handle.kind === 'directory') { if (depth < 6) await walk(handle, into, depth + 1) } else { try { into.bytes += (await handle.getFile()).size; into.files++ } catch { into.locked++ } } } };
  const top = {};
  for await (const [name, handle] of (await navigator.storage.getDirectory()).entries()) {
    const into = top[name] = { kind: handle.kind, bytes: 0, files: 0, locked: 0 };
    if (handle.kind === 'directory') await walk(handle, into, 1); else { try { into.bytes = (await handle.getFile()).size; into.files = 1 } catch { into.locked = 1 } }
  }
  return top;
})(), new Promise((_, no) => setTimeout(() => no(Error('no answer in 30 s')), 30000))])));
const measured = await attempt('measureUserAgentSpecificMemory', () => page.evaluate(() => Promise.race([performance.measureUserAgentSpecificMemory(), new Promise((_, no) => setTimeout(() => no(Error('no answer in 60 s')), 60000))])));
if (measured) result.userAgentSpecificMemory = { bytes: measured.bytes, breakdown: measured.breakdown.filter(b => b.bytes).map(b => ({ bytes: b.bytes, types: b.types, attribution: b.attribution.map(a => ({ scope: a.scope, url: short(a.url) })) })) };
// Every WebAssembly.Memory and Module each context can reach. Runtime.queryObjects collects
// garbage in that context first, which is the forced collection of this capture (the relay
// does not pass HeapProfiler.collectGarbage).
if (QUERY) for (const [i, target] of targets.entries()) {
  const entry = result.targets[i];
  entry.memories = await attempt('memories ' + target.url, () => instances(target.session, 'WebAssembly.Memory.prototype', 'function () { return this.map(m => ({ bytes: m.buffer.byteLength, shared: typeof SharedArrayBuffer === "function" && m.buffer instanceof SharedArrayBuffer })) }'));
  entry.modules = await attempt('modules ' + target.url, () => instances(target.session, 'WebAssembly.Module.prototype', 'function () { return this.map(m => ({ exports: WebAssembly.Module.exports(m).length, imports: WebAssembly.Module.imports(m).length })) }'));
}
await page.waitForTimeout(1500);
for (const [i, target] of targets.entries()) result.targets[i].heapAfterGc = await attempt('heap ' + target.url, () => call(target.session, 'Runtime.getHeapUsage'));
return result;
`

const burnCode = `await page.evaluate(() => { const end = performance.now() + 1000; let x = 0; while (performance.now() < end) x += Math.sqrt(x + 1); return x }); return true;`
/** Requests the service worker has to answer: the preview frame's own address, which it serves. */
const swBurnCode = () => `await page.evaluate(async () => { const path = document.querySelector('iframe').contentWindow.location.href; for (let i = 0; i < 40; i++) await Promise.all(Array.from({ length: 10 }, () => fetch(path, { cache: 'no-store' }).then(r => r.arrayBuffer(), () => 0))) }); return true;`

const clearStorageCode = `
await page.goto(${JSON.stringify(base)}.replace(/\\?.*$/, '') + '${example === 'todo' ? '' : 'sw.js'}');
await page.evaluate(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
  const root = await navigator.storage.getDirectory();
  for (let attempt = 0; ; attempt++) {
    try { for await (const name of root.keys()) await root.removeEntry(name, { recursive: true }); break; }
    catch (e) { if (attempt > 50) throw e; await new Promise(r => setTimeout(r, 200)); }
  }
  localStorage.clear();
});
return await page.evaluate(() => navigator.storage.estimate());
`

// ---- the TODO example
const todo = {
  load: `await page.setViewportSize({ width: 1280, height: 800 }); await page.goto(${JSON.stringify(base)}, { waitUntil: 'load' }); await page.getByRole('button', { name: 'Open editor', exact: true }).waitFor(); await page.bringToFront(); return { url: page.url(), isolated: await page.evaluate(() => crossOriginIsolated) };`,
  reset: `await page.getByRole('button', { name: 'Reset workspace', exact: true }).click(); await page.locator('aside [role=status]').filter({ hasText: /^\\s*Workspace reset\\.$/ }).waitFor({ timeout: 30000 }); await page.reload({ waitUntil: 'load' }); await page.getByRole('button', { name: 'Open editor', exact: true }).waitFor(); return true;`,
  open: `
const started = Date.now();
await page.getByRole('button', { name: 'Open editor', exact: true }).click();
for (;;) {
  const s = await page.evaluate(() => {
    const frame = document.querySelector('.todo-editor-preview iframe');
    let preview = false; try { preview = !!frame?.contentDocument?.querySelector('main input#title:not(:disabled)') } catch {}
    return { preview, composer: !!document.querySelector('.todo-editor-chat textarea'), status: document.querySelector('.todo-editor-panel > footer [role=status]')?.textContent ?? '', error: document.querySelector('.todo-editor-panel > footer [role=alert]')?.textContent ?? '' };
  });
  if (s.preview && s.composer && /^Ready/.test(s.status)) break;
  if (s.error) throw Error('The editor failed to open: ' + s.error);
  if (Date.now() - started > 300000) throw Error('The editor was not ready within 300 s: ' + JSON.stringify(s));
  await page.waitForTimeout(100);
}
return { openMs: Date.now() - started, timings: await page.evaluate(() => window.__editorTimings?.current ?? {}) };`,
  turn: (prompt: string) => `
const panel = () => page.evaluate(() => {
  const chat = document.querySelector('.todo-editor-chat'), log = chat?.querySelector('[role=log]');
  let heading = null; try { heading = document.querySelector('.todo-editor-preview iframe').contentDocument.querySelector('h1')?.textContent ?? null } catch {}
  return { assistants: log?.querySelectorAll('[aria-label="assistant message"]').length ?? 0, chatStatus: chat?.querySelector('.oc-connection [role=status]')?.textContent ?? '',
    alerts: [...(chat?.querySelectorAll('[role=alert]') ?? [])].map(e => e.textContent.slice(0, 300)), heading,
    tools: log?.innerText.match(/\\b(read|edit|write|grep|glob|runJavascript)\\s*(completed|error)/g) ?? [], done: (log?.innerText.match(/SCRIPTED-[A-Z]+-DONE/g) ?? []).length };
});
const before = await panel();
await page.locator('.todo-editor-chat textarea').first().click();
await page.keyboard.type(${JSON.stringify(prompt)});
await page.keyboard.press('Enter');
const started = Date.now();
let s, busy = false;
for (;;) {
  s = await panel();
  if (s.chatStatus && s.chatStatus !== 'Ready') busy = true;
  if (s.alerts.length > before.alerts.length) throw Error('The chat reported: ' + s.alerts.at(-1));
  if (s.done > before.done && s.chatStatus === 'Ready') break;
  if (Date.now() - started > 120000) throw Error('The assistant did not finish within 120 s: ' + JSON.stringify(s));
  await page.waitForTimeout(150);
}
await page.waitForTimeout(1500);
s = await panel();
return { replyMs: Date.now() - started, heading: s.heading, tools: s.tools.length - before.tools.length, assistants: s.assistants };`,
  exit: `await page.getByRole('button', { name: 'Exit' }).click(); await page.waitForFunction(() => !document.querySelector('.todo-editor'), null, { timeout: 30000 }); return true;`,
}

// ---- the terminal example
const terminalReady = `
const ready = async limit => {
  const deadline = Date.now() + limit;
  for (;;) {
    const t = await page.evaluate(() => {
      const bat = window.batTerminal;
      let app = false; try { app = !!document.querySelector('#app')?.contentDocument?.querySelector('main input:not([type=checkbox]):not(:disabled)') } catch {}
      return { app, mounted: !!bat?.terminal, screen: bat?.terminal ? bat.terminal.screen().map(l => l.trimEnd()).filter(Boolean) : [], status: document.querySelector('#status')?.textContent ?? '', failed: !!document.querySelector('#status.error') };
    });
    if (t.failed) throw Error('The page failed to start: ' + t.status);
    if (t.mounted && t.app && t.screen.some(line => /Ask anything|ctrl\\+p commands/.test(line))) return t;
    if (Date.now() > deadline) throw Error('The page was not ready within ' + limit / 1000 + ' s: ' + JSON.stringify({ status: t.status, screen: t.screen.slice(-4) }));
    await page.waitForTimeout(100);
  }
};`
const terminal = {
  open: (reset: boolean) => `${terminalReady}
await page.setViewportSize({ width: 1280, height: 800 });
const started = Date.now();
await page.goto(${JSON.stringify(base)} + ${JSON.stringify(reset ? '&reset=1' : '')}, { waitUntil: 'load' });
await page.bringToFront();
await ready(300000);
return { openMs: Date.now() - started, isolated: await page.evaluate(() => crossOriginIsolated) };`,
  turn: (prompt: string) => `
const screen = () => page.evaluate(() => ({ lines: window.batTerminal.terminal.screen().map(l => l.trimEnd()).filter(Boolean), heading: (() => { try { return document.querySelector('#app').contentDocument.querySelector('h1')?.textContent ?? null } catch { return null } })() }));
await page.locator('#terminal').click();
await page.waitForTimeout(300);
await page.keyboard.type(${JSON.stringify(prompt)});
await page.keyboard.press('Enter');
const started = Date.now();
// The client shows "esc interrupt" for as long as the agent works.
let t, busy = false, idleSince = 0;
for (;;) {
  t = await screen();
  if (t.lines.some(line => line.includes('esc interrupt'))) { busy = true; idleSince = 0; }
  else if (busy) { idleSince ||= Date.now(); if (Date.now() - idleSince > 1500) break; }
  else if (Date.now() - started > 20000) throw Error('The agent never started working: ' + JSON.stringify(t.lines.slice(-8)));
  if (Date.now() - started > 120000) throw Error('The agent did not finish within 120 s: ' + JSON.stringify(t.lines.slice(-8)));
  await page.waitForTimeout(150);
}
await page.waitForTimeout(1500);
t = await screen();
return { replyMs: Date.now() - started, heading: t.heading, done: t.lines.some(line => /SCRIPTED-[A-Z]+-DONE/.test(line)) };`,
}

// ---------------------------------------------------------------- one run

const seenPids = new Set<number>()
const turnsAfterFirst = ['hello', 'Give this app a dark theme with a violet accent, and show how many todos are left under the list.', 'set the heading to "Memory B"', 'set the heading to "Memory C"', 'hello again']

/** Wait until a renderer has exited (a service worker keeps its process for about half a minute after the tab). */
async function gone(pid: number | undefined, limitMs = 150_000): Promise<boolean> {
  for (const end = Date.now() + limitMs; pid && rollup(pid) && Date.now() < end; ) await sleep(1000)
  return !pid || !rollup(pid)
}
/** Steps in a tab that is closed again; returns once that tab's renderer has exited, so the measured tab cannot inherit it. */
async function throwaway(name: string, steps: (session: string, identify: () => Promise<void>) => Promise<void>) {
  await control('session', 'new', name)
  let pid: number | undefined
  try {
    // Which renderer the tab uses is asked while it still shows the site.
    await steps(name, async () => { pid = await rendererOf(name) })
  } finally { await control('session', 'delete', name).catch(() => {}) }
  log(`preparation tab closed; waiting for its renderer ${pid} to exit`)
  if (!(await gone(pid))) log(`the preparation tab's renderer ${pid} is still alive`)
  await sleep(1000)
}

async function oneRun(index: number): Promise<any> {
  // 1. The starting state, made in a tab that is closed again.
  await throwaway(`${label}-prep`, async (session, identify) => {
    if (kind === 'first') {
      const left = await execute(session, clearStorageCode)
      log(`run ${index}: origin storage emptied (${left.usage} bytes left)`); await identify()
    } else if (example === 'todo') {
      await execute(session, todo.load); await execute(session, todo.reset); await identify(); await execute(session, todo.open); await sleep(2000); await execute(session, todo.exit)
    } else {
      // Leave the page before the tab goes: closing it while its runtime runs left its renderer alive here.
      await execute(session, terminal.open(true)); await sleep(2000); await identify(); await execute(session, `await page.goto('about:blank'); await page.waitForTimeout(2000); return true;`)
    }
  })

  const session = `${label}-${index}`
  log(`run ${index}: starting state made; opening the measured tab`)
  await control('session', 'new', session)
  const run: any = { index, example, kind, startedAt: new Date().toISOString(), points: [], light: [], events: [] }
  const pids: { main: number; sw?: number } = { main: 0 }
  // Peak between points, from a sample of the main renderer every 500 ms.
  let peak = { rss: 0, pss: 0 }
  const sampler = setInterval(() => { if (!pids.main) return; const r = rollup(pids.main); if (r) { peak.rss = Math.max(peak.rss, r.rss + r.swap); peak.pss = Math.max(peak.pss, r.pss + r.swap) } }, 500)
  const point = async (name: string) => {
    const pre = processSample(pids, true)
    const browser = await execute(session, captureCode)
    await sleep(1000)
    const post = processSample(pids, true)
    run.points.push({ name, peakSincePreviousPoint: peak, pre, browser, post })
    peak = { rss: 0, pss: 0 }
    const mb = (kb?: number) => Math.round((kb ?? 0) / 1024)
    log(`run ${index} ${name}: main rss ${mb(pre.main.rss)} → ${mb(post.main.rss)} MB, pss ${mb(pre.main.pss)} → ${mb(post.main.pss)} MB, sw pss ${mb(pre.sw?.pss)} MB, workers ${browser.targets.length - 1}, kernel ${mb((browser.targets[0]?.memories?.find((m: any) => m.shared)?.bytes ?? 0) / 1024)} MB committed, load ${pre.load[0]}${browser.errors.length ? `, errors: ${browser.errors.join('; ')}` : ''}`)
  }
  const identifyMain = async () => {
    const pid = await rendererOf(session)
    if (!pid) throw Error('could not tell which renderer hosts the tab')
    if (seenPids.has(pid)) run.events.push(`renderer ${pid} was already used by an earlier run`)
    seenPids.add(pid); pids.main = pid; run.mainPid = pid
  }
  const identifySw = async () => {
    // The site has a renderer of its own, so a service-worker thread in it is this page's.
    run.swInMainRenderer = Object.keys(threadNames(pids.main)).some((name) => name.startsWith('ServiceWorker'))
    if (!run.swInMainRenderer) {
      const candidates = renderers().filter((pid) => pid !== pids.main && Object.keys(threadNames(pid)).some((name) => name.startsWith('ServiceWorker')))
      pids.sw = await busiest(candidates, () => execute(session, swBurnCode()), 8)
    }
    run.swPid = pids.sw ?? null
    // The runtime's workers are threads of the tab's renderer: none there means the wrong process is being watched.
    if (!(threadNames(pids.main).DedicatedWorker >= 3)) throw Error(`renderer ${pids.main} has no worker threads after the open: not the tab's process`)
  }
  try {
    if (example === 'todo') {
      await execute(session, todo.load)
      await identifyMain()
      await sleep(5000)
      await point('loaded')
      run.open = await execute(session, todo.open)
      await identifySw()
      await sleep(10000)
      await point('open')
      run.turn1 = await execute(session, todo.turn('set the heading to "Memory A"'))
      await sleep(3000)
      await point('turn1')
      run.turns = []
      for (const prompt of turnsAfterFirst) run.turns.push(await execute(session, todo.turn(prompt)))
      await sleep(3000)
      await point('turns')
    } else {
      // The runtime boots on page load (and the page reloads itself once under its service
      // worker's headers), so the renderer is identified after the open.
      run.open = await execute(session, terminal.open(false))
      await sleep(4000)
      await identifyMain()
      await identifySw()
      await sleep(10000)
      await point('open')
      run.turn1 = await execute(session, terminal.turn('set the heading to "Memory A"'))
      await sleep(3000)
      await point('turn1')
      run.turns = []
      for (const prompt of turnsAfterFirst) run.turns.push(await execute(session, terminal.turn(prompt)))
      await sleep(3000)
      await point('turns')
    }
    for (let waited = 0; waited < idleSeconds; waited += 30) {
      await sleep(30000)
      const sample = processSample(pids, false)
      run.light.push({ secondsIdle: waited + 30, load: sample.load, main: sample.main, sw: sample.sw, wasmMemories: smaps(pids.main)?.wasmMemories })
    }
    await point('idle')
    if (example === 'todo') { await execute(session, todo.exit); await sleep(5000); await point('exited') }
  } catch (error) {
    run.error = String((error as Error).message ?? error).slice(0, 2000)
    log(`run ${index} failed: ${run.error}`)
  } finally {
    clearInterval(sampler)
    await control('session', 'delete', session).catch(() => {})
  }
  run.processesGoneAfterClose = { main: await gone(pids.main), sw: await gone(pids.sw, 60_000) }
  return run
}

const meta = {
  label, example, kind, base, idleSeconds, queryObjects: query, startedAt: new Date().toISOString(),
  chrome: (await Bun.$`/opt/google/chrome/chrome --version`.quiet().nothrow().text()).trim(),
  kernel: (await Bun.$`uname -sr`.quiet().text()).trim(),
  cores: navigator.hardwareConcurrency,
  memory: readFileSync('/proc/meminfo', 'utf8').split('\n').filter((line) => /^(MemTotal|MemAvailable|SwapTotal|SwapFree):/.test(line)).join('; ').replace(/\s+/g, ' '),
  git: (await Bun.$`git -C ${import.meta.dir} rev-parse --short HEAD`.quiet().text()).trim(),
  units: 'process figures in kB (smaps_rollup, smaps, status); browser figures in bytes',
}
mkdirSync(dirname(out), { recursive: true })
const results: any[] = []
for (let i = 1; i <= runs; i++) {
  results.push(await oneRun(i))
  writeFileSync(out, JSON.stringify({ meta: { ...meta, finishedAt: new Date().toISOString(), loadAtEnd: load() }, runs: results }, null, 1))
}
log(`wrote ${out}`)
process.exit(results.some((run) => run.error) ? 1 : 0)
