import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserEditorHandler } from '../src/server';

test('editor authorization covers runtime, preparation, private chunks and model; public app is delegated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'editor-server-'));
  try {
    await Bun.write(join(root, 'editor-assets.json'), JSON.stringify(['/assets/private.js', '/assets/private.css']));
    const handler = createBrowserEditorHandler({ authorize: () => false, preparedDirectory: root, runtimeDirectory: root,
      clientDirectory: root, providers: { opencode: { baseURL: 'https://example.invalid/v1' } } });
    for (const path of ['/editor/runtime/distribution.json', '/editor/prepared/manifest.json', '/editor/model/opencode/chat/completions', '/assets/private.js', '/assets/private.css']) {
      expect((await handler(new Request('http://localhost' + path)))?.status).toBe(403);
    }
    expect(await handler(new Request('http://localhost/'))).toBeUndefined();
    expect(await handler(new Request('http://localhost/assets/public.js'))).toBeUndefined();
    const failedPolicy = createBrowserEditorHandler({ authorize: () => { throw Error('session unavailable'); }, preparedDirectory: root, runtimeDirectory: root, providers: { opencode: { baseURL: 'https://example.invalid/v1' } } });
    expect((await failedPolicy(new Request('http://localhost/editor/model/test')))?.status).toBe(403);
  } finally { await rm(root, { recursive: true }); }
});

test('authorized model proxy streams real HTTP, strips client credentials, and keeps its upstream prefix', async () => {
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
    const handler = createBrowserEditorHandler({ authorize: () => true, preparedDirectory: '.', runtimeDirectory: '.', providers: {
      opencode: { baseURL: upstream.url + 'v1', headers: { authorization: 'Bearer server-only', 'user-agent': 'opencode/stable/2.0.3/vivari-opencode-server' } },
      anthropic: { baseURL: upstream.url + 'anthropic/v1', headers: { 'x-api-key': 'server-anthropic' } },
    } });
    const response = await handler(new Request('http://localhost/editor/model/opencode/chat/completions?native=value%2Fone', { method: 'POST', body: '{ "opaque": true }',
      headers: { authorization: 'Bearer client', cookie: 'session=private', origin: 'http://localhost', 'x-api-key': 'private', 'x-opencode-session': 'ses_test', 'x-opencode-client': 'test-client', 'user-agent': 'Mozilla/5.0' } }));
    expect(await response?.text()).toBe('data: real-stream\n\n');
    expect(received?.path).toBe('/v1/chat/completions');
    expect(received?.search).toBe('?native=value%2Fone');
    expect(received?.body).toBe('{ "opaque": true }');
    expect(received?.headers.get('x-opencode-session')).toBe('ses_test');
    expect(received?.headers.get('x-opencode-client')).toBe('test-client');
    expect(received?.headers.get('authorization')).toBe('Bearer server-only');
    expect(received?.headers.get('user-agent')).toBe('opencode/stable/2.0.3/vivari-opencode-server');
    for (const name of ['cookie', 'origin', 'x-api-key']) expect(received?.headers.get(name)).toBeNull();
    expect(response?.headers.get('set-cookie')).toBeNull();
    const native = await handler(new Request('http://localhost/editor/model/anthropic/messages?beta=true', { method: 'POST', body: '{"messages":[]}',
      headers: { authorization: 'Bearer client', 'x-api-key': 'client-key', 'anthropic-version': '2023-06-01' } }));
    await native?.text();
    expect(received?.path).toBe('/anthropic/v1/messages');
    expect(received?.headers.get('x-api-key')).toBe('server-anthropic');
    expect(received?.headers.get('authorization')).toBeNull();
    expect(received?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect((await handler(new Request('http://localhost/editor/model/opencode/%2e%2e%2foutside')))?.status).toBe(400);
    for (const provider of ['unknown', 'constructor', '__proto__']) {
      expect((await handler(new Request(`http://localhost/editor/model/${provider}/responses`)))?.status).toBe(404);
    }
    expect(requests).toBe(2);
  } finally { upstream.stop(true); }
});
