/** Finite offline gates. Evidence is written before any caller-owned cleanup.
 * bun effect-loader-regression-gates.ts <runtime archive> <built sdk/host.js>
 *   <candidate-receipt.json> <NEW evidence directory> baseline|accept
 * Does not build, install, run servers, mutate input archives, or clean anything.
 * accept is deliberately NOT overall pilot acceptance: missing adapters stay pending. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [rootArg, sdkArg, receiptArg, evidenceArg, mode] = process.argv.slice(2);
assert.ok(rootArg && sdkArg && receiptArg && evidenceArg, 'See file header for usage');
assert.ok(mode === 'baseline' || mode === 'accept');
const root = resolve(rootArg), sdk = resolve(sdkArg), evidence = resolve(evidenceArg);
const testDir = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(readFileSync(resolve(testDir, 'effect-loader-baseline-provenance.json'), 'utf8'));
const receipt = JSON.parse(readFileSync(resolve(receiptArg), 'utf8'));
assert.match(receipt.runtimeRevision, /^[a-f0-9]{40}$/);
assert.match(receipt.toolkitRevision, /^[a-f0-9]{40}$/);
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(sha256(sdk), receipt.hashes['sdk/host.js'], 'SDK differs from candidate receipt');
if (mode === 'baseline') {
  assert.equal(receipt.runtimeRevision, baseline.runtimeRevision);
  assert.equal(receipt.toolkitRevision, baseline.toolkitRevision);
  assert.equal(receipt.runtimeArchiveSha256, baseline.runtimeArchiveSha256);
  assert.equal(receipt.toolkitArchiveSha256, baseline.toolkitArchiveSha256);
  assert.equal(sha256(sdk), baseline.sdkSha256);
  for (const [path, expected] of Object.entries(baseline.sourceHashes)) {
    assert.equal(sha256(resolve(root, path)), expected, 'baseline source/native mismatch: ' + path);
  }
}
mkdirSync(evidence); // refuse an existing directory, never overwrite an old cohort
const files = ['packages/kernel-host/kernel.js', 'packages/kernel-host/load-real-tsgo.js',
  'packages/kernel-host/fs-server.js', 'packages/kernel-host/direct-kernel-fs.js',
  'packages/protocol/syscall.js', 'packages/vfs/pkg-node/vivari_vfs.js',
  'packages/vfs/pkg-node/vivari_vfs_bg.wasm'];
const provenance = { runtimeRoot: root, sdk, receiptPath: resolve(receiptArg),
  receiptSha256: sha256(resolve(receiptArg)), runtimeRevision: receipt.runtimeRevision,
  toolkitRevision: receipt.toolkitRevision, candidateVersion: receipt.version ?? receipt.candidateVersion ??
    (receipt.runtimeRevision === baseline.runtimeRevision ? baseline.candidateVersion : null),
  nativeRebuilt: false, nativeReuseClaim: receipt.nativeRebuilt === false,
  sourceHashes: Object.fromEntries(files.map(path => [path, sha256(resolve(root, path))])),
  sdkSha256: sha256(sdk), fixtureSha256: sha256(resolve(testDir, 'effect-loader-fixture.ts')),
  bun: Bun.version, node: process.version, mode, offline: true };
writeFileSync(resolve(evidence, 'provenance.json'), JSON.stringify(provenance, null, 2));
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'effect-loader-fixture.ts');
const results = [];
if (mode === 'baseline') {
  const original = resolve(dirname(fixture), 'cached-switch-lazy-loader-stop-proof.mjs');
  const command = [original, root, sdk];
  const run = spawnSync(process.execPath, command, { encoding: 'utf8', timeout: 15000 });
  writeFileSync(resolve(evidence, 'original-negative-control.json'), JSON.stringify({
    command: [process.execPath, ...command], testSha256: sha256(original), exit: run.status,
    signal: run.signal, error: run.error ? String(run.error) : null,
    stdout: run.stdout, stderr: run.stderr }, null, 2));
  results.push({ scenario: 'original-negative-control', status: run.status === 0 ? 'PASS' : 'FAIL' });
}
for (const scenario of ['held-vendor', 'held-write', 'shared-interest', 'loader-failure']) {
  const command = [fixture, root, sdk, scenario, mode];
  const run = spawnSync(process.execPath, command, { encoding: 'utf8', timeout: 15000 });
  const result = { scenario, command: [process.execPath, ...command], exit: run.status,
    signal: run.signal, error: run.error ? String(run.error) : null, stdout: run.stdout, stderr: run.stderr };
  writeFileSync(resolve(evidence, scenario + '.json'), JSON.stringify(result, null, 2));
  results.push({ scenario, status: run.status === 0 ? 'PASS' : 'FAIL' });
}
const pending = ['native-abort-request-through-supported-loader-adapter',
  'pre-PID-production-host-launch-close', 'rollback-failure-public-receipt-and-runtime-attachment',
  'browser-and-Node-same-compiled-core-delivery'];
const summary = { mode, results, pending, overallPilotAccepted: false,
  expectedBaselineFailures: mode === 'baseline' ? ['held-vendor', 'held-write', 'loader-failure'] : [],
  evidence, cleanupPerformed: false };
writeFileSync(resolve(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
