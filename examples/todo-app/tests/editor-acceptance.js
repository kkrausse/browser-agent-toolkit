// Bun-backed browser-control execute --session ID --file .../tests/editor-acceptance.js
// Execute body, not a standalone Node/Bun program. See README.md before running.
const cfg = state.editorAcceptanceConfig;
if (!cfg?.url || !cfg?.evidenceDir || !cfg?.phase) throw Error('Set state.editorAcceptanceConfig: {url, evidenceDir (absolute), phase}');
if (!path.isAbsolute(cfg.evidenceDir)) throw Error('evidenceDir must be absolute');
if (page.url() !== cfg.url) throw Error(`Wrong page: ${page.url()} (expected ${cfg.url}); parent must navigate deliberately`);
const phase = cfg.phase;
page.setDefaultTimeout(8000);
const a = state.editorAcceptance ??= { run: Date.now().toString(36), url: cfg.url, receipts: [], done: {} };
if (a.url !== cfg.url) throw Error('Harness state belongs to another URL');
const assert = (ok, reason) => { if (!ok) throw Error(reason); };
function shellSourceCommand(sourcePath, sha256, heading, stdout) {
  const program = [
    `const bytes = require("node:fs").readFileSync(${JSON.stringify(sourcePath)});`,
    `const hash = require("node:crypto").createHash("sha256").update(bytes).digest("hex");`,
    `if (hash !== ${JSON.stringify(sha256)}) throw new Error("Source SHA-256 mismatch");`,
    `if (!bytes.toString("utf8").includes(${JSON.stringify(`<h1>${heading}</h1>`)})) throw new Error("Source heading mismatch");`,
    `process.stdout.write(${JSON.stringify(stdout)});`,
  ].join('\n');
  return `node -e '${program.replace(/'/g, "'\\''")}'`;
}
const need = (...phases) => phases.forEach(p => assert(a.done[p], `Prerequisite not verified: ${p}`));
const button = name => page.getByRole('button', { name, exact: true });
const file = () => page.getByRole('textbox', { name: 'File contents', exact: true });
const frame = () => page.frameLocator('iframe[title="Workspace preview"]');
const click = async locator => { assert(await locator.count() === 1, 'Control is missing or ambiguous'); await locator.click({ timeout: 8000 }); };
const inspect = async () => ({
  snapshot: await snapshot(),
  dom: await page.evaluate(() => ({
    url: location.href, timeOrigin: performance.timeOrigin,
    frames: [...document.querySelectorAll('iframe')].map(f => ({ title: f.title, src: f.getAttribute('src') })),
    alerts: [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent),
    statuses: [...document.querySelectorAll('[role="status"]')].map(e => e.textContent),
    activity: document.querySelector('.oc-editor-panel details > pre')?.textContent,
    preview: (() => {
      try {
        const d = document.querySelector('iframe[title="Workspace preview"]')?.contentDocument;
        return d ? { heading: d.querySelector('h1')?.textContent, controls: [...d.querySelectorAll('input,button')].map(e => ({
          tag: e.tagName, type: e.getAttribute('type'), label: e.getAttribute('aria-label') ?? e.labels?.[0]?.textContent ?? e.textContent,
          disabled: e.disabled,
        })) } : null;
      } catch (error) { return { error: String(error) }; }
    })(),
  })),
});
// Read-only React inspection. Find a controller by shape, never component names
// (production names may be minified). No callbacks, hooks, or globals are installed.
const controller = async kind => {
  const h = await page.evaluateHandle(kind => {
    const element = document.querySelector(kind === 'chat' ? '.oc-chat' : '.oc-editor');
    if (!element) throw Error(`Missing ${kind} root`);
    const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
    for (let f = element[key], n = 0; f && n < 80; f = f.return, n++) {
      for (const node of [f, f.alternate]) {
        const c = node?.memoizedProps?.controller;
        if (typeof c?.getSnapshot !== 'function') continue;
        const s = c.getSnapshot();
        if (kind === 'chat' ? Array.isArray(s.messages) : s.services && Array.isArray(s.progress)) return c;
      }
    }
    throw Error(`No ${kind} controller on inspected React ancestry; inspect migrated UI before adapting harness`);
  }, kind);
  return h;
};
const chat = async () => {
  const h = await controller('chat');
  try { return await h.evaluate(c => c.getSnapshot()); } finally { await h.dispose(); }
};
const lifecycle = async h => h.evaluate(c => {
  const s = c.getSnapshot();
  return { status: s.status, error: s.error, busy: s.busy, workspace: !!s.workspace,
    runtime: !!s.runtime, persistence: s.persistence, services: Object.keys(s.services),
    clients: s.clients, progress: s.progress, logs: s.logs };
});
const captureServices = h => h.evaluateHandle(c => Object.entries(c.getSnapshot().services).map(([name, service]) => ({
  name, execution: service.execution, drained: service.drained,
})));
const serviceExits = h => h.evaluate(async services => {
  let timer;
  try {
    return await Promise.race([
      Promise.all(services.map(async s => {
        const result = await s.execution.exited;
        await s.drained;
        return { name: s.name, result, drained: true };
      })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Captured service exit/drain exceeded 8s')), 8000); }),
    ]);
  } finally { clearTimeout(timer); }
});
const readSource = async () => {
  const h = await controller('workspace');
  try {
    return await h.evaluate(async (c, sourcePath) => {
      let timer;
      try {
        const bytes = await Promise.race([c.getSnapshot().workspace.fs.readFile(sourcePath),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Workspace read exceeded 8s')), 8000); })]);
        return new TextDecoder().decode(bytes);
      } finally { clearTimeout(timer); }
    }, cfg.sourcePath ?? '/src/home.tsx');
  } finally { await h.dispose(); }
};
const previewIdentity = async () => {
  assert(await page.locator('iframe[title="Workspace preview"]').count() === 1, 'Expected one preview');
  const h = await page.evaluateHandle(() => document.querySelector('iframe[title="Workspace preview"]').contentDocument);
  assert(await h.evaluate(d => !!d?.querySelector('main')), 'Preview document not accessible/ready');
  return h;
};
const sameDocument = async h => h.evaluate(d => d === document.querySelector('iframe[title="Workspace preview"]')?.contentDocument);
const backendTodos = async () => page.evaluate(async () => {
  const r = await fetch('/api/getTodos', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  const body = await r.json();
  if (!r.ok || !Array.isArray(body.result?.data)) throw Error(`Unexpected getTodos protocol: HTTP ${r.status}`);
  return body.result.data;
});
const tools = s => s.messages.flatMap(m => m.type === 'assistant'
  ? m.content.filter(p => p.type === 'tool').map(p => ({ messageID: m.id, model: m.model, ...p })) : []);
const newTools = (s, turn) => tools(s).filter(t => !turn.toolIDs.includes(t.id));
const terminalLocalTool = t => t.state.status === 'completed' && t.executed === false &&
  typeof t.time?.ran === 'number' && typeof t.time?.completed === 'number' && t.time.completed >= t.time.ran;
const settledTurn = (s, turn) => {
  assert(s.sessionID === turn.sessionID, 'Conversation changed during turn');
  assert(!s.error, `Chat error: ${s.error}`);
  assert(!s.permissions.length && !(s.questions?.length) && !(s.unsupportedForms?.length) && !(s.forms?.length), 'Parent coordination needed: permission/form request (question UI may project a candidate form)');
  if (s.execution !== 'idle' || s.sending || s.loading) return false;
  const fresh = s.messages.filter(m => !turn.messageIDs.includes(m.id));
  assert(!fresh.some(m => m.type === 'assistant' && (m.error || m.finish === 'error')), 'Assistant execution ended with an error');
  if (!fresh.some(m => m.type === 'assistant' && typeof m.time?.completed === 'number')) return false;
  return s.messages.some(m => !turn.messageIDs.includes(m.id) && m.type === 'user' && m.text === turn.prompt);
};
const stableMessages = messages => messages.map(m => m.type === 'assistant'
  ? { id: m.id, type: m.type, model: m.model, content: m.content, finish: m.finish, error: m.error }
  : m);
const startTurn = async (kind, prompt) => {
  assert(!a[kind], `${kind} already submitted; observe existing turn instead of duplicating it`);
  const s = await chat();
  assert(s.sessionID && s.connection === 'connected' && s.execution === 'idle' && !s.sending, 'Select/create a ready chat first');
  // Save intent before action so an ambiguous timeout never silently resubmits.
  a[kind] = { sessionID: s.sessionID, prompt, toolIDs: tools(s).map(t => t.id), messageIDs: s.messages.map(m => m.id), started: new Date().toISOString() };
  await page.getByRole('textbox', { name: 'Message OpenCode', exact: true }).fill(prompt, { timeout: 8000 });
  await click(button('Send ↑'));
  return a[kind];
};
const receipt = { run: a.run, phase, started: new Date().toISOString(), status: 'BLOCKED' };
fs.mkdirSync(cfg.evidenceDir, { recursive: true });
try {
  receipt.before = await inspect(); // inspect DOM before choosing/acting on controls
  switch (phase) {
    case 'startup': {
      assert(!a.done.startup, 'Startup already captured; use a new harness run for a new baseline');
      assert(await button('Open editor').isEnabled({ timeout: 8000 }), 'Admin launcher not ready');
      assert(await page.locator('.oc-editor, iframe[title="Workspace preview"]').count() === 0, 'Editor was not closed by default');
      assert(await page.getByRole('textbox', { name: 'New todo', exact: true }).isEnabled(), 'Normal todo UI not ready');
      a.hostDocument = await page.evaluateHandle(() => document);
      a.hostMain = await page.locator('main').elementHandle();
      receipt.backend = await backendTodos();
      break;
    }
    case 'open':
      need('startup');
      assert(await page.locator('.oc-editor').count() === 0, 'Editor already mounted');
      await click(button('Open editor'));
      receipt.status = 'SUBMITTED';
      break;
    case 'ready': {
      need('startup');
      const h = await controller('workspace');
      receipt.lifecycle = await lifecycle(h); await h.dispose();
      assert(!receipt.lifecycle.error, receipt.lifecycle.error);
      if (receipt.lifecycle.busy || !receipt.lifecycle.runtime || receipt.lifecycle.clients.vite !== 'ready' || receipt.lifecycle.clients.chat !== 'ready') {
        receipt.status = 'PENDING'; break;
      }
      assert(await a.hostDocument.evaluate(d => d === document), 'Host document replaced');
      assert(await a.hostMain.evaluate(e => e.isConnected), 'Underlying normal app unmounted');
      assert(await frame().getByRole('textbox', { name: 'New todo', exact: true }).isEnabled(), 'Preview todo form not ready');
      receipt.chat = await chat();
      assert(receipt.chat.connection === 'connected', 'OpenCode not connected');
      break;
    }
    case 'crud-add': {
      need('ready');
      assert(!a.todo, 'An acceptance todo already exists; inspect/continue rather than adding another');
      a.todo = { title: `editor-acceptance-${a.run}` };
      await frame().getByRole('textbox', { name: 'New todo', exact: true }).fill(a.todo.title, { timeout: 8000 });
      await click(frame().getByRole('button', { name: 'Add', exact: true }));
      await frame().getByRole('checkbox', { name: a.todo.title, exact: true }).waitFor({ timeout: 8000 });
      receipt.backend = await backendTodos();
      const matches = receipt.backend.filter(t => t.title === a.todo.title);
      assert(matches.length === 1 && matches[0].completed === false, 'Added todo not independently persisted at host API');
      a.todo = matches[0];
      break;
    }
    case 'crud-toggle': {
      need('crud-add');
      const checkbox = frame().getByRole('checkbox', { name: a.todo.title, exact: true });
      const before = await backendTodos();
      if (!before.some(t => t.id === a.todo.id && t.completed === true) && !a.todoToggleSubmitted) {
        // This is server-controlled state, so Playwright check()'s immediate
        // checked assertion races the mutation response. Submit once, then observe.
        a.todoToggleSubmitted = true;
        if (!await checkbox.isChecked()) await click(checkbox);
      }
      receipt.backend = await backendTodos();
      if (!receipt.backend.some(t => t.id === a.todo.id && t.completed === true) || !await checkbox.isChecked()) { receipt.status = 'PENDING'; break; }
      break;
    }
    case 'crud-delete': {
      need('crud-toggle');
      receipt.beforeBackend = await backendTodos();
      assert(receipt.beforeBackend.some(t => t.id === a.todo.id && t.title === a.todo.title), 'Own todo no longer exists');
      await click(frame().getByRole('button', { name: `Delete ${a.todo.title}`, exact: true }));
      await frame().getByRole('checkbox', { name: a.todo.title, exact: true }).waitFor({ state: 'detached', timeout: 8000 });
      receipt.backend = await backendTodos();
      assert(!receipt.backend.some(t => t.id === a.todo.id), 'Deleted todo still exists at host API');
      break;
    }
    case 'source-open':
      need('ready');
      if (await button('Source').getAttribute('aria-expanded') !== 'true') await click(button('Source'));
      await file().waitFor({ timeout: 8000 });
      assert(await file().isEnabled(), 'Source is not ready');
      receipt.source = await readSource();
      assert(await file().inputValue() === receipt.source, 'Selected source does not equal configured workspace sourcePath');
      break;
    case 'hmr-edit': {
      need('source-open');
      assert(!a.hmr, 'HMR edit already started; run hmr-verify');
      const original = await readSource();
      assert(await file().inputValue() === original, 'Reload file before editing stale source');
      const from = cfg.headingFrom ?? 'Todos';
      const needle = `<h1>${from}</h1>`;
      assert(original.split(needle).length === 2, `Expected one ${needle}; inspect source and adapt explicitly`);
      const heading = `Todos acceptance ${a.run}`;
      const expected = original.replace(needle, `<h1>${heading}</h1>`);
      a.hmr = { original, expected, heading, document: await previewIdentity() };
      await file().fill(expected, { timeout: 8000 });
      receipt.status = 'SUBMITTED';
      break;
    }
    case 'hmr-verify': {
      assert(a.hmr, 'Run hmr-edit first');
      receipt.source = await readSource();
      receipt.sameDocument = await sameDocument(a.hmr.document);
      assert(receipt.sameDocument, 'Preview document replaced; not same-document HMR');
      const sourceStatus = await page.getByRole('region', { name: 'Source editor', exact: true }).getByRole('status').innerText();
      receipt.sourceStatus = sourceStatus;
      receipt.heading = await frame().getByRole('heading', { level: 1 }).innerText({ timeout: 8000 });
      if (receipt.source !== a.hmr.expected || receipt.heading !== a.hmr.heading || !sourceStatus.includes('Written and flushed to local workspace.')) { receipt.status = 'PENDING'; break; }
      break;
    }
    case 'model-send': {
      need('hmr-verify');
      assert(!a.model, 'Model intent already exists; do not overwrite baseline or resubmit');
      a.modelBaseline = await readSource();
      a.modelHeading = `Todos model ${a.run}`;
      a.modelDocument = await previewIdentity();
      receipt.turn = await startTurn('model', `Read /workspace${cfg.sourcePath ?? '/src/home.tsx'} with a real file tool, then use a file edit tool to change only the h1 text from "${a.hmr.heading}" to "${a.modelHeading}". Preserve all other code. Do not merely describe the change. Do not run a shell for this task.`);
      receipt.status = 'SUBMITTED';
      break;
    }
    case 'model-verify': {
      assert(a.model, 'Run model-send first');
      const s = receipt.chat = await chat();
      receipt.tools = newTools(s, a.model);
      if (!settledTurn(s, a.model)) { receipt.status = 'PENDING'; break; }
      assert(receipt.tools.length && receipt.tools.every(terminalLocalTool), 'Missing native local terminal tool record (completed, executed:false, ran/completed times) for this turn');
      const target = `/workspace${cfg.sourcePath ?? '/src/home.tsx'}`;
      const onTarget = t => [target, cfg.sourcePath ?? '/src/home.tsx'].includes(t.state.input?.filePath ?? t.state.input?.path);
      assert(receipt.tools.some(t => t.name === 'read' && onTarget(t)), 'No completed native read tool targeting requested file');
      assert(receipt.tools.some(t => t.name === 'edit' && onTarget(t) &&
        typeof t.state.input.oldString === 'string' && t.state.input.oldString.includes(a.hmr.heading) &&
        typeof t.state.input.newString === 'string' && t.state.input.newString.includes(a.modelHeading)), 'No completed native edit with correlated old/new strings on requested file');
      receipt.source = await readSource();
      assert(receipt.source === a.modelBaseline.replace(`<h1>${a.hmr.heading}</h1>`, `<h1>${a.modelHeading}</h1>`), 'Independent filesystem bytes do not equal requested single edit');
      receipt.sameDocument = await sameDocument(a.modelDocument);
      assert(receipt.sameDocument, 'Model edit reloaded preview');
      assert(await frame().getByRole('heading', { level: 1 }).innerText({ timeout: 8000 }) === a.modelHeading, 'Model edit not rendered');
      a.retainedSource = receipt.source;
      break;
    }
    case 'file-link': {
      need('model-verify');
      const open = page.locator('.oc-tool').getByRole('button', { name: `Open /workspace${cfg.sourcePath ?? '/src/home.tsx'}`, exact: true, includeHidden: true });
      assert(await open.count() > 0, 'No tool file-link button; inspect tool card input schema');
      await open.last().locator('xpath=ancestor::details[1]').evaluate(e => { e.open = true; });
      await click(open.last());
      await file().waitFor({ timeout: 8000 });
      const expected = await readSource();
      await page.waitForFunction(text => document.querySelector('.oc-editor-source textarea')?.value === text, expected, { timeout: 8000 });
      assert(await file().inputValue() === expected, 'File link did not load independent edited bytes');
      break;
    }
    case 'shell-send': {
      need('model-verify');
      assert(!a.shell, 'Shell intent already exists; do not overwrite source baseline or resubmit');
      const source = await readSource();
      assert(source === a.retainedSource, 'Source changed since independent model verification; establish a fresh model/source baseline first');
      const sha256 = await page.evaluate(async source => {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
        return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
      }, source);
      a.shellStdout = `editor-shell-${a.run}\n`;
      a.shellCheck = { path: `/workspace${cfg.sourcePath ?? '/src/home.tsx'}`, sha256, heading: a.modelHeading, stdout: a.shellStdout };
      receipt.sourceCheck = a.shellCheck;
      a.shellCommand = shellSourceCommand(a.shellCheck.path, sha256, a.modelHeading, a.shellStdout);
      receipt.turn = await startTurn('shell', `Use the native built-in shell tool exactly once in foreground (background:false, timeout:8000) to run this exact command:\n${a.shellCommand}\nThis must launch ordinary guest Node through the shell. The command reads the real source, checks its SHA-256 and heading, and emits its marker only after both checks pass. Do not replace or change the command, use a custom tool, emulate execution, or edit files. We need actual tool output and the actual process exit code, not prose.`);
      receipt.status = 'SUBMITTED';
      break;
    }
    case 'shell-verify': {
      assert(a.shell, 'Run shell-send first');
      const s = receipt.chat = await chat();
      receipt.tools = newTools(s, a.shell);
      if (!settledTurn(s, a.shell)) { receipt.status = 'PENDING'; break; }
      const candidates = receipt.tools.filter(t => t.name === 'shell' && t.state.input?.command === a.shellCommand);
      assert(candidates.length === 1 && receipt.tools.length === 1, 'No unique native shell tool for exact command, or extra tools ran');
      const t = candidates[0];
      assert(terminalLocalTool(t), `Native local shell not terminal: ${t.state.status}, executed:${t.executed}`);
      // beta-19425 tool/plugin/shell.ts toolResult + shell/result.ts:
      // content[0] is combined process capture; content[1] is the exit notice.
      // Node emits the stdout marker only after fs + crypto source verification.
      // Success emits no stderr. Do not strip/normalize capture.
      assert(a.shellCheck, 'Missing Node source-check baseline (an older printf intent cannot qualify this gate)');
      receipt.sourceCheck = a.shellCheck;
      receipt.output = t.state.content;
      receipt.exit = t.state.metadata?.exit;
      assert(receipt.exit === 0 && t.state.metadata.status === 'completed' && t.state.metadata.truncated === false && t.state.metadata.timeout !== true, 'Shell metadata does not prove completed, non-truncated exit 0');
      assert(t.state.content?.length === 2 && t.state.content[0].type === 'text' && t.state.content[0].text === a.shellStdout &&
        t.state.content[1].type === 'text' && t.state.content[1].text === 'Command exited with code 0.', 'Shell native capture/notice differs from exact stdout and exit notice');
      receipt.source = await readSource();
      assert(receipt.source === a.retainedSource, 'Independent workspace source changed during Node shell check');
      break;
    }
    case 'close': {
      need('model-verify');
      const s = await chat();
      assert(s.execution === 'idle' && !s.sending && !s.loading, 'Wait for terminal chat completion before close');
      a.retention = { sessionID: s.sessionID, messageIDs: s.messages.map(m => m.id), messages: stableMessages(s.messages), source: await readSource() };
      receipt.retention = a.retention;
      a.closingController = await controller('workspace');
      a.closingServices = await captureServices(a.closingController);
      receipt.lifecycle = await lifecycle(a.closingController);
      await click(button('Exit'));
      receipt.status = 'SUBMITTED';
      break;
    }
    case 'closed': {
      assert(a.closingController, 'Run close or cancel-startup first');
      receipt.lifecycle = await lifecycle(a.closingController);
      if (await page.locator('.oc-editor').count() || receipt.lifecycle.busy || receipt.lifecycle.workspace || receipt.lifecycle.runtime || receipt.lifecycle.services.length) { receipt.status = 'PENDING'; break; }
      assert(receipt.lifecycle.persistence === 'closed', 'Workspace persistence not closed');
      assert(await page.locator('iframe[title="Workspace preview"]').count() === 0, 'Preview attachment remains');
      assert(await button('Open editor').isEnabled(), 'Launcher not restored');
      assert(await a.hostMain.evaluate(e => e.isConnected), 'Normal app unmounted');
      receipt.serviceExits = await serviceExits(a.closingServices);
      // Exit codes/signals/forced flags are evidence, not an assertion of natural exit 0.
      break;
    }
    case 'reopen':
      need('closed');
      assert(a.retention, 'No normal close retention baseline');
      await click(button('Open editor'));
      receipt.status = 'SUBMITTED';
      break;
    case 'retention': {
      need('closed');
      assert(a.retention, 'No retention baseline');
      receipt.source = await readSource();
      assert(receipt.source === a.retention.source, 'Source bytes not retained after close/reopen');
      const s = receipt.chat = await chat();
      assert(s.sessionID === a.retention.sessionID, 'Select prior session via UI, then repeat retention; automatic selection is not established');
      assert(!s.loading && s.connection === 'connected', 'Conversation not ready');
      assert(a.retention.messageIDs.every(id => s.messages.some(m => m.id === id)), 'Conversation IDs missing; load earlier messages if paginated');
      assert(JSON.stringify(stableMessages(s.messages.filter(m => a.retention.messageIDs.includes(m.id)))) === JSON.stringify(a.retention.messages), 'Retained conversation content/tool records changed');
      break;
    }
    case 'cancel-startup': {
      need('startup');
      const h = await controller('workspace');
      receipt.lifecycle = await lifecycle(h);
      assert(receipt.lifecycle.busy, 'Startup already settled; cancellation not exercised');
      a.closingController = h;
      a.closingServices = await captureServices(h);
      await click(button('Exit'));
      receipt.status = 'SUBMITTED';
      break;
    }
    case 'tailwind-baseline': {
      need('source-open');
      const source = await readSource();
      const utility = cfg.tailwind?.utility ?? 'tracking-[7px]';
      assert(!source.includes(utility), 'Utility already in target source');
      const property = cfg.tailwind?.property ?? 'letter-spacing';
      const value = cfg.tailwind?.value ?? '7px';
      const selector = cfg.tailwind?.selector ?? 'h1';
      assert(await frame().locator(selector).count() === 1, 'Tailwind selector must identify exactly one element');
      const before = await frame().locator(selector).evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), property);
      assert(before !== value, 'Computed value already matches; choose a genuinely new gate');
      a.tailwind = { utility, property, value, selector, before, source, document: await previewIdentity() };
      receipt.baseline = { utility, property, value, selector, before };
      break;
    }
    case 'tailwind-verify': {
      assert(a.tailwind, 'Capture tailwind-baseline before parent/manual UI source edit');
      const t = a.tailwind;
      receipt.source = await readSource();
      assert(receipt.source !== t.source && receipt.source.includes(t.utility), 'New utility not independently saved');
      receipt.sameDocument = await sameDocument(t.document);
      assert(receipt.sameDocument, 'Tailwind change replaced preview document');
      receipt.style = await frame().locator(t.selector).evaluate((e, t) => {
        const matchingRules = [];
        const walk = rules => { for (const rule of rules) {
          if (rule.cssRules) walk(rule.cssRules);
          if (rule.selectorText && e.matches(rule.selectorText) && rule.style?.getPropertyValue(t.property) === t.value)
            matchingRules.push({ selector: rule.selectorText, cssText: rule.cssText });
        } };
        for (const sheet of e.ownerDocument.styleSheets) walk(sheet.cssRules);
        return { classApplied: e.classList.contains(t.utility), computed: getComputedStyle(e).getPropertyValue(t.property), matchingRules };
      }, { utility: t.utility, property: t.property, value: t.value });
      assert(receipt.style.classApplied && receipt.style.computed === t.value, 'New Tailwind utility not applied at computed-style layer');
      assert(receipt.style.matchingRules.length > 0, 'No matching new utility declaration in installed CSSOM');
      break;
    }
    case 'inspect': break;
    default: throw Error(`Unknown phase: ${phase}`);
  }
  if (receipt.status === 'BLOCKED') receipt.status = phase === 'inspect' ? 'OBSERVED' : 'PASS';
  if (receipt.status === 'PASS') a.done[phase] = true;
} catch (error) {
  receipt.status = 'BLOCKED'; receipt.error = String(error?.stack ?? error);
} finally {
  try { receipt.after = await inspect(); } catch (error) { receipt.diagnosticError = String(error); }
  receipt.finished = new Date().toISOString();
  a.receipts.push(receipt);
  const name = `${a.run}-${String(a.receipts.length).padStart(3, '0')}-${phase.replace(/[^a-z0-9-]/gi, '_')}`;
  receipt.artifact = path.join(cfg.evidenceDir, `${name}.json`);
  fs.writeFileSync(receipt.artifact, JSON.stringify(receipt, null, 2), { flag: 'wx' });
}
return { status: receipt.status, phase, error: receipt.error, artifact: receipt.artifact,
  verified: Object.keys(a.done), pending: receipt.status === 'PENDING' ? 'Repeat this observation phase after allowing progress; do not repeat a send phase.' : undefined };
