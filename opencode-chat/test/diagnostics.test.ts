import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileDiagnosticSink, editorModelError, handleDiagnosticRequest } from '../src/diagnostics-server';
import { createBrowserEditorHandler } from '../src/server';
import { createBrowserEditorDiagnostics } from '../src/diagnostics';
import { createDiagnosticReporter, createDiagnosticScope, type ControllerDiagnosticEvent } from '@kev-browser-agent-kit/workspace/diagnostics';
import { runPreparationProcess } from '../src/prepare-process';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'editor-diagnostics-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const event = (data: unknown = {}): ControllerDiagnosticEvent => ({ id: crypto.randomUUID(), runId: 'startup', time: new Date().toISOString(), event: 'guest.output', data });

test('real transport -> authorized handler -> file sink redacts, preserves IDs, and deduplicates lost acknowledgements', async () => {
  const sink = createFileDiagnosticSink({ directory });
  const editor = createBrowserEditorHandler({ preparedDirectory: directory, runtimeDirectory: directory, providers: {}, diagnostics: sink });
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (request.headers.get('authorization') !== 'test-auth') return new Response(null, { status: 403 });
    return await editor.fetch(request, { actorId: 'verified-user' }) ?? new Response(null, { status: 404 });
  } });
  let loseAck = true;
  const reporter = createDiagnosticReporter({ flushIntervalMs: 60000, retryIntervalMs: 60000, async transport(batch) {
    const response = await fetch(new URL('/editor/diagnostics', server.url), { method: 'POST', headers: { authorization: 'test-auth' }, body: JSON.stringify(batch) });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    if (loseAck) { loseAck = false; throw Error('lost acknowledgement'); }
  } });
  try {
    reporter.onDiagnostic(event({ message: 'Cannot find module. Bearer private-value', cookie: 'private-cookie' }));
    await reporter.flush(); await reporter.flush();
    const stored = await sink.read();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.actorId).toBe('verified-user');
    expect(stored[0]?.data).toEqual({ message: 'Cannot find module. Bearer [redacted]', cookie: '[redacted]' });
    expect((await Bun.file(join(directory, 'events.jsonl')).text())).not.toContain('private-value');
    expect((await fetch(new URL('/editor/diagnostics', server.url))).status).toBe(403);
  } finally { await reporter.dispose(); server.stop(true); }
});

test('receiving boundary rejects malformed and oversized streaming batches and ignores forged identity', async () => {
  const sink = createFileDiagnosticSink({ directory });
  for (const [body, status] of [['{}', 400], ['x'.repeat(65537), 413]] as const) {
    const request = new Request('http://localhost/editor/diagnostics', { method: 'POST', body });
    expect((await handleDiagnosticRequest(request, sink, { actorId: 'user' })).status).toBe(status);
  }
  expect(await sink.read()).toEqual([]);
  const request = new Request('http://localhost/editor/diagnostics', { method: 'POST', body: JSON.stringify({ clientId: 'browser', actorId: 'forged', events: [{ ...event(), actorId: 'forged', receivedAt: 'forged' }] }) });
  expect((await handleDiagnosticRequest(request, sink, { actorId: 'real' })).status).toBe(204);
  expect((await sink.read())[0]?.actorId).toBe('real');
  expect((await sink.read())[0]?.receivedAt).not.toBe('forged');
});

test('file rotation is bounded even for concurrent multi-event writes', async () => {
  const sink = createFileDiagnosticSink({ directory, maxFileBytes: 65536 });
  await Promise.all(Array.from({ length: 4 }, (_, batch) => sink.write({ clientId: 'browser', events: Array.from({ length: 30 }, (_, i) => event({ index: batch * 30 + i, message: 'x'.repeat(6000) })) }, { actorId: 'user' })));
  expect((await stat(join(directory, 'events.jsonl'))).size).toBeLessThanOrEqual(65536);
  expect((await stat(join(directory, 'events.jsonl.1'))).size).toBeLessThanOrEqual(65536);
  expect((await sink.read(1))[0]?.data).toMatchObject({ index: 119 });
});

test('server switch disables ingestion and host events while preparation still runs', async () => {
  let writes = 0, preparations = 0;
  const editor = createBrowserEditorHandler({ preparedDirectory: directory, runtimeDirectory: directory, providers: {},
    diagnostics: { enabled: false, async write() { writes++; } },
    async prepare(diagnostics) { preparations++; diagnostics.record('test.prepare'); await Bun.write(join(directory, 'manifest.json'), '{}'); },
  });
  const config = await editor.fetch(new Request('http://localhost/editor/diagnostics/config'));
  expect(await config?.json()).toEqual({ enabled: false });
  expect((await editor.fetch(new Request('http://localhost/editor/prepared/manifest.json')))?.status).toBe(200);
  await editor.fetch(new Request('http://localhost/editor/diagnostics', { method: 'POST', body: '{}' }));
  editor.diagnostic('test.event');
  await Bun.sleep(0);
  expect(preparations).toBe(1); expect(writes).toBe(0);
});

