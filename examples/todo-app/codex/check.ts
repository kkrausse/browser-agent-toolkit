#!/usr/bin/env bun
// Codex in the TODO example's editor, checked in a real Chrome through the `browser-control`
// CLI, with the scripted model only (wasm-term/mock-llm): no sign-in, no tokens.
//
// The example must be serving, and a mock must be reachable from the browser:
//
//   MOCK_LLM_PORT=4781 bun wasm-term/mock-llm/server.ts          # or mock-llm/up.sh (port 4791), if it has the todo-* scenarios
//   cd examples/todo-app && bun codex.ts && bun run prepare:editor && bun run build
//   PORT=4780 EDITOR_MODEL_API_KEY=not-a-key EDITOR_MODEL_BASE_URL=http://127.0.0.1:4781/v1 bun run start
//   bun codex/check.ts --base http://127.0.0.1:4780 --mock http://127.0.0.1:4781 --opencode-edit
//
//   --session <name>   browser-control session (default codex-todo-check; created if missing)
//   --opencode-edit    the server's OpenCode model is the mock too (EDITOR_MODEL_BASE_URL): also have OpenCode edit
//   --shots <dir>      save a screenshot after each stage
//
// What it asserts, in order:
//   1. open     "Open editor" with ?agent=codex: the codex TUI draws its prompt in /workspace
//   2. edit     `todo-heading "<unique>"`: codex reads src/home.tsx through the shell (rg, nl | sed), applies a
//               patch, and the preview frame's <h1> is the new text without the frame having reloaded
//   3. node     `todo-node`: `node -e`, a script on the source, `npx tsc --noEmit` (exit 0), all as codex commands
//   4. reload   the page is reloaded and the editor reopened: the heading is still there (the kernel's journal),
//               codex still has its history (IndexedDB)
//   5. opencode the OpenCode tab: its chat is attached while codex stays mounted; with --opencode-edit it changes
//               the heading too, and codex's shell then reads OpenCode's edit (one filesystem)
//   6. creds    a fixture auth.json planted in this origin's storage is reported, and "Clear stored credentials"
//               removes it and restarts codex
//   7. exit     Exit, then "Open editor" again: codex comes back (its Worker was released from the kernel)
//
// Prints one JSON line (pass, the failed stage, timings) and exits 1 on failure.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1] ?? '' }
const has = (name: string) => process.argv.includes(`--${name}`)
const base = (flag('base') ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/$/, '')
const mock = (flag('mock') ?? 'http://127.0.0.1:4791').replace(/\/$/, '')
const session = flag('session') ?? 'codex-todo-check'
const shots = flag('shots') && resolve(flag('shots')!)
const scratch = mkdtempSync(join(tmpdir(), 'codex-todo-check-'))
const id = Date.now().toString(36)
if (shots) mkdirSync(shots, { recursive: true })

