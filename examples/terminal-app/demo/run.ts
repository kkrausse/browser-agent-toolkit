#!/usr/bin/env bun
// The demo video's scenario, driven in a real Chrome through the `browser-control` CLI and
// checked at every step. The page must already be served: the public build on its shelf, or
// a development build beside its mock (`bun mock-model.ts`, whose "dark theme" script answers
// this prompt). Same shape as `../todo-app/demo/run.ts`.
//
//   bun demo/run.ts --base https://<host>/artifacts/bat-demo-staging/ [--session bat-terminal-demo]
//                   [--runs 1] [--record out.mp4] [--slow] [--prompt "…"] [--reply-timeout 300]
//                   [--query "tunnel=0&model=http://127.0.0.1:4311/v1"]   (page parameters for every load)
//
//   1. warm: open the page once, so that the browser has its files, then an empty tab (not recorded).
//   2. open: `?reset=1`, a fresh workspace; wait for the app in the frame and for the
//      terminal client's prompt. Recorded from the navigation on, in real time.
//   3. todos: in the app add "Record a demo GIF" and "Water the plants", tick the second.
//   4. prompt: click the terminal, type the prompt, Enter; wait until the client's
//      "esc interrupt" has come and gone.
//   5. the agent must have changed a source file, the app must have turned dark without a
//      reload of its frame and show "1 … left"; in it add "Ship it" (2 left) and tick the
//      first checkbox (1 left).
//
// With the public build this is one conversation with a free hosted model per run: takes
// differ, and HTTP 429 answers (which OpenCode retries by itself) are counted in the result.
// Prints one JSON line per run and exits 1 if any run failed. `--record` captures the run as
// mp4 (1280x800, CDP) with the step marks beside it (`<out>.marks.json`) for `demo/gif.ts`;
// with `--runs` over 1 the files are `<out>-1.mp4`, …. `--slow` types and pauses like a person.
//
// `--webkit` runs the same steps in Playwright's WebKit instead (`browser-control` is
// Chromium-only): headless unless `--headed`, a profile directory that persists for the
// invocation (`--profile DIR` to choose it; WebKit refuses OPFS sync access handles in an
// ephemeral context), no `--record`. `--shot out.png` saves the page at the end of each run.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1] ?? '' }
const has = (name: string) => process.argv.includes(`--${name}`)
const base = (flag('base') ?? `http://127.0.0.1:${process.env.PORT ?? 4310}/`).replace(/\/?$/, '/')
const session = flag('session') ?? 'bat-terminal-demo'
const runs = Number(flag('runs') ?? 1)
const record = flag('record')
const prompt = flag('prompt') ?? 'Give this app a dark theme with a violet accent, and show how many todos are left under the list.'
const query = flag('query') ?? ''
const replyTimeout = Number(flag('reply-timeout') ?? 300)
const scratch = mkdtempSync(join(tmpdir(), 'bat-terminal-demo-'))
const inWebKit = has('webkit')
if (inWebKit && record) throw Error('--record needs Chrome: leave out --webkit')

