/** Offline independent acceptance; no build/install/cleanup of input delivery.
 * node effect-loader-expanded-runner.ts <frozen-root> <NEW-evidence-dir> [--verify-only|--preserved-only]
 * NODE executable is the runner's own process.execPath; first failed case stops.
 * Qualified tooling is recorded, not guessed from a PATH/install directory. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [rootArg, outputArg, option] = process.argv.slice(2);
assert.ok(rootArg && outputArg, 'See header for usage');
assert.ok(!option || option === '--verify-only' || option === '--preserved-only');
const root = resolve(rootArg), output = resolve(outputArg);
assert.ok(!output.startsWith(root + sep), 'Evidence must be outside immutable frozen delivery');
mkdirSync(output); // never overwrite an old cohort
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const save = (name: string, value: unknown) => writeFileSync(resolve(output, name + '.json'), JSON.stringify(value, null, 2));
let provenance: any;
try {
  assert.equal(hash(resolve(root, 'delivery.tar.gz')), '52b857effc27289d553d0e39851954b1fb9042a5eb80f01c1b551c4a07e71b47');
  assert.equal(hash(resolve(root, 'candidate-receipt.json')), '1ef11f7c30b262b211d43a57f2142697ddf87ac3e086d87fb684640b225e75f9');
  const receipt = json('candidate-receipt.json'), frozen = json('freeze-manifest.json');
  assert.equal(receipt.runtimeRevision, '5c4b1c5655b54a840370fa6215e51fd661701591');
  assert.equal(receipt.toolkitRevision, '9814c715cfca42309c581440577976833f4326e6');
  assert.equal(receipt.effectVersion, '4.0.0-rc.118');
  assert.equal(json('runtime-source/packages/kernel-lifecycle/package.json').dependencies.effect, receipt.effectVersion);
  const verify = (entries: Record<string, string>, base: string) => {
    for (const [path, expected] of Object.entries(entries)) {
      const target = resolve(base, path);
      assert.ok(target.startsWith(base + sep), 'manifest path escapes input root');
      assert.equal(hash(target), expected, 'Artifact differs: ' + path);
    }
    return Object.keys(entries).length;
  };
  const candidateEntries = verify(receipt.hashes, resolve(root, 'candidate'));
  const freezeEntries = verify(frozen, root);
  assert.equal(candidateEntries, 106); assert.equal(freezeEntries, 997);
  assert.equal(hash(resolve(root, 'runtime-source.tar')), receipt.runtimeArchiveSha256);
  assert.equal(hash(resolve(root, 'toolkit-source.tar')), receipt.toolkitArchiveSha256);
  assert.equal(hash(resolve(root, receipt.compiledCore.path)), receipt.compiledCore.sha256);
  const text = (path: string) => readFileSync(resolve(root, path), 'utf8');
  const kernel = text('runtime-source/packages/kernel-host/kernel.js');
  const worker = text('runtime-source/packages/core/src/workers/kernel-worker.ts');
  assert.match(kernel, /import \{ createLoaderLifecycle \} from '\.\.\/kernel-lifecycle\/dist\/index\.js'/);
  assert.match(worker, /import.*Kernel.*kernel-host\/kernel\.js/);
  assert.match(worker, /hostKernel\.createLaunchOwner\(\)/);
  assert.match(worker, /await hostKernel\.launchLoaded\(/);
  assert.match(worker, /fetchLoaderVendorBytes\(vendorUrl\(asset\), context\.signal\)/);
  const core = text(receipt.compiledCore.path);
  const browserCore = text('candidate/' + receipt.compiledCore.browserWorker);
  for (const marker of ['KernelLoader.installGeneration', 'KernelLoader.drainOwner', 'Loader cleanup failed']) {
    assert.ok(core.includes(marker), 'missing compiled core marker: ' + marker);
    assert.ok(browserCore.includes(marker), 'missing packaged worker core marker: ' + marker);
  }
  assert.ok(browserCore.includes('launchLoaded'));
  assert.equal(hash(resolve(root, 'candidate/runtime/assets/kernel-worker-BXNXoz3O.js')),
    hash(resolve(root, 'candidate/sdk/assets/kernel-worker-BXNXoz3O.js')));
  // Compare critical imported/orchestrating source bytes directly to committed
  // archive members, not merely the owner-written hash claims.
  const sourcePaths = ['packages/kernel-host/kernel.js', 'packages/kernel-host/load-real-tsgo.js',
    'packages/kernel-host/loader-vendor-bytes.js', 'packages/kernel-host/loader-install-transaction.js',
    'packages/kernel-lifecycle/src/index.ts', 'packages/core/src/workers/kernel-worker.ts',
    'packages/core/src/host-sdk/execution.ts'];
  for (const path of sourcePaths) {
    const member = spawnSync('tar', ['-xOf', resolve(root, 'runtime-source.tar'), path]);
    assert.equal(member.status, 0, String(member.stderr));
    assert.deepEqual(member.stdout, readFileSync(resolve(root, 'runtime-source', path)), 'Archive/source mismatch: ' + path);
  }
  const toolkitMember = spawnSync('tar', ['-xOf', resolve(root, 'toolkit-source.tar'), 'workspace-api/src/runtime.ts']);
  assert.equal(toolkitMember.status, 0, String(toolkitMember.stderr));
  assert.deepEqual(toolkitMember.stdout, readFileSync(resolve(root, 'toolkit-source/workspace-api/src/runtime.ts')));
  const distribution = json('candidate/runtime/distribution.json');
  provenance = { runtimeRevision: receipt.runtimeRevision, toolkitRevision: receipt.toolkitRevision,
    effectVersion: receipt.effectVersion, candidateVersion: distribution.version,
    candidateEntries, freezeEntries, mismatches: 0, deliverySha256: hash(resolve(root, 'delivery.tar.gz')),
    receiptSha256: hash(resolve(root, 'candidate-receipt.json')), freezeManifestSha256: hash(resolve(root, 'freeze-manifest.json')),
    compiledCoreSha256: receipt.compiledCore.sha256, sdkSha256: receipt.hashes['sdk/host.js'],
    workspaceLibrarySha256: receipt.hashes['workspace/index.js'], browserWorkerSha256: receipt.hashes[receipt.compiledCore.browserWorker],
    archiveSourceMembersCompared: sourcePaths, node: process.version, nodeExecutable: process.execPath,
    qualifiedNode24_18: process.version === 'v24.18.0', offline: true, liveBrowserExecuted: false,
    sameCompiledCoreStaticDelivery: true, runtimeRoot: resolve(root, 'runtime-source'),
    nativeRebuilt: false, toolkitLibraryBuiltSeparately: true };
  save('provenance', provenance);
} catch (error) {
  save('provenance-failure', { error: String(error), stack: (error as Error).stack, node: process.version });
  throw error;
}
if (option === '--verify-only') {
  console.log(JSON.stringify(provenance));
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  const expanded = resolve(here, 'effect-loader-expanded-fixture.ts');
  const previous = resolve(here, 'effect-loader-fixture.ts');
  const sdk = resolve(root, 'candidate/sdk/host.js');
  const expandedGates = [
    ...['held-vendor', 'held-write', 'shared-interest', 'loader-failure'].map(name => ({ name: 'preserved-' + name,
      script: previous, args: [provenance.runtimeRoot, sdk, name, 'accept'] })),
    ...['native-stream-cancel-held', 'native-stream-cancel-failed', 'native-fetch-ignored-abort',
      'native-read-ignored-abort', 'prepid-shared-interest', 'prepid-held-write',
      'prepid-rollback-failed', 'sdk-pid-rollback-failed', 'runtime-prepid-held-success',
      'runtime-prepid-rollback-failed'].map(name => ({ name, script: expanded, args: [root, name] })),
  ];
  const preservedGates = [
    { name: 'preserved-pid-egress', script: resolve(root, 'runtime-source/scripts/test-process-egress-cleanup.mjs'),
      args: [resolve(root, 'runtime-source/packages/kernel-host/kernel.js'), sdk] },
    { name: 'preserved-endpoint', script: resolve(root, 'runtime-source/scripts/test-endpoint-cleanup.mjs'), args: [sdk] },
  ];
  const gates = option === '--preserved-only' ? preservedGates : expandedGates;
  save('test-scope', { gates: gates.map(g => g.name), oldFixtureSha256: hash(previous), expandedFixtureSha256: hash(expanded),
    pending: ['qualified-Node-24.18.0', 'real-browser-native-cancellation', 'full-todo-app/editor/close', 'remaining-domains/all-writer-quiescence'] });
  const results: any[] = [];
  for (const gate of gates) {
    const args = [gate.script, ...gate.args];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
    const result = { name: gate.name, command: [process.execPath, ...args], exit: run.status, signal: run.signal,
      error: run.error ? String(run.error) : null, stdout: run.stdout, stderr: run.stderr,
      status: run.status === 0 ? 'PASS' : 'FAIL' };
    save(gate.name, result); results.push(result);
    // Failure evidence on disk BEFORE stopping cohort; no forced green cleanup.
    save('summary', { provenance, results: results.map(({ name, status }) => ({ name, status })),
      notRun: gates.slice(results.length).map(g => g.name), firstFailure: result.status === 'FAIL' ? gate.name : null,
      expandedOfflinePassed: option !== '--preserved-only' && results.length === gates.length && results.every(r => r.status === 'PASS'),
      preservedRegressionChecks: option === '--preserved-only',
      overallPilotAccepted: false, qualifiedNodePending: !provenance.qualifiedNode24_18,
      liveBrowserPending: true, fullAppPending: true, cleanupPerformed: false });
    console.log(JSON.stringify({ gate: gate.name, status: result.status }));
    if (result.status === 'FAIL') { process.exitCode = 1; break; }
  }
}
