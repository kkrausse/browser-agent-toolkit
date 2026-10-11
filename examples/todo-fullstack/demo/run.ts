#!/usr/bin/env bun
// The README scenario, driven in a real Chrome through the `browser-control` CLI and
// checked at every step. The example must already be serving (`bun run editor`).
//
//   bun demo/run.ts [--base http://127.0.0.1:3000] [--session bat-demo] [--runs 1]
//                   [--record out.mp4] [--keep-workspace] [--slow]
//
//   1. home: delete leftover todos, reset the workspace (unless --keep-workspace), add
//      "Record a demo GIF" and "Water the plants", tick the second, click "Open editor";
//      wait for the app in the preview and for the chat.
//   2. send the prompt; wait for the assistant to finish.
//   3. the preview must have turned dark without a full reload and show "1 … left";
//      inside it add "Ship it" (2 left) and tick the first checkbox (1 left).
//
// One model conversation per run: it spends the key in `.env.local`. Prints one JSON line
// per run (pass/fail, the failed check, step timings from the panel, load average) and
// exits 1 if any run failed. `--record` captures the run as mp4 (1280x800, CDP) with the
// step marks beside it (`<out>.marks.json`) for `demo/gif.ts`. `--slow` types and pauses
// like a person, for a recording.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1] ?? '' }
const has = (name: string) => process.argv.includes(`--${name}`)
const base = (flag('base') ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/$/, '')
const session = flag('session') ?? 'bat-demo'
const runs = Number(flag('runs') ?? 1)
const record = flag('record')
const prompt = flag('prompt') ?? 'Give this app a dark theme with a violet accent, and show how many todos are left under the list.'
const scratch = mkdtempSync(join(tmpdir(), 'bat-demo-'))

