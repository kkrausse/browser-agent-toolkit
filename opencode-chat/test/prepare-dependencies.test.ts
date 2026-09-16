import { test, expect } from 'bun:test';
import { selectBackends, prepareDependencies, verifyBackendArchive, type BackendArchiveInput } from '../src/prepare-dependencies';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const policy = { runtimeVersion: 'test-runtime', sha256: 'test-policy', aliases: { esbuild: 'esbuild-wasm' } };
test('backend selection preserves locked versions and refuses version collapsing', () => {
  expect(selectBackends({ lockfileVersion: 1, packages: { esbuild: ['esbuild@0.28.2'] } }, policy).overrides).toEqual({ esbuild: 'npm:esbuild-wasm@0.28.2' });
  expect(() => selectBackends({ lockfileVersion: 1, packages: { esbuild: ['esbuild@0.28.2'], 'vite/esbuild': ['esbuild@0.25.12'] } }, policy)).toThrow('Multiple locked versions');
});

test('Oxide override is exact and requires original archive integrity', () => {
  const oxide = '@tailwindcss/oxide-wasm32-wasi';
  const lock = { lockfileVersion: 1, packages: { [oxide]: [oxide + '@4.3.3', '', {}, 'sha512-test'] } };
  expect(selectBackends(lock, policy).overrides[oxide]).toBe('https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.3.3.tgz');
  expect(() => selectBackends({ ...lock, packages: { [oxide]: [oxide + '@4.3.4', '', {}, 'sha512-test'] } }, policy)).toThrow('qualified only');
  expect(() => selectBackends({ ...lock, packages: { [oxide]: [oxide + '@4.3.3'] } }, policy)).toThrow('integrity');
});

const oxide = '@tailwindcss/oxide-wasm32-wasi';
const source = { repository: 'https://github.com/example/runtime-backend', revision: '1'.repeat(40), buildReceiptSha256: '2'.repeat(64) };
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sha512 = (bytes: Uint8Array) => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
async function makeArchive(directory: string, packageJson: object, files: Record<string, string> = {}) {
  const bytes = await new Bun.Archive({ 'package/package.json': JSON.stringify(packageJson), ...Object.fromEntries(Object.entries(files).map(([name, value]) => ['package/' + name, value])) }, { compress: 'gzip' }).bytes();
  const archivePath = join(directory, sha256(bytes) + '.tgz');
  await Bun.write(archivePath, bytes);
  return { bytes, archivePath, sha256: sha256(bytes), sha512: sha512(bytes) };
}

