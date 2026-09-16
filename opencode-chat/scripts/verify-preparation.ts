/** Networked full-graph checkpoint; no OpenCode application or browser launch. */
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { strict as assert } from 'node:assert';
import { readRuntimeBackendPolicy } from '@kev-browser-agent-kit/workspace/assets';
import { prepareDependencies, parseLock } from '../src/prepare-dependencies';
import { captureTree, sha256 } from '../src/prepare-tree';
import { validateTree } from '../src/package-tree';

const appRoot = resolve(process.argv[2] ?? '../todo-app-demo');
const runtimeDirectory = resolve(process.argv[3] ?? '../workspace-api/dist/runtime');
const originals = await Promise.all(['package.json', 'bun.lock'].map(file => readFile(join(appRoot, file), 'utf8')));
const prepared = await prepareDependencies({ appRoot, source: ['src', 'vite.config.ts', 'react-router.config.ts', 'tsconfig.json'], policy: await readRuntimeBackendPolicy(runtimeDirectory) });
try {
  const { provenance } = prepared;
  assert.equal(provenance.original.manifest, originals[0]);
  assert.equal(provenance.original.lock, originals[1]);
  assert.equal(provenance.original.manifestSha256, sha256(originals[0]!));
  assert.equal(provenance.original.lockSha256, sha256(originals[1]!));
  const original = JSON.parse(originals[0]!), derived = JSON.parse(provenance.derived.manifest);
  for (const field of ['scripts', 'dependencies', 'devDependencies']) assert.deepEqual(derived[field], original[field]);
  assert.deepEqual(provenance.lockChanges.changed.sort(), ['@tailwindcss/oxide-wasm32-wasi', 'esbuild', 'lightningcss', 'rollup']);
  const oxide = '@tailwindcss/oxide-wasm32-wasi';
  const integrity = parseLock(originals[1]!).packages[oxide]!.find(value => typeof value === 'string' && value.startsWith('sha512-'));
  assert(parseLock(provenance.derived.lock).packages[oxide]!.includes(integrity));
  assert.equal(provenance.backendAssertions.length, 4);
  const tree = await captureTree(join(prepared.install, 'node_modules'), '/workspace/node_modules', async () => {});
  validateTree(tree);
  assert(tree.some(entry => entry.kind === 'symlink' && entry.destination === '/workspace/node_modules/.bin/vite'));
  assert(tree.some(entry => entry.kind === 'symlink' && entry.destination === '/workspace/node_modules/.bin/tsc'));
  for (const name of Object.keys({ ...original.dependencies, ...original.devDependencies })) {
    const delivered = JSON.parse(await readFile(join(prepared.install, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(delivered.name, name);
  }
  const toolkit = JSON.parse(await readFile(join(prepared.install, 'node_modules/@kev-browser-agent-kit/opencode-chat/package.json'), 'utf8'));
  assert(toolkit.exports['./editor']);
  assert.deepEqual(await Promise.all(['package.json', 'bun.lock'].map(file => readFile(join(appRoot, file), 'utf8'))), originals);
  const counts = { file: 0, directory: 0, symlink: 0 };
  for (const entry of tree) counts[entry.kind]++;
  console.log(JSON.stringify({ result: 'PASS', installer: provenance.installer, linker: provenance.linker, runtimeVersion: provenance.policy.runtimeVersion, originalManifest: provenance.original.manifestSha256, originalLock: provenance.original.lockSha256, derivedLock: provenance.derived.lockSha256, overrides: provenance.overrides, backends: provenance.backendAssertions, lockChanges: provenance.lockChanges, counts }, null, 2));
} finally { await prepared.cleanup(); }