/** Run one Playwright snippet in the session's tab. `page` and a persistent `state` are in scope. */
async function execute(name: string, body: string): Promise<any> {
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

const settings = { base, prompt, slow: has('slow'), reset: !has('keep-workspace') }
const prelude = `
const demo = ${JSON.stringify(settings)};
const mark = name => (state.marks ??= []).push([name, Date.now()]);
const pause = ms => page.waitForTimeout(demo.slow ? ms : Math.min(ms, 100));
const keys = { delay: demo.slow ? 40 : 0 };
const panel = () => page.evaluate(() => {
  const q = s => document.querySelector(s);
  const chat = q('.todo-editor-chat'), log = chat?.querySelector('[role=log]');
  const frame = q('.todo-editor-preview iframe');
  let preview = false;
  try { preview = !!frame?.contentDocument?.querySelector('main input#title:not(:disabled)'); } catch {}
  return {
    preview, composer: !!chat?.querySelector('textarea'),
    status: q('.todo-editor-panel > footer [role=status]')?.textContent ?? '',
    error: q('.todo-editor-panel > footer [role=alert]')?.textContent ?? '',
    users: log?.querySelectorAll('[aria-label="user message"]').length ?? 0,
    assistants: log?.querySelectorAll('[aria-label="assistant message"]').length ?? 0,
    chatStatus: chat?.querySelector('.oc-connection [role=status]')?.textContent ?? '',
    alerts: [...(chat?.querySelectorAll('[role=alert]') ?? [])].map(e => e.textContent.slice(0, 300)),
    timings: window.__editorTimings?.current ?? {},
  };
});
// What the scenario is about, read from the app inside the preview frame.
const app = () => page.evaluate(() => {
  const frame = document.querySelector('.todo-editor-preview iframe');
  const doc = frame?.contentDocument, win = frame?.contentWindow;
  if (!doc?.body) return null;
  const luminance = el => { const m = /rgba?\\(([\\d.]+), ([\\d.]+), ([\\d.]+)(?:, ([\\d.]+))?/.exec(win.getComputedStyle(el).backgroundColor); return !m || m[4] === '0' ? null : (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255; };
  const text = doc.querySelector('main')?.innerText ?? doc.body.innerText;
  const left = /(\\d+)\\s*(?:of\\s*\\d+\\s*)?(?:todos?|items?|tasks?)?\\s*(?:left|remaining|to go)/i.exec(text) ?? /(?:left|remaining)\\D{0,12}(\\d+)/i.exec(text);
  return {
    background: luminance(doc.body) ?? luminance(doc.documentElement) ?? 1,
    left: left ? Number(left[1]) : null, text: text.slice(0, 600),
    todos: [...doc.querySelectorAll('main li')].map(li => [li.innerText.replace(/\\s*Delete\\s*$/, '').trim(), !!li.querySelector('input[type=checkbox]:checked')]),
    sameDocument: win.__demoDocument === true,
  };
});
`

const steps = {
  home: `${prelude}
state.marks = [];
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(demo.base + '/', { waitUntil: 'load' });
const box = page.getByRole('textbox', { name: 'New todo' });
await box.waitFor();
// Todos live in the server's memory: start from none.
for (let i = 0; i < 50; i++) {
  await page.locator('main input#title:not(:disabled)').waitFor();
  const buttons = page.getByRole('button', { name: /^Delete / });
  const count = await buttons.count();
  if (!count) break;
  await buttons.first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForFunction(n => document.querySelectorAll('main li').length < n, count, { timeout: 5000 }).catch(() => {});
}
if (demo.reset) {
  await page.getByRole('button', { name: 'Reset workspace', exact: true }).click();
  await page.locator('aside [role=status]').filter({ hasText: /^\\s*Workspace reset\\.$/ }).waitFor({ timeout: 20000 });
  await page.reload({ waitUntil: 'load' });
  await box.waitFor();
}
return { url: page.url(), viewport: page.viewportSize() };`,

  open: `${prelude}
mark('start');
await pause(800);
const box = page.getByRole('textbox', { name: 'New todo' });
for (const title of ['Record a demo GIF', 'Water the plants']) {
  await box.click();
  await page.keyboard.type(title, keys);
  await pause(250);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('checkbox', { name: title }).waitFor();
  await pause(500);
}
await page.getByRole('checkbox', { name: 'Water the plants' }).click();
await page.getByRole('checkbox', { name: 'Water the plants', checked: true }).waitFor();
await pause(900);
mark('open-click');
await page.getByRole('button', { name: 'Open editor', exact: true }).click();
const deadline = Date.now() + 120000;
let s;
for (;;) {
  s = await panel();
  if (s.preview && s.composer && /^Ready/.test(s.status)) break;
  if (s.error) throw Error('The editor failed to open: ' + s.error);
  if (Date.now() > deadline) throw Error('The editor was not ready within 120 s: ' + JSON.stringify(s));
  await page.waitForTimeout(100);
}
mark('editor-ready');
const before = await app();
// Survives hot updates, not a reload of the frame.
await page.evaluate(() => { document.querySelector('.todo-editor-preview iframe').contentWindow.__demoDocument = true; });
await pause(1200);
return { openMs: state.marks.at(-1)[1] - state.marks.at(-2)[1], timings: s.timings, before };`,

  prompt: `${prelude}
const before = await panel();
await page.locator('.todo-editor-chat textarea').first().click();
await page.keyboard.type(demo.prompt, { delay: demo.slow ? 28 : 0 });
await pause(500);
mark('send');
await page.keyboard.press('Enter');
const started = Date.now();
let s, busy = false;
for (;;) {
  s = await panel();
  if (s.chatStatus && s.chatStatus !== 'Ready') busy = true;
  if (s.alerts.length > before.alerts.length) throw Error('The chat reported: ' + s.alerts.at(-1));
  if (s.assistants > before.assistants && s.chatStatus === 'Ready' && (busy || Date.now() - started > 3000)) break;
  if (Date.now() - started > 240000) throw Error('The assistant did not finish within 240 s: ' + JSON.stringify(s));
  await page.waitForTimeout(150);
}
mark('reply');
await pause(1500);
const tools = await page.evaluate(() => document.querySelector('.todo-editor-chat [role=log]')?.innerText.match(/\\b(read|edit|write|grep|glob|runJavascript)\\s*(completed|error)/g) ?? []);
return { replyMs: Date.now() - started, tools, after: await app() };`,

  preview: `${prelude}
const frame = page.frameLocator('.todo-editor-preview iframe');
const expectLeft = async (n, what) => {
  const deadline = Date.now() + 10000;
  for (;;) {
    const a = await app();
    if (a?.left === n) return a;
    if (Date.now() > deadline) throw Error(what + ': expected ' + n + ' left, the preview shows: ' + JSON.stringify(a?.text));
    await page.waitForTimeout(100);
  }
};
await expectLeft(1, 'after the change');
await frame.locator('input#title').click();
await page.keyboard.type('Ship it', { delay: demo.slow ? 60 : 0 });
await pause(300);
await page.keyboard.press('Enter');
await expectLeft(2, 'after adding "Ship it"');
await pause(900);
await frame.getByRole('checkbox').first().click();
const end = await expectLeft(1, 'after ticking the first todo');
await pause(2000);
mark('end');
return { end, marks: state.marks };`,
}

interface RunResult { pass: boolean; failed?: string; error?: string; openMs?: number; replyMs?: number; tools?: string[]; timings?: Record<string, number>; load: number[]; marks?: [string, number][]; recording?: unknown }

async function once(index: number): Promise<RunResult> {
  const result: RunResult = { pass: false, load: loadavg().map(n => Math.round(n * 100) / 100) }
  let step = 'home', recording = false
  const check = (ok: unknown, what: string) => { if (!ok) throw Error(what) }
  try {
    const home = await execute('home', steps.home)
    check(home.viewport?.width === 1280 && home.viewport?.height === 800, `viewport is ${JSON.stringify(home.viewport)}, not 1280x800`)
    if (record) {
      const file = resolve(runs > 1 ? record.replace(/(\.\w+)$/, `-${index + 1}$1`) : record)
      await control('recording', 'start', file, '--session', session, '--mode', 'cdp', '--frame-rate', '30')
      recording = true
      result.recording = file
    }
    step = 'open'
    const open = await execute('open', steps.open)
    Object.assign(result, { openMs: open.openMs, timings: open.timings })
    check(open.before && open.before.background > 0.5, `the preview did not start light: ${JSON.stringify(open.before)}`)
    check(open.before.todos.length === 2 && open.before.todos[1][1] === true, `the preview does not show the two todos: ${JSON.stringify(open.before.todos)}`)
    step = 'prompt'
    const reply = await execute('prompt', steps.prompt)
    Object.assign(result, { replyMs: reply.replyMs, tools: reply.tools })
    check(reply.tools.some((t: string) => /^(edit|write)\s*completed/.test(t)), `the assistant finished without editing a file: ${JSON.stringify(reply.tools)}`)
    step = 'hot update'
    check(reply.after, 'the preview frame is gone')
    check(reply.after.sameDocument, 'the preview frame was reloaded instead of hot-updated')
    check(reply.after.background < 0.25, `the preview is not dark (background luminance ${reply.after.background})`)
    check(reply.after.left === 1, `the preview does not show 1 todo left: ${JSON.stringify(reply.after.text)}`)
    step = 'preview'
    const preview = await execute('preview', steps.preview)
    check(preview.end.todos.length === 3, `expected three todos in the preview: ${JSON.stringify(preview.end.todos)}`)
    check(preview.end.sameDocument, 'the preview frame was reloaded while it was used')
    result.marks = preview.marks
    result.pass = true
  } catch (error) {
    result.failed = step
    result.error = error instanceof Error ? error.message : String(error)
  }
  if (recording) {
    const stopped = await control('recording', 'stop', '--session', session, '--json').catch(error => String(error))
    try {
      const info = JSON.parse(stopped)
      writeFileSync(`${result.recording}.marks.json`, JSON.stringify({ startedAt: info.startedAt ?? info.recording?.startedAt, marks: result.marks ?? [], info }, null, 2))
    } catch { /* the recorder's own sidecar still exists */ }
  }
  result.load.push(...loadavg().slice(0, 1).map(n => Math.round(n * 100) / 100))
  return result
}

// Creating a session that exists fails; that is the common case.
await control('session', 'new', session).catch(() => {})
let failures = 0
for (let i = 0; i < runs; i++) {
  const result = await once(i)
  if (!result.pass) failures++
  console.log(JSON.stringify({ run: i + 1, ...result, marks: undefined }))
}
console.log(`${runs - failures}/${runs} passed`)
process.exit(failures ? 1 : 0)
