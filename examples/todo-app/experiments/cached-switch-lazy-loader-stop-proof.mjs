/** Offline causal characterization: actual committed kernel, tsgo loader, Rust
 * VFS, FsServer/direct access and built SDK; controlled worker/relay/vendor bytes.
 * No guest, browser, server, OPFS or network. Historical egress proof unchanged. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(process.argv[2] ?? '');
const sdk = resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) throw Error('Usage: bun cached-switch-lazy-loader-stop-proof.mjs <committed runtime root with verified pkg-node> <built sdk/host.js>');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const { Kernel } = await load('packages/kernel-host/kernel.js');
const { FsServer } = await load('packages/kernel-host/fs-server.js');
const { createDirectKernelFs } = await load('packages/kernel-host/direct-kernel-fs.js');
const { ensureRealTsgo } = await load('packages/kernel-host/load-real-tsgo.js');
const protocol = await load('packages/protocol/syscall.js');
const { launch } = await import(pathToFileURL(sdk).href);
const require = createRequire(import.meta.url);
const { VirtualFileSystem } = require(resolve(root, 'packages/vfs/pkg-node/vivari_vfs.js'));
const vfs = new VirtualFileSystem();
const fs = createDirectKernelFs(new FsServer(vfs));
const cache = '/workspace/.browser-editor-cache/vite';
fs.mkdirp(cache); fs.mkdirp('/usr/lib/tsgo');
fs.symlink(cache, '/bin');
fs.writeFile('/bin/node.js', ''); fs.writeFile('/fixture.js', '');
const workers = new Map(), listeners = new Set(), executions = new Map();
let publishExit = false, releaseVendor, startedVendor;
const heldVendor = new Promise(yes => { releaseVendor = yes; });
const vendorStarted = new Promise(yes => { startedVendor = yes; });
// Valid vendor framing with tiny synthetic files; no real compiler is executed.
const header = Buffer.from(JSON.stringify({ version: 'offline-fixture', files: [
  { p: 'tsgo.wasm', o: 0, l: 1 }, { p: 'wasm_exec.cjs', o: 1, l: 1 },
] }));
const size = Buffer.alloc(4); size.writeUInt32LE(header.length);
const pack = gzipSync(Buffer.concat([size, header, Buffer.from([1, 2])]));
const kernel = new Kernel({ fs, spawnWorker(info) {
  workers.set(info.pid, info); return { terminate() {}, postMessage() {} };
}, stdout() {}, stderr() {} });
kernel.registerLazyProgram(['tsc', 'tsgo'], () => ensureRealTsgo(kernel, async () => {
  startedVendor(); await heldVendor; return pack;
}));
const emit = message => { for (const listener of [...listeners]) listener(message); };
kernel.onProcExit = (pid, result) => {
  publishExit = true;
  emit({ type: 'proc-exit', execId: executions.get(pid), code: result.code,
    signal: result.signal, cleanupError: result.cleanupError });
};
const host = { nextExecution: 1,
  async request(type) { assert.equal(type, 'vv-stat'); return { exists: true, isDir: false }; },
  on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  post(type, message) {
    if (type === 'proc-spawn') {
      const pid = kernel.launch(message.command, message.args, { cwd: message.cwd, env: message.env });
      executions.set(pid, message.execId); emit({ type: 'proc-started', execId: message.execId });
    } else if (type === 'proc-kill') {
      kernel.stop([...executions].find(([, id]) => id === message.execId)?.[0]);
    } else assert.equal(type, 'proc-input');
  },
};
const bounded = async (promise, phase) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Fixture timeout: ' + phase)), 5000);
  })]); } finally { clearTimeout(timer); }
};
const execution = await bounded(launch(host, { entry: '/fixture.js' }), 'SDK launch');
const worker = workers.get([...executions.keys()][0]);
const { ctrl, data } = protocol.makeViews(worker.sab);
const request = protocol.encodeRequest([protocol.encodeString(JSON.stringify({ command: 'tsc', args: [], cwd: '/workspace', env: {} }))]);
data.set(request);
Atomics.store(ctrl, protocol.I_OPCODE, protocol.OP_SPAWN_ASYNC);
Atomics.store(ctrl, protocol.I_REQ_LEN, request.length);
Atomics.store(ctrl, protocol.I_STATE, protocol.STATE_REQUEST);
worker.on.syscall();
await bounded(vendorStarted, 'lazy vendor start');
// Private promises ONLY for fixture cleanup, never proposed as consumer APIs.
const owned = [...kernel.lazyInflight.values()];
const drain = async stream => { for await (const _ of stream) {} };
try {
  await bounded(Promise.all([execution.stop(), drain(execution.stdout), drain(execution.stderr)]), 'SDK stop/readers');
  assert.equal(publishExit, true); assert.equal(kernel.procs.size, 0);
  assert.equal(kernel.lazyInflight.size, 1);
  assert.equal(kernel.diagnostics().fetch.active, 0);
  assert.deepEqual(fs.readdir(cache), ['node.js']);
  releaseVendor(); await Promise.all(owned); await new Promise(setImmediate);
  assert.equal(fs.lstat('/bin').kind, 'symlink');
  assert.deepEqual(fs.readdir(cache).sort(), ['node.js', 'tsc.js', 'tsgo.js']);
  assert.ok(fs.readFile(cache + '/tsc.js').includes('/usr/lib/tsgo/tsgo-run.js'));
  assert.equal(kernel.procs.size, 0, 'spawn continuation correctly refuses a dead parent');
  console.log(JSON.stringify({ executionStopJoined: true, readersJoined: true,
    processesAtStop: 0, pidFetchActiveAtStop: 0, lazyLoadsAtStop: 1,
    lateAuditedCacheFiles: fs.readdir(cache).length - 1, lateChildSpawn: false,
    sourceOwnershipProvenAtStop: false }));
} finally { releaseVendor(); await Promise.allSettled(owned); }
