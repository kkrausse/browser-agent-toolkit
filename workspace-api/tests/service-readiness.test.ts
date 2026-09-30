import { expect, test } from 'bun:test';
import { WorkspaceController } from '../src/react';
import { readinessBudget } from '../src/service-readiness';
import type { Execution, NodeLaunchOptions } from '../src/types';

function fixture() {
  let resolveExit!: (value: Awaited<Execution['exited']>) => void;
  let rejectOutput!: (reason: Error) => void;
  const exited = new Promise<Awaited<Execution['exited']>>(resolve => { resolveExit = resolve; });
  const failure = new Promise<void>((_, reject) => { rejectOutput = reject; });
  void failure.catch(() => {});
  const stream = { async *[Symbol.asyncIterator]() { await Promise.race([exited, failure]); } };
  const calls: string[] = [];
  let processSignal!: AbortSignal;
  const execution: Execution = { stdout: stream, stderr: stream, exited, writeStdin() {}, closeStdin() {}, async stop() { calls.push('stop'); resolveExit({ exitCode: 143, signal: 'SIGTERM', forced: true }); } };
  const endpoint = { url: 'http://service.invalid', dispose() { calls.push('dispose'); } };
  const runtime = { async node(options: NodeLaunchOptions) { processSignal = options.signal!; return execution; }, async expose(_port: number, _options: {signal: AbortSignal}) { return endpoint; }, async stop() {} };
  const controller = new WorkspaceController();
  Object.defineProperty(controller, 'runtime', { get: () => runtime });
  const connect = async () => ({ url: endpoint.url, fetch: async () => new Response('ok') });
  return { controller, runtime, calls, connect, resolveExit, rejectOutput, processSignal: () => processSignal };
}

test('readiness options reject invalid budgets before spawn', async () => {
  for (const value of [0, -1, NaN, 1.5, 240001]) expect(() => readinessBudget({listenMs:value})).toThrow();
});

test('successful readiness does not terminate published non-EOF process', async () => {
  const f = fixture();
  const service = await f.controller.launch('vite', {entry:'/vite.js'}, 5173, f.connect, undefined, {listenMs:20,connectMs:20,overallMs:50});
  expect(f.processSignal().aborted).toBe(false);
  expect(f.controller.getSnapshot().services.vite).toBe(service);
  await f.controller.stopService('vite');
});

test('exit during connect fails closed rather than publishing a dead service', async () => {
  const f = fixture();
  await expect(f.controller.launch('vite', {entry:'/vite.js'}, 5173, async () => {
    f.resolveExit({exitCode:1,signal:null,forced:false}); await Bun.sleep(25); throw Error('late connect settled');
  })).rejects.toThrow('exited during readiness');
  expect(f.calls).toEqual(['dispose','stop']);
  expect(f.controller.getSnapshot().services).toEqual({});
});

test('stdout transport error fails immediately during listener wait', async () => {
  const f = fixture();
  f.runtime.expose = async () => { f.rejectOutput(Error('worker transport failed')); await Bun.sleep(25); throw Error('late expose settled'); };
  await expect(f.controller.launch('vite', {entry:'/vite.js'}, 5173, f.connect)).rejects.toThrow('worker transport failed');
  expect(f.calls).toEqual(['stop']);
  expect(f.controller.getSnapshot().services).toEqual({});
});

test('listener deadline aborts expose and stops/drains the process', async () => {
  const f = fixture();
  let exposeSignal!: AbortSignal;
  f.runtime.expose = async (_port, options) => { exposeSignal=options.signal; await Bun.sleep(25); throw Error('late expose settled'); };
  await expect(f.controller.launch('vite', {entry:'/vite.js'}, 5173, f.connect, undefined, {listenMs:10,overallMs:100})).rejects.toThrow('listen budget exhausted');
  expect(exposeSignal.aborted).toBe(true);
  expect(f.calls).toEqual(['stop']);
});

test('uncooperative connect is bounded and never publishes a service', async () => {
  const f = fixture();
  await expect(f.controller.launch('vite', {entry:'/vite.js'}, 5173, async () => {await Bun.sleep(25); throw Error('late connect settled')}, undefined, {connectMs:10})).rejects.toThrow('connect budget exhausted');
  expect(f.calls).toEqual(['dispose','stop']);
  expect(f.controller.getSnapshot().services).toEqual({});
});

test('overall budget does not reset after listener stage succeeds', async () => {
  const f = fixture();
  f.runtime.expose = async () => { await Bun.sleep(20); return {url:'http://service.invalid',dispose(){f.calls.push('dispose');}}; };
  await expect(f.controller.launch('vite', {entry:'/vite.js'}, 5173, async () => {await Bun.sleep(40); throw Error('late connect settled')}, undefined, {listenMs:100,connectMs:100,overallMs:40})).rejects.toThrow('overall budget exhausted');
  expect(f.calls).toEqual(['dispose','stop']);
});

test('overall timeout bounds a delayed spawn and stops a late accepted execution', async () => {
  const f = fixture();
  const original = f.runtime.node;
  let accept!: () => void;
  const accepted = new Promise<void>(resolve => { accept=resolve; });
  f.runtime.node = async options => { await accepted; return original(options); };
  const launch = f.controller.launch('vite',{entry:'/vite.js'},5173,f.connect,undefined,{overallMs:10});
  void launch.catch(() => {});
  await Bun.sleep(15);
  let settled = false; void launch.finally(() => {settled=true}).catch(() => {});
  expect(settled).toBe(false);
  accept(); await expect(launch).rejects.toThrow('overall budget exhausted');
  expect(f.calls).toEqual(['stop']);
  expect(f.controller.getSnapshot().services).toEqual({});
});

