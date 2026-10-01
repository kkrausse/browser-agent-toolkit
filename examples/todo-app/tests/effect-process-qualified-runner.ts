/** Explicit cc5a932 phase2A admission, not a relabelled phase1 schema.
 * All17 cases use version2; only the reviewed stale-loader stop policy differs.
 * First genuine failure stops. Original baseline fixtures/receipts stay unchanged. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const temp = '/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode';
const binary = resolve(temp, 'effect-loader-qualified-node-toolchain-20260930/node-v24.18.0-darwin-arm64/bin/node');
const [rootArg, outputArg] = process.argv.slice(2); assert.ok(rootArg && outputArg);
assert.equal(process.version, 'v24.18.0'); assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
assert.equal(realpathSync(process.execPath), realpathSync(binary));
const root = resolve(rootArg), output = resolve(outputArg), here = dirname(fileURLToPath(import.meta.url));
assert.ok(!output.startsWith(root + sep)); mkdirSync(output);
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const save = (name: string, value: unknown) => writeFileSync(resolve(output, name + '.json'), JSON.stringify(value, null, 2));
const verify = (entries: Record<string, string>, base: string, count: number) => {
  assert.equal(Object.keys(entries).length, count);
  for (const [path, digest] of Object.entries(entries)) {
    const full = resolve(base, path); assert.ok(full.startsWith(base + sep)); assert.equal(hash(full), digest, path);
  }
};
const admit = () => {
  assert.equal(hash(binary), 'ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a');
  assert.equal(hash(resolve(root, 'candidate-receipt.json')), '838195f4fed09e75ce83e9991f57d89e3001dd7990b5225e12466ea64f49a1f3');
  assert.equal(hash(resolve(root, 'freeze-manifest.json')), '59b394fab8d6773863f54435e2489b282f10429ad2603f9aebd86d1f3efa9fc8');
  const receipt = json(resolve(root, 'candidate-receipt.json'));
  assert.equal(receipt.runtimeRevision, 'cc5a932bf4f9a1da4bf8b5d16f6c6c7e4aec573d');
  assert.equal(receipt.toolkitRevision, '9814c715cfca42309c581440577976833f4326e6');
  assert.equal(receipt.effectVersion, '4.0.0-rc.118');
  assert.equal(receipt.distributionVersion, '446021ba611932b0c531570ecc5739255e8d97f608dcc8c53ad1ca07eeceb6a6');
  verify(receipt.hashes, resolve(root, 'candidate'), 103); verify(json(resolve(root, 'freeze-manifest.json')), root, 1475);
  assert.equal(receipt.compiledCore.path, 'runtime-source/packages/kernel-lifecycle/dist/index.js');
  assert.equal(receipt.compiledCore.sha256, '05859327b72d924b3533fc5b35c6b3db5a3c6ca429339a20da6abe1f5f2ebed5');
  assert.equal(hash(resolve(root, receipt.compiledCore.path)), receipt.compiledCore.sha256);
  // NEW schema: browserWorker is relative to candidate/sdk, not root.
  assert.equal(receipt.compiledCore.browserWorker, 'assets/kernel-worker-a6UDx747.js');
  for (const prefix of ['sdk', 'runtime']) assert.equal(hash(resolve(root, 'candidate', prefix, receipt.compiledCore.browserWorker)),
    '7d21c5bfe263b047c1113d219623dcba50c47001624939448ae0d3d191926cea');
  assert.equal(json(resolve(root, 'candidate/runtime/distribution.json')).version, receipt.distributionVersion);
  assert.equal(hash(resolve(root, 'runtime-source.tar')), receipt.runtimeArchiveSha256);
  assert.equal(hash(resolve(root, 'toolkit-source.tar')), receipt.toolkitArchiveSha256);
  assert.deepEqual(receipt.nativeReuse, { inputs: 12, outputs: 37, rebuilt: false });
  assert.equal(json(resolve(root, 'runtime-source/packages/kernel-lifecycle/package.json')).dependencies.effect, '4.0.0-rc.118');
  assert.match(readFileSync(resolve(root, 'runtime-source/packages/kernel-host/kernel.js'), 'utf8'),
    /import \{ createLoaderLifecycle \} from '\.\.\/kernel-lifecycle\/dist\/index\.js'/);
  assert.match(readFileSync(resolve(root, 'runtime-source/packages/core/src/workers/kernel-worker.ts'), 'utf8'),
    /import \{ Kernel \} from "\.\.\/\.\.\/\.\.\/kernel-host\/kernel\.js"/);
  assert.match(readFileSync(resolve(root, 'runtime-source/scripts/lib/spike-harness.mjs'), 'utf8'),
    /import \{ Kernel \} from "\.\.\/\.\.\/packages\/kernel-host\/kernel\.js"/);
  const native = json(resolve(root, 'native-reuse.json'));
  assert.equal(native.trackedInputsEqual.length, 12); assert.equal(native.outputs.length, 37);
  for (const entry of [...native.trackedInputsEqual, ...native.outputs]) assert.equal(hash(resolve(root, 'runtime-source', entry.path)), entry.sha256);
  for (const [file, digest] of Object.entries({
    'effect-loader-fixture.ts': 'e94c74e0da00d36e85d2e706b008d0607e61ef40c7cb2063b722918e0e284fa8',
    'effect-loader-expanded-fixture.ts': 'ec29b6e96f81b5a92b283b9a8513a07d397642a33b4cfef0ea2c8c49f338cd8a',
    'effect-process-fixture.ts': '1a89c10dc0bef4ae184b423a04dcb846e479f879eb68eaebc6703170f00a27e3',
    'effect-process-fixture-v2.ts': '767193c9af8a74c440034f7713fdf53efa5f931ec8c643e106b917c7ea2a9e6c',
    'effect-process-runner.ts': '6f1f8913e89e945bfbd5a1ae6b20a3dc3e64d44ac01be825d5acdce54bccde3f',
  })) assert.equal(hash(resolve(here, file)), digest);
  return { node: process.version, executable: process.execPath, runtime: receipt.runtimeRevision,
    toolkit: receipt.toolkitRevision, distribution: receipt.distributionVersion, candidateEntries: 103,
    freezeEntries: 1475, nativeInputs: 12, nativeOutputs: 37, offline: true,
    coreSha256: receipt.compiledCore.sha256, workerSha256: '7d21c5bfe263b047c1113d219623dcba50c47001624939448ae0d3d191926cea',
    sdkSha256: receipt.hashes['sdk/host.js'], workspaceSha256: receipt.hashes['workspace/index.js'],
    phase2APositive: 'not yet executed', sameCoreImportWiringStatic: true, browserExecuted: false };
};
const provenance = admit(); save('provenance', provenance);
assert.equal(hash(resolve(temp, 'effect-loader-vendor-url-repair-l9k65fzh/runtime-source.tar')),
  '82ec90a5075a89bf35753ef2e5bf51e0cb1bbc13e9af18727879ee0a2a9a4bc0');
// Compare imported regular source bytes to committed archives independently.
// Six source changes only; guest-fetch and all untouched fixtures stay identical.
const comparison = spawnSync('python3', ['-c', `
import tarfile,pathlib,json,sys
new,old=map(pathlib.Path,sys.argv[1:])
def members(root,name):
 with tarfile.open(root/(name+'-source.tar')) as t:
  return {m.name:t.extractfile(m).read() for m in t.getmembers() if m.isfile()}
a,b=members(new,'runtime'),members(old,'runtime')
changed=sorted(k for k in a.keys()|b.keys() if a.get(k)!=b.get(k))
assert changed==['AGENTS.md','ARCHITECTURE.md','packages/core/src/workers/kernel-worker.ts','packages/kernel-host/kernel.js','packages/kernel-lifecycle/src/index.ts','scripts/lib/spike-harness.mjs'],changed
for name in ['runtime','toolkit']:
 for p,data in members(new,name).items():
  assert (new/(name+'-source')/p).read_bytes()==data,p
print(json.dumps({'changedSourcePaths':changed,'runtimeRegularMembers':len(a),'archiveRegularSourceBytesMatch':True}))
`, root, resolve(temp, 'effect-loader-vendor-url-repair-l9k65fzh')], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
assert.equal(comparison.status, 0, comparison.stderr); save('source-archive-comparison', JSON.parse(comparison.stdout));
const scenarios = ['held-terminate-receipt', 'exited-child-pending', 'concurrent-subtree-stop', 'terminate-throw-retained',
  'exited-children-multiple-failures', 'runtime-pid-failure-retains-attachment', 'launch-transfer-revoked', 'boot-before-transfer', 'stale-spawn-exit',
  'stale-loader-rejection', 'thread-transfer-revoked', 'late-thread-after-stop', 'native-node-terminate', 'node-adapter-terminate-promise',
  'acquisition-constructor', 'acquisition-register', 'acquisition-postmessage'];
const source = resolve(root, 'runtime-source'), sdk = resolve(root, 'candidate/sdk/host.js');
const gates = [
  ...scenarios.map(name => ({ name, group: 'new-process', args: [resolve(here, 'effect-process-fixture-v2.ts'), root, name] })),
  ...['held-vendor', 'held-write', 'shared-interest', 'loader-failure'].map(name => ({ name: 'preserved-loader-' + name,
    group: 'preserved', args: [resolve(here, 'effect-loader-fixture.ts'), source, sdk, name, 'accept'] })),
  ...['native-stream-cancel-held', 'native-stream-cancel-failed', 'native-fetch-ignored-abort', 'native-read-ignored-abort',
    'prepid-shared-interest', 'prepid-held-write', 'prepid-rollback-failed', 'sdk-pid-rollback-failed',
    'runtime-prepid-held-success', 'runtime-prepid-rollback-failed'].map(name => ({ name: 'preserved-' + name,
    group: 'preserved', args: [resolve(here, 'effect-loader-expanded-fixture.ts'), root, name] })),
  { name: 'preserved-pid-six', group: 'preserved', args: [resolve(source, 'scripts/test-process-egress-cleanup.mjs'), resolve(source, 'packages/kernel-host/kernel.js'), sdk] },
  { name: 'preserved-endpoint-eight', group: 'preserved', args: [resolve(source, 'scripts/test-endpoint-cleanup.mjs'), sdk] },
  { name: 'preserved-close-three', group: 'preserved', args: [resolve(source, 'scripts/test-single-kernel-close.mjs')] },
  { name: 'preserved-routing', group: 'preserved', args: [resolve(source, 'scripts/test-single-kernel-routing.mjs')] },
  { name: 'preserved-sync-capture', group: 'preserved', args: [resolve(source, 'scripts/test-sync-capture.mjs')] },
];
const results: any[] = [];
for (const gate of gates) {
  // Timeout is only a failing liveness bound, NEVER a cleanup success/handshake.
  const run = spawnSync(process.execPath, gate.args, { cwd: source, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const record = { name: gate.name, group: gate.group, command: [process.execPath, ...gate.args],
    status: run.status === 0 && !run.error ? 'PASS' : 'FAIL', exit: run.status, signal: run.signal,
    error: run.error ? String(run.error) : null, stdout: run.stdout, stderr: run.stderr };
  save(gate.name, record); results.push(record); console.log(JSON.stringify({ name: gate.name, status: record.status }));
  save('summary', { provenance, results: results.map(({ name, group, status }) => ({ name, group, status })),
    newDenominator: 17, newPass: results.filter(r => r.group === 'new-process' && r.status === 'PASS').length,
    newFail: results.filter(r => r.group === 'new-process' && r.status === 'FAIL').length,
    newUnrun: gates.slice(results.length).filter(g => g.group === 'new-process').length,
    unrun: gates.slice(results.length).map(g => g.name), firstFailure: results.find(r => r.status === 'FAIL')?.name ?? null,
    independentOfflinePassed: results.length === gates.length && results.every(r => r.status === 'PASS'), browserPending: true });
  if (record.status === 'FAIL') { process.exitCode = 1; break; }
}
admit(); save('postflight', { verified: true, candidateEntries: 103, freezeEntries: 1475, nativeInputs: 12, nativeOutputs: 37 });
