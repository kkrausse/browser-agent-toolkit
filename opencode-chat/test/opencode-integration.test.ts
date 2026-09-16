import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareOpenCodeRipgrep } from '../src/prepare';
import { readQualifiedOpenCodeApplication } from '../src/opencode-application';
import { openCodeCandidateLaunch, createOpenCodeCandidateConfig } from '../src/opencode-launch';
import { validatePreparedOpenCode, type PreparedManifest } from '../src/prepared';
import { validateTree } from '../src/package-tree';
import { createBrowserEditorRecipe, verifyOpenCodeReady } from '../src/recipe';
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

function endpointFixture(change: 'none' | 'activation' | 'config' | 'model' = 'none') {
  const calls: { path: string; method: string; authorization: string | null }[] = [];
  const endpoint = { async fetch(path: string | URL | Request, init?: RequestInit) {
    const name = String(path);
    calls.push({ path: name, method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
    if (name === openCodeCandidateLaunch.activation.path) return new Response('', { status: change === 'activation' ? 503 : 200 });
    if (name === openCodeCandidateLaunch.configAPIPath) return Response.json(change === 'config' ? [] : [{ type: 'document', path: openCodeCandidateLaunch.configPath, info: createOpenCodeCandidateConfig('http://host.vivari.internal:4390/editor/model/') }]);
    if (name === openCodeCandidateLaunch.modelPath) return Response.json({ data: [{ ...openCodeCandidateLaunch.model, enabled: true, capabilities: { tools: change !== 'model' } }] });
    return Response.json({ healthy: true });
  } };
  return { endpoint, calls };
}

test('chat readiness awaits authenticated activation and validates global config and tool-capable catalog', async () => {
  const { endpoint, calls } = endpointFixture();
  const authorization = 'Basic ' + btoa('opencode:' + crypto.randomUUID());
  await verifyOpenCodeReady(endpoint, authorization, new AbortController().signal);
  expect(calls.map(call => call.path)).toEqual([openCodeCandidateLaunch.healthPath, openCodeCandidateLaunch.activation.path, openCodeCandidateLaunch.configAPIPath, openCodeCandidateLaunch.modelPath]);
  expect(calls[1].method).toBe('POST');
  expect(calls.every(call => call.authorization === authorization)).toBe(true);
  for (const failure of ['activation', 'config', 'model'] as const) {
    await expect(verifyOpenCodeReady(endpointFixture(failure).endpoint, authorization, new AbortController().signal)).rejects.toThrow();
  }
});

test('unqualified model options fail before starting workspace work', () => {
  expect(() => createBrowserEditorRecipe({ model: 'other/unqualified' })).toThrow('qualified');
  expect(() => createBrowserEditorRecipe({ model: 'opencode/muse-spark-1.3-contributor-free' })).not.toThrow();
});

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
