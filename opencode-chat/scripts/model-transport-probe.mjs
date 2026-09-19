// Opt-in test helper: run the unchanged qualified server inside the real guest runtime.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runHeadlessProcessProbe } from '../../vivari/scripts/headless-process-probe.mjs';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const result = await runHeadlessProcessProbe({ directory: input.directory, name: 'model-transport', timeoutMs: 60000,
  exercise: async api => {
    const receiptBytes = readFileSync(input.application + '/build-receipt.json');
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash(receiptBytes), input.receiptSha256);
    const receipt = JSON.parse(receiptBytes);
    for (const [file, expected] of Object.entries(receipt.outputs)) {
      const bytes = readFileSync(input.application + '/.runtime/opencode-bun-server/' + file);
      assert.equal(hash(bytes), expected.sha256);
      await api.kernel.writeFilesBatch([{ path: '/app/' + file, bytes }]);
    }
    await api.kernel.writeFilesBatch([
      { path: '/workspace/.server/config/opencode/opencode.json', bytes: Buffer.from(JSON.stringify(input.config)) },
      { path: '/workspace/.server/config/opencode/plugins/editor-model-headers.js', bytes: Buffer.from(input.plugin) },
    ]);
    api.launch('/bin/bun.js', ['/app/server.js'], { cwd: '/workspace', env: {
      PATH: '/bin', HOME: '/workspace/.server', OPENCODE_TEST_HOME: '/workspace/.server', OPENCODE_PASSWORD: 'isolated-test',
      XDG_CONFIG_HOME: '/workspace/.server/config', XDG_STATE_HOME: '/workspace/.server/state',
      XDG_DATA_HOME: '/workspace/.server/data', XDG_CACHE_HOME: '/workspace/.server/cache', TMPDIR: '/tmp',
      OPENCODE_TREE_SITTER_WASM_PATH: '/app/tree-sitter.wasm',
      OPENCODE_TREE_SITTER_BASH_WASM_PATH: '/app/tree-sitter-bash.wasm',
      OPENCODE_TREE_SITTER_POWERSHELL_WASM_PATH: '/app/tree-sitter-powershell.wasm',
    } });
    await api.waitForOutput('stdout', 'OPENCODE_SERVER_PROCESS_READY');
    const request = (method, url, body) => api.request(4096, { method, url,
      headers: { authorization: 'Basic ' + Buffer.from('opencode:isolated-test').toString('base64'), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal((await request('POST', '/api/plugin/await-activation?location%5Bdirectory%5D=%2Fworkspace')).status, 204);
    const plugins = JSON.parse((await request('GET', '/api/plugin?location%5Bdirectory%5D=%2Fworkspace')).body);
    assert(plugins.data.some(plugin => plugin.id === 'editor.model-headers' && plugin.state.status === 'active'));
    api.stage('plugin.active');
    const created = await request('POST', '/api/session', { location: { directory: '/workspace' }, model: input.model });
    assert.equal(created.status, 200, created.body);
    const session = JSON.parse(created.body).data;
    const generated = await request('POST', `/api/session/${session.id}/generate`, { prompt: 'Transport qualification only' });
    console.log('Generated result', generated);
    // Mock provider deliberately rejects the call; the parent asserts the native request it received.
    assert.notEqual(generated.status, 404, generated.body);
    api.stage('model.dispatched', { status: generated.status });
    api.closeStdin();
    await api.waitForOutput('stdout', 'OPENCODE_SERVER_PROCESS_SHUTDOWN_COMPLETE');
    await api.waitForExit();
  },
});
console.log(JSON.stringify({ result: result.receipt.result, receiptPath: result.receiptPath, failure: result.receipt.primaryFailure }));
process.exitCode = result.receipt.result === 'PASS' ? 0 : 1;
