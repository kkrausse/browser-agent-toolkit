import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareOpenCodeRipgrep } from '../src/prepare';
import { readQualifiedOpenCodeApplication } from '../src/opencode-application';
import { openCodeCandidateLaunch, createOpenCodeCandidateConfig } from '../src/opencode-launch';
import { validatePreparedOpenCode, type PreparedManifest } from '../src/prepared';
import { validateTree } from '../src/package-tree';
import { verifyOpenCodeReady } from '../src/browser';
import { sourcePaths, type SourceWorkspace } from '../src/editor-source';

test('ordinary ripgrep install captures pinned bytes, relative executable links and modes', async () => {
  const output = await mkdtemp(join(tmpdir(), 'editor-ripgrep-test-'));
  try {
    const support = await prepareOpenCodeRipgrep(output);
    validateTree([{ kind: 'directory', destination: '/app', mode: 0o755 }, ...support.assets]);
    const files = support.assets.filter(entry => entry.kind === 'file');
    expect(files).toHaveLength(9);
    expect(support.assets.find(entry => entry.destination === '/app/node_modules/.bin/rg')).toEqual({
      kind: 'symlink', destination: '/app/node_modules/.bin/rg', target: '../ripgrep/lib/rg.mjs',
    });
    const executable = files.find(entry => entry.destination.endsWith('/ripgrep/lib/rg.mjs'))!;
    expect(executable.mode & 0o111).toBe(0o111);
    // Independent identity from the nine-file qualification, not installation output.
    expect(executable.sha256).toBe('df012098713f29496b23959450821d441cd3cc1d99db4f646c78c69d10341752');
    expect((await readFile(join(output, executable.file))).byteLength).toBe(417);
    expect(JSON.parse(support.provenance.lock).packages.ripgrep).toContain(support.provenance.integrity);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test.skipIf(!process.env.OPENCODE_PACKAGE_DIR)('real retained candidate survives V2 provenance delivery; tampering is rejected', async () => {
  const output = await mkdtemp(join(tmpdir(), 'editor-candidate-test-'));
  try {
    const candidate = await readQualifiedOpenCodeApplication(process.env.OPENCODE_PACKAGE_DIR!);
    const support = await prepareOpenCodeRipgrep(output);
    const manifest: Pick<PreparedManifest, 'opencode' | 'assets'> = {
      opencode: { ...candidate.provenance, format: openCodeCandidateLaunch.format, receipt: candidate.receiptBytes.toString('utf8'), support: support.provenance },
      assets: [...candidate.assets.map(asset => ({ kind: 'file' as const, destination: asset.destination, bytes: asset.length, sha256: asset.sha256, mode: 0o644, file: asset.sha256 + '.bin' })), ...support.assets],
    };
    await validatePreparedOpenCode(manifest);
    const tampered = structuredClone(manifest);
    const server = tampered.assets.find(entry => entry.destination === '/app/server.js');
    if (server?.kind !== 'file') throw Error('Missing server fixture');
    server.sha256 = '0'.repeat(64);
    await expect(validatePreparedOpenCode(tampered)).rejects.toThrow('output mismatch');
    const wrongReceipt = structuredClone(manifest);
    wrongReceipt.opencode.receipt += '\n';
    await expect(validatePreparedOpenCode(wrongReceipt)).rejects.toThrow('receipt mismatch');
    const noLink = structuredClone(manifest);
    noLink.assets = noLink.assets.filter(entry => entry.destination !== '/app/node_modules/.bin/rg');
    await expect(validatePreparedOpenCode(noLink)).rejects.toThrow('link missing');
  } finally { await rm(output, { recursive: true, force: true }); }
});

function endpointFixture(change: 'none' | 'activation' | 'plugin' | 'javascript' | 'config' | 'model' | 'disabled' | 'missing-model' = 'none', selectedModel?: string, selection: 'decoded' | 'shorthand' | 'wrong-provider' = 'decoded') {
  const calls: { path: string; method: string; authorization: string | null }[] = [];
  const config = createOpenCodeCandidateConfig('http://host.vivari.internal:4390/editor/model/opencode/');
  if (selectedModel) {
    config.model = `opencode/${selectedModel}`;
    config.providers.opencode.models = { [selectedModel]: config.providers.opencode.models[openCodeCandidateLaunch.model.id]! };
  }
  const endpoint = { async fetch(path: string | URL | Request, init?: RequestInit) {
    const name = String(path);
    calls.push({ path: name, method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
    if (name === openCodeCandidateLaunch.activation.path) return new Response('', { status: change === 'activation' ? 503 : 200 });
    if (name === openCodeCandidateLaunch.pluginPath) return Response.json({ data: change === 'plugin' ? [] : [
      { id: 'editor.model-headers', state: { status: 'active' } },
      { id: 'editor.javascript', state: { status: change === 'javascript' ? 'error' : 'active' } },
    ] });
    if (name === openCodeCandidateLaunch.configAPIPath) return Response.json(change === 'config' ? [] : [{ type: 'document', path: openCodeCandidateLaunch.configPath, info: {
      ...config,
      model: selection === 'shorthand' ? config.model : { providerID: selection === 'wrong-provider' ? 'other' : 'opencode', model: selectedModel ?? openCodeCandidateLaunch.model.id },
    } }]);
    if (name === openCodeCandidateLaunch.modelPath) return Response.json({ data: change === 'missing-model' ? [] : [{ ...openCodeCandidateLaunch.model, id: selectedModel ?? openCodeCandidateLaunch.model.id, enabled: change !== 'disabled', capabilities: { tools: change !== 'model' } }] });
    return Response.json({ healthy: true });
  } };
  return { endpoint, calls };
}

test('chat readiness awaits authenticated activation and validates global config and tool-capable catalog', async () => {
  const { endpoint, calls } = endpointFixture();
  const authorization = 'Basic ' + btoa('opencode:' + crypto.randomUUID());
  await verifyOpenCodeReady(endpoint, authorization, new AbortController().signal);
  expect(calls.map(call => call.path)).toEqual([openCodeCandidateLaunch.healthPath, openCodeCandidateLaunch.activation.path, openCodeCandidateLaunch.pluginPath, openCodeCandidateLaunch.configAPIPath, openCodeCandidateLaunch.modelPath]);
  expect(calls[1].method).toBe('POST');
  expect(calls.every(call => call.authorization === authorization)).toBe(true);
  for (const failure of ['activation', 'plugin', 'javascript', 'config', 'model'] as const) {
    await expect(verifyOpenCodeReady(endpointFixture(failure).endpoint, authorization, new AbortController().signal)).rejects.toThrow();
  }
});

test('readiness accepts a configured default without the toolkit fallback in the catalog', async () => {
  await verifyOpenCodeReady(endpointFixture('none', 'deepseek-v4.1-flash').endpoint, 'Basic test', new AbortController().signal);
  for (const failure of ['model', 'disabled', 'missing-model'] as const)
    await expect(verifyOpenCodeReady(endpointFixture(failure, 'deepseek-v4.1-flash').endpoint, 'Basic test', new AbortController().signal)).rejects.toThrow('not enabled with tools');
});

test('readiness accepts legacy shorthand but rejects a decoded model from another provider', async () => {
  await verifyOpenCodeReady(endpointFixture('none', 'deepseek-v4.1-flash', 'shorthand').endpoint, 'Basic test', new AbortController().signal);
  await expect(verifyOpenCodeReady(endpointFixture('none', 'deepseek-v4.1-flash', 'wrong-provider').endpoint, 'Basic test', new AbortController().signal)).rejects.toThrow('global model configuration not loaded');
});

test('health readiness recovers from fetch failure, request timeout and non-OK response', async () => {
  const fixture = endpointFixture();
  let attempts = 0;
  let timedOut: AbortSignal | undefined;
  const endpoint = { async fetch(path: string, init?: RequestInit) {
    if (path === openCodeCandidateLaunch.healthPath) {
      attempts++;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      if (attempts === 2) {
        timedOut = init!.signal!;
        return await new Promise<Response>((_resolve, reject) => {
          timedOut!.addEventListener('abort', () => reject(new TypeError('Failed to fetch')), { once: true });
        });
      }
      if (attempts === 3) return new Response('', { status: 503 });
    }
    return fixture.endpoint.fetch(path, init);
  } };
  await verifyOpenCodeReady(endpoint, 'Basic test', new AbortController().signal);
  expect(attempts).toBe(4);
  expect(timedOut?.aborted).toBe(true);
  expect(fixture.calls.at(-1)?.path).toBe(openCodeCandidateLaunch.modelPath);
});

test('health readiness stops retrying at its overall deadline', async () => {
  let attempts = 0;
  let aborted = 0;
  const started = Date.now();
  const endpoint = { fetch(_path: string, init?: RequestInit) {
    attempts++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted++; reject(new TypeError('Failed to fetch')); }, { once: true });
    });
  } };
  await expect(verifyOpenCodeReady(endpoint, 'Basic test', new AbortController().signal)).rejects.toThrow('health readiness timed out');
  expect(Date.now() - started).toBeLessThan(31500);
  expect(attempts).toBeGreaterThan(1);
  expect(aborted).toBe(attempts);
}, 35000);

test('readiness cancellation aborts an in-flight response body', async () => {
  const lifetime = new AbortController();
  let requestSignal: AbortSignal | undefined;
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const endpoint = { async fetch(_path: string, init?: RequestInit) {
    requestSignal = init!.signal!;
    return new Response(new ReadableStream({
      start(controller) {
        requestSignal!.addEventListener('abort', () => controller.error(requestSignal!.reason), { once: true });
        reading();
      },
    }));
  } };
  const result = verifyOpenCodeReady(endpoint, 'Basic test', lifetime.signal);
  const outcome = result.then(() => 'resolved', () => 'rejected');
  await started;
  lifetime.abort();
  expect(await outcome).toBe('rejected');
  expect(requestSignal?.aborted).toBe(true);
});

test('readiness cancellation during health backoff prevents subsequent requests', async () => {
  const lifetime = new AbortController();
  let requests = 0;
  let drained!: () => void;
  const consumed = new Promise<void>(resolve => { drained = resolve; });
  const endpoint = { async fetch() {
    requests++;
    const response = new Response('', { status: 503 });
    const consume = response.arrayBuffer.bind(response);
    response.arrayBuffer = async () => { const bytes = await consume(); drained(); return bytes; };
    return response;
  } };
  const result = verifyOpenCodeReady(endpoint, 'Basic test', lifetime.signal);
  const outcome = result.then(() => 'resolved', () => 'rejected');
  await consumed;
  lifetime.abort();
  expect(await outcome).toBe('rejected');
  await new Promise(resolve => setTimeout(resolve, 130));
  expect(requests).toBe(1);
});

test('source scanning excludes server state and still discovers application files', async () => {
  const scanned: string[] = [];
  const workspace = { fs: {
    async readdir(path: string) { scanned.push(path); return path === '/' ? ['.server', 'node_modules', 'src'] : ['home.tsx']; },
    async stat(path: string) { return { isDirectory: path === '/src' }; },
  } } as unknown as SourceWorkspace;
  expect(await sourcePaths(workspace)).toEqual(['/src/home.tsx']);
  expect(scanned).toEqual(['/', '/src']);
});
