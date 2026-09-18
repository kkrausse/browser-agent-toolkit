import { expect, test } from 'bun:test';
import { createDiagnosticReporter, type DiagnosticBatch } from '../src/diagnostic-transport';
import { createDiagnosticScope } from '../src/react-diagnostics';

test('delivery retries retain IDs, drain multiple UTF-8 bounded batches, and do not expose secrets', async () => {
  const batches: DiagnosticBatch[] = [];
  let fail = true;
  const reporter = createDiagnosticReporter({ flushIntervalMs: 60000, retryIntervalMs: 60000, async transport(batch) {
    batches.push(batch);
    if (fail) { fail = false; throw Error('offline'); }
  } });
  for (let i = 0; i < 75; i++) reporter.record('test.output', { i, message: '😀'.repeat(1000), authorization: 'private', detail: 'Bearer private' });
  await reporter.flush();
  await reporter.flush();
  expect(batches[0]?.events.map(event => event.id)).toEqual(batches[1]?.events.map(event => event.id));
  expect(batches.slice(1).flatMap(batch => batch.events)).toHaveLength(75);
  for (const batch of batches) {
    expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThan(48000);
    expect(batch.events.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(batch)).not.toContain('private');
  }
  await reporter.dispose();
});

test('overflow is explicit and disabling discards pending events and prevents delivery', async () => {
  const batches: DiagnosticBatch[] = [];
  const reporter = createDiagnosticReporter({ maxQueue: 3, flushIntervalMs: 60000, async transport(batch) { batches.push(batch); } });
  for (let i = 0; i < 10; i++) reporter.record('test.event', { i });
  await reporter.flush();
  expect(batches[0]?.events[0]).toMatchObject({ event: 'diagnostics.dropped', data: { count: 7 } });
  expect(batches[0]?.events.slice(1).map(event => (event.data as { i: number }).i)).toEqual([7, 8, 9]);
  reporter.record('discarded'); reporter.setEnabled(false); reporter.record('disabled'); await reporter.flush();
  expect(batches).toHaveLength(1);
  reporter.setEnabled(true); reporter.record('resumed'); await reporter.flush();
  expect(batches[1]?.events.map(event => event.event)).toEqual(['resumed']);
  await reporter.dispose();
});

test('a throwing observer and unreadable data cannot break the operation; pending stages emit heartbeats', async () => {
  const events: string[] = [];
  const scope = createDiagnosticScope(event => { events.push(event.event); throw Error('sink failed'); }, 'run', 5);
  await expect(scope.stage('slow', async () => { await Bun.sleep(15); return 42; })).resolves.toBe(42);
  expect(events).toContain('slow.waiting');
  expect(events.at(-1)).toBe('slow.ready');
  await expect(scope.stage('broken', async () => { throw Error('real failure'); })).rejects.toThrow('real failure');
  expect(events.at(-1)).toBe('broken.failed');
  const reporter = createDiagnosticReporter({ transport: async () => {} });
  expect(() => reporter.record('unreadable', { get value() { throw Error('getter'); } })).not.toThrow();
  await reporter.dispose();
});
