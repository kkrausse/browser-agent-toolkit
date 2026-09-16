import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cacheMatches, fileManifest, fingerprint, treeFiles } from './runtime-fingerprint.mjs';
import { integrationRoot, resolveRuntimeSource, runtimeSourcePath, runtimeSourceUrl } from './runtime-source.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'vivari-build-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test('resolver defaults to sibling fork, supports cwd-relative overrides and file URLs', () => {
  const previous = process.env.VIVARI_SOURCE;
  try {
    delete process.env.VIVARI_SOURCE;
    expect(resolveRuntimeSource()).toBe(resolve(integrationRoot, '../../vivari'));
    process.env.VIVARI_SOURCE = 'a fork/#source';
    expect(runtimeSourcePath('packages', 'core')).toBe(resolve('a fork/#source/packages/core'));
    expect(runtimeSourceUrl('packages', 'core').href).toContain('a%20fork/%23source/packages/core');
  } finally {
    if (previous === undefined) delete process.env.VIVARI_SOURCE;
    else process.env.VIVARI_SOURCE = previous;
  }
});

test('native cache invalidates source/toolchain edits and missing, extra or tampered outputs', () => {
  const root = join(scratch, 'native');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'pkg'));
  writeFileSync(join(root, 'src/lib.rs'), 'original');
  writeFileSync(join(root, 'pkg/core.wasm'), 'wasm');
  const inputs = { toolchain: 'rust-a', files: fileManifest(root, treeFiles(root, 'src')) };
  const outputs = fileManifest(root, treeFiles(root, 'pkg'));
  const cache = { fingerprint: fingerprint(inputs), outputs };
  expect(cacheMatches(cache, inputs, outputs)).toBe(true);
  expect(cacheMatches(cache, { ...inputs, toolchain: 'rust-b' }, outputs)).toBe(false);
  writeFileSync(join(root, 'src/lib.rs'), 'edited');
  expect(cacheMatches(cache, { ...inputs, files: fileManifest(root, treeFiles(root, 'src')) }, outputs)).toBe(false);
  writeFileSync(join(root, 'pkg/core.wasm'), 'tampered');
  expect(cacheMatches(cache, inputs, fileManifest(root, treeFiles(root, 'pkg')))).toBe(false);
  writeFileSync(join(root, 'pkg/core.wasm'), 'wasm');
  writeFileSync(join(root, 'pkg/extra.js'), 'extra');
  expect(cacheMatches(cache, inputs, fileManifest(root, treeFiles(root, 'pkg')))).toBe(false);
  rmSync(join(root, 'pkg/core.wasm'));
  expect(cacheMatches(cache, inputs, fileManifest(root, ['pkg/core.wasm']))).toBe(false);
  expect(cacheMatches(cache, inputs, [])).toBe(false);
});

test('--release rejects untracked source before installing or building', () => {
  const cwd = join(scratch, 'dirty-fork');
  mkdirSync(join(cwd, 'packages/core'), { recursive: true });
  writeFileSync(join(cwd, 'packages/core/package.json'), '{}');
  for (const args of [['init', '-q'], ['add', 'packages/core/package.json'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']]) {
    expect(Bun.spawnSync(['git', ...args], { cwd }).exitCode).toBe(0);
  }
  writeFileSync(join(cwd, 'bun.lock'), 'uncommitted lock');
  const result = Bun.spawnSync(['bun', join(integrationRoot, 'scripts/build-runtime.ts'), '--release'], { cwd, env: { ...process.env, VIVARI_SOURCE: cwd } });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('--release requires clean committed Vivari source');
  expect(result.stderr.toString()).toContain('bun.lock');
  expect(result.stdout.toString()).not.toContain('bun install');
});

test('--release rejects a clean checkout at the wrong recorded revision', () => {
  const cwd = join(scratch, 'wrong-pin');
  mkdirSync(join(cwd, 'packages/core'), { recursive: true });
  writeFileSync(join(cwd, 'packages/core/package.json'), '{}');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'first']]) {
    expect(Bun.spawnSync(['git', ...args], { cwd }).exitCode).toBe(0);
  }
  const first = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd }).stdout.toString().trim();
  writeFileSync(join(cwd, 'packages/core/package.json'), '{"name":"changed"}');
  expect(Bun.spawnSync(['git', 'add', '.'], { cwd }).exitCode).toBe(0);
  expect(Bun.spawnSync(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'second'], { cwd }).exitCode).toBe(0);
  const result = Bun.spawnSync(['bun', join(integrationRoot, 'scripts/build-runtime.ts'), '--release', '--revision', first], { cwd, env: { ...process.env, VIVARI_SOURCE: cwd } });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('Expected source revision');
  expect(result.stdout.toString()).not.toContain('bun install');
});
