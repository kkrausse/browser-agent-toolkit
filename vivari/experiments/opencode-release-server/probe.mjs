import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, MessageChannel } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { runtimeSourceUrl } from '../../scripts/runtime-source.mjs';

const root = fileURLToPath(new URL('../../.runtime/opencode-release-2.0.3/', import.meta.url));
const inputRoot = process.env.OPENCODE_PROBE_BASELINE ?? root;
const version = process.env.OPENCODE_PROBE_BASELINE ? '0.0.0-beta-19425' : '2.0.3';
const output = resolve(inputRoot, '.runtime/opencode-bun-server');
const receipt = JSON.parse(readFileSync(resolve(inputRoot, 'build-receipt.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(receipt.sourceRevision, process.env.OPENCODE_PROBE_BASELINE
  ? '20aff6d9f643afe9abf8a048e68f019d049f5329' : 'd44b52ca66b6bf69626c0384626d1a9cd9555977');
assert.deepEqual(readdirSync(output).sort(), Object.keys(receipt.outputs).sort());
for (const [file, expected] of Object.entries(receipt.outputs)) {
  const bytes = readFileSync(resolve(output, file));
  assert.equal(bytes.length, expected.bytes);
  assert.equal(hash(bytes), expected.sha256);
}
const { Kernel } = await import(runtimeSourceUrl('packages/kernel-host/kernel.js'));
const { createKernelFs } = await import(runtimeSourceUrl('packages/kernel-host/kernel-fs.js'));
const directory = process.env.OPENCODE_PROBE_STORAGE ?? mkdtempSync(resolve(root, 'storage-'));
mkdirSync(directory, { recursive: true });
const workers = new Set();
const errors = [];
let stdout = '', stderr = '', pid, port, checks, accepted = false, kernel;
const deadline = setTimeout(() => { console.error('OPENCODE_RELEASE_TIMEOUT'); process.exit(124); }, 90000);
const password = 'isolated-release-probe';
async function check() {
  try {
    assert.equal(port, 4096);
    const request = async (headers, url = '/api/health', body) => {
      let timer;
      try {
        return await Promise.race([
          kernel.handleHttpRequest(port, { method: body === undefined ? 'GET' : 'POST', url,
            headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers }, body: body ?? '' }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Health timeout')), 10000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    assert.equal((await request({})).status, 401);
    const headers = { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') };
    const response = await request(headers);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { healthy: true, version, pid });
    console.log('OPENCODE_RELEASE_HEALTH_PASS');
    if (process.argv.includes('--seed-migration')) {
      const created = await request(headers, '/api/session', JSON.stringify({ title: 'Release migration probe', location: { directory: '/workspace' } }));
      assert.equal(created.status, 200);
      const session = JSON.parse(created.body).data;
      assert.equal(typeof session.id, 'string');
      writeFileSync(resolve(directory, 'migration-session.json'), JSON.stringify(session));
      console.log('OPENCODE_MIGRATION_SEEDED', session.id);
    }
    if (process.argv.includes('--verify-migration')) {
      const previous = JSON.parse(readFileSync(resolve(directory, 'migration-session.json'), 'utf8'));
      const response = await request(headers, '/api/session/' + encodeURIComponent(previous.id));
      assert.equal(response.status, 200);
      const retained = JSON.parse(response.body).data;
      for (const key of ['id', 'title', 'projectID', 'location']) assert.deepEqual(retained[key], previous[key]);
      console.log('OPENCODE_MIGRATION_RETAINED', retained.id);
    }
    accepted = true;
    kernel.sendStdin(pid, null);
  } catch (error) { errors.push(String(error)); kernel.stop(pid); }
}
try {
  const fsWorker = new Worker(new URL('../../scripts/sqlite-headless-fs.mjs', import.meta.url), { workerData: { directory } });
  workers.add(fsWorker);
  let dispatch = () => {};
  await new Promise((done, reject) => {
    fsWorker.once('error', reject);
    fsWorker.on('message', m => m.type === 'ready' ? done() : dispatch(m));
  });
  const bridge = createKernelFs(fsWorker);
  dispatch = bridge.onMessage;
  kernel = new Kernel({ fs: bridge.fs,
    stdout: s => { stdout += s; process.stdout.write(s); if (!checks && stdout.includes('OPENCODE_SERVER_PROCESS_READY')) checks = check(); },
    stderr: s => { stderr += s; process.stderr.write(s); },
    spawnWorker(info) {
      const worker = new Worker(runtimeSourceUrl('scripts/process-worker.mjs'));
      workers.add(worker);
      worker.on('message', m => info.on[m.type]?.(m));
      worker.on('error', error => { errors.push(String(error)); kernel.stop(info.pid); });
      const { port1, port2 } = new MessageChannel();
      fsWorker.postMessage({ type: 'fs-register', client: info.pid, sab: info.sab, port: port2 }, [port2]);
      worker.postMessage({ type: 'init', sab: info.sab, spec: info.spec, fsPort: port1 }, [port1]);
      return { postMessage: m => worker.postMessage(m), terminate() {
        void worker.terminate(); fsWorker.postMessage({ type: 'fs-unregister', client: info.pid });
      } };
    },
  });
  kernel.installCoreutils();
  await kernel.writeFilesBatch(Object.keys(receipt.outputs).map(file => ({ path: '/app/' + file, bytes: readFileSync(resolve(output, file)) })));
  for (const path of ['/home/direct/config', '/home/direct/state', '/home/direct/data', '/home/direct/cache', '/home/direct/tmp', '/runtime-probe', '/workspace']) kernel.mkdirp(path);
  kernel.onListen = (listeningPort, listeningPid) => { port = listeningPort; pid = listeningPid; console.log('OPENCODE_RELEASE_LISTEN', port); };
  const result = await kernel.start('bun', ['/app/server.js'], { cwd: '/app', env: {
    PATH: '/bin', HOME: '/home/direct', OPENCODE_PASSWORD: password,
    XDG_CONFIG_HOME: '/home/direct/config', XDG_STATE_HOME: '/home/direct/state',
    XDG_DATA_HOME: '/home/direct/data', XDG_CACHE_HOME: '/home/direct/cache',
    OPENCODE_TEST_HOME: '/home/direct', TMPDIR: '/home/direct/tmp',
    OPENCODE_TREE_SITTER_WASM_PATH: '/app/tree-sitter.wasm',
    OPENCODE_TREE_SITTER_BASH_WASM_PATH: '/app/tree-sitter-bash.wasm',
    OPENCODE_TREE_SITTER_POWERSHELL_WASM_PATH: '/app/tree-sitter-powershell.wasm',
  }, capture: false });
  await checks;
  assert.deepEqual(errors, []);
  assert.equal(accepted, true);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.ok(stdout.includes('OPENCODE_SERVER_PROCESS_SHUTDOWN_COMPLETE'));
  assert.equal(stderr, '');
  console.log('OPENCODE_RELEASE_PASS', JSON.stringify({ version, exit: result.code, receiptSha256: hash(readFileSync(resolve(inputRoot, 'build-receipt.json'))) }));
} finally {
  clearTimeout(deadline);
  await Promise.all([...workers].map(worker => worker.terminate()));
}
