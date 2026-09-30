/** Offline characterization, not browser/guest fidelity or TODO overlap evidence.
 * Run with committed kernel.js and separately built committed host SDK index.js.
 * The injected worker emits real OP_FETCH_ASYNC frames; filesystem and network
 * are controlled in-memory leaves. No worker, server or network is launched. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';

const kernelPath = resolve(process.argv[2] ?? '');
const sdkPath = resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) throw Error('Usage: bun cached-switch-egress-stop-proof.mjs <committed kernel.js> <built host/index.js>');
const { Kernel } = await import(pathToFileURL(kernelPath).href);
const { launch } = await import(pathToFileURL(sdkPath).href);
const protocol = await import(pathToFileURL(resolve(dirname(kernelPath), '../protocol/syscall.js')).href);
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const first = deferred(), second = deferred(), secondStarted = deferred();
const workers = new Map(), listeners = new Set(), executions = new Map();
const writes = [], networkStarts = [];
let exited = false;
const files = new Map([['/bin/node.js', new Uint8Array()], ['/fixture.js', new Uint8Array()]]);
const kernel = new Kernel({
  fs: {
    exists: path => files.has(path), isFile: path => files.has(path), mkdirp() {},
    async writeLarge(path, bytes) { files.set(path, bytes.slice()); writes.push({ path, afterExit: exited }); },
    unlink(path) { files.delete(path); },
  },
  spawnWorker(info) {
    workers.set(info.pid, info);
    return { terminate() {}, postMessage() {} };
  },
  stdout() {}, stderr() {},
});
kernel.fetchConcurrency = 1;
kernel.fetcher = async url => {
  networkStarts.push({ url, afterExit: exited });
  if (url.endsWith('/first')) await first.promise;
  else { secondStarted.resolve(); await second.promise; }
  return { status: 200, ok: true, headers: {}, body: new Uint8Array([1, 2, 3]) };
};
const emit = message => { for (const listener of [...listeners]) listener(message); };
kernel.onProcExit = (pid, result) => {
  exited = true;
  emit({ type: 'proc-exit', execId: executions.get(pid), code: result.code, signal: result.signal });
};
// The SDK consumes the kernel's actual exit receipt. Only the host relay is modeled.
const host = {
  nextExecution: 1,
  async request(type) { assert.equal(type, 'vv-stat'); return { exists: true, isDir: false }; },
  on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  post(type, message) {
    if (type === 'proc-spawn') {
      const pid = kernel.launch(message.command, message.args, { cwd: message.cwd, env: message.env });
      assert.ok(pid > 0);
      executions.set(pid, message.execId);
      emit({ type: 'proc-started', execId: message.execId });
    } else if (type === 'proc-kill') {
      const pid = [...executions].find(([, id]) => id === message.execId)?.[0];
      kernel.stop(pid);
    } else assert.equal(type, 'proc-input');
  },
};
const execution = await launch(host, { entry: '/fixture.js' });
const pid = [...executions.keys()][0], worker = workers.get(pid);
function request(fetchId, suffix) {
  const { ctrl, data } = protocol.makeViews(worker.sab);
  const bytes = protocol.encodeRequest([protocol.encodeString(JSON.stringify({ fetchId, url: 'https://fixture.invalid/' + suffix }))]);
  data.set(bytes);
  Atomics.store(ctrl, protocol.I_OPCODE, protocol.OP_FETCH_ASYNC);
  Atomics.store(ctrl, protocol.I_REQ_LEN, bytes.length);
  Atomics.store(ctrl, protocol.I_STATE, protocol.STATE_REQUEST);
  worker.on.syscall();
  assert.equal(Atomics.load(ctrl, protocol.I_STATE), protocol.STATE_RESPONSE_OK);
}
const drain = async stream => { for await (const _ of stream) {} };
let owned = [];
try {
  request(1, 'first'); request(2, 'second');
  // Private observation only, to release and join every fixture promise below.
  // An application has no supported handle to these ownership promises.
  owned = [...kernel._fetchInflight.values()];
  await Promise.all([execution.stop(), drain(execution.stdout), drain(execution.stderr)]);
  const atStop = kernel.diagnostics().fetch;
  assert.equal(kernel.procs.size, 0);
  assert.equal(atStop.active, 1); assert.equal(atStop.queued, 1);
  assert.equal(writes.length, 0);
  first.resolve();
  await secondStarted.promise;
  assert.equal(networkStarts[1].afterExit, true);
  second.resolve();
  await Promise.all(owned);
  await new Promise(setImmediate); // let the real async handoff continuations run
  const after = kernel.diagnostics().fetch;
  assert.equal(writes.length, 2);
  assert.ok(writes.every(write => write.afterExit));
  assert.equal(after.active, 0); assert.equal(after.queued, 0);
  assert.equal(after.pinnedBodies, 2); // handoffs added AFTER PID release ran
  console.log(JSON.stringify({ executionStopJoined: true, readersJoined: true,
    processesAtStop: 0, fetchActiveAtStop: atStop.active, fetchQueuedAtStop: atStop.queued,
    queuedNetworkStartedAfterExit: true, vfsWritesAfterExit: writes.length,
    latePinnedBodies: after.pinnedBodies, fetchOwnershipProvenAtStop: false }));
} finally {
  first.resolve(); second.resolve();
  await Promise.allSettled(owned);
  if (kernel.procs.has(pid)) kernel.stop(pid);
}
