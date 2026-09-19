import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserEditorHandler } from '../src/server';
import type { ControllerDiagnosticEvent, DiagnosticBatch } from '@kev-browser-agent-kit/workspace/diagnostics';
import { encodeModelHeaders, MODEL_HEADERS } from '../src/model-headers';

test('request matching includes every editor resource and excludes public application routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'editor-server-'));
  try {
    await Bun.write(join(root, 'editor-assets.json'), JSON.stringify(['/assets/private.js', '/assets/private.css']));
    const handler = createBrowserEditorHandler({ preparedDirectory: root, runtimeDirectory: root,
      clientDirectory: root, providers: { opencode: { baseURL: 'https://example.invalid/v1' } } });
    for (const path of ['/editor/runtime/distribution.json', '/editor/prepared/manifest.json', '/editor/model/opencode/chat/completions', '/assets/private.js', '/assets/private.css']) {
      expect(await handler.matches(new Request('http://localhost' + path))).toBe(true);
    }
    for (const path of ['/', '/assets/public.js', '/editorial']) {
      expect(await handler.matches(new Request('http://localhost' + path))).toBe(false);
      expect(await handler.fetch(new Request('http://localhost' + path))).toBeUndefined();
    }
    await Bun.write(join(root, 'manifest.json'), '{"test":"prepared"}');
    expect(await (await handler.fetch(new Request('http://localhost/editor/prepared/manifest.json')))?.json()).toEqual({ test: 'prepared' });
  } finally { await rm(root, { recursive: true }); }
});

test('model proxy streams real HTTP, strips client credentials, and keeps its upstream prefix', async () => {
  let received: { path: string; search: string; headers: Headers; body: string } | undefined;
  let requests = 0;
  const upstream = Bun.serve({ port: 0, async fetch(request) {
    requests++;
    received = { path: new URL(request.url).pathname, search: new URL(request.url).search, headers: request.headers, body: await request.text() };
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: real-stream\n\n')); controller.close(); } }), {
      headers: { 'content-type': 'text/event-stream', 'set-cookie': 'upstream=secret' },
    });
  } });
  try {
    const handler = createBrowserEditorHandler({ preparedDirectory: '.', runtimeDirectory: '.', providers: {
      opencode: { baseURL: upstream.url + 'v1', headers: { authorization: 'Bearer server-only', 'user-agent': 'opencode/stable/2.0.3/vivari-opencode-server' } },
      anthropic: { baseURL: upstream.url + 'anthropic/v1', headers: { 'x-api-key': 'server-anthropic' } },
    } });
    const nativeHeaders = new Headers({ authorization: 'Bearer client', 'x-api-key': 'private', 'x-opencode-session': 'ses_test',
      'x-opencode-client': 'test-client', 'user-agent': 'OpenCode-native', 'x-provider-feature': 'one' });
    nativeHeaders.append('x-provider-feature', 'two');
    const response = await handler.fetch(new Request('http://localhost/editor/model/opencode/chat/completions?native=value%2Fone', { method: 'POST', body: '{ "opaque": true }',
      headers: { authorization: 'Bearer app', cookie: 'session=private', origin: 'http://localhost', 'x-app-secret': 'private', 'x-clerk-auth': 'private',
        [MODEL_HEADERS]: encodeModelHeaders(nativeHeaders) } }));
    expect(await response?.text()).toBe('data: real-stream\n\n');
    expect(received?.path).toBe('/v1/chat/completions');
    expect(received?.search).toBe('?native=value%2Fone');
    expect(received?.body).toBe('{ "opaque": true }');
    expect(received?.headers.get('x-opencode-session')).toBe('ses_test');
    expect(received?.headers.get('x-opencode-client')).toBe('test-client');
    expect(received?.headers.get('x-provider-feature')).toBe('one, two');
    expect(received?.headers.get('authorization')).toBe('Bearer server-only');
    expect(received?.headers.get('user-agent')).toBe('opencode/stable/2.0.3/vivari-opencode-server');
    for (const name of ['cookie', 'origin', 'x-api-key', 'x-app-secret', 'x-clerk-auth', MODEL_HEADERS]) expect(received?.headers.get(name)).toBeNull();
    expect(response?.headers.get('set-cookie')).toBeNull();
    const native = await handler.fetch(new Request('http://localhost/editor/model/anthropic/messages?beta=true', { method: 'POST', body: '{"messages":[]}',
      headers: { [MODEL_HEADERS]: encodeModelHeaders(new Headers({ authorization: 'Bearer client', 'x-api-key': 'client-key', 'anthropic-version': '2023-06-01' })) } }));
    await native?.text();
    expect(received?.path).toBe('/anthropic/v1/messages');
    expect(received?.headers.get('x-api-key')).toBe('server-anthropic');
    expect(received?.headers.get('authorization')).toBeNull();
    expect(received?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect((await handler.fetch(new Request('http://localhost/editor/model/opencode/%2e%2e%2foutside')))?.status).toBe(400);
    for (const provider of ['unknown', 'constructor', '__proto__']) {
      expect((await handler.fetch(new Request(`http://localhost/editor/model/${provider}/responses`)))?.status).toBe(404);
    }
    expect(requests).toBe(2);
  } finally { upstream.stop(true); }
});

