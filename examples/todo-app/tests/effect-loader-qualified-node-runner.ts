/** Targeted Node qualification, no input builds/edits/install or servers.
 * Invoke with the verified absolute Node 24.18.0 binary:
 * node this.ts <frozen-root> <download-toolchain-root> <NEW-evidence-dir>
 * Existing fixtures remain unchanged; stop entire cohort at first failure. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [frozenArg, toolchainArg, evidenceArg] = process.argv.slice(2);
assert.ok(frozenArg && toolchainArg && evidenceArg);
const frozen = resolve(frozenArg), toolchain = resolve(toolchainArg), evidence = resolve(evidenceArg);
assert.ok(!evidence.startsWith(frozen + sep));
mkdirSync(evidence); // preserve old cohorts
const save = (name: string, value: unknown) => writeFileSync(resolve(evidence, name + '.json'), JSON.stringify(value, null, 2));
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const here = dirname(fileURLToPath(import.meta.url));
const previous = resolve(here, 'effect-loader-expanded-runner.ts');
const source = resolve(frozen, 'runtime-source');
const script = (name: string) => resolve(source, 'scripts', name);
const fixture = script('fixtures/runtime-contracts/worker-uncloneable.cjs');
const gates = [
  { name: 'expanded-and-loader', args: [previous, frozen, resolve(evidence, 'expanded')], timeout: 240000 },
  { name: 'preserved-pid-and-endpoint', args: [previous, frozen, resolve(evidence, 'preserved'), '--preserved-only'], timeout: 120000 },
  { name: 'single-kernel-routing', args: [script('test-single-kernel-routing.mjs')], timeout: 30000 },
  { name: 'single-kernel-close', args: [script('test-single-kernel-close.mjs')], timeout: 30000 },
  { name: 'native-worker-uncloneable', args: [fixture], timeout: 15000 },
  { name: 'guest-worker-uncloneable', args: [script('verify-runtime-contracts.mjs'), 'worker-uncloneable'], timeout: 70000 },
  { name: 'guest-vm-import', args: [script('verify-runtime-contracts.mjs'), 'vm-import'], timeout: 70000 },
  { name: 'post-run-frozen-verification', args: [previous, frozen, resolve(evidence, 'postflight'), '--verify-only'], timeout: 120000 },
];
let qualification: any;
try {
  assert.equal(process.version, 'v24.18.0'); assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const binary = resolve(toolchain, 'node-v24.18.0-darwin-arm64/bin/node');
  assert.equal(realpathSync(process.execPath), realpathSync(binary));
  const download = json(resolve(toolchain, 'download-verification.json'));
  const archive = resolve(toolchain, 'node-v24.18.0-darwin-arm64.tar.gz');
  const sums = readFileSync(resolve(toolchain, 'SHASUMS256.txt'), 'utf8');
  assert.ok(sums.split('\n').includes('e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1  node-v24.18.0-darwin-arm64.tar.gz'));
  assert.equal(hash(archive), 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1');
  assert.equal(hash(archive), download.archiveSha256);
  assert.equal(hash(resolve(toolchain, 'SHASUMS256.txt')), download.checksumsSha256);
  assert.equal(hash(binary), json(resolve(toolchain, 'executable-verification.json')).executableSha256);
  const driver = readFileSync(previous, 'utf8');
  assert.ok(driver.includes('spawnSync(process.execPath, args,'));
  const directFixtures = ['effect-loader-fixture.ts', 'effect-loader-expanded-fixture.ts',
    script('test-process-egress-cleanup.mjs'), script('test-endpoint-cleanup.mjs')];
  for (const path of directFixtures) {
    const full = path.startsWith('/') ? path : resolve(here, path);
    assert.ok(!/\b(?:spawnSync|execFileSync|execSync|execFile|spawn)\s*\(\s*['"]node['"]/.test(readFileSync(full, 'utf8')),
      'Implicit host Node child executable in ' + full);
  }
  qualification = { node: process.version, executable: process.execPath, executableSha256: hash(binary),
    platform: process.platform, arch: process.arch, download, runnerSha256: hash(previous),
    fixtureSha256: hash(resolve(here, 'effect-loader-fixture.ts')),
    expandedFixtureSha256: hash(resolve(here, 'effect-loader-expanded-fixture.ts')),
    explicitNodeChildren: true, workerThreadsInheritNode: true,
    environment: 'No PATH/profile/global package edits; all Node CLI children use process.execPath',
    pendingFullSuites: ['verify-node.mjs (no selector; includes host/guest servers)', 'test-single-kernel.mjs (includes guest HTTP server)'],
    liveBrowserExecuted: false, toolkitBuildPerformed: false, nativeBuildPerformed: false };
  save('qualification', qualification);
} catch (error) {
  save('qualification-failure', { error: String(error), stack: (error as Error).stack }); throw error;
}
const results: any[] = [];
for (const gate of gates) {
  const run = spawnSync(process.execPath, gate.args, { cwd: source, encoding: 'utf8', timeout: gate.timeout, maxBuffer: 8 * 1024 * 1024 });
  const result: any = { name: gate.name, command: [process.execPath, ...gate.args], cwd: source,
    status: run.status === 0 && !run.error ? 'PASS' : 'FAIL', exit: run.status, signal: run.signal,
    error: run.error ? String(run.error) : null, stdout: run.stdout, stderr: run.stderr };
  save(gate.name, result); // preserve failure BEFORE validation/summary
  if (result.status === 'PASS' && ['expanded-and-loader', 'preserved-pid-and-endpoint'].includes(gate.name)) {
    try {
      const directory = resolve(evidence, gate.name === 'expanded-and-loader' ? 'expanded' : 'preserved');
      const summary = json(resolve(directory, 'summary.json'));
      assert.equal(summary.provenance.node, 'v24.18.0');
      assert.equal(summary.provenance.nodeExecutable, process.execPath);
      assert.equal(summary.provenance.qualifiedNode24_18, true);
      assert.equal(summary.provenance.candidateEntries, 106); assert.equal(summary.provenance.freezeEntries, 997);
      assert.equal(summary.provenance.mismatches, 0); assert.equal(summary.notRun.length, 0);
      for (const child of summary.results) {
        assert.equal(child.status, 'PASS');
        const childReceipt = json(resolve(directory, child.name + '.json'));
        assert.equal(childReceipt.command[0], process.execPath);
      }
      result.childChecks = summary.results;
    } catch (error) { result.status = 'FAIL'; result.receiptValidationError = String(error); }
    save(gate.name, result);
  }
  results.push(result);
  save('summary', { qualification, checks: results.map(({ name, status, childChecks }) => ({ name, status, childChecks })),
    notRun: gates.slice(results.length).map(g => g.name), firstFailure: result.status === 'FAIL' ? gate.name : null,
    qualifiedTargetedNodePassed: results.length === gates.length && results.every(r => r.status === 'PASS'),
    overallPilotAccepted: false, browserPending: true, fullAppPending: true, fullVerifyNodePending: true, fullSingleKernelPending: true });
  console.log(JSON.stringify({ gate: gate.name, status: result.status }));
  if (result.status === 'FAIL') { process.exitCode = 1; break; }
}
