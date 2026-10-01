/** Independently authored finite production-seam gates, not an Effect sidecar.
 * Imports frozen compiled Kernel/core, real native vendor adapter, actual tsgo
 * transaction/installer, real Rust VFS, separately built SDK/workspace library.
 * Controlled leaves: Worker handles, host message relay, tiny valid vendor pack,
 * and explicitly identified native fetch/read/write/rollback completion gates.
 * Real Web Streams used where specified; ignored-read case deliberately supplies
 * a controllable reader because Web Stream cancel itself resolves pending reads.
 * No servers/browser/guest/compiler/network. No internal Effect primitives/maps. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { MessageChannel } from 'node:worker_threads';

const [stageArg, scenario] = process.argv.slice(2);
assert.ok(stageArg && scenario);
const stage = resolve(stageArg), root = resolve(stage, 'runtime-source');
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { Kernel } = await load('packages/kernel-host/kernel.js');
const { FsServer } = await load('packages/kernel-host/fs-server.js');
const { createDirectKernelFs } = await load('packages/kernel-host/direct-kernel-fs.js');
const { ensureRealTsgo } = await load('packages/kernel-host/load-real-tsgo.js');
const { fetchLoaderVendorBytes } = await load('packages/kernel-host/loader-vendor-bytes.js');
const protocol = await load('packages/protocol/syscall.js');
const { launch } = await import(pathToFileURL(resolve(stage, 'candidate/sdk/host.js')).href);
const { Runtime, workspaceInternals } = await import(pathToFileURL(resolve(stage, 'candidate/workspace/index.js')).href);
const { VirtualFileSystem } = createRequire(import.meta.url)(resolve(root, 'packages/vfs/pkg-node/vivari_vfs.js'));
const events: any[] = [], gates: Array<() => void> = [], cleanups: Array<() => Promise<unknown>> = [];
const event = (name: string, fields = {}) => events.push({ n: events.length, name, ...fields });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const releaseGate = () => {
  const gate = deferred(); gates.push(() => gate.resolve()); return gate;
};
const checkpoint = () => new Promise<void>(yes => {
  const { port1, port2 } = new MessageChannel();
  port1.once('message', () => { port1.close(); port2.close(); yes(); }); port2.postMessage('checkpoint');
});
const errorText = (error: any): string => [String(error), error?.cleanupError,
  ...(error instanceof AggregateError ? [...error.errors].map(errorText) : [])].filter(Boolean).join('\n');
const observe = (promise: Promise<any>, name: string) => {
  const record: any = { state: 'pending', error: undefined, value: undefined };
  record.result = promise.then(value => {
    record.state = 'success'; record.value = value; event(name + '-settled', { state: 'success' }); return record;
  }, error => {
    record.state = 'failure'; record.error = error; event(name + '-settled', { state: 'failure', error: errorText(error) }); return record;
  });
  return record;
};
const pending = async (record: any, label: string) => {
  await checkpoint(); event('held-checkpoint', { label, state: record.state });
  assert.equal(record.state, 'pending', label + ': underlying native work still held');
};
const rejected = async (record: any, pattern?: RegExp) => {
  await record.result; assert.equal(record.state, 'failure');
  if (pattern) assert.match(errorText(record.error), pattern); return record.error;
};
const succeeded = async (record: any) => { await record.result; assert.equal(record.state, 'success', errorText(record.error)); return record.value; };
const url = 'https://offline.invalid/tsgo-pack.bin';
const header = Buffer.from(JSON.stringify({ version: 'expanded-independent', files: [
  { p: 'tsgo.wasm', o: 0, l: 3 }, { p: 'wasm_exec.cjs', o: 3, l: 2 },
] }));
const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
const pack = gzipSync(Buffer.concat([length, header, Buffer.from([11, 12, 13, 21, 22])]));
const cache = '/workspace/.browser-editor-cache/vite';
function fixture() {
  result.actualKernelCore = true; result.realRustVfs = true;
  const fs = createDirectKernelFs(new FsServer(new VirtualFileSystem()));
  fs.mkdirp(cache); fs.symlink(cache, '/bin'); fs.writeFile('/bin/node.js', ''); fs.writeFile('/fixture.js', '');
  const workers: any[] = [], publications: number[] = [];
  const kernel = new Kernel({ fs, spawnWorker(info: any) {
    workers.push(info); event('worker-created', { pid: info.pid, command: info.spec.command });
    return { terminate() { event('worker-terminated', { pid: info.pid }); }, postMessage() {} };
  }, stdout() {}, stderr() {} });
  const write = fs.writeFile.bind(fs), batch = fs.writeFilesBatch.bind(fs);
  fs.writeFile = (path: string, bytes: any) => { event('vfs-write', { path }); return write(path, bytes); };
  fs.writeFilesBatch = async (files: any[]) => {
    event('vfs-batch-start', { paths: files.map(f => f.path) }); const result = await batch(files); event('vfs-batch-settled'); return result;
  };
  const start = (command: string, owner: any) => observe(kernel.launchLoaded(command, [], {
    cwd: '/workspace', onStarted(pid: number) { publications.push(pid); event('launch-published', { pid }); },
  }, owner), 'launch-' + owner.id);
  cleanups.push(async () => { await kernel.closeLoaderOperations().catch(() => {}); });
  return { fs, kernel, workers, publications, start };
}
function register(f: any, names: string | string[], fetcher: any) {
  f.kernel.registerLazyProgram(names, (context: any) => ensureRealTsgo(f.kernel,
    (signal: AbortSignal) => fetchLoaderVendorBytes(url, signal, fetcher), context));
}
function heldFetch() {
  const entered = deferred(), release = releaseGate(), aborted = deferred();
  let calls = 0, signal: AbortSignal;
  const fetcher = async (_url: string, init: any) => {
    calls++; signal = init.signal; event('fetch-entered', { calls });
    signal.addEventListener('abort', () => { event('fetch-abort-requested'); aborted.resolve(); }, { once: true });
    entered.resolve(); await release.promise;
    event('fetch-underlying-settled'); return new Response(pack);
  };
  return { entered, release, aborted, fetcher, get calls() { return calls; }, get signal() { return signal; } };
}
function heldRollbackFailure(f: any) {
  const entered = deferred(), release = releaseGate();
  const write = f.kernel.writeFile.bind(f.kernel), unlink = f.kernel.unlink.bind(f.kernel);
  f.kernel.writeFile = (path: string, bytes: any) => {
    if (path === '/bin/tsc.js') { event('install-failed', { path }); throw Error('INDEPENDENT_INSTALL_FAILURE'); }
    return write(path, bytes);
  };
  // This is the install transaction's native kernel.unlink adapter boundary.
  // Ordinary VFS unlink remains synchronous; this explicitly injected native
  // promise performs that real unlink after its handshake and then rejects.
  f.kernel.unlink = async (path: string) => {
    if (path === '/usr/lib/tsgo/wasm_exec.cjs') {
      event('rollback-entered', { path }); entered.resolve(); await release.promise;
      unlink(path); event('rollback-underlying-failed', { path }); throw Error('INDEPENDENT_ROLLBACK_FAILURE');
    }
    return unlink(path);
  };
  return { entered, release };
}
function relay(f: any) {
  // Calls actual production Kernel host-launch seam. This is NOT execution of
  // browser kernel-worker.ts; leaf wire vocabulary mirrors that committed worker.
  const listeners = new Set<(message: any) => void>();
  const owners = new Map<number, any>(), pids = new Map<number, number>();
  const tasks: Promise<unknown>[] = [], messages: any[] = [];
  const emit = (message: any) => { messages.push(message); event('wire-' + message.type, { execId: message.execId, cleanupError: message.cleanupError });
    for (const listener of [...listeners]) listener(message); };
  f.kernel.onProcExit = (pid: number, result: any) => {
    const execId = [...pids].find(([, value]) => value === pid)?.[0];
    emit({ type: 'proc-exit', execId, code: result.code, signal: result.signal, cleanupError: result.cleanupError });
  };
  const host = { nextExecution: 1, features: new Set(),
    async request(type: string) { assert.equal(type, 'vv-stat'); return { exists: true, isDir: false }; },
    on(listener: (message: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    post(type: string, message: any) {
      if (type === 'proc-spawn') {
        const owner = f.kernel.createLaunchOwner(); owners.set(message.execId, owner);
        const task = f.kernel.launchLoaded(message.command, message.args, {
          cwd: message.cwd, env: message.env, stdioCredits: message.stdioCredits,
          onStarted(pid: number) { pids.set(message.execId, pid); owners.delete(message.execId);
            emit({ type: 'proc-started', execId: message.execId, pid }); },
        }, owner).catch((error: any) => emit({ type: 'proc-exit', execId: message.execId,
          code: 143, signal: 'SIGTERM', error: String(error.message), cleanupError: error.cleanupError }))
          .finally(() => owners.delete(message.execId));
        tasks.push(task);
      } else if (type === 'proc-kill') {
        const pid = pids.get(message.execId), owner = owners.get(message.execId);
        const task = pid !== undefined ? f.kernel.stop(pid) : owner?.close();
        if (task) { tasks.push(task); task.catch(() => {}); }
      } else assert.equal(type, 'proc-input');
    },
  };
  cleanups.push(async () => { await Promise.allSettled(tasks); });
  return { host, messages, pids };
}
const drain = async (stream: AsyncIterable<unknown>) => { for await (const _ of stream) {} };
let failure: unknown, result: any = { scenario, node: process.version, offline: true,
  compilerExecuted: false, actualKernelCore: false, realRustVfs: false, pathSecurityFixed: false };
try {
  if (scenario === 'native-stream-cancel-held' || scenario === 'native-stream-cancel-failed') {
    const readStarted = deferred(), cancelStarted = deferred(), release = releaseGate();
    const controller = new AbortController(); let calls = 0, cancelReason: unknown;
    const body = new ReadableStream({ pull() { event('stream-pull-entered'); readStarted.resolve(); },
      async cancel(reason) { calls++; cancelReason = reason; event('stream-cancel-entered'); cancelStarted.resolve();
        await release.promise; event('stream-cancel-underlying-settled');
        if (scenario.endsWith('failed')) throw Error('INDEPENDENT_CANCEL_FAILURE');
      } });
    const operation = observe(fetchLoaderVendorBytes(url, controller.signal, async (_url: string, init: any) => {
      assert.equal(init.signal, controller.signal); return new Response(body);
    }), 'native-adapter');
    await readStarted.promise; controller.abort(); await cancelStarted.promise;
    assert.equal(cancelReason, controller.signal.reason); assert.equal(calls, 1);
    await pending(operation, 'native body cancel'); assert.equal(body.locked, true);
    release.resolve(); const error = await rejected(operation);
    assert.equal(body.locked, false); assert.equal(calls, 1);
    if (scenario.endsWith('failed')) {
      assert.ok(error instanceof AggregateError); assert.match(errorText(error), /AbortError/);
      assert.match(errorText(error), /INDEPENDENT_CANCEL_FAILURE/);
    } else assert.equal(error.name, 'AbortError');
    result = { ...result, realWebStream: true, cancellationCalls: calls, lockReleased: true, error: errorText(error) };
  } else if (scenario === 'native-read-ignored-abort') {
    const readStarted = deferred(), readRelease = releaseGate(), cancelStarted = deferred();
    const controller = new AbortController(); let cancelCalls = 0, lockReleased = false;
    const operation = observe(fetchLoaderVendorBytes(url, controller.signal, async (_url: string, init: any) => {
      assert.equal(init.signal, controller.signal);
      return { ok: true, body: { getReader() { return {
        async read() { event('native-read-entered'); readStarted.resolve(); await readRelease.promise;
          event('native-read-underlying-settled'); return { done: false, value: pack }; },
        async cancel() { cancelCalls++; event('native-cancel-settled-read-still-held'); cancelStarted.resolve(); },
        releaseLock() { lockReleased = true; event('native-reader-lock-released'); },
      }; } } };
    }), 'ignored-native-read');
    await readStarted.promise; controller.abort(); await cancelStarted.promise;
    await pending(operation, 'ignored native read after acknowledged cancel'); assert.equal(lockReleased, false);
    readRelease.resolve(); const error = await rejected(operation); assert.equal(error.name, 'AbortError');
    assert.equal(lockReleased, true); assert.equal(cancelCalls, 1);
    result = { ...result, controlledReaderLeaf: true, realWebStream: false, cancelCalls, lockReleased };
  } else if (scenario === 'native-fetch-ignored-abort') {
    const f = fixture(), fetch = heldFetch(); register(f, 'tsc', fetch.fetcher);
    const owner = f.kernel.createLaunchOwner(), launching = f.start('tsc', owner);
    await fetch.entered.promise;
    const receipt = owner.close(), closing = observe(receipt, 'owner-close');
    assert.equal(receipt, owner.close()); assert.equal(owner.open, false);
    await fetch.aborted.promise; assert.equal(fetch.signal.aborted, true);
    await pending(closing, 'ignored native fetch'); await pending(launching, 'pre-PID launch cleanup');
    assert.equal(f.workers.length, 0); assert.deepEqual(f.publications, []);
    fetch.release.resolve(); await succeeded(closing); await rejected(launching, /admission closed/);
    assert.equal(f.workers.length, 0); assert.deepEqual(f.fs.readdir(cache), ['node.js']);
    assert.equal(f.kernel.exists('/usr/lib/tsgo'), false); await f.kernel.closeLoaderOperations();
    result = { ...result, downloadCalls: fetch.calls, lastInterestAbortObserved: true, noLatePidOrWrites: true };
  } else if (scenario === 'prepid-shared-interest') {
    const f = fixture(), fetch = heldFetch(); register(f, ['tsc', 'tsgo'], fetch.fetcher);
    const a = f.kernel.createLaunchOwner(), b = f.kernel.createLaunchOwner();
    const first = f.start('tsc', a), second = f.start('tsgo', b);
    await fetch.entered.promise; const receipt = a.close(); assert.equal(receipt, a.close()); await receipt;
    await rejected(first, /admission closed/); assert.equal(fetch.signal.aborted, false); assert.equal(fetch.calls, 1);
    assert.equal(f.workers.length, 0); await pending(second, 'second live pre-PID interest');
    fetch.release.resolve(); const pid = await succeeded(second);
    assert.deepEqual(f.publications, [pid]); assert.equal(f.workers.length, 1);
    assert.equal(f.workers[0].spec.command, 'tsgo');
    assert.deepEqual([...f.kernel.readFileBytes('/usr/lib/tsgo/tsgo.wasm')], [11, 12, 13]);
    assert.deepEqual([...f.kernel.readFileBytes('/usr/lib/tsgo/wasm_exec.cjs')], [21, 22]);
    assert.equal(f.fs.lstat('/bin').kind, 'symlink');
    await f.kernel.stop(pid); await f.kernel.closeLoaderOperations();
    result = { ...result, downloadCalls: fetch.calls, firstInterestAbortedDownload: false, publications: f.publications };
  } else if (scenario === 'prepid-held-write') {
    const f = fixture(), batchStarted = deferred(), release = releaseGate();
    f.kernel.mkdirp('/usr/lib/tsgo'); f.kernel.writeFile('/usr/lib/tsgo/tsgo.wasm', new Uint8Array([99]));
    const batch = f.fs.writeFilesBatch.bind(f.fs);
    f.fs.writeFilesBatch = async (files: any[]) => { await batch(files); event('native-written-batch-held');
      batchStarted.resolve(); await release.promise; event('native-batch-underlying-settled'); };
    register(f, 'tsc', async () => new Response(pack));
    const owner = f.kernel.createLaunchOwner(), launching = f.start('tsc', owner);
    await batchStarted.promise; assert.deepEqual([...f.kernel.readFileBytes('/usr/lib/tsgo/tsgo.wasm')], [11, 12, 13]);
    const receipt = owner.close(), closing = observe(receipt, 'owner-close'); assert.equal(receipt, owner.close());
    await pending(closing, 'already written native installer batch'); await pending(launching, 'launch while native batch held');
    release.resolve(); await succeeded(closing); await rejected(launching, /admission closed/);
    assert.deepEqual([...f.kernel.readFileBytes('/usr/lib/tsgo/tsgo.wasm')], [99]);
    assert.deepEqual(f.fs.readdir('/usr/lib/tsgo'), ['tsgo.wasm']); assert.deepEqual(f.fs.readdir(cache), ['node.js']);
    assert.equal(f.workers.length, 0); assert.deepEqual(f.publications, []); await f.kernel.closeLoaderOperations();
    result = { ...result, restoredOriginalBytes: [99], rollbackJoined: true, workers: 0 };
  } else if (scenario === 'prepid-rollback-failed') {
    const f = fixture(), rollback = heldRollbackFailure(f); register(f, 'tsc', async () => new Response(pack));
    const owner = f.kernel.createLaunchOwner(), launching = f.start('tsc', owner);
    await rollback.entered.promise; const receipt = owner.close(), closing = observe(receipt, 'owner-close');
    assert.equal(receipt, owner.close()); assert.equal(owner.open, false);
    await pending(closing, 'native rollback unlink'); await pending(launching, 'failed launch rollback');
    rollback.release.resolve(); const closeError = await rejected(closing), launchError = await rejected(launching);
    for (const error of [closeError, launchError]) {
      assert.match(errorText(error), /INDEPENDENT_INSTALL_FAILURE/); assert.match(errorText(error), /INDEPENDENT_ROLLBACK_FAILURE/);
    }
    assert.match(launchError.cleanupError, /INDEPENDENT_INSTALL_FAILURE/); assert.match(launchError.cleanupError, /INDEPENDENT_ROLLBACK_FAILURE/);
    assert.equal(receipt, owner.close()); assert.equal((await rejected(observe(owner.close(), 'repeat-close'))), closeError);
    assert.equal(f.workers.length, 0); assert.deepEqual(f.publications, []);
    const rootReceipt = f.kernel.closeLoaderOperations(); assert.equal(rootReceipt, f.kernel.closeLoaderOperations());
    await rejected(observe(rootReceipt, 'root-close'), /INDEPENDENT_ROLLBACK_FAILURE/);
    result = { ...result, cleanupError: launchError.cleanupError, memoizedFailedClose: true, workers: 0 };
  } else if (scenario === 'sdk-pid-rollback-failed') {
    const f = fixture(), wire = relay(f), rollback = heldRollbackFailure(f);
    register(f, 'tsc', async () => new Response(pack));
    const execution = await launch(wire.host, { entry: '/fixture.js' });
    const readers = Promise.all([drain(execution.stdout), drain(execution.stderr)]);
    const parent = f.workers[0], { ctrl, data } = protocol.makeViews(parent.sab);
    const request = protocol.encodeRequest([protocol.encodeString(JSON.stringify({ command: 'tsc', args: [], cwd: '/workspace', env: {} }))]);
    data.set(request); Atomics.store(ctrl, protocol.I_OPCODE, protocol.OP_SPAWN_ASYNC);
    Atomics.store(ctrl, protocol.I_REQ_LEN, request.length); Atomics.store(ctrl, protocol.I_STATE, protocol.STATE_REQUEST);
    parent.on.syscall(); await rollback.entered.promise;
    const exited = observe(execution.exited, 'sdk-exited'), stopping = observe(execution.stop(), 'sdk-stop');
    const again = observe(execution.stop(), 'sdk-stop-concurrent');
    await pending(stopping, 'Execution.stop rollback'); await pending(exited, 'Execution.exited rollback');
    const state = Atomics.load(ctrl, protocol.I_STATE); rollback.release.resolve();
    const stopError = await rejected(stopping), otherError = await rejected(again);
    assert.equal(stopError.code, 'CLEANUP_FAILED'); assert.equal(otherError.code, 'CLEANUP_FAILED');
    assert.equal(stopError.message, otherError.message); const exit = await succeeded(exited); await readers;
    assert.match(exit.cleanupError, /INDEPENDENT_INSTALL_FAILURE/); assert.match(exit.cleanupError, /INDEPENDENT_ROLLBACK_FAILURE/);
    const repeatedError = await rejected(observe(execution.stop(), 'sdk-stop-after-exit')); assert.equal(repeatedError.message, stopError.message);
    assert.equal(Atomics.load(ctrl, protocol.I_STATE), state); assert.equal(f.workers.length, 1);
    await rejected(observe(f.kernel.closeLoaderOperations(), 'root-close'), /INDEPENDENT_ROLLBACK_FAILURE/);
    result = { ...result, actualSpawnAsyncOpcode: true, exit, stopCode: stopError.code, noLateChild: true };
  } else if (scenario === 'runtime-prepid-held-success' || scenario === 'runtime-prepid-rollback-failed') {
    const f = fixture(), wire = relay(f), fetch = heldFetch();
    const failing = scenario.endsWith('failed'), rollback = failing ? heldRollbackFailure(f) : undefined;
    // SDK always requests /bin/node.js. Deliberately register its first-use gate
    // with actual tsgo installer to exercise built SDK + Runtime pre-PID contract.
    // This substitution is not claimed as production command selection/browser QA.
    register(f, '/bin/node.js', failing ? async () => new Response(pack) : fetch.fetcher);
    const workspace = {}, distribution = { name: 'offline-independent', version: 'fixture', assetBaseUrl: '/fixture/' };
    const state = { host: wire.host, distribution, attached: false, clearing: false, closed: false };
    workspaceInternals.set(workspace, state); // workspace/transport acquisition leaf only
    const runtime = await Runtime.start({ workspace, distribution });
    const launching = observe(runtime.node({ entry: '/fixture.js' }), 'built-runtime-node');
    if (failing) await rollback!.entered.promise; else await fetch.entered.promise;
    const receipt = runtime.stop(), stopping = observe(receipt, 'built-runtime-stop'); assert.equal(receipt, runtime.stop());
    if (!failing) await fetch.aborted.promise;
    await pending(stopping, 'built Runtime stop'); await pending(launching, 'built Runtime pending launch');
    assert.equal(state.attached, true); await assert.rejects(Runtime.start({ workspace, distribution }), (e: any) => e.code === 'ATTACHED');
    if (failing) rollback!.release.resolve(); else fetch.release.resolve();
    const launchError = await rejected(launching);
    assert.equal(f.workers.length, 0); assert.equal(wire.messages.filter(m => m.type === 'proc-started').length, 0);
    if (failing) {
      assert.equal(launchError.code, 'CLEANUP_FAILED'); assert.match(launchError.message, /INDEPENDENT_INSTALL_FAILURE/);
      assert.match(launchError.message, /INDEPENDENT_ROLLBACK_FAILURE/);
      const error = await rejected(stopping, /workspace remains attached/);
      assert.match(errorText(error), /INDEPENDENT_INSTALL_FAILURE/); assert.match(errorText(error), /INDEPENDENT_ROLLBACK_FAILURE/);
      assert.equal(state.attached, true); assert.equal(receipt, runtime.stop());
      assert.equal(await rejected(observe(runtime.stop(), 'repeat-runtime-stop')), error);
      await assert.rejects(Runtime.start({ workspace, distribution }), (e: any) => e.code === 'ATTACHED');
      const message = wire.messages.find(m => m.type === 'proc-exit');
      assert.match(message.cleanupError, /INDEPENDENT_INSTALL_FAILURE/); assert.match(message.cleanupError, /INDEPENDENT_ROLLBACK_FAILURE/);
      await rejected(observe(f.kernel.closeLoaderOperations(), 'root-close'), /INDEPENDENT_ROLLBACK_FAILURE/);
      result = { ...result, launchCode: launchError.code, runtimeAttached: state.attached, replacementRefused: true,
        memoizedFailedRuntimeStop: true, wireCleanupError: message.cleanupError };
    } else {
      assert.equal(launchError.code, 'LAUNCH_REJECTED'); await succeeded(stopping); assert.equal(state.attached, false);
      assert.deepEqual(f.fs.readdir(cache), ['node.js']);
      const replacement = await Runtime.start({ workspace, distribution }); await replacement.stop();
      await f.kernel.closeLoaderOperations();
      result = { ...result, launchCode: launchError.code, runtimeDetachedAfterJoin: true, replacementAllowedAfterJoin: true };
    }
  } else throw Error('Unknown bounded scenario: ' + scenario);
} catch (error) { failure = error; }
finally {
  // Preserve observed schedule and failure BEFORE any fixture leaf release.
  console.log(JSON.stringify({ phase: 'before-fixture-cleanup', ...result, events,
    status: failure ? 'FAIL' : 'PASS', failure: failure ? errorText(failure) : null }));
  for (const release of gates) release();
  for (const cleanup of cleanups.reverse()) await cleanup();
}
if (failure) throw failure;
