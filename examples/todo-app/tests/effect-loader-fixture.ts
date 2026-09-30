/** Offline production-seam regression, NOT an Effect model or compiler test.
 * Actual imported Kernel/tsgo loader/protocol/FsServer/Rust VFS and built SDK.
 * Substitutions: worker handles, host message relay, tiny vendor pack, and (one
 * case) a held native filesystem batch adapter which forwards to the real VFS.
 * No private kernel maps are used as receipts, including for fixture cleanup.
 * Registration retains the existing public callback shape. A changed supported
 * loader adapter must be reviewed here before migrated acceptance is claimed. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { MessageChannel } from 'node:worker_threads';

const [runtimeArg, sdkArg, scenario, mode] = process.argv.slice(2);
assert.ok(runtimeArg && sdkArg, 'runtime root and separately built SDK required');
assert.ok(['held-vendor', 'held-write', 'shared-interest', 'loader-failure'].includes(scenario));
assert.ok(mode === 'baseline' || mode === 'accept');
const root = resolve(runtimeArg);
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { Kernel } = await load('packages/kernel-host/kernel.js');
const { FsServer } = await load('packages/kernel-host/fs-server.js');
const { createDirectKernelFs } = await load('packages/kernel-host/direct-kernel-fs.js');
const { ensureRealTsgo } = await load('packages/kernel-host/load-real-tsgo.js');
const protocol = await load('packages/protocol/syscall.js');
const { launch } = await import(pathToFileURL(resolve(sdkArg)).href);
const { VirtualFileSystem } = createRequire(import.meta.url)(resolve(root, 'packages/vfs/pkg-node/vivari_vfs.js'));
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
// Message acknowledgement advances the host event loop, not a delay/retry.
// Pending at this checkpoint alone is NOT a cancellation/settlement receipt.
const checkpoint = () => new Promise<void>(yes => {
  const { port1, port2 } = new MessageChannel();
  port1.once('message', () => { port1.close(); port2.close(); yes(); });
  port2.postMessage('checkpoint');
});
const fs = createDirectKernelFs(new FsServer(new VirtualFileSystem()));
const cache = '/workspace/.browser-editor-cache/vite';
fs.mkdirp(cache); fs.mkdirp('/usr/lib/tsgo'); fs.symlink(cache, '/bin');
fs.writeFile('/bin/node.js', ''); fs.writeFile('/fixture.js', '');
const bytes = Buffer.from([1, 2]);
const header = Buffer.from(JSON.stringify({ version: 'offline-fixture', files: [
  { p: 'tsgo.wasm', o: 0, l: 1 }, { p: 'wasm_exec.cjs', o: 1, l: 1 },
] }));
const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
const pack = gzipSync(Buffer.concat([length, header, bytes]));
const vendorStarted = deferred(), releaseVendor = deferred();
const writeStarted = deferred(), releaseWrite = deferred(), installDone = deferred();
const observations: Record<string, any> = { scenario, mode, realRustVfs: true,
  actualTsgoLoader: true, actualSpawnAsyncOpcode: true, compilerExecuted: false,
  vendorCalls: 0, vendorSettled: false, installerSettled: false,
  abortSignalObserved: false, abortRequested: false, writes: [], spawns: [], exits: [] };
let installedPromise: Promise<unknown> | undefined;
const originalBatch = fs.writeFilesBatch.bind(fs);
fs.writeFilesBatch = async (files: any[]) => {
  if (scenario === 'held-write') {
    writeStarted.resolve(); await releaseWrite.promise;
    // Native adapter deliberately ignores cancellation, then writes actual bytes.
  }
  for (const file of files) observations.writes.push({ path: file.path,
    batch: true, afterSuccessfulStop: observations.stopSucceeded === true });
  return originalBatch(files);
};
const originalWrite = fs.writeFile.bind(fs);
fs.writeFile = (path: string, contents: any) => {
  observations.writes.push({ path, afterSuccessfulStop: observations.stopSucceeded === true });
  return originalWrite(path, contents);
};
const workers = new Map<number, any>(), listeners = new Set<(m: any) => void>();
const executions = new Map<number, number>();
const childSpawned = deferred<any>();
const kernel = new Kernel({ fs, spawnWorker(info: any) {
  workers.set(info.pid, info);
  observations.spawns.push({ pid: info.pid, programPath: info.spec.programPath });
  if (info.spec.programPath === '/bin/tsc.js' || info.spec.programPath === '/bin/tsgo.js') childSpawned.resolve(info);
  return { terminate() {}, postMessage() {} };
}, stdout() {}, stderr() {} });
const vendor = async (...args: any[]) => {
  observations.vendorCalls++;
  // Observational only: no guessed future callback/context property names.
  const signal = args.find(value => value instanceof AbortSignal);
  if (signal) {
    observations.abortSignalObserved = true;
    signal.addEventListener('abort', () => { observations.abortRequested = true; }, { once: true });
    observations.abortRequested ||= signal.aborted;
  }
  vendorStarted.resolve();
  await releaseVendor.promise; // deliberately abort-ignoring native promise
  observations.vendorSettled = true;
  if (scenario === 'loader-failure') throw Error('EFFECT_LOADER_VENDOR_FAILURE');
  return pack;
};
kernel.registerLazyProgram(['tsc', 'tsgo'], () => {
  installedPromise = ensureRealTsgo(kernel, vendor);
  // Observe original outcome without replacing/swallowing its rejection.
  installedPromise!.then(() => {
    observations.installerSettled = true; installDone.resolve();
  }, error => {
    observations.installerSettled = true; observations.installError = String(error); installDone.resolve();
  });
  return installedPromise;
});
const emit = (message: any) => { for (const listener of [...listeners]) listener(message); };
kernel.onProcExit = (pid: number, result: any) => {
  observations.exits.push({ pid, ...result });
  emit({ type: 'proc-exit', execId: executions.get(pid), code: result.code,
    signal: result.signal, cleanupError: result.cleanupError });
};
const host = { nextExecution: 1,
  async request(type: string) { assert.equal(type, 'vv-stat'); return { exists: true, isDir: false }; },
  on(listener: (m: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  post(type: string, message: any) {
    if (type === 'proc-spawn') {
      const pid = kernel.launch(message.command, message.args, { cwd: message.cwd, env: message.env });
      executions.set(pid, message.execId); emit({ type: 'proc-started', execId: message.execId });
    } else if (type === 'proc-kill') {
      kernel.stop([...executions].find(([, id]) => id === message.execId)?.[0]);
    } else assert.equal(type, 'proc-input');
  },
};
const drain = async (stream: AsyncIterable<any>) => { for await (const _ of stream) {} };
const active: any[] = [];
const start = async () => {
  const execution = await launch(host, { entry: '/fixture.js' });
  const pid = [...executions.keys()].at(-1)!;
  const worker = workers.get(pid);
  const { ctrl, data } = protocol.makeViews(worker.sab);
  const request = protocol.encodeRequest([protocol.encodeString(JSON.stringify({ command: 'tsc', args: [], cwd: '/workspace', env: {} }))]);
  data.set(request); Atomics.store(ctrl, protocol.I_OPCODE, protocol.OP_SPAWN_ASYNC);
  Atomics.store(ctrl, protocol.I_REQ_LEN, request.length);
  Atomics.store(ctrl, protocol.I_STATE, protocol.STATE_REQUEST); worker.on.syscall();
  const entry = { execution, pid, ctrl, readers: Promise.all([drain(execution.stdout), drain(execution.stderr)]) };
  active.push(entry); return entry;
};
const stop = (entry: any) => {
  const result = entry.execution.stop().then(() => {
    observations.stopSucceeded = true;
    observations.atSuccessfulStop = { vendorSettled: observations.vendorSettled,
      installerSettled: observations.installerSettled, cacheFiles: fs.readdir(cache).sort() };
    return { ok: true };
  }, (error: any) => ({ ok: false, code: error.code, error: String(error) }));
  return result;
};
let failure: unknown;
try {
  const first = await start(); await vendorStarted.promise;
  if (scenario === 'held-write') {
    releaseVendor.resolve(); await writeStarted.promise;
  }
  if (scenario === 'loader-failure') {
    releaseVendor.resolve(); await installDone.promise; await checkpoint();
  }
  let second: any;
  if (scenario === 'shared-interest') {
    second = await start(); // syscall dispatch synchronously reaches shared-load wait
    await checkpoint();
  }
  const firstStop = stop(first);
  await checkpoint();
  observations.receiptBeforeNativeRelease = observations.atSuccessfulStop ?? null;
  observations.deadParentStateBeforeRelease = Atomics.load(first.ctrl, protocol.I_STATE);
  if (scenario === 'shared-interest') {
    await firstStop; await first.readers;
    assert.equal(observations.vendorSettled, false, 'first release must not finish the held shared backend');
    releaseVendor.resolve(); await installDone.promise;
    const child = await childSpawned.promise;
    observations.liveChildPid = child.pid;
    observations.liveParentResponseState = Atomics.load(second.ctrl, protocol.I_STATE);
    assert.equal(observations.vendorCalls, 1, 'two actual syscall interests share one download');
    assert.equal(observations.liveParentResponseState, protocol.STATE_RESPONSE_OK);
    assert.deepEqual([...fs.readFileBytes('/usr/lib/tsgo/tsgo.wasm')], [1]);
    assert.deepEqual([...fs.readFileBytes('/usr/lib/tsgo/wasm_exec.cjs')], [2]);
    assert.equal(kernel.procs.get(child.pid).parentPid, second.pid);
    assert.equal(observations.spawns.filter((x: any) => x.programPath === '/bin/tsc.js').length, 1);
    assert.equal(Atomics.load(first.ctrl, protocol.I_STATE), observations.deadParentStateBeforeRelease,
      'shared completion cannot publish to the stopped first caller');
    await second.execution.stop(); await second.readers;
  } else {
    releaseVendor.resolve(); releaseWrite.resolve(); await installDone.promise;
    const outcome = await firstStop; await first.readers;
    observations.stopOutcome = outcome;
    observations.exitOutcome = await first.execution.exited;
    observations.repeatedStopOutcome = await stop(first);
    assert.equal(kernel.procs.size, 0, 'no late child survives dead-parent guard');
    observations.deadParentStateAfterRelease = Atomics.load(first.ctrl, protocol.I_STATE);
    assert.equal(observations.deadParentStateAfterRelease, observations.deadParentStateBeforeRelease,
      'no post-stop SAB publication to dead caller');
    if (scenario === 'loader-failure') {
      assert.match(observations.installError, /EFFECT_LOADER_VENDOR_FAILURE/);
      if (mode === 'baseline') {
        assert.equal(outcome.ok, true); assert.equal(observations.exitOutcome.cleanupError, undefined);
      } else {
        assert.equal(outcome.ok, false, 'loader failure must not be swallowed into successful public stop');
        assert.equal(outcome.code, 'CLEANUP_FAILED');
        assert.match(observations.exitOutcome.cleanupError, /EFFECT_LOADER_VENDOR_FAILURE/);
        assert.deepEqual(observations.repeatedStopOutcome, outcome);
      }
    } else if (mode === 'baseline') {
      assert.equal(observations.receiptBeforeNativeRelease.installerSettled, false);
      assert.deepEqual(observations.receiptBeforeNativeRelease.cacheFiles, ['node.js']);
      assert.deepEqual(fs.readdir(cache).sort(), ['node.js', 'tsc.js', 'tsgo.js']);
      assert.ok(observations.writes.filter((x: any) => x.afterSuccessfulStop).length >= 2);
    } else {
      assert.equal(observations.receiptBeforeNativeRelease, null,
        'successful stop escaped while underlying vendor/installer write could still run');
      assert.equal(outcome.ok, true);
      assert.equal(observations.atSuccessfulStop.installerSettled, true);
      assert.equal(observations.writes.filter((x: any) => x.afterSuccessfulStop).length, 0);
    }
  }
  assert.equal(fs.lstat('/bin').kind, 'symlink');
  observations.finalCacheFiles = fs.readdir(cache).sort();
  observations.pathSecurityFixed = false;
} catch (error) { failure = error; }
finally {
  // Emit the failure/ownership snapshot BEFORE releasing test leaves/cleanup.
  console.log(JSON.stringify({ phase: 'before-fixture-cleanup', ...observations,
    failure: failure ? String(failure) : null }));
  // Own leaf releases/joins only. No force-termination or private-map drain claim.
  releaseVendor.resolve(); releaseWrite.resolve();
  await Promise.allSettled(installedPromise ? [installedPromise] : []);
  await Promise.allSettled(active.map(entry => entry.execution.stop()));
  await Promise.allSettled(active.map(entry => entry.readers));
  console.log(JSON.stringify({ ...observations, status: failure ? 'FAIL' : 'PASS',
    failure: failure ? String(failure) : null }));
}
if (failure) throw failure;
