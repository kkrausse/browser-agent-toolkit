import { expect, test } from 'bun:test';
import { shutdownAtEOF } from '../src/service-shutdown';
import type { Execution } from '../src/types';

function fixture() {
  const calls: string[] = [];
  let exit!: (result: Awaited<Execution['exited']>) => void, drain!: () => void;
  const exited = new Promise<Awaited<Execution['exited']>>(resolve => { exit = resolve; });
  const drained = new Promise<void>(resolve => { drain = resolve; });
  const stream = { async *[Symbol.asyncIterator]() {} };
  const execution: Execution = { stdout: stream, stderr: stream, exited,
    writeStdin() {}, closeStdin() { calls.push('eof'); },
    async stop() { calls.push('kill'); exit({ exitCode: 143, signal: 'SIGTERM', forced: true }); drain(); },
  };
  return { calls, execution, drained, exit, drain };
}

test('EOF shutdown waits for both natural exit and output drain', async () => {
  const f = fixture(); let finished = false;
  const task = shutdownAtEOF(f.execution, f.drained, 1000).then(() => { finished = true; });
  f.exit({ exitCode: 0, signal: null, forced: false });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(f.calls).toEqual(['eof']);
  f.drain(); await task;
  expect(finished).toBe(true);
  expect(f.calls).toEqual(['eof']);
});

test('unresponsive EOF has a forced fallback and rejects rather than claiming graceful shutdown', async () => {
  const f = fixture();
  await expect(shutdownAtEOF(f.execution, f.drained, 10)).rejects.toThrow('timed out');
  expect(f.calls).toEqual(['eof', 'kill']);
});

test('nonzero natural exit is reported after draining', async () => {
  const f = fixture();
  const task = shutdownAtEOF(f.execution, f.drained, 1000);
  f.exit({ exitCode: 1, signal: null, forced: false }); f.drain();
  await expect(task).rejects.toThrow('Service EOF shutdown failed');
  expect(f.calls).toEqual(['eof', 'kill']);
});
