import { expect, test } from 'bun:test';
import { WorkspaceController } from '../src/react';
import type { Execution, NodeLaunchOptions } from '../src/types';

test('published EOF service survives cancellation until ordered shutdown and drain', async () => {
  const calls: string[] = [];
  let resolveExit!: (result: Awaited<Execution['exited']>) => void;
  let processSignal: AbortSignal | undefined;
  const exited = new Promise<Awaited<Execution['exited']>>(resolve => { resolveExit = resolve; });
  const stream = { async *[Symbol.asyncIterator]() { await exited; calls.push('drain'); } };
  const execution: Execution = { stdout: stream, stderr: stream, exited, writeStdin() {},
    closeStdin() { calls.push('eof'); resolveExit({ exitCode: 0, signal: null, forced: false }); },
    async stop() { calls.push('kill'); resolveExit({ exitCode: 143, signal: 'SIGTERM', forced: true }); },
  };
  const endpoint = { url: 'http://service.invalid', settled: Promise.resolve(), dispose() { calls.push('endpoint.dispose'); } };
  const runtime = {
    async node(options: NodeLaunchOptions) {
      processSignal = options.signal;
      processSignal!.addEventListener('abort', () => { calls.push('process.abort'); void execution.stop(); });
      return execution;
    },
    async expose() { return endpoint; },
    async stop() { calls.push('runtime.stop'); },
  };
  const controller = new WorkspaceController();
  Object.defineProperty(controller, 'runtime', { get: () => runtime });
  const lifetime = controller.signal;
  await controller.launch('server', { entry: '/server.js' }, 4096,
    async () => ({ url: endpoint.url, fetch: async () => new Response('ok') }), { shutdown: 'stdin-eof' });
  controller.registerAttachment('server', () => { calls.push('client.dispose'); });
  await controller.cancelAndClose();
  expect(lifetime.aborted).toBe(true);
  expect(processSignal!.aborted).toBe(false);
  expect(calls).toEqual(['client.dispose', 'endpoint.dispose', 'eof', 'drain', 'drain', 'runtime.stop']);
  expect(controller.getSnapshot().services).toEqual({});
});

test('EOF-managed startup still receives immediate cancellation before publication', async () => {
  let processSignal: AbortSignal | undefined;
  let spawned!: () => void;
  const ready = new Promise<void>(resolve => { spawned = resolve; });
  const runtime = { node(options: NodeLaunchOptions) {
    processSignal = options.signal; spawned();
    return new Promise<never>((_, reject) => { options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }); });
  }, async stop() {} };
  const controller = new WorkspaceController();
  Object.defineProperty(controller, 'runtime', { get: () => runtime });
  const task = controller.run('start', async () => {
    await controller.launch('server', { entry: '/server.js' }, 4096,
      async () => { throw Error('Must not connect'); }, { shutdown: 'stdin-eof' });
  });
  await ready;
  await controller.cancelAndClose(); await task;
  expect(processSignal!.aborted).toBe(true);
  expect(controller.getSnapshot().services).toEqual({});
});

// Observed failure: one missed EOF budget left the controller unable to stop, close or
// restart until reload, although the forced fallback had already ended the process.
function stubbornService(options: ConstructorParameters<typeof WorkspaceController>[0] = {}) {
  const calls: string[] = [];
  let resolveExit!: (result: Awaited<Execution['exited']>) => void;
  const exited = new Promise<Awaited<Execution['exited']>>(resolve => { resolveExit = resolve; });
  const stream = { async *[Symbol.asyncIterator]() { await exited; } };
  const execution: Execution = { stdout: stream, stderr: stream, exited, writeStdin() {}, closeStdin() { calls.push('eof'); },
    async stop() { calls.push('kill'); if (!runtime.unkillable) resolveExit({ exitCode: 143, signal: 'SIGTERM', forced: true }); await exited; } };
  const endpoint = { url: 'http://service.invalid', settled: Promise.resolve(), dispose() {} };
  const runtime = { async node() { return execution; }, async expose() { return endpoint; },
    async stop() { calls.push('runtime.stop'); if (runtime.stuck) throw Error('workspace remains attached'); }, stuck: false, unkillable: false };
  const workspace = { async close(options?: { force?: boolean }) { calls.push(options?.force ? 'workspace.close(force)' : 'workspace.close'); } };
  const controller = new WorkspaceController(options);
  (controller as unknown as { publish(patch: object): void }).publish({ runtime, workspace });
  const launch = () => controller.launch('server', { entry: '/server.js' }, 4096,
    async () => ({ url: endpoint.url, fetch: async () => new Response('ok') }), { shutdown: 'stdin-eof', timeoutMs: 10 });
  return { calls, runtime, controller, launch };
}