async function execute(name: string, body: string): Promise<any> {
  const file = join(scratch, `${name}.js`)
  writeFileSync(file, prelude + body)
  const child = Bun.spawn(['browser-control', 'execute', '--json', '--session', session, '--file', file], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  let envelope: any
  try { envelope = JSON.parse(out) } catch { throw Error(`${name}: browser-control gave no result (exit ${code}): ${(err || out).slice(0, 600)}`) }
  if (!envelope.ok || envelope.isError) throw Error(`${name}: ${envelope.error?.message ?? envelope.text ?? 'failed'}`.slice(0, 1500))
  return envelope.value
}

const settings = {
  url: `${base}/?agent=codex&codex-backend=mock&codex-mock=${encodeURIComponent(mock)}`,
  heading: `Codex check ${id}`, openCodeHeading: `OpenCode check ${id}`, shots,
  // Not a credential: a fixture with the shape of codex's file, so that there is something to clear.
  fixture: { key: 'todo-codex\n/home/user/.codex/auth.json', value: JSON.stringify({ OPENAI_API_KEY: 'not-a-key-check-fixture' }) },
}
const prelude = `
const check = ${JSON.stringify(settings)};
const fail = message => { throw new Error(message) };
const shot = async name => { if (check.shots) await page.screenshot({ path: check.shots + '/' + name + '.png' }) };
const screen = () => page.evaluate(() => window.__codex?.screen() ?? []);
const preview = () => page.frames().find(frame => frame.url().includes('/preview/')) ?? fail('no preview frame');
const heading = () => preview().evaluate(() => document.querySelector('h1')?.textContent ?? null);
const openEditor = async () => {
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await page.waitForFunction(() => window.__codex?.timings?.prompt && window.__editorTimings?.current?.['preview.visible'], null, { timeout: 60000 });
  await page.waitForFunction(() => window.__codex.screen().some(line => line.includes('· /workspace')), null, { timeout: 15000 });
};
/** Types a prompt into the codex TUI and waits for the marker that ends the scripted turn. */
const turn = async (prompt, done, timeout = 90000) => {
  const before = (await screen()).join('\\n').split(done).length;
  await page.evaluate(() => window.__codex.focus());
  await page.evaluate(text => window.__codex.write(text), prompt);
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__codex.write('\\r'));
  const started = Date.now();
  for (;;) {
    const lines = await screen();
    if (lines.join('\\n').split(done).length > before && lines.some(line => /^\\s*› (Ask Codex|\\S)/.test(line))) return { ms: Date.now() - started, lines };
    if (Date.now() - started > timeout) fail('no ' + done + ' on the screen after ' + timeout + ' ms:\\n' + lines.filter(line => line.trim()).join('\\n'));
    await page.waitForTimeout(200);
  }
};
const idb = (mode, run) => page.evaluate(([mode, run, fixture]) => new Promise((resolve, reject) => {
  const open = indexedDB.open('wasm-term', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('files');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const store = open.result.transaction('files', mode).objectStore('files');
    const request = run === 'put' ? store.put(new TextEncoder().encode(fixture.value).buffer, fixture.key) : store.getKey(fixture.key);
    request.onsuccess = () => { resolve(request.result !== undefined); open.result.close(); };
    request.onerror = () => reject(request.error);
  };
}), [mode, run, check.fixture]);
`

const stages: [name: string, body: string][] = [
  ['open', `
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(check.url);
    if (!(await page.evaluate(() => crossOriginIsolated))) fail('the page is not cross-origin isolated');
    await idb('readwrite', 'put');
    await openEditor();
    const lines = await screen();
    if (!lines.some(line => /mock-model/.test(line))) fail('codex is not on the mock model:\\n' + lines.join('\\n'));
    await shot('1-open');
    return { editor: await page.evaluate(() => window.__editorTimings.current), codex: await page.evaluate(() => window.__codex.timings) };
  `],
  ['edit', `
    const before = await heading();
    if (before === check.heading) fail('the heading is already ' + before);
    // A mark in the frame's window: gone if the frame reloads instead of hot-updating.
    await preview().evaluate(() => { window.__checkMark = true });
    const procsBefore = await page.evaluate(() => window.__codex.procs.length);
    const result = await turn('todo-heading "' + check.heading + '"', 'MOCK-TODO-HEADING-DONE');
    const text = result.lines.join('\\n');
    if (!text.includes('<h1>' + check.heading + '</h1>')) fail('the turn did not report the new heading:\\n' + text);
    const started = Date.now();
    while ((await heading()) !== check.heading) {
      if (Date.now() - started > 10000) fail('the preview still shows "' + (await heading()) + '"');
      await page.waitForTimeout(50);
    }
    const procs = (await page.evaluate(() => window.__codex.procs)).slice(procsBefore);
    for (const want of ['rg -n', 'nl -ba']) if (!procs.some(proc => proc.command.includes(want) && proc.status === 0)) fail('no successful "' + want + '" among the commands: ' + JSON.stringify(procs));
    if (!(await preview().evaluate(() => window.__checkMark === true))) fail('the preview frame reloaded instead of hot-updating');
    await shot('2-edit');
    return { before, after: await heading(), turnMs: result.ms, previewMsAfterTurn: Date.now() - started, commands: procs.map(proc => [proc.command.replace('/bin/bash -lc ', ''), proc.status, Math.round(proc.runMs)]) };
  `],
  ['node', `
    const result = await turn('todo-node', 'MOCK-TODO-NODE-DONE', 180000);
    const text = result.lines.join('\\n');
    const version = /mock-node-ok (v[\\d.]+) 42/.exec(text)?.[1] ?? fail('node did not run:\\n' + text);
    if (!/mock-node-script: \\d+ tsx files, \\d+ lines, heading /.test(text)) fail('the script did not run on the source:\\n' + text);
    if (!text.includes('tsc-exit=0')) fail('the typecheck did not pass:\\n' + text);
    await shot('3-node');
    return { node: version, turnMs: result.ms, tscMs: Math.round((await page.evaluate(() => window.__codex.procs)).findLast(proc => proc.command.includes('tsc'))?.runMs ?? -1) };
  `],
  ['reload', `
    await page.reload();
    await openEditor();
    if ((await heading()) !== check.heading) fail('after a reload the preview shows "' + (await heading()) + '"');
    const history = await page.evaluate(() => window.__codex.readFile('/home/user/.codex/history.jsonl'));
    if (!history?.includes('todo-heading')) fail('codex lost its history across the reload');
    return { heading: await heading(), editor: await page.evaluate(() => window.__editorTimings.current), codex: await page.evaluate(() => window.__codex.timings) };
  `],
  ['opencode', `
    await page.getByRole('tab', { name: 'OpenCode' }).click();
    await page.waitForFunction(() => window.__editorTimings?.current?.['chat.ready'], null, { timeout: 60000 });
    const box = page.locator('.todo-editor-chat textarea').first();
    await box.waitFor({ state: 'visible' });
    if (!(await page.locator('.todo-editor-codex').isHidden())) fail('the codex panel is still shown');
    let edited = false;
    if (${has('opencode-edit')}) {
      await box.click();
      await page.keyboard.type('todo-heading "' + check.openCodeHeading + '"');
      await page.keyboard.press('Enter');
      const started = Date.now();
      while ((await heading()) !== check.openCodeHeading) {
        if (Date.now() - started > 60000) fail('OpenCode did not change the heading: "' + (await heading()) + '"\\n' + (await page.locator('.todo-editor-chat').innerText()).slice(-600));
        await page.waitForTimeout(100);
      }
      edited = true;
    }
    await shot('5-opencode');
    await page.getByRole('tab', { name: 'Codex' }).click();
    await page.waitForFunction(() => window.__codex.screen().some(line => line.trim()), null, { timeout: 10000 });
    // The other agent's edit, read by codex's shell: the same file, not a copy.
    let seen = null;
    if (edited) {
      const result = await turn('!rg -n "<h1>" src/home.tsx; echo seen-by-$((40 + 2))', 'seen-by-42', 30000);
      seen = result.lines.join('\\n').includes('<h1>' + check.openCodeHeading + '</h1>');
      if (!seen) fail('codex does not see the edit OpenCode made:\\n' + result.lines.join('\\n'));
    }
    return { chatReady: true, edited, codexSeesOpenCodeEdit: seen };
  `],
  ['creds', `
    if (!(await idb('readonly', 'has'))) fail('the fixture auth.json is not in storage');
    const note = page.locator('.todo-editor-codex footer small');
    if (!/A sign-in is stored/.test(await note.innerText())) fail('the panel does not report the stored sign-in: ' + (await note.innerText()));
    await page.getByRole('button', { name: 'Clear stored credentials' }).click();
    await page.waitForFunction(() => /No sign-in is stored/.test(document.querySelector('.todo-editor-codex footer small')?.textContent ?? ''), null, { timeout: 15000 });
    await page.waitForFunction(() => window.__codex?.screen().some(line => /^\\s*› /.test(line)), null, { timeout: 30000 });
    if (await idb('readonly', 'has')) fail('auth.json is still in storage after "Clear stored credentials"');
    if ((await page.evaluate(() => window.__codex.readFile('/home/user/.codex/auth.json'))) !== null) fail('the restarted codex still has auth.json');
    await shot('6-creds');
    return { cleared: true };
  `],
  ['exit', `
    await page.getByRole('button', { name: 'Exit', exact: true }).click();
    await page.getByRole('button', { name: 'Open editor', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.todo-editor'), null, { timeout: 15000 });
    await page.evaluate(() => { window.__codex = undefined });
    await openEditor();
    const result = await turn('!echo back-$((40 + 2)); pwd', 'back-42', 30000);
    if (!result.lines.some(line => line.trim() === '/workspace')) fail('the shell is not in /workspace:\\n' + result.lines.join('\\n'));
    return { reopened: true, editor: await page.evaluate(() => window.__editorTimings.current), codex: await page.evaluate(() => window.__codex.timings) };
  `],
]

await Bun.spawn(['browser-control', 'session', 'new', session], { stdout: 'ignore', stderr: 'ignore' }).exited
const report: Record<string, unknown> = { pass: false, base, mock, load: loadavg()[0]!.toFixed(1) }
try {
  for (const [name, body] of stages) {
    report.failed = name
    report[name] = await execute(name, body)
  }
  delete report.failed
  report.pass = true
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
}
console.log(JSON.stringify(report))
process.exit(report.pass ? 0 : 1)
