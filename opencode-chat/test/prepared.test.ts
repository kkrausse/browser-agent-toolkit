import { expect, spyOn, test } from 'bun:test';
import type { ToolContext } from '@kev-browser-agent-kit/workspace';
import type { DiagnosticScope } from '@kev-browser-agent-kit/workspace/diagnostics';
import { preparedApps, type PreparedManifest } from '../src/prepared';
import { sha256 } from '../src/prepare-tree';
import { treeRoots } from '../src/package-tree';

const fetchFixture = (body: Uint8Array | string): typeof fetch => Object.assign(async () => new Response(typeof body === 'string' ? body : Uint8Array.from(body)), { preconnect: globalThis.fetch.preconnect });

test('OpenCode preparation delegates managed replacement and retains only its runtime marker', async () => {
  const bytes = new TextEncoder().encode('verified dependency'), hash = sha256(bytes);
  const compressed = Bun.gzipSync(bytes), bundleHash = sha256(compressed);
  const manifest = { runtimeVersion: 'test', dependencies: { backendArchives: [] }, assets: [
    { kind: 'directory', destination: '/workspace/node_modules', mode: 0o755 },
    { kind: 'file', destination: '/workspace/node_modules/file', mode: 0o640, file: hash + '.bin', sha256: hash, bytes: bytes.length },
  ], bundle: { file: bundleHash + '.bundle.gz', sha256: bundleHash, bytes: compressed.length } } as unknown as PreparedManifest;
  const installed = new Map<string, Uint8Array>();
  const context = {
    async installTree(tree: Parameters<ToolContext['installTree']>[0]) {
      expect(tree.roots).toContain('/workspace/node_modules');
      for (const entry of tree.entries) if (entry.kind === 'file') installed.set(entry.path, entry.bytes);
      return { files: 1, verifyMs: 1, installMs: 1, readbackMs: 0 };
    },
    async installFile(path: string, value: Uint8Array) { installed.set(path, value); },
  } as ToolContext;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(fetchFixture(compressed));
  try {
    const install = await preparedApps(manifest, '/prepared/', new AbortController().signal, () => {}).bind(context);
    await install();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(installed.get('/workspace/node_modules/file')).toEqual(bytes);
    expect(new TextDecoder().decode(installed.get('/runtime-probe/.browser-editor'))).toContain('opencode-server-process');
    fetch.mockImplementation(fetchFixture('corrupt'));
    await expect(install()).rejects.toThrow('integrity failure');
    const legacy = { ...manifest, bundle: undefined };
    expect(() => preparedApps(legacy, '/prepared/', new AbortController().signal, () => {})).toThrow('managed bundle is required');
  } finally { fetch.mockRestore(); }
});

test('prepared installed cache preservation is explicit, audited and forwards cancellation', async () => {
  const manifest = { runtimeVersion: 'fixture', dependencies: { backendArchives: [] }, assets: [
    { kind: 'directory', destination: '/workspace/node_modules', mode: 0o755 },
  ], bundle: { file: 'fixture.bundle.gz', sha256: 'bundle', bytes: 1 } } as unknown as PreparedManifest;
  const policy = { paths: ['/workspace/node_modules/.vite', '/workspace/node_modules/.vite-temp', '/workspace/.browser-editor-cache/vite'] };
  const controller = new AbortController();
  expect(() => preparedApps(manifest, '/prepared/', controller.signal, () => {}, undefined, { experimentalPreserveInstalledCaches: { servicesStopped: true, policy } })).toThrow('explicit installed reuse');
  const key = sha256(new TextEncoder().encode(JSON.stringify([1, manifest.runtimeVersion, manifest.bundle!.sha256, null, treeRoots, manifest.assets])));
  const scripts: string[] = [], results: Record<string, unknown>[] = [];
  let stops = 0;
  const context: ToolContext = {
    readFile: async () => new TextEncoder().encode(key),
    installTree: async () => { throw Error('reuse must not install') },
    installFile: async (path, bytes) => { if (path.endsWith('.cjs')) scripts.push(new TextDecoder().decode(bytes)) },
    node: async options => {
      expect(options.signal).toBeDefined(); expect(options.signal!.aborted).toBe(false);
      return { stdout: (async function* () { yield new TextEncoder().encode(JSON.stringify({ valid: true, checked: 1, inventory: [], cacheDigest: 'a'.repeat(64), cacheBytes: 0 })) })(),
        stderr: (async function* () {})(), exited: Promise.resolve({ exitCode: 0, signal: null, forced: false }),
        closeStdin() {}, writeStdin() {}, stop: async () => { stops++ } };
    },
  };
  const diagnostics: DiagnosticScope = { runId: 'fixture', enabled: true, record: (_name, result) => { results.push(result as Record<string, unknown>) }, stage: async (_name, run) => run() };
  const install = await preparedApps(manifest, '/prepared/', controller.signal, () => {}, diagnostics, {
    experimentalReuseInstalled: true, experimentalPreserveInstalledCaches: { servicesStopped: true, policy },
  }).bind(context);
  await install();
  expect(stops).toBe(1); expect(scripts).toHaveLength(1);
  expect(scripts[0]).toContain('cacheDigest'); expect(scripts[0]).not.toContain('rmSync');
  expect(results.some(result => result.reused === true && !!result.audit)).toBe(true);
  controller.abort(Error('consumer canceled'));
  await expect(install()).rejects.toThrow('consumer canceled'); expect(stops).toBe(1);
  const ordinary = await preparedApps(manifest, '/prepared/', new AbortController().signal, () => {}, undefined, { experimentalReuseInstalled: true }).bind(context);
  await ordinary();
  expect(scripts[1]).toContain('rmSync'); expect(scripts[1]).not.toContain('cacheDigest');
});