/** `--webkit`: one page of a persistent WebKit context, and the `state` the steps share. */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<any>
const local = inWebKit
  ? await (async () => {
      const { webkit } = await import('playwright')
      const context = await webkit.launchPersistentContext(flag('profile') ?? mkdtempSync(join(tmpdir(), 'bat-terminal-webkit-')), { headless: !has('headed'), viewport: { width: 1280, height: 800 } })
      const problems: string[] = []
      const page = context.pages()[0] ?? (await context.newPage())
      page.on('pageerror', e => problems.push(`pageerror: ${String(e).slice(0, 300)}`))
      page.on('crash', () => problems.push('the page crashed'))
      page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`) })
      return { context, page, state: {} as Record<string, unknown>, problems }
    })()
  : undefined

/** Run one Playwright snippet in the session's tab. `page` and a persistent `state` are in scope. */
async function execute(name: string, body: string): Promise<any> {
  if (local) return new AsyncFunction('page', 'state', body)(local.page, local.state)
  const file = join(scratch, `${name}.js`)
  writeFileSync(file, body)
  const child = Bun.spawn(['browser-control', 'execute', '--json', '--session', session, '--file', file], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  let envelope: any
  try { envelope = JSON.parse(out) } catch { throw Error(`${name}: browser-control gave no result (exit ${code}): ${(err || out).slice(0, 600)}`) }
  if (!envelope.ok || envelope.isError) throw Error(`${name}: ${envelope.error?.message ?? envelope.text ?? 'failed'}`.slice(0, 1200))
  return envelope.value
}
async function control(...args: string[]): Promise<string> {
  const child = Bun.spawn(['browser-control', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(`browser-control ${args.join(' ')}: ${(err || out).slice(0, 600)}`)
  return out
}

const settings = { base, query, prompt, slow: has('slow'), replyTimeout: replyTimeout * 1000 }
const prelude = `
const demo = ${JSON.stringify(settings)};
const mark = name => (state.marks ??= []).push([name, Date.now()]);
const pause = ms => page.waitForTimeout(demo.slow ? ms : Math.min(ms, 100));
const keys = { delay: demo.slow ? 40 : 0 };
const frame = page.frameLocator('#app');
const sources = ['/workspace/src/style.css', '/workspace/src/App.tsx'];
// The page's own view of itself: the terminal's screen as text, its log, the agent's files.
const terminal = () => page.evaluate(async sources => {
  const bat = window.batTerminal, decoder = new TextDecoder();
  const screen = bat?.terminal ? bat.terminal.screen().map(line => line.trimEnd()).filter(Boolean) : [];
  const files = {};
  if (bat?.runtime) for (const path of sources) files[path] = await bat.runtime.fs.readFile(path).then(bytes => decoder.decode(bytes), () => null);
  return {
    mounted: !!bat?.terminal, screen, files, log: bat?.log ?? [],
    status: document.querySelector('#status')?.textContent ?? '', failed: !!document.querySelector('#status.error'),
    title: document.querySelector('#title')?.textContent ?? '',
  };
}, sources);
// What the scenario is about, read from the app inside the frame.
const app = () => page.evaluate(() => {
  const frame = document.querySelector('#app');
  const doc = frame?.contentDocument, win = frame?.contentWindow;
  if (!doc?.body || !doc.querySelector('main')) return null;
  const luminance = el => { const m = /rgba?\\(([\\d.]+), ([\\d.]+), ([\\d.]+)(?:, ([\\d.]+))?/.exec(win.getComputedStyle(el).backgroundColor); return !m || m[4] === '0' ? null : (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255; };
  const text = doc.querySelector('main').innerText;
  const left = /(\\d+)\\s*(?:of\\s*\\d+\\s*)?(?:todos?|items?|tasks?)?\\s*(?:left|remaining|to go)/i.exec(text) ?? /(?:left|remaining)\\D{0,12}(\\d+)/i.exec(text);
  return {
    ready: !!doc.querySelector('main input:not([type=checkbox]):not(:disabled)'),
    background: luminance(doc.body) ?? luminance(doc.documentElement) ?? 1,
    left: left ? Number(left[1]) : null, text: text.slice(0, 600),
    todos: [...doc.querySelectorAll('main li')].map(li => [li.innerText.replace(/\\s*Delete\\s*$/, '').trim(), !!li.querySelector('input[type=checkbox]:checked')]),
    sameDocument: win.__demoDocument === true,
  };
});
const ready = async limit => {
  const deadline = Date.now() + limit;
  for (;;) {
    const t = await terminal(), a = await app();
    if (t.failed) throw Error('The page failed to start: ' + t.status);
    if (t.mounted && a?.ready && t.screen.some(line => /Ask anything|ctrl\\+p commands/.test(line))) return { t, a };
    if (Date.now() > deadline) throw Error('The page was not ready within ' + limit / 1000 + ' s: ' + JSON.stringify({ status: t.status, screen: t.screen.slice(-4), app: a?.text?.slice(0, 80) }));
    await page.waitForTimeout(100);
  }
};
`

const steps = {
  warm: `${prelude}
state.marks = [];
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(demo.base + (demo.query && '?' + demo.query), { waitUntil: 'load' });
await ready(180000);
// The recording starts on an empty tab, not on what an earlier run left in the workspace.
await page.goto('about:blank');
return { viewport: page.viewportSize() };`,

  open: `${prelude}
mark('start');
const started = Date.now();
await page.goto(demo.base + '?reset=1' + (demo.query && '&' + demo.query), { waitUntil: 'load' });
const { t, a } = await ready(120000);
mark('ready');
// Survives hot updates, not a reload of the frame.
await page.evaluate(() => { document.querySelector('#app').contentWindow.__demoDocument = true; });
state.before = t.files;
await pause(1500);
return { openMs: state.marks.at(-1)[1] - started, title: t.title, before: a, log: t.log };`,

  todos: `${prelude}
const box = frame.locator('main input:not([type=checkbox])').first();
for (const title of ['Record a demo GIF', 'Water the plants']) {
  await box.click();
  await page.keyboard.type(title, keys);
  await pause(250);
  await page.keyboard.press('Enter');
  await frame.getByRole('checkbox', { name: title }).waitFor();
  await pause(500);
}
await frame.getByRole('checkbox', { name: 'Water the plants' }).click();
await frame.getByRole('checkbox', { name: 'Water the plants', checked: true }).waitFor();
await pause(900);
return { before: await app() };`,

  prompt: `${prelude}
await page.locator('#terminal').click();
await pause(400);
await page.keyboard.type(demo.prompt, { delay: demo.slow ? 28 : 0 });
await pause(500);
mark('send');
await page.keyboard.press('Enter');
const started = Date.now();
// The client shows "esc interrupt" for as long as the agent works.
let t, busy = false, idleSince = 0;
for (;;) {
  t = await terminal();
  if (t.screen.some(line => line.includes('esc interrupt'))) { busy = true; idleSince = 0; }
  else if (busy) { idleSince ||= Date.now(); if (Date.now() - idleSince > 1500) break; }
  else if (Date.now() - started > 15000) throw Error('The agent never started working: ' + JSON.stringify(t.screen.slice(-8)));
  if (Date.now() - started > demo.replyTimeout) throw Error('The agent did not finish within ' + demo.replyTimeout / 1000 + ' s: ' + JSON.stringify(t.screen.slice(-8)));
  await page.waitForTimeout(150);
}
state.marks.push(['reply', idleSince]);
await pause(1500);
const fetches = t.log.filter(line => line.includes('[bat fetch]'));
return {
  replyMs: idleSince - started, changed: sources.filter(path => t.files[path] !== state.before[path]),
  rateLimited: fetches.filter(line => line.includes('HTTP 429')).length,
  otherFailures: fetches.filter(line => !/HTTP (200|429)/.test(line)).map(line => line.slice(line.indexOf('[bat fetch]')).slice(0, 200)),
  // The client's own line under the prompt box: "Build · <model> <provider>".
  model: t.screen.findLast(line => /^[\\s┃]*Build · /.test(line))?.replace(/^[\\s┃]*Build · /, ''),
  screen: t.screen.slice(-14), after: await app(),
};`,

  preview: `${prelude}
const expectLeft = async (n, what) => {
  const deadline = Date.now() + 10000;
  for (;;) {
    const a = await app();
    if (a?.left === n) return a;
    if (Date.now() > deadline) throw Error(what + ': expected ' + n + ' left, the app shows: ' + JSON.stringify(a?.text));
    await page.waitForTimeout(100);
  }
};
await expectLeft(1, 'after the change');
await pause(1200);
await frame.locator('main input:not([type=checkbox])').first().click();
await page.keyboard.type('Ship it', { delay: demo.slow ? 60 : 0 });
await pause(300);
await page.keyboard.press('Enter');
await expectLeft(2, 'after adding "Ship it"');
await pause(900);
await frame.getByRole('checkbox').first().click();
const end = await expectLeft(1, 'after ticking the first todo');
await pause(2500);
mark('end');
return { end, marks: state.marks };`,
}

interface RunResult { pass: boolean; failed?: string; error?: string; model?: string; openMs?: number; replyMs?: number; changed?: string[]; rateLimited?: number; otherFailures?: string[]; screen?: string[]; load: number[]; marks?: [string, number][]; recording?: unknown }

async function once(index: number): Promise<RunResult> {
  const result: RunResult = { pass: false, load: loadavg().map(n => Math.round(n * 100) / 100) }
  let step = 'warm', recording = false
  const check = (ok: unknown, what: string) => { if (!ok) throw Error(what) }
  try {
    const warm = await execute('warm', steps.warm)
    check(warm.viewport?.width === 1280 && warm.viewport?.height === 800, `viewport is ${JSON.stringify(warm.viewport)}, not 1280x800`)
    if (record) {
      const file = resolve(runs > 1 ? record.replace(/(\.\w+)$/, `-${index + 1}$1`) : record)
      await control('recording', 'start', file, '--session', session, '--mode', 'cdp', '--frame-rate', '30')
      recording = true
      result.recording = file
    }
    step = 'open'
    const open = await execute('open', steps.open)
    result.openMs = open.openMs
    check(open.before.background > 0.5, `the app did not start light: ${JSON.stringify(open.before)}`)
    check(open.before.todos.length === 0, `the workspace is not fresh: ${JSON.stringify(open.before.todos)}`)
    step = 'todos'
    const todos = await execute('todos', steps.todos)
    check(todos.before.todos.length === 2 && todos.before.todos[1][1] === true, `the app does not show the two todos: ${JSON.stringify(todos.before.todos)}`)
    step = 'prompt'
    const reply = await execute('prompt', steps.prompt)
    Object.assign(result, { model: reply.model, replyMs: reply.replyMs, changed: reply.changed, rateLimited: reply.rateLimited, otherFailures: reply.otherFailures, screen: reply.screen })
    check(reply.changed.length, `the agent finished without changing ${JSON.stringify(['src/style.css', 'src/App.tsx'])}`)
    step = 'hot update'
    check(reply.after, 'the app is gone from the frame')
    check(reply.after.sameDocument, 'the frame was reloaded instead of hot-updated')
    check(reply.after.background < 0.25, `the app is not dark (background luminance ${reply.after.background})`)
    check(reply.after.left === 1, `the app does not show 1 todo left: ${JSON.stringify(reply.after.text)}`)
    step = 'preview'
    const preview = await execute('preview', steps.preview)
    check(preview.end.todos.length === 3, `expected three todos in the app: ${JSON.stringify(preview.end.todos)}`)
    check(preview.end.sameDocument, 'the frame was reloaded while it was used')
    result.marks = preview.marks
    result.pass = true
  } catch (error) {
    result.failed = step
    result.error = error instanceof Error ? error.message : String(error)
    // What there is of the marks, for looking at a failed recording.
    result.marks = await execute('marks', 'return state.marks ?? []').catch(() => undefined)
  }
  if (recording) {
    const stopped = await control('recording', 'stop', '--session', session, '--json').catch(error => String(error))
    try {
      const info = JSON.parse(stopped)
      writeFileSync(`${result.recording}.marks.json`, JSON.stringify({ startedAt: info.startedAt ?? info.recording?.startedAt, marks: result.marks ?? [], info, result: { ...result, marks: undefined } }, null, 2))
    } catch { /* the recorder's own sidecar still exists */ }
  }
  if (local) {
    if (flag('shot')) await local.page.screenshot({ path: resolve(runs > 1 ? flag('shot')!.replace(/(\.\w+)$/, `-${index + 1}$1`) : flag('shot')!) }).catch(() => {})
    if (local.problems.length) (result as RunResult & { problems?: string[] }).problems = local.problems.splice(0)
  }
  result.load.push(...loadavg().slice(0, 1).map(n => Math.round(n * 100) / 100))
  return result
}

// Creating a session that exists fails; that is the common case.
if (!local) await control('session', 'new', session).catch(() => {})
let failures = 0
for (let i = 0; i < runs; i++) {
  const result = await once(i)
  if (!result.pass) failures++
  console.log(JSON.stringify({ run: i + 1, ...result, marks: undefined }))
}
console.log(`${runs - failures}/${runs} passed`)
await local?.context.close().catch(() => {})
process.exit(failures ? 1 : 0)
