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
    f.resolveExit({exitCode:1,signal:null,forced:false}); return new Promise<never>(() => {});
  })).rejects.toThrow('exited during readiness');
  expect(f.calls).toEqual(['dispose','stop']);
  expect(f.controller.getSnapshot().services).toEqual({});
});

test('stdout transport error fails immediately during listener wait', async () => {
  const f = fixture();
  f.runtime.expose = async () => { f.rejectOutput(Error('worker transport failed')); return new Promise<never>(() => {}); };
  await expect(f.controller.launch('vite', {entry:'/vite.js'}, 5173, f.connect)).rejects.toThrow('worker transport failed');
  expect(f.calls).toEqual(['stop']);
  expect(f.controller.getSnapshot().services).toEqual({});
});

test('listener deadline aborts expose and stops/drains the process', async () => {
  const f = fixture();
  let exposeSignal!: AbortSignal;
  f.runtime.expose = async (_port, options) => { exposeSignal=options.signal; return new Promise<never>(() => {}); };
  await expect(f.controller.launch('vite', {entry:'/vite.js'}, 5173, f.connect, undefined, {listenMs:10,overallMs:100})).rejects.toThrow('listen budget exhausted');
  expect(exposeSignal.aborted).toBe(true);
  expect(f.calls).toEqual(['stop']);
});

test('uncooperative connect is bounded and never publishes a service', async () => {
  const f = fixture();
  await expect(f.controller.launch('vite', {entry:'/vite.js'}, 5173, async () => new Promise<never>(() => {}), undefined, {connectMs:10})).rejects.toThrow('connect budget exhausted');
  expect(f.calls).toEqual(['dispose','stop']);
  expect(f.controller.getSnapshot().services).toEqual({});
});

test('overall budget does not reset after listener stage succeeds', async () => {
  const f = fixture();
  f.runtime.expose = async () => { await Bun.sleep(20); return {url:'http://service.invalid',dispose(){f.calls.push('dispose');}}; };
  await expect(f.controller.launch('vite', {entry:'/vite.js'}, 5173, async () => new Promise<never>(() => {}), undefined, {listenMs:100,connectMs:100,overallMs:40})).rejects.toThrow('overall budget exhausted');
  expect(f.calls).toEqual(['dispose','stop']);
});

test('overall timeout bounds a delayed spawn and stops a late accepted execution', async () => {
  const f = fixture();
  const original = f.runtime.node;
  let accept!: () => void;
  const accepted = new Promise<void>(resolve => { accept=resolve; });
  f.runtime.node = async options => { await accepted; return original(options); };
  await expect(f.controller.launch('vite',{entry:'/vite.js'},5173,f.connect,undefined,{overallMs:10})).rejects.toThrow('overall budget exhausted');
  accept(); await Bun.sleep(5);
  expect(f.calls).toEqual(['stop']);
  expect(f.controller.getSnapshot().services).toEqual({});
});

test('late listener cannot escape disposal after readiness timeout', async () => {
  const f = fixture();
  let listen!: () => void;
  const listening = new Promise<void>(resolve => { listen=resolve; });
  const original=f.runtime.expose;
  f.runtime.expose=async (port,options) => {await listening; return original(port,options);};
  await expect(f.controller.launch('vite',{entry:'/vite.js'},5173,f.connect,undefined,{listenMs:10})).rejects.toThrow('listen budget exhausted');
  listen(); await Bun.sleep(5);
  expect(f.calls).toEqual(['stop','dispose']);
});
