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
      clientDirectory: root, model: { baseURL: 'https://example.invalid/v1' } });
    for (const path of ['/editor/runtime/distribution.json', '/editor/prepared/manifest.json', '/editor/model/chat/completions', '/assets/private.js', '/assets/private.css']) {
      expect((await handler(new Request('http://localhost' + path)))?.status).toBe(403);
    }
    expect(await handler(new Request('http://localhost/'))).toBeUndefined();
    expect(await handler(new Request('http://localhost/assets/public.js'))).toBeUndefined();
    const failedPolicy = createBrowserEditorHandler({ authorize: () => { throw Error('session unavailable'); }, preparedDirectory: root, runtimeDirectory: root, model: { baseURL: 'https://example.invalid/v1' } });
    expect((await failedPolicy(new Request('http://localhost/editor/model/test')))?.status).toBe(403);
  } finally { await rm(root, { recursive: true }); }
});

test('authorized model proxy streams real HTTP, strips client credentials, and keeps its upstream prefix', async () => {
  let received: { path: string; headers: Headers } | undefined;
  const upstream = Bun.serve({ port: 0, fetch(request) {
    received = { path: new URL(request.url).pathname, headers: request.headers };
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: real-stream\n\n')); controller.close(); } }), {
      headers: { 'content-type': 'text/event-stream', 'set-cookie': 'upstream=secret' },
    });
  } });
  try {
    const handler = createBrowserEditorHandler({ authorize: () => true, preparedDirectory: '.', runtimeDirectory: '.', model: { baseURL: upstream.url + 'v1', headers: { authorization: 'Bearer server-only' } } });
    const response = await handler(new Request('http://localhost/editor/model/chat/completions', { method: 'POST', body: '{}',
      headers: { authorization: 'Bearer client', cookie: 'session=private', origin: 'http://localhost', 'x-api-key': 'private' } }));
    expect(await response?.text()).toBe('data: real-stream\n\n');
    expect(received?.path).toBe('/v1/chat/completions');
    expect(received?.headers.get('authorization')).toBe('Bearer server-only');
    for (const name of ['cookie', 'origin', 'x-api-key']) expect(received?.headers.get(name)).toBeNull();
    expect(response?.headers.get('set-cookie')).toBeNull();
    expect((await handler(new Request('http://localhost/editor/model/%2e%2e%2foutside')))?.status).toBe(400);
    expect(received?.path.startsWith('/v1/')).toBe(true);
  } finally { upstream.stop(true); }
});
