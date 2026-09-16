import { test, expect, spyOn } from 'bun:test';
import { preparedApps, type PreparedManifest } from '../src/prepared';
import { sha256 } from '../src/prepare-tree';
import type { ToolContext } from '@kev-browser-agent-kit/workspace';

test('guest delivery uses distinct immutable installer scripts and checks completion and file hashes', async () => {
  const bytes = new TextEncoder().encode('verified dependency'), hash = sha256(bytes);
  const manifest = { runtimeVersion: 'test', dependencies: { backendArchives: [] }, assets: [
    { kind: 'directory', destination: '/workspace/node_modules', mode: 0o755 },
    { kind: 'file', destination: '/workspace/node_modules/file', mode: 0o640, file: hash + '.bin', sha256: hash, bytes: bytes.length },
  ] } as PreparedManifest;
  const files = new Map<string, Uint8Array>(), launches: string[] = [];
  let complete = true;
  const context: ToolContext = {
    async installTree(tree) {
      expect(launches).toHaveLength(2);
      const entries = tree.entries.filter(e => e.kind === 'file');
      expect(entries).toHaveLength(2);
      const cloned = structuredClone(entries);
      expect(cloned[0]!.bytes.buffer).toBe(cloned[1]!.bytes.buffer);
      for (const e of entries) files.set(e.path, e.bytes);
      return { files: entries.length, verifyMs: 0, installMs: 0, readbackMs: 0 };
    },
    async installFile(path, value) {
      // Real worker postMessage clones the backing buffer, including invisible bytes.
      if (path === '/workspace/node_modules/file') expect(structuredClone(value).buffer.byteLength).toBe(value.byteLength);
      // Match the public API's immutable install semantics, including scripts.
      if (files.has(path) && sha256(files.get(path)!) !== sha256(value)) throw Error('Bundle conflict');
      files.set(path, value);
    },
    async readFile(path) { return files.get(path)!; },
    async node(options) {
      launches.push(options.entry);
      const phase = options.entry.includes('-reset-') ? 'reset' : 'metadata';
      async function* stdout() { yield new TextEncoder().encode(complete ? `prepared-tree-${phase}-complete` : 'early exit'); }
      async function* stderr() {}
      return { stdout: stdout(), stderr: stderr(), exited: Promise.resolve({ exitCode: 0, signal: null, forced: false }), writeStdin() {}, closeStdin() {}, async stop() {} };
    },
  };
  const response = (body: BodyInit) => Object.assign(async () => new Response(body), { preconnect() {} }) as typeof globalThis.fetch;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(response(bytes));
  try {
    const install = await preparedApps(manifest, '/prepared/', new AbortController().signal, () => {}).bind(context);
    await install();
    expect(launches).toHaveLength(2);
    expect(launches[0]).not.toBe(launches[1]);
    expect(files.get('/workspace/node_modules/file')).toEqual(bytes);
    const extra = new TextEncoder().encode('another file in the same bundle'), extraHash = sha256(extra);
    manifest.assets.push({ kind: 'file', destination: '/workspace/node_modules/extra', mode: 0o644, file: extraHash + '.bin', sha256: extraHash, bytes: extra.length });
    const compressed = Bun.gzipSync(new Uint8Array([...bytes, ...extra])), bundleHash = sha256(compressed);
    manifest.bundle = { file: bundleHash + '.bundle.gz', sha256: bundleHash, bytes: compressed.length };
    fetch.mockImplementation(response(compressed));
    fetch.mockClear();
    await install();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(files.get('/workspace/node_modules/file')).toEqual(bytes);
    expect(files.get('/workspace/node_modules/extra')).toEqual(extra);
    manifest.assets.pop();
    delete manifest.bundle;
    fetch.mockImplementation(response(bytes));
    complete = false;
    await expect(install()).rejects.toThrow('reset failed');
    complete = true;
    fetch.mockImplementation(response('corrupt'));
    await expect(install()).rejects.toThrow('integrity failure');
  } finally { fetch.mockRestore(); }
});