test('missed EOF budget is reported once, then retrying exit closes and renews the controller', async () => {
  const f = stubbornService();
  await f.launch();
  await expect(f.controller.cancelAndClose()).rejects.toThrow('quiescence unproven');
  expect(f.calls).toEqual(['eof', 'kill']);
  expect(f.controller.runtime).toBeDefined(); expect(f.controller.workspace).toBeDefined();
  expect(f.controller.signal.aborted).toBe(true);
  await f.controller.cancelAndClose();
  expect(f.calls).toEqual(['eof', 'kill', 'runtime.stop', 'workspace.close']);
  expect(f.controller.runtime).toBeUndefined(); expect(f.controller.workspace).toBeUndefined();
  expect(f.controller.signal.aborted).toBe(false);
});

test('force exit closes a controller whose runtime cannot prove cleanup, and reports it', async () => {
  const f = stubbornService();
  f.runtime.stuck = true;
  await expect(f.controller.cancelAndClose()).rejects.toThrow('workspace remains attached');
  await expect(f.controller.cancelAndClose()).rejects.toThrow('workspace remains attached');
  expect(f.controller.workspace).toBeDefined(); expect(f.controller.signal.aborted).toBe(true);
  const forced = await f.controller.cancelAndClose({ force: true }).then(() => null, error => error as AggregateError);
  expect(forced?.message).toContain('force-closed; cleanup unproven');
  expect(forced?.errors.map(String).join()).toContain('workspace remains attached');
  expect(f.calls).toEqual(['runtime.stop', 'runtime.stop', 'runtime.stop', 'workspace.close(force)']);
  expect(f.controller.runtime).toBeUndefined(); expect(f.controller.workspace).toBeUndefined();
  expect(f.controller.signal.aborted).toBe(false);
});

// Observed gap: a disposed controller has nobody left to retry, so a failed or hung
// close on unmount kept the document's only store open until reload.
test('dispose falls back to a forced close when cleanup fails, and still reports it', async () => {
  const events: string[] = [];
  const f = stubbornService({ onDiagnostic: event => { events.push(event.event); } });
  f.runtime.stuck = true;
  await expect(f.controller.dispose()).rejects.toThrow(/force-closed; cleanup unproven .*workspace remains attached/);
  expect(f.calls).toEqual(['runtime.stop', 'workspace.close(force)']);
  expect(f.controller.runtime).toBeUndefined(); expect(f.controller.workspace).toBeUndefined();
  expect(events).toContain('provider.dispose.forced');
  // Reported once: the controller is closed, so disposing again has nothing to force.
  await f.controller.dispose();
  expect(f.calls).toEqual(['runtime.stop', 'workspace.close(force)']);
});

test('dispose forces the close at the deadline when a service stop never settles', async () => {
  const f = stubbornService({ stopTimeoutMs: 20 });
  f.runtime.unkillable = true;
  await f.launch();
  const started = performance.now();
  await expect(f.controller.dispose()).rejects.toThrow(/force-closed; cleanup unproven .*1 service stop\(s\)/);
  // The EOF budget (10ms here) and the stop deadline add up; nothing waits beyond them.
  expect(performance.now() - started).toBeLessThan(500);
  expect(f.calls).toEqual(['eof', 'kill', 'workspace.close(force)']);
  expect(f.controller.getSnapshot()).toMatchObject({ services: {}, persistence: 'closed' });
  expect(f.controller.workspace).toBeUndefined();
});
