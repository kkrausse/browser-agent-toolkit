import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readRuntimeBackendPolicy, copyRuntimeAssets } from '../src/assets';

test('delivered backend policy must match the consumed runtime source receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backend-policy-test-'));
  const source = join(root, 'source'), destination = join(root, 'copy');
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const policy = 'export const NATIVE_WASM_ALIASES = { esbuild: "esbuild-wasm" };';
  try {
    await mkdir(join(source, 'assets'), { recursive: true });
    await writeFile(join(source, 'assets/worker.js'), 'worker');
    await writeFile(join(source, 'assets/sw.js'), 'sw');
    await writeFile(join(source, 'backend-policy.mjs'), policy);
    await writeFile(join(source, 'distribution.json'), JSON.stringify({ abi: 'workspace-v2-sab6-sqlite39', features: ['install-tree-v1', 'http-stream-v1', 'workspace-flush-v1'], name: 'vivari', version: 'a'.repeat(64), kernelWorker: 'assets/worker.js', serviceWorker: 'assets/sw.js', kernelSha256: hash('worker'), runtimeBuild: { source: { files: [{ name: 'packages/runtime/toolchain-shims.js', sha256: hash(policy) }] } } }));
    const expected = { runtimeVersion: 'a'.repeat(64), sha256: hash(policy), aliases: { esbuild: 'esbuild-wasm' } };
    expect(await readRuntimeBackendPolicy(source)).toEqual(expected);
    await copyRuntimeAssets({ source, destination });
    expect(await readRuntimeBackendPolicy(destination)).toEqual(expected);
    await writeFile(join(source, 'backend-policy.mjs'), policy.replace('esbuild-wasm', 'other-backend'));
    await expect(readRuntimeBackendPolicy(source)).rejects.toThrow('hash mismatch');
  } finally { await rm(root, { recursive: true, force: true }); }
});
