// Offline regression: actual frozen SDK + native MessageChannel; controlled guest leaf.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [frozen, source, output] = process.argv.slice(2);
assert.ok(frozen && source && output, 'usage: qualified-node fixture.ts frozen runtime-source NEW-output');
assert.equal(process.version, 'v24.18.0');
mkdirSync(output); // Never overwrite an earlier cohort.
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const sdkPath = `${frozen}/sdk/host.js`;
const receipt = JSON.parse(readFileSync(`${frozen}/receipt.json`, 'utf8'));
assert.equal(receipt.revision, '3ee918522c1233a1f8e10a9b798c09b6c3e30c81');
assert.equal(receipt.toolkitRevision, '9814c715cfca42309c581440577976833f4326e6');
assert.equal(hash(readFileSync(sdkPath)), '14e5b1e965c4645ccbed41a93536db8b941b5ed076225dfea9288d9a0b5dfc87');
const sourceHashes: Record<string, string> = {};
for (const [file, expected] of Object.entries({
  'endpoint.ts': '440225c7550abdf865ba6be414b3dbf5f9c7b5f766d0230f279851739570505a',
  'http-stream.ts': '62a44cf02af97fd1fd27ed220ea348e802943a99247ddbd0c58a459d8edc6295',
})) {
  const path = `packages/core/src/host-sdk/browser/${file}`;
  const current = execFileSync('git', ['show', `${receipt.revision}:${path}`], { cwd: source });
  const baseline = execFileSync('git', ['show', `33fa1359a003ca9c50cb3bc49699b99bc1a063f1:${path}`], { cwd: source });
  assert.equal(hash(current), expected);
  assert.deepEqual(current, baseline);
  assert.deepEqual(readFileSync(`${source}/${path}`), current);
  sourceHashes[path] = expected;
}
writeFileSync(`${output}/identity.json`, JSON.stringify({ node: process.version, executable: process.execPath,
  executableSha256: hash(readFileSync(process.execPath)), runtime: receipt.revision, toolkit: receipt.toolkitRevision,
  sdk: sdkPath, sdkSha256: hash(readFileSync(sdkPath)), sourceHashes, scope: 'offline-controlled-guest-transport-leaf' }, null, 2));
Object.defineProperty(globalThis, 'location', { value: { href: 'http://offline.invalid/' }, configurable: true });
const { createEndpoint } = await import(pathToFileURL(sdkPath).href);
const deferred = () => { let resolve!: (value?: any) => void; const promise = new Promise<any>(r => resolve = r); return { promise, resolve }; };
const events: any[] = [];
const results: any[] = [];
let currentCase = '';
const record = (event: string, value?: any) => events.push({ case: currentCase, event, value });
const reasonRecord = (e: any): any => ({ name: e?.name, message: e?.message, stack: e?.stack, code: e?.code,
  cause: e?.cause ? reasonRecord(e.cause) : undefined, errors: e?.errors?.map(reasonRecord) });