test('manifest preparation events correlate with the browser run, including failures', async () => {
  const sink = createFileDiagnosticSink({ directory });
  const editor = createBrowserEditorHandler({ preparedDirectory: directory, runtimeDirectory: directory, providers: {}, diagnostics: sink,
    async prepare(diagnostics) { await diagnostics.stage('preparation.install', async () => { throw Error('installer stderr failure'); }); },
  });
  const result = await editor.fetch(new Request('http://localhost/editor/prepared/manifest.json', { headers: { 'x-editor-run-id': 'browser-run' } }), { actorId: 'user' });
  expect(result?.status).toBe(503);
  const stored = await sink.read();
  expect(stored.every(event => event.runId === 'browser-run' && event.actorId === 'user')).toBe(true);
  expect(stored.map(event => event.event)).toContain('preparation.install.failed');
  expect(stored.map(event => event.event)).toContain('preparation.failed');
});

test('provider error capture preserves the forwarded body and never reads successful model content', async () => {
  const response = Response.json({ error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded' } }, { status: 429 });
  expect(await editorModelError(response)).toEqual({ type: 'FreeUsageLimitError', message: 'Rate limit exceeded' });
  expect(await response.json()).toEqual({ error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded' } });
  expect(await editorModelError(Response.json({ output: 'not logged' }))).toBeUndefined();
});

test('browser client discovers the host switch and sends diagnostics only when enabled', async () => {
  const sink = createFileDiagnosticSink({ directory });
  const editor = createBrowserEditorHandler({ preparedDirectory: directory, runtimeDirectory: directory, providers: {}, diagnostics: sink });
  let posts = 0;
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (request.method === 'POST') posts++;
    return await editor.fetch(request, { actorId: 'user' }) ?? new Response(null, { status: 404 });
  } });
  try {
    for (const enabled of [false, true]) {
      sink.enabled = enabled;
      const client = createBrowserEditorDiagnostics({ base: server.url + 'editor/' });
      await client.connect();
      expect(client.enabled).toBe(enabled);
      client.record('browser.probe', { enabled });
      await client.dispose();
      expect(posts).toBe(enabled ? 1 : 0);
    }
    expect((await sink.read()).map(event => event.event)).toEqual(['browser.probe']);
  } finally { server.stop(true); }
});

test('library CLI follows newly appended events and emits JSON', async () => {
  const sink = createFileDiagnosticSink({ directory });
  const command = `import {runEditorLogs} from ${JSON.stringify(new URL('../src/diagnostics-server.ts', import.meta.url).href)}; await runEditorLogs({directory:process.argv[1],args:['--follow','--json']});`;
  const child = Bun.spawn([process.execPath, '-e', command, directory], { stdout: 'pipe', stderr: 'pipe' });
  const output = child.stdout.getReader(), status = child.stderr.getReader();
  try {
    expect(new TextDecoder().decode((await status.read()).value)).toContain('Following');
    await sink.write({ clientId: 'cli-test', events: [event({ message: 'follow probe' })] }, { actorId: 'user' });
    const line = new TextDecoder().decode((await output.read()).value);
    expect(JSON.parse(line.trim())).toMatchObject({ clientId: 'cli-test', data: { message: 'follow probe' } });
  } finally { child.kill(); await child.exited; await output.cancel(); await status.cancel(); }
});

test('failed preparation subprocess stdout/stderr and exit status reach the sink', async () => {
  const sink = createFileDiagnosticSink({ directory });
  const scope = createDiagnosticScope(event => { void sink.write({ clientId: 'server', events: [event] }, { actorId: 'preparer' }); }, 'process-test');
  await expect(runPreparationProcess([process.execPath, '-e', 'console.log("installer stdout");console.error("installer stderr");process.exit(7)'], { cwd: directory, label: 'installer-probe', diagnostics: scope })).rejects.toThrow('exit 7');
  const events = await sink.read();
  expect(events.filter(event => event.event === 'host.output').map(event => event.data)).toEqual(expect.arrayContaining([
    { label: 'installer-probe:stdout', message: 'installer stdout\n' },
    { label: 'installer-probe:stderr', message: 'installer stderr\n' },
  ]));
  expect(events.at(-1)?.event).toBe('preparation.install.failed');
});
