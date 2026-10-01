// Offline only: new isolated archive + observer overlay + separate library/consumer builds.
import { cp, mkdir, mkdtemp, readdir, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '../../..');
const input = '/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-full-app-Yb8T8p';
const frozen = join(input, 'frozen');
const toolkit = 'd0eec346dbc749db1c0cd82dd8aad0b27c1da363';
const runtime = '33fa1359a003ca9c50cb3bc49699b99bc1a063f1';
const hash = (bytes: string | ArrayBuffer) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const fileHash = async (file: string) => hash(await Bun.file(file).arrayBuffer());
async function walk(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await walk(dir, path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
async function verify(dir: string, hashes: Record<string, string>) {
  for (const [file, expected] of Object.entries(hashes)) {
    if (file.startsWith('/') || file.split('/').includes('..') || await fileHash(join(dir, file)) !== expected) throw Error('Hash mismatch: ' + file);
  }
}
if (process.argv[2] === '--verify') {
  const dir = resolve(process.argv[3]!);
  const receipt = await Bun.file(join(dir, 'receipt.json')).json();
  await verify(dir, receipt.hashes);
  if (!receipt.instrumented || await fileHash(receipt.overlayManifest) !== receipt.overlaySha256) throw Error('Instrumented overlay manifest mismatch');
  console.log(JSON.stringify({ files: Object.keys(receipt.hashes).length, receiptSha256: await fileHash(join(dir, 'receipt.json')) }));
  process.exit(0);
}
const originalReceipt = await Bun.file(join(frozen, 'receipt.json')).json();
if (originalReceipt.toolkitRevision !== toolkit || originalReceipt.revision !== runtime) throw Error('Wrong frozen cohort');
await verify(frozen, originalReceipt.hashes);
const out = await mkdtemp('/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/editor-save-close-trace-');
const source = join(out, 'instrumented-source'), stage = join(out, 'consumer-stage');
await mkdir(source); await mkdir(stage);
async function command(args: string[], cwd = source) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  await Bun.write(join(out, 'command-' + Date.now() + '.json'), JSON.stringify({ args, cwd, stdout, stderr, exit }, null, 2));
  if (exit) throw Error(stdout + stderr);
}
// Extract the exact archived source, not the mutable checkout or old run origin.
if (await fileHash(join(input, 'toolkit-source.tar')) !== originalReceipt.sourceArchives.toolkit) throw Error('Archive changed');
await command(['tar', '-xf', join(input, 'toolkit-source.tar'), '-C', source], out);
for (const pkg of ['', 'workspace-api', 'opencode-chat', 'examples/todo-app']) await symlink(join(root, pkg, 'node_modules'), join(source, pkg, 'node_modules'));
for (const file of Object.keys(originalReceipt.hashes)) {
  await mkdir(dirname(join(stage, file)), { recursive: true });
  await cp(join(frozen, file), join(stage, file), { errorOnExist: true, force: false });
}
const diffs: any[] = [];
const prelude = `const qaTrace = (globalThis as any).__editorSaveCloseTrace;\n`;
async function transform(file: string, edits: [string, string][]) {
  const path = join(source, file), before = await Bun.file(path).text();
  let after = before;
  for (const [old, replacement] of edits) {
    if (after.split(old).length !== 2) throw Error('Expected one exact transform: ' + file + ': ' + old);
    after = after.replace(old, replacement);
  }
  // Reverse ALL exact edits in reverse order; the result must be the original bytes.
  let reversed = after;
  for (const [old, replacement] of [...edits].reverse()) {
    if (reversed.split(replacement).length !== 2) throw Error('Ambiguous reversal: ' + file);
    reversed = reversed.replace(replacement, old);
  }
  if (reversed !== before) throw Error('Reversal mismatch');
  await Bun.write(path, prelude + after);
  diffs.push({ file, before: hash(before), after: hash(prelude + after), reversalExact: true, edits });
}
await transform('examples/todo-app/src/workspace-editor.tsx', [
  ["if (!idleChat(current?.getSnapshot())) throw", "qaTrace?.checkpoint('admission', current?.getSnapshot());\n    if (!idleChat(current?.getSnapshot())) throw"],
  ["if (!idleChat(currentChat?.getSnapshot())) throw Error('Chat is not idle')", "qaTrace?.checkpoint('capture.initial', currentChat?.getSnapshot());\n    if (!idleChat(currentChat?.getSnapshot())) throw Error('Chat is not idle')"],
  ["    await workspace.flush()", "    qaTrace?.record('capture.flush.enter');\n    await workspace.flush(); qaTrace?.record('capture.flush.return')"],
  ["if (!idleChat(currentChat?.getSnapshot())) throw Error('Chat became busy; workspace was not replaced')", "qaTrace?.checkpoint('capture.final', currentChat?.getSnapshot());\n    if (!idleChat(currentChat?.getSnapshot())) throw Error('Chat became busy; workspace was not replaced')"],
  ["    await store.write(next)", "    qaTrace?.record('catalog.persist.enter');\n    await store.write(next); qaTrace?.record('catalog.persist.return')"],
  ["    assertIdle()\n    const saved = await capture()", "    qaTrace?.record('save.enter');\n    assertIdle()\n    const saved = await capture()"],
  ["    setNote(`Saved ${saved.name} locally, including resumable native sessions.`)", "    setNote(`Saved ${saved.name} locally, including resumable native sessions.`); qaTrace?.record('save.return')"],
  ["    locked.current = true; setActionBusy(true)\n    void controller.run", "    qaTrace?.record('action.admitted', {label});\n    locked.current = true; setActionBusy(true)\n    void controller.run"],
  ["await controller.close(); onExit()", "qaTrace?.record('exit.controller.close.enter'); await controller.close(); qaTrace?.record('exit.controller.close.return'); onExit(); qaTrace?.record('exit.onExit.return')"],
]);
await transform('examples/todo-app/src/local-workspaces.ts', [
  ["  const source: Record<string, Uint8Array> = {}", "  qaTrace?.record('source.capture.enter');\n  const source: Record<string, Uint8Array> = {}"],
  ["  return source", "  qaTrace?.capture('source.capture.return', source);\n  return source"],
]);
await transform('examples/todo-app/src/workspace-sessions.ts', [
  ["  const response = await service.connection.fetch(url(service, path), { ...init, signal: AbortSignal.timeout(30_000) })", "  qaTrace?.record('native.request.enter', {path, method: init?.method ?? 'GET'});\n  const nativeRequest = service.connection.fetch(url(service, path), { ...init, signal: AbortSignal.timeout(30_000) }); qaTrace?.promise('native.request', nativeRequest, {path});\n  const response = await nativeRequest"],
  ["  if (!response.ok) throw", "  qaTrace?.record('native.request.headers', {path, status: response.status});\n  if (!response.ok) throw"],
  ["  const sessions: SessionBundle[] = [], ids = new Set<string>()", "  qaTrace?.record('native.capture.enter');\n  const sessions: SessionBundle[] = [], ids = new Set<string>()"],
  ["  return orderSessions(sessions)", "  const ordered = orderSessions(sessions); qaTrace?.capture('native.capture.return', ordered);\n  return ordered"],
]);
await transform('opencode-chat/src/editor-adapter.ts', [
  ["    chats.set(service, chat);", "    chats.set(service, chat); qaTrace?.attach(chat, owner, service);"],
  ["chats.delete(service); current.dispose();", "chats.delete(service); qaTrace?.record('attachment.dispose.enter'); current.dispose(); qaTrace?.record('attachment.dispose.return.discarded');"],
]);
await transform('opencode-chat/src/controller.ts', [
  ["  function event(e: NativeEvent) {", "  function event(e: NativeEvent) {\n    qaTrace?.record('sse.event', {type: e.type, sessionID: (e.data as any)?.sessionID, nativeSequence: (e as any).sequence ?? null});"],
  ["      disposed = true;", "      qaTrace?.record('chat.dispose.enter');\n      disposed = true;"],
  ["      void disposal.catch(() => {});", "      qaTrace?.promise('chat.dispose', disposal);\n      void disposal.catch(() => {});"],
]);
await transform('opencode-chat/src/api.ts', [
  ["      return endpoint.fetch(url.href, init);", "      qaTrace?.record('sdk.request.enter', {path: url.pathname, method: init?.method ?? 'GET'});\n      const response = endpoint.fetch(url.href, init); qaTrace?.promise('sdk.request', response, {path: url.pathname}); return response;"],
]);
await transform('workspace-api/src/react.tsx', [
  ['  async stopService(name: string) {', "  async stopService(name: string) {\n    qaTrace?.record('controller.stopService.enter', {name});"],
  ['    const failures = results.filter((result): result is PromiseRejectedResult', "    qaTrace?.record('controller.service.settled', {name, results: results.map(r => r.status === 'rejected' ? {status: r.status, error: String(r.reason)} : {status: r.status})});\n    const failures = results.filter((result): result is PromiseRejectedResult"],
  ['  async stopRuntime() {', "  async stopRuntime() {\n    qaTrace?.record('controller.stopRuntime.enter');"],
  ['await this.runtime?.stop(); this.publish', "await this.runtime?.stop(); qaTrace?.record('controller.runtime.stop.return'); this.publish"],
  ['  async stopServices() {', "  async stopServices() {\n    qaTrace?.record('controller.stopServices.enter');"],
  ['  async close() {', "  async close() {\n    qaTrace?.record('controller.close.enter');"],
  ['try { await this.workspace?.close(); }', "try { await this.workspace?.close(); qaTrace?.record('controller.workspace.close.return'); }"],
]);
await transform('workspace-api/src/workspace.ts', [
  ['        close() {', "        close() {\n          qaTrace?.record('workspace.close.enter');"],
  ['try { await h.flush(); }', "try { qaTrace?.record('workspace.close.flush.enter'); await h.flush(); qaTrace?.record('workspace.close.flush.return'); }"],
  ['off(); watches.clear(); h.destroy(); opening = false;', "off(); watches.clear(); qaTrace?.record('host.destroy.enter'); try { h.destroy(); qaTrace?.record('host.destroy.return'); } catch (error) { qaTrace?.record('host.destroy.throw', String(error)); throw error; } opening = false;"],
]);
const workspaceEntries = ['index', 'react'];
const chatEntries = ['controller', 'index', 'editor', 'react', 'browser'];
const peers = ['react', 'react/*', 'react-dom', 'react-dom/*', '@kev-browser-agent-kit/workspace', '@kev-browser-agent-kit/workspace/*'];
const hostPlugin = { name: 'exact-sdk', setup(b: any) { b.onResolve({ filter: /^@vivari\/core\/host$/ }, () => ({ path: join(stage, 'sdk/host.js') })); } };
for (const [pkg, entries, directory] of [['workspace-api', workspaceEntries, 'workspace'], ['opencode-chat', chatEntries, 'chat']] as const) {
  for (const entry of entries) {
    const file = pkg === 'opencode-chat' && entry === 'index' ? 'controller' : entry;
    const result = await Bun.build({ entrypoints: [join(source, pkg, 'src', file + (['react', 'editor'].includes(file) ? '.tsx' : '.ts'))], outdir: join(stage, directory), naming: entry + '.js', target: 'browser', external: peers, plugins: [hostPlugin], jsx: { runtime: 'automatic', development: false } });
    if (!result.success) throw new AggregateError(result.logs);
  }
}
const paths: Record<string, string[]> = { '@vivari/core/host': [join(stage, 'sdk/host-sdk/index.d.ts')] };
for (const [pkg, dir, entries] of [['workspace-api', 'workspace', ['index', 'react', 'delivery', 'diagnostics']], ['opencode-chat', 'chat', ['index', 'react', 'editor', 'browser']]] as const) {
  for (const entry of entries) paths['@kev-browser-agent-kit/' + (pkg === 'workspace-api' ? 'workspace' : 'opencode-chat') + (entry === 'index' ? '' : '/' + entry)] = [join(stage, dir, entry + '.d.ts')];
}
const checked = diffs.map(d => join(source, d.file));
await Bun.write(join(out, 'trace.tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true, noEmit: true, lib: ['ES2023', 'DOM', 'DOM.Iterable'], types: ['bun', 'react'], typeRoots: [join(root, 'workspace-api/node_modules/@types'), join(root, 'opencode-chat/node_modules/@types')], paths }, files: [...checked, join(import.meta.dir, 'editor-save-close-trace-observer.ts'), import.meta.path] }));
await command(['node', join(root, 'workspace-api/node_modules/typescript/bin/tsc'), '-p', join(out, 'trace.tsconfig.json')]);
function libraries(b: any) {
  hostPlugin.setup(b);
  b.onResolve({ filter: /^@kev-browser-agent-kit\/workspace(?:\/(react|delivery|diagnostics|assets|prepare))?$/ }, (a: any) => ({ path: join(stage, 'workspace', (a.path.split('/')[2] ?? 'index') + '.js') }));
  b.onResolve({ filter: /^@kev-browser-agent-kit\/opencode-chat(?:\/(browser|editor|react|prepare|server|diagnostics|diagnostics-server))?$/ }, (a: any) => ({ path: join(stage, 'chat', (a.path.split('/')[2] ?? 'index') + '.js') }));
  b.onResolve({ filter: /^@kev-browser-agent-kit\/opencode-chat\/editor.css$/ }, () => ({ path: join(stage, 'chat/editor.css') }));
  b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (a: any) => ({ path: require.resolve(a.path, { paths: [join(root, 'opencode-chat')] }) }));
}
// Separate classic script: bundlers may hoist imported library initializers before
// a static observer import. The HTML parser completes this script before the module.
const observerBuild = await Bun.build({ entrypoints: [join(import.meta.dir, 'editor-save-close-trace-observer.ts')], outdir: join(stage, 'client'), target: 'browser' });
if (!observerBuild.success) throw new AggregateError(observerBuild.logs);
const client = join(source, 'examples/todo-app/tests/single-kernel-live-client.tsx');
const build = await Bun.build({ entrypoints: [client], outdir: join(stage, 'client'), naming: 'single-kernel-live-client.[ext]', target: 'browser', jsx: { runtime: 'automatic', development: false }, plugins: [{ name: 'separate-library-consumer', setup: libraries }] });
if (!build.success) throw new AggregateError(build.logs);
const css = 'client/single-kernel-live-client.css';
const removeComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
if (removeComments(await Bun.file(join(stage, css)).text()) !== removeComments(await Bun.file(join(frozen, css)).text())) throw Error('CSS semantics changed');
await cp(join(frozen, css), join(stage, css));
const hostPath = join(stage, 'qa/live-host.ts');
const hostBefore = await Bun.file(hostPath).text();
const hostEdits: [string, string][] = [
  ['<script type="module" src="/client/single-kernel-live-client.js"></script>', '<script src="/client/editor-save-close-trace-observer.js"></script><script type="module" src="/client/single-kernel-live-client.js"></script>'],
  ["['/client/single-kernel-live-client.js','/client/single-kernel-live-client.css']", "['/client/single-kernel-live-client.js','/client/single-kernel-live-client.css','/client/editor-save-close-trace-observer.js']"],
];
let hostAfter = hostBefore;
for (const [before, after] of hostEdits) {
  if (hostAfter.split(before).length !== 2) throw Error('QA host transform mismatch');
  hostAfter = hostAfter.replace(before, after);
}
let hostReversed = hostAfter;
for (const [before, after] of [...hostEdits].reverse()) hostReversed = hostReversed.replace(after, before);
if (hostReversed !== hostBefore) throw Error('QA host reversal mismatch');
await Bun.write(hostPath, hostAfter);
diffs.push({ file: 'consumer-stage/qa/live-host.ts', before: hash(hostBefore), after: hash(hostAfter), reversalExact: true, edits: hostEdits });
for (const name of ['prepare.ts', 'observer.ts', 'save-once.js', 'close-census.js', 'read.js']) await cp(join(import.meta.dir, 'editor-save-close-trace-' + name), join(stage, 'qa/editor-save-close-trace-' + name));
const hashes: Record<string, string> = {};
for (const file of await walk(stage)) hashes[file] = await fileHash(join(stage, file));
const assetDiffs = Object.entries(hashes).filter(([file, value]) => originalReceipt.hashes[file] !== value).map(([file, after]) => ({ file, before: originalReceipt.hashes[file] ?? null, after }));
if (assetDiffs.some(d => /^(sdk|runtime|prepared)\//.test(d.file))) throw Error('Exact native/SDK/prepared outputs changed');
await Bun.write(join(out, 'source-overlay.json'), JSON.stringify({ toolkit, runtime, diffs, assetDiffs, originalReceiptSha256: await fileHash(join(frozen, 'receipt.json')), workerAssetsRebuilt: false, originalGuardAndDisposeOrderPreserved: true }, null, 2));
await Bun.write(join(stage, 'receipt.json'), JSON.stringify({ ...originalReceipt, output: stage, hashes, instrumented: true, overlayManifest: join(out, 'source-overlay.json'), overlaySha256: await fileHash(join(out, 'source-overlay.json')), liveRuns: 0 }, null, 2));
await verify(stage, hashes); await verify(frozen, originalReceipt.hashes);
// Parse CLI bodies without invoking them or contacting Browser Control.
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
for (const name of ['save-once', 'close-census', 'read']) new AsyncFunction(await Bun.file(join(import.meta.dir, 'editor-save-close-trace-' + name + '.js')).text());
await Bun.write(join(out, 'handoff.json'), JSON.stringify({ stage, source, overlay: join(out, 'source-overlay.json'), receiptSha256: await fileHash(join(stage, 'receipt.json')), assetDiffs, typecheck: 'passed', cliBodiesParse: 'passed; not invoked', browserStarted: false, hostStarted: false, guestStarted: false, servedHashes: 'not observed: offline only; stage file hashes verified', freshRunCopyRequired: true }, null, 2));
console.log(out);
