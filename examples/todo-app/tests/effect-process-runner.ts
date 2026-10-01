/** Baseline-only admission. Positive acceptance requires a NEW explicit receipt
 * adapter after the phase2A handoff; never change old assertions/receipts to green. */
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
  assert.equal(hash(resolve(root, 'candidate-receipt.json')), 'e242092e6a920b88a6a2ae7eb76654f1f61773a3bcf99ee4bcbe61f6b85ee6e6');
  assert.equal(hash(resolve(root, 'freeze-manifest.json')), '1cec74d220b0e035948adb7ae8330fa5174593c324b612d38345b4018fdd13a4');
  const receipt = json(resolve(root, 'candidate-receipt.json'));
  assert.equal(receipt.runtimeRevision, '3ee918522c1233a1f8e10a9b798c09b6c3e30c81');
  assert.equal(receipt.toolkitRevision, '9814c715cfca42309c581440577976833f4326e6');
  assert.equal(receipt.effectVersion, '4.0.0-rc.118');
  assert.equal(receipt.distributionVersion, 'bd39000ff5bbc334f836ad65a4433e627525070413f810d7169132102f49b9f9');
  verify(receipt.hashes, resolve(root, 'candidate'), 107); verify(json(resolve(root, 'freeze-manifest.json')), root, 1020);
  assert.equal(hash(resolve(root, receipt.compiledCore.path)), '211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070');
  const native = json(resolve(root, 'native-reuse.json'));
  assert.equal(native.trackedInputsEqual.length, 12); assert.equal(native.outputs.length, 37);
  for (const entry of [...native.trackedInputsEqual, ...native.outputs]) assert.equal(hash(resolve(root, 'runtime-source', entry.path)), entry.sha256);
  for (const [file, digest] of Object.entries({
    'effect-loader-fixture.ts': 'e94c74e0da00d36e85d2e706b008d0607e61ef40c7cb2063b722918e0e284fa8',
    'effect-loader-expanded-fixture.ts': 'ec29b6e96f81b5a92b283b9a8513a07d397642a33b4cfef0ea2c8c49f338cd8a',
  })) assert.equal(hash(resolve(here, file)), digest);
  return { node: process.version, executable: process.execPath, runtime: receipt.runtimeRevision,
    toolkit: receipt.toolkitRevision, distribution: receipt.distributionVersion, candidateEntries: 107,
    freezeEntries: 1020, nativeInputs: 12, nativeOutputs: 37, offline: true, phase2APositive: 'PENDING' };
};
const provenance = admit(); save('provenance', provenance);
const scenarios = ['held-terminate-receipt', 'exited-child-pending', 'concurrent-subtree-stop', 'terminate-throw-retained',
  'exited-children-multiple-failures', 'runtime-pid-failure-retains-attachment', 'launch-transfer-revoked', 'boot-before-transfer', 'stale-spawn-exit',
  'stale-loader-rejection', 'thread-transfer-revoked', 'late-thread-after-stop', 'native-node-terminate', 'node-adapter-terminate-promise',
  'acquisition-constructor', 'acquisition-register', 'acquisition-postmessage'];
const source = resolve(root, 'runtime-source'), sdk = resolve(root, 'candidate/sdk/host.js');
const gates = [
  ...scenarios.map(name => ({ name, group: 'new-process', args: [resolve(here, 'effect-process-fixture.ts'), root, name] })),
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
];
const results: any[] = [];
for (const gate of gates) {
  // Timeout is only a failing liveness bound, NEVER a cleanup success/handshake.
  const run = spawnSync(process.execPath, gate.args, { cwd: source, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const record = { name: gate.name, group: gate.group, command: [process.execPath, ...gate.args],
    status: run.status === 0 && !run.error ? 'PASS' : 'FAIL', exit: run.status, signal: run.signal,
    error: run.error ? String(run.error) : null, stdout: run.stdout, stderr: run.stderr };
  save(gate.name, record); results.push(record); console.log(JSON.stringify({ name: gate.name, status: record.status }));
  // Baseline negative controls are all selected in advance; do not stop on an
  // expected process-domain failure. A preserved assertion failure stops cohort.
  if (record.status === 'FAIL' && gate.group === 'preserved') { process.exitCode = 1; break; }
}
save('summary', { provenance, results: results.map(({ name, group, status }) => ({ name, group, status })),
  newDenominator: scenarios.length, unrun: gates.slice(results.length).map(g => g.name), phase2APositive: 'PENDING',
  baselineOnly: true, negativeControlsRequireFailureClassification: true });
admit(); save('postflight', { verified: true, candidateEntries: 107, freezeEntries: 1020 });
