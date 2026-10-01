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
  const f = stubbornService({ closeTimeoutMs: 90 });
  f.runtime.unkillable = true;
  await f.launch();
  const started = performance.now();
  await expect(f.controller.dispose()).rejects.toThrow(/force-closed; cleanup unproven .*1 service stop\(s\)/);
  // The stops give up 30ms before the 90ms budget ends; that reserve is the forced flush's.
  expect(performance.now() - started).toBeLessThan(500);
  expect(f.calls).toEqual(['eof', 'kill', 'workspace.close(force)']);
  expect(f.controller.getSnapshot()).toMatchObject({ services: {}, persistence: 'closed' });
  expect(f.controller.workspace).toBeUndefined();
});

// Observed design fault: every stage of a close started its own timer (cancelled
// operation, each service's EOF budget, service join, runtime stop, kernel shutdown), so
// hangs added up to 70s, and stops waited on the operation before they were even signalled.
function hungClose(options: ConstructorParameters<typeof WorkspaceController>[0]) {
  const calls: string[] = [];
  const service = (name: string) => {
    let resolveExit!: (result: Awaited<Execution['exited']>) => void;
    const exited = new Promise<Awaited<Execution['exited']>>(resolve => { resolveExit = resolve; });
    const stream = { async *[Symbol.asyncIterator]() { await exited; } };
    const execution: Execution = { stdout: stream, stderr: stream, exited, writeStdin() {}, closeStdin() { calls.push(`eof:${name}`); }, stop: () => exited.then(() => {}) };
    return { execution, exit: () => resolveExit({ exitCode: 0, signal: null, forced: false }) };
  };
  const services = { a: service('a'), b: service('b') };
  const endpoint = { url: 'http://service.invalid', settled: Promise.resolve(), dispose() {} };
  const runtime = { async node(options: NodeLaunchOptions) { return services[options.entry as 'a' | 'b'].execution; }, async expose() { return endpoint; },
    stop() { calls.push('runtime.stop'); return new Promise<void>(() => {}); } };
  const workspace = { async close(close?: { force?: boolean }) { calls.push(close?.force ? 'workspace.close(force)' : 'workspace.close'); } };
  const controller = new WorkspaceController(options);
  (controller as unknown as { publish(patch: object): void }).publish({ runtime, workspace });
  const launch = (name: 'a' | 'b') => controller.launch(name, { entry: name }, 4096,
    async () => ({ url: endpoint.url, fetch: async () => new Response('ok') }), { shutdown: 'stdin-eof', timeoutMs: 100 });
  let finish!: () => void;
  // A recipe that ignores cancellation: still running when the close needs it gone.
  const operation = () => { void controller.run('stuck', () => new Promise<void>(resolve => { finish = resolve; })); return Bun.sleep(0); };
  return { calls, controller, services, launch, operation, finish: () => finish() };
}

test('a close whose operation, services and runtime all hang rejects within the one budget', async () => {
  // Per stage these would have added up: operation 150 + (EOF 100 + stop 150) + runtime 150.
  const f = hungClose({ closeTimeoutMs: 150, stopTimeoutMs: 150 });
  await f.launch('a'); await f.operation();
  const started = performance.now();
  const failed = await f.controller.cancelAndClose().then(() => null, error => error);
  const elapsed = performance.now() - started;
  expect(failed).toMatchObject({ code: 'CLEANUP_FAILED' });
  expect(failed.message).toMatch(/1 cancelled operation\(s\).*1 service stop\(s\)/);
  // Stops get the 150ms budget minus the 50ms kept back for the kernel's flush.
  expect(elapsed).toBeGreaterThanOrEqual(95); expect(elapsed).toBeLessThan(150 + 100);
  // Unproven, so nothing closed: still attached and retryable, or force.
  expect(f.calls).toEqual(['eof:a']);
  expect(f.controller.workspace).toBeDefined(); expect(f.controller.signal.aborted).toBe(true);
  await expect(f.controller.cancelAndClose({ force: true })).rejects.toThrow('force-closed; cleanup unproven');
  expect(f.calls).toEqual(['eof:a', 'workspace.close(force)']);
  f.finish();
});

test('a close signals every service at once, without waiting on the operation or each other', async () => {
  const f = hungClose({ closeTimeoutMs: 3000 });
  await f.launch('a'); await f.launch('b'); await f.operation();
  const closing = f.controller.cancelAndClose().then(() => null, error => error as Error);
  await Bun.sleep(0);
  // Neither service has exited and the operation is still running.
  expect(f.calls).toEqual(['eof:a', 'eof:b']);
  f.services.a.exit(); f.services.b.exit(); f.finish();
  // The runtime (which would kill them) is stopped only after those graceful exits.
  await Bun.sleep(5);
  expect(f.calls).toEqual(['eof:a', 'eof:b', 'runtime.stop']);
  await expect(f.controller.cancelAndClose({ force: true })).rejects.toThrow('force-closed');
  expect((await closing)?.message).toContain('force-closed');
});

test('force pre-empts a close that is still waiting, and both callers get the forced outcome', async () => {
  const f = hungClose({ closeTimeoutMs: 3000 });
  await f.launch('a');
  const waiting = f.controller.cancelAndClose().then(() => null, error => error as Error);
  await Bun.sleep(5);
  const started = performance.now();
  const forced = f.controller.cancelAndClose({ force: true });
  await expect(forced).rejects.toThrow(/force-closed; cleanup unproven .*still waiting on cleanup when it was forced/);
  expect((await waiting)?.message).toContain('force-closed; cleanup unproven');
  expect(performance.now() - started).toBeLessThan(500);
  expect(f.calls).toEqual(['eof:a', 'workspace.close(force)']);
  expect(f.controller.workspace).toBeUndefined(); expect(f.controller.signal.aborted).toBe(false);
});