const rejected = async (promise: Promise<any>, expected: any, identity = true) => {
  let actual: any;
  await promise.then(() => assert.fail('expected rejection'), e => { actual = e; record('public-rejection', reasonRecord(e)); });
  if (identity) assert.equal(actual, expected);
  else { assert.equal(actual.constructor, expected.constructor); assert.equal(actual.message, expected.message); }
  return actual;
};
function setup(postError?: Error) {
  let guest: MessagePort;
  const inbox: any[] = [], waiters: any[] = [];
  const guestClosed = deferred();
  const subscriptions = new Set<any>();
  const endpoint = createEndpoint({ listeners: new Map([[5173, 'offline:1']]),
    on(fn: any) { subscriptions.add(fn); return () => subscriptions.delete(fn); },
    post(type: string, metadata: any, ports: MessagePort[]) {
      record('post', { type, metadata });
      assert.equal(type, 'workspace-http-stream');
      assert.equal(metadata.request.path, '/');
      if (postError) throw postError;
      guest = ports[0];
      guest.addEventListener('close', () => { record('guest-port-closed'); guestClosed.resolve(); });
      guest.onmessage = ({ data }) => {
        record('adapter-message', data);
        const i = waiters.findIndex(w => w.op === data.op);
        if (i >= 0) waiters.splice(i, 1)[0].resolve(data); else inbox.push(data);
      };
      guest.start();
    },
  }, 5173, 'offline:1', new AbortController().signal);
  return { endpoint, subscriptions,
    send(op: string, extra = {}) { record('guest-message', { op, ...extra }); guest.postMessage({ op, ...extra }); },
    next(op: string) { const i = inbox.findIndex(m => m.op === op); if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise(resolve => waiters.push({ op, resolve })); },
    async finish() { endpoint.dispose(); await endpoint.settled; assert.equal(subscriptions.size, 0); if (!postError) await guestClosed.promise; record('cleanup-finished'); },
  };
}
const headers = (s: ReturnType<typeof setup>) => s.send('headers', { status: 200, statusText: 'OK', headers: ['content-type', 'text/plain'] });
const timeoutReason = () => new DOMException('signal timed out', 'TimeoutError');
const cases: [string, () => Promise<void>][] = [];
cases.push(['abort-before-admission', async () => {
  const s = setup(), c = new AbortController(), reason = timeoutReason(); c.abort(reason);
  await rejected(s.endpoint.fetch('/', { signal: c.signal }), reason);
  assert.equal(events.filter(e => e.case === currentCase && e.event === 'post').length, 0);
  s.endpoint.dispose(); await s.endpoint.settled;
}]);
for (const phase of ['before-headers', 'during-body']) cases.push([`abort-${phase}`, async () => {
  const s = setup(), c = new AbortController(), reason = timeoutReason();
  const fetch = s.endpoint.fetch('/', { signal: c.signal });
  let body: Promise<any> | undefined;
  if (phase === 'during-body') { headers(s); const response = await fetch; assert.equal(response.status, 200); body = response.arrayBuffer(); await s.next('pull'); }
  c.abort(reason); await rejected(body ?? fetch, reason); await s.next('cancel'); await s.finish();
}]);
cases.push(['abort-after-body-eof', async () => {
  const s = setup(), c = new AbortController(), reason = timeoutReason();
  const fetch = s.endpoint.fetch('/', { signal: c.signal }); headers(s);
  const response = await fetch; assert.equal(response.headers.get('content-type'), 'text/plain');
  const body = response.arrayBuffer(); await s.next('pull'); s.send('data', { bytes: new TextEncoder().encode('complete') });
  await s.next('pull'); s.send('end'); assert.equal(new TextDecoder().decode(await body), 'complete');
  const count = events.filter(e => e.case === currentCase && e.event === 'adapter-message' && e.value.op === 'cancel').length;
  c.abort(reason); assert.equal(c.signal.reason, reason); await s.finish();
  assert.equal(events.filter(e => e.case === currentCase && e.event === 'adapter-message' && e.value.op === 'cancel').length, count);
  record('late-abort-no-op', reasonRecord(reason));
}]);
for (const phase of ['before-headers', 'during-body']) cases.push([`guest-error-${phase}`, async () => {
  const s = setup(), fetch = s.endpoint.fetch('/'); let body: Promise<any> | undefined;
  if (phase === 'during-body') { headers(s); body = (await fetch).arrayBuffer(); await s.next('pull'); }
  s.send('error', { error: 'offline guest ECONNRESET' });
  await rejected(body ?? fetch, new Error('offline guest ECONNRESET'), false); await s.next('cancel'); await s.finish();
}]);
cases.push(['native-post-failure', async () => {
  const reason = new TypeError('offline native post failed', { cause: new Error('transport leaf') });
  const s = setup(reason); await rejected(s.endpoint.fetch('/'), reason); await s.finish();
}]);
cases.push(['upload-read-rejection-no-self-join', async () => {
  const entered = deferred(), release = deferred(), reason = new TypeError('offline upload read failed');
  const body = new ReadableStream({ pull() { entered.resolve(); return release.promise.then(() => { throw reason; }); } }, { highWaterMark: 0 });
  const s = setup(), fetch = s.endpoint.fetch('/', { method: 'POST', body }); s.send('upload-credit');
  await entered.promise; release.resolve(); await rejected(fetch, reason); await s.next('cancel');
  s.endpoint.dispose(); const error = await rejected(s.endpoint.settled, new AggregateError([], 'Endpoint cleanup failed'), false);
  assert.equal(error.errors[0].message, 'HTTP source cleanup failed'); assert.ok(error.errors[0].errors.includes(reason));
  assert.equal(body.locked, false); assert.equal(s.subscriptions.size, 0); record('cleanup-finished-with-original-source-error');
}]);
for (const terminal of ['abort', 'eof']) cases.push([`held-read-and-cancel-${terminal}`, async () => {
  const entered = deferred(), cancelEntered = deferred(), readRelease = deferred(), cancelRelease = deferred();
  let readFinished = false, cancelFinished = false;
  const body = new ReadableStream({
    pull() { entered.resolve(); return readRelease.promise.then(() => { readFinished = true; record('source-pull-finished'); }); },
    cancel() { cancelEntered.resolve(); return Promise.all([cancelRelease.promise, readRelease.promise]).then(() => { cancelFinished = true; record('source-cancel-finished'); }); },
  }, { highWaterMark: 0 });
  const s = setup(), c = new AbortController(), reason = timeoutReason();
  const fetch = s.endpoint.fetch('/', { method: 'POST', body, signal: c.signal });
  s.send('upload-credit'); await entered.promise;
  if (terminal === 'abort') { c.abort(reason); await rejected(fetch, reason); await s.next('cancel'); }
  else { headers(s); const response = await fetch; const consumed = response.arrayBuffer(); await s.next('pull'); s.send('end'); await consumed; c.abort(reason); }
  await cancelEntered.promise; s.endpoint.dispose();
  let settled = false; void s.endpoint.settled.then(() => settled = true);
  await Promise.resolve(); assert.equal(settled, false); assert.equal(body.locked, true);
  cancelRelease.resolve(); await Promise.resolve(); assert.equal(settled, false); assert.equal(readFinished, false);
  readRelease.resolve(); await s.finish(); assert.ok(readFinished && cancelFinished); assert.equal(body.locked, false);
}]);
// Watchdog is failure-only, not a test delay or acceptance budget extension.
const watchdog = setTimeout(() => { writeFileSync(`${output}/failure.json`, JSON.stringify({ currentCase, error: 'handshake watchdog', events, results }, null, 2)); process.exit(1); }, 5000);
try {
  for (const [name, run] of cases) { currentCase = name; await run(); results.push({ name, status: 'PASS' }); }
  assert.equal(hash(readFileSync(sdkPath)), receipt.hashes['sdk/host.js']);
  writeFileSync(`${output}/results.json`, JSON.stringify({ status: 'PASS', count: cases.length, results, events }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', count: cases.length, node: process.version, output }));
} catch (error) {
  writeFileSync(`${output}/failure.json`, JSON.stringify({ currentCase, error: reasonRecord(error), events, results }, null, 2));
  console.error(error); process.exitCode = 1;
} finally { clearTimeout(watchdog); }