test('source archives verify both hashes, pinned provenance and package identity before staging', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'backend-archive-test-'));
  try {
    const archive = await makeArchive(temporary, { name: oxide, version: '4.3.3' }, { 'tailwindcss-oxide.wasm32-wasi.wasm': 'source-pinned-wasm' });
    const input: BackendArchiveInput = { override: oxide, packageName: oxide, version: '4.3.3', archivePath: archive.archivePath, sha256: archive.sha256, sha512: archive.sha512, source };
    const result = await verifyBackendArchive(input);
    expect(result.input.path).toBe(`.browser-editor-backends/${archive.sha256}.tgz`);
    expect(result.provenance.files.map(file => file.path).sort()).toEqual(['package.json', 'tailwindcss-oxide.wasm32-wasi.wasm']);
    expect(result.provenance).not.toHaveProperty('archivePath');
    await expect(verifyBackendArchive({ ...input, sha256: '0'.repeat(64) })).rejects.toThrow('integrity failure');
    await expect(verifyBackendArchive({ ...input, sha512: 'sha512-' + Buffer.alloc(64).toString('base64') })).rejects.toThrow('integrity failure');
    await expect(verifyBackendArchive({ ...input, version: '4.3.4' })).rejects.toThrow('identity mismatch');
    await expect(verifyBackendArchive({ ...input, source: { ...source, revision: 'main' } })).rejects.toThrow('source provenance');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('source override rejects absent selection, mismatched versions, duplicates and project conflicts before installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backend-selection-test-'));
  try {
    const archive = await makeArchive(root, { name: oxide, version: '4.3.3' });
    const input: BackendArchiveInput = { override: oxide, packageName: oxide, version: '4.3.3', archivePath: archive.archivePath, sha256: archive.sha256, sha512: archive.sha512, source };
    const options = { appRoot: root, source: [], policy, backendArchives: [input] };
    await Bun.write(join(root, 'package.json'), JSON.stringify({ private: true }));
    await Bun.write(join(root, 'bun.lock'), JSON.stringify({ lockfileVersion: 1, packages: {} }));
    await expect(prepareDependencies(options)).rejects.toThrow('not the selected backend');
    await Bun.write(join(root, 'bun.lock'), JSON.stringify({ lockfileVersion: 1, packages: { [oxide]: [oxide + '@4.3.3', '', {}, archive.sha512] } }));
    await expect(prepareDependencies({ ...options, backendArchives: [{ ...input, version: '4.3.4' }] })).rejects.toThrow('not the selected backend');
    await expect(prepareDependencies({ ...options, backendArchives: [input, input] })).rejects.toThrow('Duplicate');
    await Bun.write(join(root, 'package.json'), JSON.stringify({ private: true, overrides: { [oxide]: '4.3.3' } }));
    await expect(prepareDependencies(options)).rejects.toThrow('Project override conflicts');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ordinary Bun installs portable source archives and their transitive closure with a fresh frozen cache', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'backend-install-test-'));
  // Entirely local fixture registry: no Tailwind downloads, builds, or public network.
  const packages = new Map<string, { metadata: any; bytes: Uint8Array; integrity: string }>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (path.startsWith('archives/')) {
      const pkg = packages.get(path.slice('archives/'.length));
      return pkg ? new Response(pkg.bytes) : new Response('missing archive', { status: 404 });
    }
    const pkg = packages.get(path);
    return pkg ? Response.json({ name: path, 'dist-tags': { latest: pkg.metadata.version }, versions: { [pkg.metadata.version]: { ...pkg.metadata, dist: { tarball: `${server.url}archives/${encodeURIComponent(path)}`, integrity: pkg.integrity } } } }) : new Response('missing package', { status: 404 });
  } });
  try {
    for (const metadata of [
      { name: oxide, version: '4.3.3', main: 'index.js' },
      { name: 'fixture-closure-a', version: '1.0.0', main: 'index.js', dependencies: { 'fixture-closure-b': '1.0.0' }, peerDependencies: { 'fixture-closure-peer': '1.0.0' } },
      { name: 'fixture-closure-b', version: '1.0.0', main: 'index.js' },
      { name: 'fixture-closure-peer', version: '1.0.0', main: 'index.js' },
    ]) {
      const archive = await makeArchive(temporary, metadata, { 'index.js': 'module.exports = "fixture";' });
      packages.set(metadata.name, { metadata, bytes: archive.bytes, integrity: archive.sha512 });
    }
    const root = join(temporary, 'app');
    await mkdir(root);
    const manifest = JSON.stringify({ private: true, scripts: { check: 'echo original-script' }, dependencies: { [oxide]: '4.3.3' } }, null, 2) + '\n';
    await Bun.write(join(root, 'package.json'), manifest);
    await Bun.write(join(root, '.npmrc'), `registry=${server.url}\n`);
    // Seed the supported v1 text format; Bun generates all package entries itself.
    await Bun.write(join(root, 'bun.lock'), JSON.stringify({ lockfileVersion: 1, configVersion: 1, workspaces: { '': { dependencies: { [oxide]: '4.3.3' } } }, packages: {} }));
    const originalInstall = Bun.spawn([process.execPath, 'install', '--linker', 'isolated', '--cache-dir', join(temporary, 'original-cache')], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const diagnostics = Promise.all([new Response(originalInstall.stdout).text(), new Response(originalInstall.stderr).text()]);
    expect(await originalInstall.exited, (await diagnostics).join('\n')).toBe(0);
    const lock = await readFile(join(root, 'bun.lock'), 'utf8');
    const candidate = await makeArchive(temporary, { name: oxide, version: '4.3.3', main: 'index.js', cpu: ['wasm32'], dependencies: { 'fixture-closure-a': '1.0.0' } }, { 'index.js': 'module.exports = require("fixture-closure-a");', 'tailwindcss-oxide.wasm32-wasi.wasm': 'source-wasm-not-registry-bytes' });
    const input: BackendArchiveInput = { override: oxide, packageName: oxide, version: '4.3.3', archivePath: candidate.archivePath, sha256: candidate.sha256, sha512: candidate.sha512, source };
    const prepared = await prepareDependencies({ appRoot: root, source: ['.npmrc'], policy, backendArchives: [input] });
    try {
      expect(prepared.provenance.original.manifest).toBe(manifest);
      expect(prepared.provenance.original.lock).toBe(lock);
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest);
      expect(await readFile(join(root, 'bun.lock'), 'utf8')).toBe(lock);
      expect(prepared.provenance.overrides[oxide]).toBe(`file:.browser-editor-backends/${candidate.sha256}.tgz`);
      expect(prepared.provenance.derived.lock).toContain(candidate.sha512);
      expect(prepared.provenance.derived.lock).not.toContain(packages.get(oxide)!.integrity);
      expect(prepared.provenance.derived.lock).not.toContain(temporary);
      expect(prepared.archiveInputs).toHaveLength(1);
      expect(prepared.archiveInputs[0]!.bytes).toEqual(candidate.bytes);
      const delivered = prepared.provenance.backendArchives![0]!;
      expect(delivered.source).toEqual(source);
      expect(delivered.dependencyClosure.map(pkg => pkg.name).sort()).toEqual([oxide, 'fixture-closure-a', 'fixture-closure-b', 'fixture-closure-peer'].sort());
      expect(delivered.files).toHaveLength(3);
      // Reproduce from retained inputs at a different root and another empty cache.
      const relocated = join(temporary, 'relocated');
      await mkdir(relocated);
      await Bun.write(join(relocated, 'package.json'), prepared.provenance.derived.manifest);
      await Bun.write(join(relocated, 'bun.lock'), prepared.provenance.derived.lock);
      await Bun.write(join(relocated, '.npmrc'), `registry=${server.url}\n`);
      for (const archive of prepared.archiveInputs) await Bun.write(join(relocated, archive.path), archive.bytes);
      const reinstall = Bun.spawn([process.execPath, 'install', '--linker', 'isolated', '--frozen-lockfile', '--cache-dir', join(temporary, 'relocation-cache')], { cwd: relocated, stdout: 'pipe', stderr: 'pipe' });
      const logs = Promise.all([new Response(reinstall.stdout).text(), new Response(reinstall.stderr).text()]);
      expect(await reinstall.exited, (await logs).join('\n')).toBe(0);
      expect(await readFile(join(relocated, 'bun.lock'), 'utf8')).toBe(prepared.provenance.derived.lock);
      expect(await readFile(join(relocated, 'node_modules', oxide, 'tailwindcss-oxide.wasm32-wasi.wasm'), 'utf8')).toBe('source-wasm-not-registry-bytes');
    } finally { await prepared.cleanup(); }
    // Normal project lifecycle scripts are preserved and really execute. A
    // script-mutated installed WASM must fail the source-content assertion.
    const mutate = `const path='node_modules/${oxide}/tailwindcss-oxide.wasm32-wasi.wasm';if(await Bun.file(path).exists())await Bun.write(path,'changed-after-install')`;
    await Bun.write(join(root, 'package.json'), JSON.stringify({ ...JSON.parse(manifest), scripts: { postinstall: `bun -e ${JSON.stringify(mutate)}` } }));
    await expect(prepareDependencies({ appRoot: root, source: ['.npmrc'], policy, backendArchives: [input] })).rejects.toThrow('Installed backend archive content mismatch');
    const extra = `await Bun.write('node_modules/${oxide}/unreceipted.js','extra code')`;
    await Bun.write(join(root, 'package.json'), JSON.stringify({ ...JSON.parse(manifest), scripts: { postinstall: `bun -e ${JSON.stringify(extra)}` } }));
    await expect(prepareDependencies({ appRoot: root, source: ['.npmrc'], policy, backendArchives: [input] })).rejects.toThrow('Unexpected installed backend archive file');
  } finally { server.stop(true); await rm(temporary, { recursive: true, force: true }); }
}, 30000);
