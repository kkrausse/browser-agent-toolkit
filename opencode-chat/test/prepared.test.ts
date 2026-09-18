import { expect, spyOn, test } from 'bun:test';
import type { ToolContext } from '@kev-browser-agent-kit/workspace';
import { preparedApps, type PreparedManifest } from '../src/prepared';
import { sha256 } from '../src/prepare-tree';

test('OpenCode preparation delegates managed replacement and retains only its runtime marker', async () => {
  const bytes = new TextEncoder().encode('verified dependency'), hash = sha256(bytes);
  const compressed = Bun.gzipSync(bytes), bundleHash = sha256(compressed);
  const manifest = { runtimeVersion: 'test', dependencies: { backendArchives: [] }, assets: [
    { kind: 'directory', destination: '/workspace/node_modules', mode: 0o755 },
    { kind: 'file', destination: '/workspace/node_modules/file', mode: 0o640, file: hash + '.bin', sha256: hash, bytes: bytes.length },
  ], bundle: { file: bundleHash + '.bundle.gz', sha256: bundleHash, bytes: compressed.length } } as PreparedManifest;
  const installed = new Map<string, Uint8Array>();
  const context = {
    async installTree(tree: Parameters<ToolContext['installTree']>[0]) {
      expect(tree.roots).toContain('/workspace/node_modules');
      for (const entry of tree.entries) if (entry.kind === 'file') installed.set(entry.path, entry.bytes);
      return { files: 1, verifyMs: 1, installMs: 1, readbackMs: 0 };
    },
    async installFile(path: string, value: Uint8Array) { installed.set(path, value); },
  } as ToolContext;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(compressed));
  try {
    const install = await preparedApps(manifest, '/prepared/', new AbortController().signal, () => {}).bind(context);
    await install();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(installed.get('/workspace/node_modules/file')).toEqual(bytes);
    expect(new TextDecoder().decode(installed.get('/runtime-probe/.browser-editor'))).toContain('opencode-server-process');
    fetch.mockImplementation(async () => new Response('corrupt'));
    await expect(install()).rejects.toThrow('integrity failure');
    const legacy = { ...manifest, bundle: undefined };
    expect(() => preparedApps(legacy, '/prepared/', new AbortController().signal, () => {})).toThrow('managed bundle is required');
  } finally { fetch.mockRestore(); }
});
