/** Explicit new-receipt bridge, not a relabelled old frozen cohort.
 * Verified Node24.18: this.ts <new-frozen-root> <NEW-evidence-dir>
 * --urls is an internal isolated child stage; never boots worker/host listener.
 * Unchanged fixtures are invoked directly, with process.execPath, after admission.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const temp = '/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode';
const oldRoot = resolve(temp, 'effect-loader-frozen-20260930-v2');
const tools = resolve(temp, 'effect-loader-qualified-node-toolchain-20260930');
const binary = resolve(tools, 'node-v24.18.0-darwin-arm64/bin/node');
const [rootArg, outputArg, mode] = process.argv.slice(2);
assert.ok(rootArg && outputArg); assert.ok(!mode || mode === '--urls');
assert.equal(process.version, 'v24.18.0'); assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
assert.equal(realpathSync(process.execPath), realpathSync(binary));
const root = resolve(rootArg), output = resolve(outputArg), here = dirname(fileURLToPath(import.meta.url));
const source = resolve(root, 'runtime-source'), sdk = resolve(root, 'candidate/sdk/host.js');
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hash = (path: string) => digest(readFileSync(path));
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const save = (name: string, value: unknown) => writeFileSync(resolve(output, name + '.json'), JSON.stringify(value, null, 2));
const importSource = (path: string) => import(pathToFileURL(resolve(source, path)).href);

if (mode === '--urls') {
  const { parse } = await importSource('packages/runtime/vendor/acorn.mjs');
  const emitted = (path: string) => {
    const text = readFileSync(path, 'utf8');
    const matches = parse(text, { ecmaVersion: 'latest', sourceType: 'module' }).body
      .filter((n: any) => n.type === 'FunctionDeclaration' && n.id?.name === 'vendorUrl');
    assert.equal(matches.length, 1); return text.slice(matches[0].start, matches[0].end);
  };
  const worker = 'kernel-worker-CvW5AR9j.js';
  const resolver = emitted(resolve(root, 'candidate/sdk/assets', worker));
  const oldResolver = emitted(resolve(oldRoot, 'candidate/sdk/assets/kernel-worker-BXNXoz3O.js'));
  // Evaluate ONLY the actual bundled function. No worker entry or model resolver.
  const evaluate = (code: string, href: string) => new Function('self', 'meta',
    code.replaceAll('import.meta', 'meta') + ';return vendorUrl;')({ location: new URL(href) }, { env: { BASE_URL: './' } });
  const origin = 'http://127.0.0.1:54321', asset = 'vendor/tsgo-pack.bin';
  const negative = evaluate(oldResolver, origin + '/runtime/assets/kernel-worker-BXNXoz3O.js')(asset);
  assert.equal(negative, 'http://127.0.0.1:54321./vendor/tsgo-pack.bin');
  assert.throws(() => new URL(negative), TypeError);
  const { Host } = await import(pathToFileURL(sdk).href);
  const { fetchLoaderVendorBytes } = await importSource('packages/kernel-host/loader-vendor-bytes.js');
  const manifest = json(resolve(root, 'candidate/runtime/distribution.json'));
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (name: string, value: any) => {
    if (!globals.has(name)) globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  const workers: any[] = [], cases: any[] = [];
  replace('location', new URL(origin + '/editor/index.html')); replace('crossOriginIsolated', true);
  replace('Worker', function (this: any, url: any, options: any) {
    this.url = new URL(url); this.options = options; this.terminated = false; workers.push(this);
    this.postMessage = (message: any) => {
      assert.equal(message.type, 'init'); queueMicrotask(() => this.onmessage({ data: { type: 'ready' } }));
    };
    this.terminate = () => { this.terminated = true; };
  });
  try {
    for (const [base, placedWorker] of [
      ['/runtime/', 'assets/' + worker], ['/editor/runtime/', 'assets/' + worker],
      ['runtime/', 'assets/' + worker], ['https://cdn.example.test/deploy/runtime/', 'assets/' + worker],
      ['/runtime/', 'https://workers.example.test/independent/' + worker],
      ['/editor/runtime/', 'https://workers.example.test/independent/' + worker],
    ]) {
      const publicRoot = new URL(base, (globalThis as any).location.href);
      const requests: string[] = [];
      replace('fetch', async (url: any) => {
        requests.push(String(url)); assert.equal(String(url), new URL('distribution.json', publicRoot).href);
        return Response.json({ ...manifest, kernelWorker: placedWorker });
      });
      const host = await Host.open({ name: 'independent-url-qa', version: manifest.version, assetBaseUrl: base });
      try {
        const handle = workers.at(-1), workerUrl = handle.url;
        assert.equal(workerUrl.searchParams.get('vivari-asset-base'), publicRoot.href);
        assert.equal(workerUrl.searchParams.has('opfs-disable'), true); assert.equal(handle.options.type, 'module');
        const actual = evaluate(resolver, workerUrl.href)(asset);
        assert.equal(new URL(actual).href, new URL(asset, publicRoot).href);
        assert.equal(evaluate(resolver, workerUrl.href)('https://assets.example.test/pack.bin'), 'https://assets.example.test/pack.bin');
        cases.push({ base, placedWorker, publicRoot: publicRoot.href, workerUrl: workerUrl.href, actual, requests });
      } finally { host.destroy(); assert.equal(workers.at(-1).terminated, true); }
    }
    const fallbacks = ['/runtime/', '/editor/runtime/'].map(base => {
      const actual = evaluate(resolver, origin + base + 'assets/' + worker)(asset);
      assert.equal(actual, origin + base + asset); return { base, actual };
    });
    // Reuse actual independent prepared handler BODY, never its Bun.serve entry.
    // The Node file leaf is a Blob, not BunFile; route/admission logic is verbatim.
    const donor = resolve(temp, 'effect-loader-full-app-Z4lmqt/frozen');
    const hostPath = resolve(donor, 'qa/effect-loader-full-delivery-host.js');
    assert.equal(hash(hostPath), 'bbabf1388f81cbc15c0d8658a88978d5a7f3cd56d094f501adf629ce2f533251');
    const hostText = readFileSync(hostPath, 'utf8'); let body: any;
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee?.object?.name === 'Bun' && node.callee?.property?.name === 'serve') {
        assert.equal(body, undefined); body = node.arguments[0].properties.find((p: any) => p.key.name === 'fetch').value.body;
      }
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
    };
    walk(parse(hostText, { ecmaVersion: 'latest', sourceType: 'module' })); assert.ok(body);
    const handlerBody = hostText.slice(body.start, body.end);
    const receipt = json(resolve(root, 'candidate-receipt.json'));
    const fileReads: string[] = [];
    const fileLeaf = { file(path: string) {
      const candidate = resolve(root, 'candidate'); assert.ok(path.startsWith(candidate + sep));
      const relative = path.slice(candidate.length + 1); assert.ok(Object.hasOwn(receipt.hashes, relative));
      assert.equal(hash(path), receipt.hashes[relative]); fileReads.push(relative);
      return new Blob([readFileSync(path)], { type: 'application/octet-stream' });
    } };
    const handler = new Function('stage', 'receipt', 'headers', 'held', 'pending', 'release', 'resolve', 'Bun',
      'return async function(request) ' + handlerBody)(resolve(root, 'candidate'), receipt, {}, false, new Set(), () => {}, resolve, fileLeaf);
    const routedUrl = cases[0].actual, nativeSignal = new AbortController().signal;
    let downloads = 0;
    const bytes = await fetchLoaderVendorBytes(routedUrl, nativeSignal, async (url: string, init: any) => {
      downloads++; assert.equal(init.signal, nativeSignal); const response = await handler(new Request(url, init));
      assert.equal(response.status, 200); assert.ok(response.body instanceof ReadableStream); return response;
    });
    assert.equal(downloads, 1); assert.equal(bytes.length, 10793012);
    assert.equal(digest(bytes), 'f318c6ec229471e1f53be8363e90e2ecdc55faf6549a9e696ee825689129c465');
    // Correct URL != invented server mount: actual prepared handler rejects subpath.
    const unsupportedSubpath = await handler(new Request(cases[1].actual)); assert.equal(unsupportedSubpath.status, 404);
    // Explicit owned mount leaf supplies deployment remap; not production routing.
    const mappedDeliveries: any[] = [];
    for (const deployment of [cases[1], cases[3], cases[4], cases[5]]) {
      const mount = new URL(deployment.publicRoot); let calls = 0;
      const result = await fetchLoaderVendorBytes(deployment.actual, new AbortController().signal, async (url: string, init: any) => {
        calls++; const parsed = new URL(url);
        assert.equal(parsed.origin, mount.origin); assert.ok(parsed.pathname.startsWith(mount.pathname));
        const mapped = new URL('/runtime/' + parsed.pathname.slice(mount.pathname.length), origin);
        return handler(new Request(mapped, init));
      });
      assert.equal(calls, 1); assert.equal(digest(result), digest(bytes));
      mappedDeliveries.push({ source: deployment.actual, explicitPublicMount: deployment.publicRoot, bytes: result.length, sha256: digest(result) });
    }
    save('targeted-url-evidence', { node: process.version, nodeExecutable: process.execPath, oldActualEmitted: oldResolver,
      oldActualUrl: negative, oldNativeParserRejected: true, newActualEmitted: resolver, hostOpenCases: cases, fallbacks,
      preparedHostSha256: hash(hostPath), preparedHandlerBodySha256: digest(handlerBody),
      actualPreparedRoute: '/runtime/vendor/tsgo-pack.bin', realPackBytes: bytes.length, realPackSha256: digest(bytes),
      adapterSignalForwarded: true, downloads, fileReads, unmappedSubpathStatus: unsupportedSubpath.status,
      mappedDeliveries, controlledManifestWorkerLeaves: true, fileAdapter: 'Node native Blob from verified bytes',
      hostEntryExecuted: false, emittedWorkerBooted: false, serversStarted: false, browserExecuted: false });
    console.log('PASS actual Host.open/emitted vendor resolver, old native-parser negative, real pack native body adapter and explicit deployment mounts');
  } finally { for (const [name, descriptor] of globals) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete (globalThis as any)[name]; }
} else {
  assert.ok(!output.startsWith(root + sep)); mkdirSync(output);
  let provenance: any;
  try {
    assert.equal(hash(binary), 'ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a');
    assert.equal(hash(resolve(tools, 'node-v24.18.0-darwin-arm64.tar.gz')), 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1');
    assert.ok(readFileSync(resolve(tools, 'SHASUMS256.txt'), 'utf8').includes('e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1  node-v24.18.0-darwin-arm64.tar.gz'));
    assert.equal(hash(resolve(root, 'candidate-receipt.json')), 'e242092e6a920b88a6a2ae7eb76654f1f61773a3bcf99ee4bcbe61f6b85ee6e6');
    assert.equal(hash(resolve(root, 'delivery.tar.gz')), '6b459be8a32041c9e996a7f339cc9a8abc8895720c5ec46b6e2d0ab810cd2bfa');
    const receipt = json(resolve(root, 'candidate-receipt.json')), freeze = json(resolve(root, 'freeze-manifest.json'));
    assert.equal(receipt.runtimeRevision, '3ee918522c1233a1f8e10a9b798c09b6c3e30c81');
    assert.equal(receipt.toolkitRevision, '9814c715cfca42309c581440577976833f4326e6'); assert.equal(receipt.effectVersion, '4.0.0-rc.118');
    const verify = (entries: Record<string, string>, base: string, count: number) => {
      assert.equal(Object.keys(entries).length, count);
      for (const [path, expected] of Object.entries(entries)) {
        const full = resolve(base, path); assert.ok(full.startsWith(base + sep)); assert.equal(hash(full), expected, path);
      }
    };
    verify(receipt.hashes, resolve(root, 'candidate'), 107); verify(freeze, root, 1020);
    assert.equal(hash(resolve(root, 'runtime-source.tar')), receipt.runtimeArchiveSha256);
    assert.equal(hash(resolve(root, 'toolkit-source.tar')), receipt.toolkitArchiveSha256);
    assert.equal(hash(resolve(root, receipt.compiledCore.path)), '211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070');
    assert.equal(hash(resolve(root, receipt.compiledCore.path)), hash(resolve(oldRoot, receipt.compiledCore.path)));
    assert.equal(receipt.distributionVersion, 'bd39000ff5bbc334f836ad65a4433e627525070413f810d7169132102f49b9f9');
    assert.equal(json(resolve(root, 'candidate/runtime/distribution.json')).version, receipt.distributionVersion);
    assert.equal(hash(sdk), '14e5b1e965c4645ccbed41a93536db8b941b5ed076225dfea9288d9a0b5dfc87');
    assert.equal(hash(resolve(root, 'candidate/sdk/assets/kernel-worker-CvW5AR9j.js')), 'c4193ae0cba8419149738ed2b3a74d79d5f59f5e447eff129106ca2f3532fecb');
    assert.equal(hash(resolve(root, 'candidate/sdk/assets/kernel-worker-CvW5AR9j.js')), hash(resolve(root, 'candidate/runtime/assets/kernel-worker-CvW5AR9j.js')));
    const native = json(resolve(root, 'native-reuse.json'));
    assert.equal(native.trackedInputsEqual.length, 12); assert.equal(native.outputs.length, 37);
    for (const entry of [...native.trackedInputsEqual, ...native.outputs]) assert.equal(hash(resolve(source, entry.path)), entry.sha256, entry.path);
    const fixtures: Record<string, string> = {
      'effect-loader-fixture.ts': 'e94c74e0da00d36e85d2e706b008d0607e61ef40c7cb2063b722918e0e284fa8',
      'effect-loader-expanded-fixture.ts': 'ec29b6e96f81b5a92b283b9a8513a07d397642a33b4cfef0ea2c8c49f338cd8a',
      'effect-loader-expanded-runner.ts': '556b9e3d88c8397de21e06e3c6b31df6d94bacdc5b369f79f60c4419653e0ffd',
    };
    for (const [file, expected] of Object.entries(fixtures)) assert.equal(hash(resolve(here, file)), expected);
    // Read-only tar comparison: all committed imported source bytes checked, exact
    // four declared changes only; no extracted/rewritten inputs or editable checkout.
    const comparison = spawnSync('python3', ['-c', `
import tarfile,pathlib,json,hashlib,sys
new,old=sys.argv[1:]
def members(root):
 with tarfile.open(pathlib.Path(root)/'runtime-source.tar') as t:
  return {m.name:t.extractfile(m).read() for m in t.getmembers() if m.isfile()}
a,b=members(new),members(old)
assert hashlib.sha256((pathlib.Path(old)/'runtime-source.tar').read_bytes()).hexdigest()=='36e210854791b56b7b6a2d5bad53eda993b76b466425511a03b9ac142f228d77'
changed=sorted(k for k in a.keys()|b.keys() if a.get(k)!=b.get(k))
expected=['ARCHITECTURE.md','packages/core/src/host-sdk/host.ts','packages/core/src/workers/kernel-worker.ts','scripts/test-vendor-url.mjs']
assert changed==expected,changed
for p,data in a.items():
 assert (pathlib.Path(new)/'runtime-source'/p).read_bytes()==data,p
with tarfile.open(pathlib.Path(new)/'toolkit-source.tar') as t:
 for m in t.getmembers():
  if m.isfile(): assert (pathlib.Path(new)/'toolkit-source'/m.name).read_bytes()==t.extractfile(m).read(),m.name
print(json.dumps({'changedSourcePaths':changed,'runtimeTrackedFilesCompared':len(a),'lifecycleNativeInstallerUnchanged':True}))
`, root, oldRoot], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(comparison.status, 0, comparison.stderr); save('source-archive-comparison', JSON.parse(comparison.stdout));
    provenance = { node: process.version, executable: process.execPath, arch: process.arch, executableSha256: hash(binary),
      runtimeRevision: receipt.runtimeRevision, toolkitRevision: receipt.toolkitRevision, effectVersion: receipt.effectVersion,
      distributionVersion: receipt.distributionVersion, receiptSha256: hash(resolve(root, 'candidate-receipt.json')),
      deliverySha256: hash(resolve(root, 'delivery.tar.gz')), coreSha256: hash(resolve(root, receipt.compiledCore.path)),
      sdkSha256: hash(sdk), workerSha256: receipt.worker.sha256, workspaceLibrarySha256: receipt.hashes['workspace/index.js'],
      candidateEntries: 107, freezeEntries: 1020, nativeInputs: 12, nativeOutputs: 37, mismatches: 0, nativeRebuilt: false,
      unchangedFixtures: fixtures, sameCompiledCoreStaticIdentity: true, browserExecuted: false };
    save('provenance', provenance);
  } catch (error) { save('admission-failure', { error: String(error), stack: (error as Error).stack }); throw error; }
  const gates = [
    { name: 'targeted-url-regression', args: [fileURLToPath(import.meta.url), root, output, '--urls'], timeout: 60000 },
    ...['held-vendor', 'held-write', 'shared-interest', 'loader-failure'].map(name => ({ name: 'loader-' + name,
      args: [resolve(here, 'effect-loader-fixture.ts'), source, sdk, name, 'accept'], timeout: 15000 })),
    ...['native-stream-cancel-held', 'native-stream-cancel-failed', 'native-fetch-ignored-abort', 'native-read-ignored-abort',
      'prepid-shared-interest', 'prepid-held-write', 'prepid-rollback-failed', 'sdk-pid-rollback-failed',
      'runtime-prepid-held-success', 'runtime-prepid-rollback-failed'].map(name => ({ name,
      args: [resolve(here, 'effect-loader-expanded-fixture.ts'), root, name], timeout: 15000 })),
    { name: 'pid-egress-six-cases', args: [resolve(source, 'scripts/test-process-egress-cleanup.mjs'), resolve(source, 'packages/kernel-host/kernel.js'), sdk], timeout: 30000 },
    { name: 'endpoint-eight-cases', args: [resolve(source, 'scripts/test-endpoint-cleanup.mjs'), sdk], timeout: 30000 },
    { name: 'close-three-cases', args: [resolve(source, 'scripts/test-single-kernel-close.mjs')], timeout: 30000 },
  ];
  const results: any[] = [];
  for (const gate of gates) {
    const run = spawnSync(process.execPath, gate.args, { cwd: source, encoding: 'utf8', timeout: gate.timeout, maxBuffer: 8 * 1024 * 1024 });
    const record = { name: gate.name, command: [process.execPath, ...gate.args], status: run.status === 0 && !run.error ? 'PASS' : 'FAIL',
      exit: run.status, signal: run.signal, error: run.error ? String(run.error) : null, stdout: run.stdout, stderr: run.stderr };
    save(gate.name, record); results.push(record);
    save('summary', { provenance, results: results.map(({ name, status }) => ({ name, status })), notRun: gates.slice(results.length).map(g => g.name),
      firstFailure: record.status === 'FAIL' ? gate.name : null, qualifiedRepairedDeliveryPassed: results.length === gates.length && results.every(r => r.status === 'PASS'),
      guestMarkAsUncloneable: 'Known baseline guest export failure retained from71ddbe3, not rerun in this targeted cohort',
      overallPilotAccepted: false, browserPending: true, fullAppPending: true, fullVerifyNodePending: true });
    console.log(JSON.stringify({ gate: gate.name, status: record.status }));
    if (record.status === 'FAIL') { process.exitCode = 1; break; }
  }
}
