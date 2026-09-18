import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import { decodeModelHeaders, encodeModelHeaders, MAX_MODEL_HEADERS, MODEL_HEADERS, modelHeaderPluginSource } from '../src/model-headers';
import { createOpenCodeCandidateConfig, openCodeCandidateLaunch } from '../src/opencode-launch';
import { createBrowserEditorHandler } from '../src/server';

async function hook(base = 'http://host/editor/model/opencode/') {
  const plugin = await import('data:text/javascript;base64,' + btoa(modelHeaderPluginSource(base)));
  let callback!: (event: { request: Request; kind: string }) => void;
  await plugin.default.setup({ session: { async hook(name: string, fn: typeof callback, scope: unknown) {
    expect(name).toBe('http.request'); expect(scope).toEqual({ providerID: 'opencode' }); callback = fn;
  } } });
  return callback;
}

test('public plugin envelopes native headers without consuming or replacing request streams/signals', async () => {
  const callback = await hook();
  for (const kind of ['primary', 'title', 'compaction', 'generate']) {
    const lifetime = new AbortController();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const request = new Request('http://host/editor/model/opencode/responses?native=1', { method: 'POST', body, signal: lifetime.signal,
      headers: { authorization: 'Bearer guest', 'content-type': 'application/json', 'x-opencode-session': 'ses_native', 'anthropic-beta': 'test' } });
    const originalBody = request.body, originalSignal = request.signal;
    callback({ request, kind });
    expect(request.body).toBe(originalBody); expect(request.signal).toBe(originalSignal); expect(request.bodyUsed).toBe(false);
    expect([...request.headers.keys()]).toEqual([MODEL_HEADERS]);
    expect(decodeModelHeaders(request.headers.get(MODEL_HEADERS)).get('authorization')).toBe('Bearer guest');
    const consuming = request.text();
    stream.enqueue(new TextEncoder().encode('first')); stream.enqueue(new TextEncoder().encode('second')); stream.close();
    expect(await consuming).toBe('firstsecond');
    lifetime.abort(); expect(request.signal.aborted).toBe(true);
  }
  expect(() => callback({ request: new Request('https://unexpected.test'), kind: 'primary' })).toThrow('destination');
});

test('envelope rejects missing, oversized, malformed and ambiguous header maps', () => {
  const invalid = [null, '', '!base64', 'a'.repeat(MAX_MODEL_HEADERS + 1), btoa('{}'), btoa('null'), btoa('no json'),
    ...[[['Bad-Name', 'x']], [['bad name', 'x']], [['x', 'line\r\nbreak']], [['x', 1]], [['x', 'a'], ['x', 'b']],
      [[MODEL_HEADERS, 'recursive']], Array.from({ length: 65 }, (_, i) => ['x-' + i, 'v'])].map(value => btoa(JSON.stringify(value)))];
  for (const value of invalid) expect(() => decodeModelHeaders(value)).toThrow();
  expect(() => encodeModelHeaders(new Headers({ huge: 'x'.repeat(MAX_MODEL_HEADERS) }))).toThrow('limit');
});

test('host rejects invalid envelopes before contacting provider', async () => {
  const handler = createBrowserEditorHandler({ preparedDirectory: '.', runtimeDirectory: '.', providers: { opencode: { baseURL: 'http://unreachable.invalid' } } });
  for (const value of [undefined, 'bad', 'x'.repeat(MAX_MODEL_HEADERS + 1)]) {
    expect((await handler.fetch(new Request('http://host/editor/model/opencode/responses', { headers: value ? { [MODEL_HEADERS]: value } : {} })))?.status).toBe(400);
  }
});

test('runtime egress policy preserves the envelope on host and same-origin routes', async () => {
  const policy = await import(join(import.meta.dir, '../../vendor/vivari/packages/runtime/egress-header-policy.js'));
  const headers = { [MODEL_HEADERS]: encodeModelHeaders(new Headers({ authorization: 'Bearer native' })) };
  for (const url of ['http://host.vivari.internal:3000/editor/model/opencode/responses', 'http://localhost:3000/editor/model/opencode/responses']) {
    expect(policy.egressHeaders(url, headers, 'http://localhost:3000')).toEqual(headers);
  }
});

test.skipIf(!process.env.OPENCODE_PACKAGE_DIR || !process.env.NODE_BINARY)('qualified 2.0.3 guest loads public plugin and dispatches native enveloped HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'editor-model-probe-'));
  const received: { headers: Headers; path: string; body: string }[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    received.push({ headers: request.headers, path: new URL(request.url).pathname, body: await request.text() });
    return Response.json({ error: { message: 'Qualification complete', type: 'invalid_request_error' } }, { status: 400 });
  } });
  try {
    // Loopback addresses refer to guest services; the headless adapter has no browser host alias.
    const host = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
    if (!host) throw Error('Qualification requires a host IPv4 address for runtime egress');
    const base = `http://${host}:${server.port}/editor/model/opencode/`;
    const config = createOpenCodeCandidateConfig(base);
    await Bun.write(join(directory, 'input.json'), JSON.stringify({ directory, application: process.env.OPENCODE_PACKAGE_DIR,
      receiptSha256: openCodeCandidateLaunch.receiptSha256, config, model: openCodeCandidateLaunch.model, plugin: modelHeaderPluginSource(base) }));
    const child = Bun.spawn([process.env.NODE_BINARY!, join(import.meta.dir, '../scripts/model-transport-probe.mjs'), join(directory, 'input.json')], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stdout, stderr }).toMatchObject({ exit: 0 });
    if (!received.length) console.log(stdout, stderr);
    expect(received.length).toBeGreaterThan(0);
    for (const request of received) {
      expect(request.path.startsWith('/editor/model/opencode/')).toBe(true);
      expect(request.headers.has('authorization')).toBe(false);
      const native = decodeModelHeaders(request.headers.get(MODEL_HEADERS));
      expect(native.has('authorization')).toBe(true);
      expect(native.get('content-type')).toContain('application/json');
      expect(JSON.parse(request.body)).toBeObject();
    }
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 90000);
