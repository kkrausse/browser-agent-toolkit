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
  const endpoint = { url: 'http://service.invalid', dispose() { calls.push('endpoint.dispose'); } };
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