test('model proxy forwards request chunks before EOF and returns response chunks before EOF', async () => {
  let firstRead!: (value: string) => void;
  const first = new Promise<string>(resolve => { firstRead = resolve; });
  let responseStream!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = Bun.serve({ port: 0, async fetch(request) {
    const reader = request.body!.getReader();
    firstRead(new TextDecoder().decode((await reader.read()).value));
    while (!(await reader.read()).done) { /* Drain remaining native bytes. */ }
    return new Response(new ReadableStream({ start(controller) {
      responseStream = controller; controller.enqueue(new TextEncoder().encode('data: first\n\n'));
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const lifetime = new AbortController();
  try {
    const handler = createBrowserEditorHandler({ preparedDirectory: '.', runtimeDirectory: '.', providers: { opencode: { baseURL: upstream.url.href } } });
    let requestStream!: ReadableStreamDefaultController<Uint8Array>;
    const request = new Request('http://host/editor/model/opencode/responses', { method: 'POST', signal: lifetime.signal,
      headers: { [MODEL_HEADERS]: encodeModelHeaders(new Headers({ 'content-type': 'application/json' })) },
      body: new ReadableStream({ start(controller) { requestStream = controller; controller.enqueue(new TextEncoder().encode('first')); } }),
    });
    const pending = handler.fetch(request);
    expect(await Promise.race([first, Bun.sleep(2000).then(() => 'timed out')])).toBe('first');
    requestStream.enqueue(new TextEncoder().encode('second')); requestStream.close();
    const response = await pending;
    const reader = response!.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
    responseStream.enqueue(new TextEncoder().encode('data: second\n\n'));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: second\n\n');
    const canceled = reader.read().then(() => false, () => true);
    lifetime.abort();
    expect(await Promise.race([canceled, Bun.sleep(2000).then(() => false)])).toBe(true);
  } finally { lifetime.abort(); upstream.stop(true); }
});

test('model proxy diagnostics correlate requests without retaining prompt or credential content', async () => {
  const events: ControllerDiagnosticEvent[] = [];
  const upstream = Bun.serve({ port: 0, fetch: () => Response.json({ error: {
    type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode",
  } }, { status: 403 }) });
  try {
    const handler = createBrowserEditorHandler({ preparedDirectory: '.', runtimeDirectory: '.', providers: {
      opencode: { baseURL: upstream.url + 'v1', headers: { authorization: 'Bearer server-secret', 'user-agent': 'opencode/stable/2.0.3/vivari-opencode-server' } },
    }, diagnostics: { enabled: true, async write(batch: DiagnosticBatch) { events.push(...batch.events); } } });
    const response = await handler.fetch(new Request('http://localhost/editor/model/opencode/responses?ignored=secret', {
      method: 'POST', body: JSON.stringify({ model: 'muse-spark-1.3-contributor-free', input: 'PRIVATE_PROMPT' }),
      headers: { [MODEL_HEADERS]: encodeModelHeaders(new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer browser-secret', 'x-opencode-client': 'vivari-opencode-server',
        'x-opencode-project': 'project-secret', 'x-opencode-session': 'session-secret',
      })) },
    }));
    expect(response?.status).toBe(403);
    for (let index = 0; index < 20 && !events.some(event => event.event === 'model.error'); index++) await Bun.sleep(10);
    const request = events.find(event => event.event === 'model.request')?.data as Record<string, unknown>;
    const result = events.find(event => event.event === 'model.response')?.data as Record<string, unknown>;
    const error = events.find(event => event.event === 'model.error')?.data as Record<string, unknown>;
    expect(request.requestId).toBeString();
    expect(result.requestId).toBe(request.requestId);
    expect(error.requestId).toBe(request.requestId);
    expect(result).toMatchObject({ method: 'POST', path: '/editor/model/opencode/responses', upstreamPath: '/v1/responses',
      provider: 'opencode', model: 'muse-spark-1.3-contributor-free', client: 'vivari-opencode-server',
      upstreamStatus: 403, downstreamStatus: 403, providerCredentialConfigured: true,
      nativeFields: ['authorization', 'content-type', 'x-opencode-client', 'x-opencode-project', 'x-opencode-session'],
      forwardedFields: ['accept-encoding', 'content-type', 'user-agent', 'x-opencode-client', 'x-opencode-project', 'x-opencode-session'],
      openCodeIdentity: { client: true, project: true, request: false, session: true } });
    expect(error.errorCategory).toBe('FreeTierError');
    const stored = JSON.stringify(events);
    for (const secret of ['PRIVATE_PROMPT', 'server-secret', 'browser-secret', 'project-secret', 'session-secret', 'ignored=secret']) expect(stored).not.toContain(secret);
  } finally { upstream.stop(true); }
});
