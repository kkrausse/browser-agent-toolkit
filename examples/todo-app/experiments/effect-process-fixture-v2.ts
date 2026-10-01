/** Version2: only stale-loader-rejection's erroneous successful-stop assumption
 * is corrected. Original v1 and its baseline/implementation failures are retained.
 * All other scenario assertions remain byte-identical to v1.
 * Offline phase2A contracts over the real Kernel/compiled core/Rust VFS.
 * Controlled leaves are explicitly recorded. No model owner, new lifecycle API,
 * server, browser, timers, retry, or copied production acquisition implementation. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, MessageChannel } from 'node:worker_threads';

const [stage, scenario] = process.argv.slice(2);
assert.ok(stage && scenario);
assert.equal(process.version, 'v24.18.0');
const root = resolve(stage, 'runtime-source');
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { Kernel } = await load('packages/kernel-host/kernel.js');
const { FsServer } = await load('packages/kernel-host/fs-server.js');
const { createDirectKernelFs } = await load('packages/kernel-host/direct-kernel-fs.js');
const p = await load('packages/protocol/syscall.js');
const { VirtualFileSystem } = createRequire(import.meta.url)(resolve(root, 'packages/vfs/pkg-node/vivari_vfs.js'));
const events: any[] = [], releases: Array<() => void> = [], resources: Array<() => unknown> = [];
const event = (name: string, fields = {}) => events.push({ name, ...fields });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function gate() { const value = deferred(); releases.push(value.resolve); return value; }
const checkpoint = () => new Promise<void>(yes => {
  const { port1, port2 } = new MessageChannel();
  port1.once('message', () => { port1.close(); port2.close(); yes(); }); port2.postMessage(0);
});
const text = (error: any): string => [String(error), error?.cleanupError,
  ...(error instanceof AggregateError ? [...error.errors].map(text) : [])].filter(Boolean).join('\n');
function observe(promise: Promise<any>) {
  const record: any = { state: 'pending' };
  record.join = promise.then(value => { record.state = 'success'; record.value = value; }, error => {
    record.state = 'failure'; record.error = error;
  });
  return record;
}
async function pending(record: any) { await checkpoint(); assert.equal(record.state, 'pending', 'owned native work remains held'); }
async function success(record: any) { await record.join; assert.equal(record.state, 'success', text(record.error)); return record.value; }
async function failure(record: any, pattern: RegExp) {
  await record.join; assert.equal(record.state, 'failure'); assert.match(text(record.error), pattern); return record.error;
}
function fixture(acquire?: (info: any) => any) {
  const server = new FsServer(new VirtualFileSystem()), fs = createDirectKernelFs(server);
  fs.mkdirp('/bin'); fs.writeFile('/bin/node.js', ''); fs.writeFile('/fixture.js', '');
  const workers: any[] = [], messages: any[] = [], exits: any[] = [], tasks: Promise<any>[] = [];
  const kernel = new Kernel({ fs, spawnWorker(info: any) {
    workers.push(info); event('acquire', { pid: info.pid });
    return acquire ? acquire(info) : { terminate() { event('terminate', { pid: info.pid }); },
      postMessage(message: any) { messages.push({ pid: info.pid, message }); } };
  }, stdout() {}, stderr() {} });
  kernel.onProcExit = (pid: number, result: any) => { exits.push({ pid, ...result }); event('exit', { pid, cleanupError: result.cleanupError }); };
  // Observe actual dispatch settlement; do not substitute dispatch behavior.
  const dispatch = kernel.dispatchSyscall.bind(kernel);
  kernel.dispatchSyscall = (...args: any[]) => {
    const task = dispatch(...args); if (task?.then) { tasks.push(task); task.catch(() => {}); } return task;
  };
  const launch = () => kernel.launch('node', ['/fixture.js']);
  function request(info: any, opcode: number, spec: any) {
    const { ctrl, data } = p.makeViews(info.sab), bytes = p.encodeRequest([p.encodeString(JSON.stringify(spec))]);
    data.set(bytes); Atomics.store(ctrl, p.I_OPCODE, opcode); Atomics.store(ctrl, p.I_REQ_LEN, bytes.length);
    Atomics.store(ctrl, p.I_STATE, p.STATE_REQUEST); info.on.syscall(); return { ctrl, data };
  }
  resources.push(async () => {
    for (const pid of [...kernel.procs.keys()]) await Promise.resolve(kernel.stop(pid)).catch(() => {});
    await kernel.closeLoaderOperations().catch(() => {});
  });
  return { kernel, server, fs, workers, messages, exits, tasks, launch, request };
}
const spawnSpec = { command: 'node', args: ['/fixture.js'], cwd: '/', env: {}, capture: true };
async function child(f: any, parent: any) {
  f.request(parent, p.OP_SPAWN_ASYNC, spawnSpec); await Promise.allSettled(f.tasks);
  assert.equal(f.workers.length >= 2, true); return f.workers.at(-1);
}
let failed: unknown;
const result: any = { scenario, node: process.version, executable: process.execPath, offline: true,
  actualKernel: true, actualCompiledCore: true, rustVfs: true, browser: false, servers: false, events };
try {
  if (scenario === 'held-terminate-receipt' || scenario === 'exited-child-pending' || scenario === 'concurrent-subtree-stop') {
    const held = gate(), entered = deferred(); let calls = 0;
    const f = fixture(info => ({ terminate() { calls++; event('terminate-held', { pid: info.pid }); entered.resolve(); return held.promise; }, postMessage() {} }));
    const parentPid = f.launch(), parent = f.workers[0];
    let pid = parentPid;
    if (scenario !== 'held-terminate-receipt') pid = (await child(f, parent)).pid;
    if (scenario === 'exited-child-pending') f.workers.at(-1).on.exit({ code: 0 });
    const receipt = f.kernel.stop(pid), stopping = observe(receipt);
    assert.equal(receipt, f.kernel.stop(pid)); await entered.promise;
    const ancestor = pid === parentPid ? stopping : observe(f.kernel.stop(parentPid));
    if (pid !== parentPid) assert.equal(f.kernel.stop(parentPid), f.kernel.stop(parentPid));
    if (scenario !== 'concurrent-subtree-stop') { await pending(stopping); await pending(ancestor); }
    held.resolve(); await success(stopping); await success(ancestor);
    assert.equal(calls, pid === parentPid ? 1 : 2); assert.equal(f.kernel.procs.size, 0);
    assert.equal(receipt, f.kernel.stop(pid)); result.controlledPromiseTermination = true;
  } else if (scenario === 'terminate-throw-retained') {
    const f = fixture(() => ({ terminate() { throw Error('PROCESS_TERMINATE_THROW'); }, postMessage() {} }));
    const pid = f.launch(), receipt = f.kernel.stop(pid), stopping = observe(receipt);
    const error = await failure(stopping, /PROCESS_TERMINATE_THROW/);
    assert.equal(receipt, f.kernel.stop(pid)); assert.equal(await failure(observe(f.kernel.stop(pid)), /PROCESS_TERMINATE_THROW/), error);
    assert.match(f.exits[0].cleanupError, /PROCESS_TERMINATE_THROW/); assert.equal(f.kernel.procs.size, 0);
  } else if (scenario === 'exited-children-multiple-failures') {
    // Existing authoritative guest-fetch cleanup is a composed leaf, not migrated.
    const f = fixture(), entered = deferred(), held = gate(); let writes = 0;
    const write = f.fs.writeLarge.bind(f.fs);
    f.fs.writeLarge = async (path: string, bytes: any) => { await write(path, bytes); if (++writes === 2) entered.resolve(); await held.promise; };
    const unlink = f.fs.unlink.bind(f.fs); let unlinks = 0;
    f.fs.unlink = (path: string) => { unlink(path); throw Error('CHILD_ROLLBACK_' + ++unlinks); };
    f.kernel.fetcher = async () => ({ status: 200, ok: true, headers: {}, body: Uint8Array.of(1) });
    const parentPid = f.launch(), parent = f.workers[0], a = await child(f, parent), b = await child(f, parent);
    for (const [index, info] of [a, b].entries()) f.request(info, p.OP_FETCH_ASYNC,
      { fetchId: index + 1, url: 'https://offline.invalid/' + index });
    await entered.promise;
    a.on.exit({ code: 0 }); b.on.exit({ code: 0 });
    assert.equal(f.kernel.procs.has(a.pid), false); assert.equal(f.kernel.procs.has(b.pid), false);
    const receipt = f.kernel.stop(parentPid), stopping = observe(receipt); await pending(stopping);
    held.resolve(); const error = await failure(stopping, /CHILD_ROLLBACK_1/); assert.match(text(error), /CHILD_ROLLBACK_2/);
    const exit = f.exits.find((x: any) => x.pid === parentPid);
    assert.match(exit.cleanupError, /CHILD_ROLLBACK_1/); assert.match(exit.cleanupError, /CHILD_ROLLBACK_2/);
    assert.equal(receipt, f.kernel.stop(parentPid)); result.fetchAuthority = 'existing composed leaf';
  } else if (scenario === 'runtime-pid-failure-retains-attachment') {
    const { Runtime, workspaceInternals } = await import(pathToFileURL(resolve(stage, 'candidate/workspace/index.js')).href);
    const f = fixture(() => ({ terminate() { throw Error('RUNTIME_PID_TERMINATE_FAILURE'); }, postMessage() {} }));
    const listeners = new Set<(message: any) => void>(), pids = new Map<number, number>(), owners = new Map<number, any>();
    const emit = (message: any) => { event('wire', message); for (const listener of [...listeners]) listener(message); };
    f.kernel.onProcExit = (pid: number, exit: any) => {
      const execId = [...pids].find(([, value]) => value === pid)?.[0];
      emit({ type: 'proc-exit', execId, code: exit.code, signal: exit.signal, cleanupError: exit.cleanupError });
    };
    const host = { nextExecution: 1, features: new Set(),
      async request(type: string) { assert.equal(type, 'vv-stat'); return { exists: true, isDir: false }; },
      on(listener: (message: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      post(type: string, message: any) {
        if (type === 'proc-spawn') {
          const owner = f.kernel.createLaunchOwner(); owners.set(message.execId, owner);
          const task = f.kernel.launchLoaded(message.command, message.args, { cwd: message.cwd, env: message.env,
            onStarted(pid: number) { pids.set(message.execId, pid); owners.delete(message.execId);
              emit({ type: 'proc-started', execId: message.execId, pid }); },
          }, owner).catch((error: any) => emit({ type: 'proc-exit', execId: message.execId,
            code: 143, signal: 'SIGTERM', error: String(error.message), cleanupError: error.cleanupError }));
          f.tasks.push(task);
        } else if (type === 'proc-kill') {
          const pid = pids.get(message.execId), owner = owners.get(message.execId);
          const task = pid === undefined ? owner?.close() : f.kernel.stop(pid);
          task?.catch(() => {});
        } else assert.equal(type, 'proc-input');
      },
    };
    // Transport/workspace acquisition leaf only. Runtime and Execution are the
    // separately built public SDK/library; no lifecycle decision lives in relay.
    const workspace = {}, distribution = { name: 'offline-process-gate', version: 'fixture', assetBaseUrl: '/fixture/' };
    const state = { host, distribution, attached: false, clearing: false, closed: false };
    workspaceInternals.set(workspace, state);
    const runtime = await Runtime.start({ workspace, distribution });
    const execution = await runtime.node({ entry: '/fixture.js' });
    const drain = async (stream: AsyncIterable<unknown>) => { for await (const _ of stream) {} };
    const readers = Promise.all([drain(execution.stdout), drain(execution.stderr)]);
    const receipt = runtime.stop(), stopping = observe(receipt);
    const error = await failure(stopping, /RUNTIME_PID_TERMINATE_FAILURE/); await readers;
    assert.equal(state.attached, true); assert.equal(receipt, runtime.stop());
    assert.equal(await failure(observe(runtime.stop()), /RUNTIME_PID_TERMINATE_FAILURE/), error);
    await assert.rejects(Runtime.start({ workspace, distribution }), (e: any) => e.code === 'ATTACHED');
    const exit = await execution.exited; assert.match(exit.cleanupError, /RUNTIME_PID_TERMINATE_FAILURE/);
    result.actualBuiltRuntimeSdk = true; result.retainedAttachment = true;
  } else if (scenario === 'launch-transfer-revoked' || scenario === 'boot-before-transfer') {
    let owner: any;
    const f = fixture(info => {
      if (scenario === 'launch-transfer-revoked') owner.close();
      else info.on['worker-error']({ error: 'BOOT_BEFORE_TRANSFER', fatal: true });
      return { terminate() { event('acquisition-unwound'); }, postMessage() {} };
    });
    owner = f.kernel.createLaunchOwner(); const started: number[] = [];
    const launching = observe(f.kernel.launchLoaded('node', ['/fixture.js'], { onStarted(pid: number) { started.push(pid); } }, owner));
    await failure(launching, scenario === 'launch-transfer-revoked' ? /admission closed/ : /BOOT_BEFORE_TRANSFER|worker|process|launch/i);
    assert.deepEqual(started, []); assert.equal(f.kernel.procs.size, 0);
    assert.equal(events.filter(e => e.name === 'acquisition-unwound').length, 1);
    assert.equal(owner.close(), owner.close());
  } else if (scenario === 'stale-spawn-exit') {
    const f = fixture(); const pid = f.launch(), parent = f.workers[0];
    f.request(parent, p.OP_SPAWN, spawnSpec); await Promise.allSettled(f.tasks);
    const first = f.workers[1], held = gate(), entered = deferred();
    f.kernel.registerLazyProgram('held', async () => { entered.resolve(); await held.promise; });
    const { ctrl, data } = f.request(parent, p.OP_SPAWN, { ...spawnSpec, command: 'held' });
    await entered.promise; const before = Uint8Array.from(data); const state = Atomics.load(ctrl, p.I_STATE);
    first.on.exit({ code: 0 }); await f.kernel.stop(first.pid);
    assert.equal(Atomics.load(ctrl, p.I_STATE), state, 'old child callback cannot publish into newer same-opcode request');
    assert.deepEqual(data, before); const stopping = f.kernel.stop(pid); held.resolve(); await stopping; await Promise.allSettled(f.tasks);
  } else if (scenario === 'stale-loader-rejection') {
    const f = fixture(); const pid = f.launch(), parent = f.workers[0], old = gate(), newer = gate();
    const oldEntered = deferred(), newEntered = deferred();
    const originalFailure = Error('OLD_LOADER_REJECTION');
    f.kernel.registerLazyProgram('old', async () => { oldEntered.resolve(); await old.promise; throw originalFailure; });
    f.kernel.registerLazyProgram('new', async () => { newEntered.resolve(); await newer.promise; });
    f.request(parent, p.OP_SPAWN_ASYNC, { ...spawnSpec, command: 'old' }); await oldEntered.promise;
    const oldTask = f.tasks.at(-1);
    const { ctrl, data } = f.request(parent, p.OP_SPAWN_ASYNC, { ...spawnSpec, command: 'new' }); await newEntered.promise;
    const before = Uint8Array.from(data), state = Atomics.load(ctrl, p.I_STATE);
    old.resolve(); await Promise.allSettled([oldTask]); await checkpoint();
    assert.equal(Atomics.load(ctrl, p.I_STATE), state, 'old rejected dispatch cannot answer newer same-opcode request');
    assert.deepEqual(data, before); event('old-rejection-publication-revoked');
    // Admission/publication revocation does not erase this accepted failure.
    // Phase1 already retains ordinary loader failure until owner/root cleanup.
    // Stop while the newer native loader is held, so no legitimate newer response
    // obscures whether old completion/stop changes the exact SAB window.
    const receipt = f.kernel.stop(pid), stopping = observe(receipt);
    assert.equal(receipt, f.kernel.stop(pid)); await pending(stopping);
    assert.equal(Atomics.load(ctrl, p.I_STATE), state); assert.deepEqual(data, before);
    newer.resolve(); await Promise.allSettled(f.tasks);
    const stopError = await failure(stopping, /OLD_LOADER_REJECTION/);
    const retainsExactFailure = (error: any): boolean => error === originalFailure ||
      (error instanceof AggregateError && [...error.errors].some(retainsExactFailure));
    assert.ok(retainsExactFailure(stopError), 'aggregate retains exact original accepted loader Error object');
    assert.equal(receipt, f.kernel.stop(pid));
    assert.equal(await failure(observe(f.kernel.stop(pid)), /OLD_LOADER_REJECTION/), stopError);
    assert.equal(Atomics.load(ctrl, p.I_STATE), state); assert.deepEqual(data, before);
    assert.match(f.exits.find((exit: any) => exit.pid === pid).cleanupError, /OLD_LOADER_REJECTION/);
    const rootReceipt = f.kernel.closeLoaderOperations(); assert.equal(rootReceipt, f.kernel.closeLoaderOperations());
    const rootError = await failure(observe(rootReceipt), /OLD_LOADER_REJECTION/);
    assert.ok(retainsExactFailure(rootError));
    event('accepted-loader-failure-retained', { exactOriginalError: true, repeatedReceiptAndError: true, unchangedSabThroughStop: true });
  } else if (scenario === 'thread-transfer-revoked') {
    let f: any, parentPid: number, terminated = 0;
    f = fixture(info => {
      if (info.pid !== parentPid && f.workers.length > 1) f.kernel.stop(parentPid);
      return { terminate() { terminated++; }, postMessage(message: any) { f.messages.push({ pid: info.pid, message }); } };
    });
    parentPid = f.launch(); const parent = f.workers[0];
    const { port1, port2 } = new MessageChannel(); resources.push(() => { port1.close(); port2.close(); });
    parent.on['thread-spawn']({ reqId: 71, spec: { programPath: '/fixture.js' }, port: port1 });
    await f.kernel.stop(parentPid);
    assert.equal(f.kernel.procs.size, 0); assert.equal(terminated, 2, 'reentrant stop must unwind returned child handle');
    assert.equal(f.messages.filter((x: any) => x.message.type === 'thread-started').length, 0);
  } else if (scenario === 'late-thread-after-stop') {
    const f = fixture(), pid = f.launch(), parent = f.workers[0]; await f.kernel.stop(pid);
    const { port1, port2 } = new MessageChannel(); resources.push(() => { port1.close(); port2.close(); });
    parent.on['thread-spawn']({ reqId: 71, spec: { programPath: '/fixture.js' }, port: port1 });
    assert.equal(f.workers.length, 1); assert.deepEqual(f.messages, []);
    const { ctrl, data } = p.makeViews(parent.sab), before = Uint8Array.from(data), state = Atomics.load(ctrl, p.I_STATE);
    parent.on.syscall(); assert.equal(Atomics.load(ctrl, p.I_STATE), state); assert.deepEqual(data, before);
  } else if (scenario === 'native-node-terminate') {
    // Actual native terminate Promise, with a join gate AFTER it resolves. Kernel
    // must compose that adapter receipt; an exit event alone is not the receipt.
    const held = gate(), terminated = deferred(); let w: Worker, calls = 0;
    const f = fixture(() => {
      w = new Worker('const {parentPort}=require("node:worker_threads"); parentPort.postMessage("ready"); parentPort.on("message",()=>{});', { eval: true });
      resources.push(() => w.terminate());
      return { terminate() { calls++; return w.terminate().then(code => {
        event('native-terminate-resolved', { code }); terminated.resolve(); return held.promise;
      }); }, postMessage() {} };
    });
    const pid = f.launch(); await new Promise<void>((yes, no) => { w.once('message', () => yes()); w.once('error', no); });
    const receipt = f.kernel.stop(pid), stopping = observe(receipt); await terminated.promise;
    await pending(stopping); assert.equal(receipt, f.kernel.stop(pid)); held.resolve(); await success(stopping); assert.equal(calls, 1);
    result.actualNativeWorker = true;
  } else if (scenario === 'node-adapter-terminate-promise') {
    const f = fixture(info => acquire(info)), ready = deferred(), nativeExit = deferred();
    const { parse } = await load('packages/runtime/vendor/acorn.mjs');
    const code = readFileSync(resolve(root, 'scripts/lib/spike-harness.mjs'), 'utf8'), nodes: any[] = [];
    function walk(node: any) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'VariableDeclarator' && node.id?.name === 'spawnWorker') nodes.push(node.init);
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
    }
    walk(parse(code, { ecmaVersion: 'latest', sourceType: 'module' })); assert.equal(nodes.length, 1);
    const { initTransferList } = await load('packages/kernel-host/worker-transfer.js');
    function WorkerPlacementLeaf() {
      const worker = new Worker('const {parentPort}=require("node:worker_threads"); parentPort.postMessage({type:"ready"}); parentPort.on("message",()=>{});', { eval: true });
      worker.on('message', () => ready.resolve()); worker.on('exit', () => nativeExit.resolve());
      resources.push(() => worker.terminate()); return worker;
    }
    const acquire = new Function('Worker', 'MessageChannel', 'filesystem', 'initTransferList', 'meta',
      'return (' + code.slice(nodes[0].start, nodes[0].end).replaceAll('import.meta', 'meta') + ');')(
      WorkerPlacementLeaf, MessageChannel, { server: f.server }, initTransferList,
      { url: pathToFileURL(resolve(root, 'scripts/lib/spike-harness.mjs')).href });
    const pid = f.launch(); await ready.promise;
    const handle = f.kernel.procs.get(pid).handle, receipt = handle.terminate();
    // Native thread really ran; only entry placement changed. Execute the ACTUAL
    // production Node adapter body, not a recreated terminate implementation.
    result.actualNodeAdapter = true; result.actualNativeWorker = true;
    assert.equal(typeof receipt?.then, 'function', 'production Node adapter must return native Worker.terminate join');
    await receipt; await nativeExit.promise; assert.equal(f.server.clients.has(pid), false);
    await f.kernel.stop(pid);
  } else if (scenario.startsWith('acquisition-')) {
    const kind = scenario.slice('acquisition-'.length), f = fixture(info => acquire(info));
    const { parse } = await load('packages/runtime/vendor/acorn.mjs');
    const manifest = JSON.parse(readFileSync(resolve(stage, 'candidate/runtime/distribution.json'), 'utf8'));
    const emitted = readFileSync(resolve(stage, 'candidate/sdk', manifest.kernelWorker), 'utf8');
    const expressions: any[] = [];
    function walk(node: any) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'VariableDeclarator' && node.id?.name === 'spawnWorker') expressions.push(node.init);
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
    }
    walk(parse(emitted, { ecmaVersion: 'latest', sourceType: 'module' })); assert.equal(expressions.length, 1);
    const expression = emitted.slice(expressions[0].start, expressions[0].end);
    const { initTransferList } = await load('packages/kernel-host/worker-transfer.js');
    const procWorkers = new Map(), procMemPending = new Map(), ports: any[] = [], natives: any[] = [];
    let registered = false;
    const register = f.server.register.bind(f.server);
    f.server.register = (...args: any[]) => { register(...args); registered = true; if (kind === 'register') throw Error('ACQUISITION_REGISTER'); };
    function WorkerLeaf(this: any) {
      if (kind === 'constructor') throw Error('ACQUISITION_CONSTRUCTOR');
      this.terminations = 0; natives.push(this);
      this.postMessage = () => { throw Error('ACQUISITION_POSTMESSAGE'); };
      this.terminate = () => { this.terminations++; };
    }
    function ChannelLeaf() {
      const channel = new MessageChannel();
      for (const port of [channel.port1, channel.port2]) {
        const close = port.close.bind(port), record = { port, closes: 0 }; ports.push(record);
        port.close = () => { record.closes++; close(); };
        resources.push(() => close());
      }
      return channel;
    }
    // Evaluate ONLY the actual emitted function. Its known platform/closure leaves
    // are supplied explicitly; the worker entry, boot, persistence never execute.
    const acquire = new Function('Worker', 'MessageChannel', 'filesystem', 'procWorkers', 'procMemPending',
      'kernel', 'codecModule', 'cryptoModule', 'initTransferList', 'meta',
      'return (' + expression.replaceAll('import.meta', 'meta') + ');')(
      WorkerLeaf, ChannelLeaf, { server: f.server }, procWorkers, procMemPending, f.kernel, null, null,
      initTransferList, { url: pathToFileURL(resolve(stage, 'candidate/sdk', manifest.kernelWorker)).href });
    const owner = f.kernel.createLaunchOwner(), started: number[] = [];
    const launching = observe(f.kernel.launchLoaded('node', ['/fixture.js'], { onStarted(pid: number) { started.push(pid); } }, owner));
    await failure(launching, /ACQUISITION_/); await Promise.resolve(owner.close()).catch(() => {});
    result.actualEmittedAcquisition = true; result.controlledPlatformLeaves = kind; result.registeredBeforeFailure = registered;
    result.residual = { pids: [...f.kernel.procs.keys()], fsClients: [...f.server.clients.keys()],
      workerProjection: [...procWorkers.keys()], terminations: natives.map(n => n.terminations), portCloses: ports.map(p => p.closes) };
    assert.deepEqual(started, []); assert.equal(f.kernel.procs.size, 0, 'failed acquisition cannot strand PID');
    assert.equal(f.server.clients.size, 0); assert.equal(procWorkers.size, 0);
    assert.ok(natives.every(n => n.terminations === 1)); assert.ok(ports.every(p => p.closes >= 1));
  } else throw Error('Unknown finite scenario: ' + scenario);
} catch (error) { failed = error; }
finally {
  console.log(JSON.stringify({ ...result, status: failed ? 'FAIL' : 'PASS', failure: failed ? text(failed) : null }));
  for (const release of releases) release();
  for (const cleanup of resources.reverse()) { try { await cleanup(); } catch {} }
}
if (failed) throw failed;