test('late listener cannot escape disposal after readiness timeout', async () => {
  const f = fixture();
  let listen!: () => void;
  const listening = new Promise<void>(resolve => { listen=resolve; });
  const original=f.runtime.expose;
  f.runtime.expose=async (port,options) => {await listening; return original(port,options);};
  const launch = f.controller.launch('vite',{entry:'/vite.js'},5173,f.connect,undefined,{listenMs:10});
  void launch.catch(() => {});
  await Bun.sleep(15);
  listen(); await expect(launch).rejects.toThrow('listen budget exhausted');
  expect(f.calls).toEqual(['stop','dispose']);
});

test('published output failure remains terminal after individual readiness', async () => {
  const f = fixture();
  await f.controller.launch('vite',{entry:'/vite.js'},5173,f.connect);
  f.rejectOutput(Error('late transport death'));
  await Bun.sleep(1);
  expect(f.controller.getSnapshot().error).toContain('late transport death');
  await expect(f.controller.stopServices()).rejects.toThrow('quiescence unproven');
});

test('published exit remains terminal after individual readiness', async () => {
  const f = fixture();
  await f.controller.launch('vite',{entry:'/vite.js'},5173,f.connect);
  f.resolveExit({exitCode:1,signal:null,forced:false});
  await Bun.sleep(1);
  expect(f.controller.getSnapshot().error).toContain('vite exited');
  expect(f.controller.getSnapshot().services).toEqual({});
});

test('service-only stop joins attachment/process/output and permits same-generation relaunch', async () => {
  const f = fixture();
  const service = await f.controller.launch('vite',{entry:'/vite.js'},5173,f.connect);
  f.controller.registerAttachment('vite',()=>f.calls.push('detach'));
  await f.controller.stopServices();
  await service.execution.exited; await service.drained;
  expect(f.calls).toEqual(['detach','dispose','stop']);
  expect(f.controller.runtime).toBe(f.runtime);
  expect(f.controller.getSnapshot().services).toEqual({});
  const incoming = fixture();
  f.runtime.node = incoming.runtime.node;
  const relaunched = await f.controller.launch('vite',{entry:'/vite.js'},5173,f.connect);
  expect(f.controller.getSnapshot().services.vite).toBe(relaunched);
  await f.controller.stopServices();
});

test('runtime teardown cannot overtake a cancelled but late accepted spawn', async () => {
  const f = fixture();
  const node = f.runtime.node;
  let accept!: () => void;
  const accepted = new Promise<void>(resolve => {accept=resolve});
  f.runtime.node = async options => {await accepted; return node(options)};
  let runtimeStopped = false;
  f.runtime.stop = async () => {runtimeStopped=true};
  const launch = f.controller.launch('vite',{entry:'/vite.js'},5173,f.connect,undefined,{overallMs:5});
  void launch.catch(() => {});
  await Bun.sleep(10);
  const teardown = f.controller.stopRuntime();
  await Bun.sleep(5); expect(runtimeStopped).toBe(false);
  accept(); await expect(launch).rejects.toThrow('overall budget exhausted');
  await teardown; expect(runtimeStopped).toBe(true); expect(f.calls).toEqual(['stop']);
});

test('natural exit detachment does not drop ownership of late output drains', async () => {
  const f = fixture();
  const execution = await f.runtime.node({entry:'/vite.js'});
  let release!: () => void;
  const pending = new Promise<void>(resolve => {release=resolve});
  Object.defineProperty(execution, 'stdout', {value:{async *[Symbol.asyncIterator]() {await pending}}});
  await f.controller.launch('vite',{entry:'/vite.js'},5173,f.connect);
  f.resolveExit({exitCode:1,signal:null,forced:false});
  await Bun.sleep(1);
  expect(f.controller.getSnapshot().services).toEqual({});
  let joined = false;
  const cleanup = f.controller.stopServices().then(() => {joined=true});
  await Bun.sleep(5); expect(joined).toBe(false);
  release(); await cleanup; expect(joined).toBe(true);
});

test('same-turn accepted endpoint remains owned when exit wins listener race', async () => {
  const f = fixture();
  const expose = f.runtime.expose;
  f.runtime.expose = async (port, options) => {
    f.resolveExit({exitCode:1,signal:null,forced:false});
    return expose(port,options);
  };
  await expect(f.controller.launch('vite',{entry:'/vite.js'},5173,f.connect)).rejects.toThrow('exited during readiness');
  expect(f.calls.filter(call=>call==='dispose')).toHaveLength(1);
  expect(f.controller.getSnapshot().services).toEqual({});
});

test('one stream failure forwards immediately but cleanup still joins the other stream', async () => {
  const f = fixture();
  const execution = await f.runtime.node({entry:'/vite.js'});
  let release!: () => void;
  const pending = new Promise<void>(resolve => {release=resolve});
  Object.defineProperty(execution, 'stderr', {value:{async *[Symbol.asyncIterator]() {await pending}}});
  const service = await f.controller.launch('vite',{entry:'/vite.js'},5173,f.connect);
  f.rejectOutput(Error('single-stream failure'));
  await expect(service.failed).rejects.toThrow('single-stream failure');
  expect(f.controller.getSnapshot().error).toContain('single-stream failure');
  let cleanupSettled = false;
  const cleanup = f.controller.stopServices();
  void cleanup.finally(() => {cleanupSettled=true}).catch(() => {});
  await Bun.sleep(5); expect(cleanupSettled).toBe(false);
  release(); await expect(cleanup).rejects.toThrow('quiescence unproven');
});
