import { mkdir, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { installNativeObserverCode } from './effect-preview-readiness-trace-browser';

const source = '/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-full-app-UMORaL/toolkit-source/examples/todo-app/tests';
const { acceptanceRequestCode, runFoundation, inventoryCode } = await import(join(source, 'effect-loader-full-app-driver-qa.ts'));
const { createDriverCommands } = await import(join(source, 'matched-pair-driver.ts'));
if (process.env.EFFECT_PREVIEW_AUTHORIZE_ONCE !== 'yes') throw Error('Fresh one-cohort parent authorization required');
const output = resolve(process.argv[2]!); const evidence = resolve(process.argv[3]!);
const origin = await Bun.file(join(output, 'owned-origin.json')).json();
const receipt = await Bun.file(join(output, 'receipt.json')).json();
if (!receipt.observerOnly || !receipt.observerInputs.reverseByteIdentical || origin.output !== output || origin.contracts || new URL(origin.url).hostname !== '127.0.0.1') throw Error('Wrong observer/origin');
const hash = (bytes: string | ArrayBuffer) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
for (const [file, digest] of Object.entries(receipt.hashes)) if (hash(await Bun.file(join(output, file)).arrayBuffer()) !== digest) throw Error('Observer artifact changed: ' + file);
await mkdir(evidence); const lock = evidence + '.lock'; await mkdir(lock);
const session = 'effect-preview-trace-' + crypto.randomUUID().slice(0, 8);
const cli = Bun.which('browser-control'); if (!cli) throw Error('Browser Control CLI absent');
await writeFile(join(evidence, 'ownership.json'), JSON.stringify({ output, origin, session, receipt, authorization: 'one fresh observer cohort through apps-1', retries: 0, requestMs: 20000 }, null, 2), { flag: 'wx' });
let expired = false;
const commands = createDriverCommands(evidence, { app: session }, () => expired, undefined, ['bun', cli]);
const command = (code: string) => commands.command('app', code);
async function lifecycle(action: string) {
  const p = Bun.spawn(['bun', cli!, 'session', action, session], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  await writeFile(join(evidence, 'session-' + action + '.json'), JSON.stringify({ stdout, stderr, exit }), { flag: 'wx' });
  if (exit) throw Error(stderr || stdout);
}
async function read(code: string) {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([command(code), new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(Error('Read expired; no replay')); }, 15000); })]); }
  finally { clearTimeout(timer!); }
}
async function poll(code: string, ms: number, accept: (value: any) => boolean) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await read(code); if (accept(result)) return result; await Bun.sleep(150); }
  expired = true; throw Error('Observation deadline expired; no replay');
}
async function request(action: string, args: any[] = []) {
  const token = crypto.randomUUID();
  await read(acceptanceRequestCode('singleKernelAcceptance', action, args, token));
  const result = await poll(`return await page.evaluate(token=>{const r=window.singleKernelRuns[token];return {status:r.status,error:r.error}},${JSON.stringify(token)});`, (action === 'childSync' ? 20000 : action === 'captureBoundaries' ? 60000 : 120000) + 10000, value => value.status !== 'pending');
  if (result.status !== 'completed') throw Error(result.error);
}
async function retain(name: string, expression: string) {
  const head = await read(`const value=${expression};const json=JSON.stringify(value);state.previewExport=json;return {length:json.length,hash:modules.crypto.createHash('sha256').update(json).digest('hex')};`);
  if (head.length > 32 * 1024 * 1024) throw Error('Evidence exceeds cap');
  let text = '';
  for (let offset = 0; offset < head.length; offset += 8000) {
    const part = await read(`return {offset:${offset},text:state.previewExport.slice(${offset},${offset + 8000})};`);
    if (part.offset !== offset || part.text.length !== Math.min(8000, head.length - offset)) throw Error('Evidence chunk missing'); text += part.text;
  }
  if (hash(text) !== head.hash) throw Error('Evidence digest changed');
  await writeFile(join(evidence, name + '.json'), text, { flag: 'wx' });
}
let cohortError: string | undefined;
try {
  await lifecycle('new');
  await read(`if(page.url()!=='about:blank')throw Error('Refuse occupied session');return {url:page.url()};`);
  await read(installNativeObserverCode(new URL(origin.url).origin, session));
  await read(`await page.goto(${JSON.stringify(origin.url + 'inspect-empty')});return await page.evaluate(async()=>{const root=await navigator.storage.getDirectory();for await(const key of root.keys())throw Error('Existing OPFS '+key);if((await indexedDB.databases()).length||(await caches.keys()).length||(await navigator.serviceWorker.getRegistrations()).length||localStorage.length)throw Error('Not fresh');return {fresh:true};});`);
  await read(`await page.goto(${JSON.stringify(origin.url)});return {url:page.url()};`);
  await poll('return await page.evaluate(()=>({ready:!!window.singleKernelAcceptance,trace:!!window.effectPreviewReadinessTrace}));', 60000, r => r.ready && r.trace);
  await read('return await snapshot();');
  await runFoundation(action => request(action));
  await read(inventoryCode(true));
  try { await request('apps'); } catch (error) { cohortError = String(error); }
  if (expired || commands.pending) throw Error('Ambiguous ownership; retain without cleanup replay');
  await read(`return await page.evaluate(async()=>{window.singleKernelAcceptance.evidence.failureDiagnostics=await Promise.race([window.singleKernelAcceptance.diagnostics().catch(error=>({unavailable:String(error)})),new Promise(resolve=>setTimeout(()=>resolve({unavailable:'5000ms read deadline'}),5000))]);return {observed:true};});`);
  await retain('natural-app', 'await page.evaluate(()=>window.singleKernelAcceptance.evidence)');
  await retain('natural-readiness-trace', 'await page.evaluate(()=>window.effectPreviewReadinessTrace.receipt)');
  await retain('natural-native-observer', 'state.previewNativeObserver');
  await read(`await page.screenshot({path:${JSON.stringify(join(evidence, 'natural-viewport.png'))},scale:'css',fullPage:false});return {url:page.url(),iframe:await page.locator('iframe').getAttribute('src')};`);
  const outcome = await read('return await page.evaluate(()=>({failed:window.singleKernelAcceptance.evidence.status===\'failed\',stages:window.singleKernelAcceptance.evidence.stages.map(s=>s.name),models:window.singleKernelAcceptance.evidence.models}));');
  await writeFile(join(evidence, 'natural-result.json'), JSON.stringify({ ...outcome, error: cohortError, diagnosticOnly: true, fullSuiteAcceptance: false }, null, 2), { flag: 'wx' });
  // Parent explicitly permits the original public failure-retirement action.
  if (outcome.failed) await request('retireFailure', ['after-evidence-and-parent-repair-authorization']);
  else await request('close');
  const census = await poll(inventoryCode(false, true), 15000, r => r.closed);
  const locks = await read('return await page.evaluate(()=>navigator.locks.query());');
  if (locks.held.length || locks.pending.length) throw Error('Post-close native locks not empty');
  await writeFile(join(evidence, 'public-cleanup.json'), JSON.stringify({ census, locks }, null, 2), { flag: 'wx' });
  await retain('retired-app', 'await page.evaluate(()=>window.singleKernelAcceptance.evidence)');
  await retain('final-readiness-trace', 'await page.evaluate(()=>window.effectPreviewReadinessTrace.receipt)');
  await retain('final-native-observer', 'state.previewNativeObserver');
  await read('return await state.previewNativeStop();');
  await lifecycle('delete');
  await writeFile(join(evidence, 'driver-completed.json'), JSON.stringify({ diagnosticCompleted: true, cohortError, publicCloseJoined: true, sessionDeleted: true }), { flag: 'wx' });
  await rmdir(lock);
  console.log(JSON.stringify({ evidence, session, diagnosticCompleted: true, cohortError }));
} catch (error) {
  await writeFile(join(evidence, 'driver-failure.json'), JSON.stringify({ error: String(error), expired, commandPending: commands.pending, session, retained: true }), { flag: 'wx' });
  throw error;
}
