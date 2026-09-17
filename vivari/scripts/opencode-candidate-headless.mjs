// Current published ServerProcess artifact, unchanged. No model credentials.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runHeadlessProcessProbe } from './headless-process-probe.mjs';

const root = resolve(process.argv[2]);
const output = resolve(root, '.runtime/opencode-bun-server');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptBytes = readFileSync(resolve(root, 'build-receipt.json'));
const build = JSON.parse(receiptBytes);
assert.equal(build.source.package, '@opencode/server');
assert.equal(build.source.version, '2.0.3');
assert.match(build.policy, /no source or output rewrites/);
const result = await runHeadlessProcessProbe({
  directory: process.env.PROBE_OUTPUT || resolve(import.meta.dirname, '../.runtime/headless-diagnostics'),
  name: 'upstream-opencode-2.0.3', timeoutMs: 120_000,
  provenance: { buildReceiptSha256: hash(receiptBytes), serverSha256: build.outputs['server.js'].sha256,
    storage: 'fresh disk-backed SQLite snapshot adapter; not OPFS', guest: '/bin/bun.js /app/server.js' },
  exercise: async api => {
    assert.deepEqual(readdirSync(output).sort(), Object.keys(build.outputs).sort());
    for (const [file, expected] of Object.entries(build.outputs)) {
      const bytes = readFileSync(resolve(output, file));
      assert.equal(bytes.length, expected.bytes); assert.equal(hash(bytes), expected.sha256);
      await api.kernel.writeFilesBatch([{ path: '/app/' + file, bytes }]);
    }
    api.stage('artifact.verified-and-mounted');
    api.kernel.mkdirp('/workspace/.server');
    const pid = api.launch('/bin/bun.js', ['/app/server.js'], { cwd: '/workspace', env: {
      PATH: '/bin', HOME: '/workspace/.server', OPENCODE_PASSWORD: 'isolated-probe-only',
      XDG_CONFIG_HOME: '/workspace/.server/config', XDG_STATE_HOME: '/workspace/.server/state',
      XDG_DATA_HOME: '/workspace/.server/data', XDG_CACHE_HOME: '/workspace/.server/cache',
      OPENCODE_TEST_HOME: '/workspace/.server', TMPDIR: '/tmp',
      OPENCODE_TREE_SITTER_WASM_PATH: '/app/tree-sitter.wasm',
      OPENCODE_TREE_SITTER_BASH_WASM_PATH: '/app/tree-sitter-bash.wasm',
      OPENCODE_TREE_SITTER_POWERSHELL_WASM_PATH: '/app/tree-sitter-powershell.wasm',
    } });
    await api.waitForOutput('stdout', 'OPENCODE_SERVER_PROCESS_READY', 'background service boot failed');
    api.stage('application.ready');
    const unauthorized = await api.request(4096, { method: 'GET', url: '/api/health', headers: {} });
    assert.equal(unauthorized.status, 401);
    const health = await api.request(4096, { method: 'GET', url: '/api/health', headers: {
      authorization: 'Basic ' + Buffer.from('opencode:isolated-probe-only').toString('base64'),
    } });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { healthy: true, version: '2.0.3', pid });
    api.stage('health.authenticated');
    api.closeStdin();
    await api.waitForOutput('stdout', 'OPENCODE_SERVER_PROCESS_SHUTDOWN_COMPLETE');
    const exit = await api.waitForExit();
    assert.equal(exit.code, 0); assert.equal(exit.natural, true);
    api.stage('shutdown.natural');
  },
});
console.log(JSON.stringify({ result: result.receipt.result, receiptPath: result.receiptPath,
  primaryFailure: result.receipt.primaryFailure, exit: result.receipt.exit }, null, 2));
process.exitCode = result.receipt.result === 'PASS' ? 0 : 1;
