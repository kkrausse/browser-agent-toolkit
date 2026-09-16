import { readdir, realpath, stat, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuntimeAssets, readRuntimeBackendPolicy } from '@kev-browser-agent-kit/workspace/assets';
import type { PreparedManifest } from './prepared';
import { prepareDependencies, type BackendArchiveInput } from './prepare-dependencies';
import { captureTree, sha256 as hash } from './prepare-tree';
import { validateTree, treeRoots } from './package-tree';
import { readQualifiedOpenCodeApplication } from './opencode-application';
import { openCodeCandidateLaunch } from './opencode-launch';
import { bundleFiles } from './prepared-bundle';
export { readTailwindWasmCandidate } from './tailwind-application';
export type { BackendArchiveInput } from './prepare-dependencies';

/** Shipped beside the compiled preparer, independent of the consumer's cwd. */
export const packagedOpenCodeDirectory = fileURLToPath(new URL('./application/', import.meta.url));

/** Ordinary registry installation, with the archive integrity retained by qualification. */
export async function prepareOpenCodeRipgrep(prepared: string, bun = process.execPath) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-editor-ripgrep-'));
  const manifest = JSON.stringify({ name: 'browser-editor-opencode-support', private: true, dependencies: { ripgrep: '0.3.1' } });
  const integrity = 'sha512-6bDtNIBh1qPviVIU685/4uv0Ap5t8eS4wiJhy/tR2LdIeIey9CVasENlGS+ul3HnTmGANIp7AjnfsztsRmALfQ==';
  const lock = JSON.stringify({ lockfileVersion: 1, workspaces: { '': { name: 'browser-editor-opencode-support', dependencies: { ripgrep: '0.3.1' } } },
    packages: { ripgrep: ['ripgrep@0.3.1', '', { bin: { rg: 'lib/rg.mjs', ripgrep: 'lib/rg.mjs' } }, integrity] } });
  try {
    await Bun.write(join(directory, 'package.json'), manifest);
    await Bun.write(join(directory, 'bun.lock'), lock);
    const child = Bun.spawn([bun, 'install', '--frozen-lockfile', '--linker', 'isolated', '--cache-dir', join(directory, 'cache')], { cwd: directory, stdout: 'inherit', stderr: 'inherit' });
    if (await child.exited) throw Error('Qualified ripgrep installation failed');
    if (await readFile(join(directory, 'bun.lock'), 'utf8') !== lock) throw Error('Frozen ripgrep lock changed');
    const pkg = JSON.parse(await readFile(join(directory, 'node_modules/ripgrep/package.json'), 'utf8'));
    if (pkg.name !== 'ripgrep' || pkg.version !== '0.3.1') throw Error('Qualified ripgrep package mismatch');
    const assets = await captureTree(join(directory, 'node_modules'), '/app/node_modules', async (file, bytes) => { await Bun.write(join(prepared, file), bytes); });
    const rg = assets.find(entry => entry.destination === '/app/node_modules/.bin/rg');
    if (rg?.kind !== 'symlink' || !((await stat(join(directory, 'node_modules/.bin/rg'))).mode & 0o111)) throw Error('Ripgrep executable metadata missing');
    return { assets, provenance: { name: 'ripgrep' as const, version: '0.3.1' as const, integrity, linker: 'isolated' as const,
      manifest, manifestSha256: hash(manifest), lock, lockSha256: hash(lock), binDirectory: '/app/node_modules/.bin' } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export interface PrepareBrowserEditorOptions {
  appRoot: string;
  output: string;
  runtimeDirectory: string;
  /** Optional qualified-build override; defaults to the application shipped in this package. */
  openCodeDirectory?: string;
  /** Explicit source delivery allowlist, relative to appRoot. Never includes server secrets. */
  source: string[];
  /** Host Bun executable; defaults to the Bun running this preparer. */
  bunExecutable?: string;
  /** Explicit source-built backend archives, verified separately from registry packages. */
  backendArchives?: BackendArchiveInput[];
}

/** Bun build-time preparation. Application source is unchanged; native bundlers use WASM. */
export async function prepareBrowserEditor(options: PrepareBrowserEditorOptions) {
  const root = resolve(options.appRoot), out = resolve(options.output);
  const runtime = await readRuntimeAssets(options.runtimeDirectory);
  const application = await readQualifiedOpenCodeApplication(options.openCodeDirectory ?? packagedOpenCodeDirectory);
  const policy = await readRuntimeBackendPolicy(options.runtimeDirectory);
  const dependencies = await prepareDependencies({ ...options, policy });
  try {
  const assets: PreparedManifest['assets'] = [];
  const prepared = join(out, 'prepared');
  async function add(destination: string, bytes: Uint8Array) {
    const sha256 = hash(bytes), file = sha256 + '.bin';
    await Bun.write(join(prepared, file), bytes);
    // The unchanged application is passed as data to /bin/bun.js.
    const parents: string[] = [];
    for (let parent = destination.slice(0, destination.lastIndexOf('/')); treeRoots.some(root => parent === root || parent.startsWith(root + '/')); parent = parent.slice(0, parent.lastIndexOf('/'))) parents.unshift(parent);
    for (const destination of parents) if (!assets.some(entry => entry.destination === destination)) assets.push({ kind: 'directory', destination, mode: 0o755 });
    assets.push({ kind: 'file', mode: 0o644, file, destination, sha256, bytes: bytes.length });
  }
  async function walk(directory: string, destination: string, visit: (path: string, destination: string) => Promise<void>, ancestors = new Set<string>()) {
    const canonical = await realpath(directory);
    if (ancestors.has(canonical)) throw Error('Cyclic source directory link');
    const next = new Set(ancestors).add(canonical);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', 'node_modules'].includes(entry.name)) continue;
      const path = await realpath(join(directory, entry.name));
      if (!path.startsWith(root + '/')) throw Error('Source symlink escapes application');
      if ((await stat(path)).isDirectory()) await walk(path, destination + '/' + entry.name, visit, next);
      else await visit(path, destination + '/' + entry.name);
    }
  }
  assets.push(...await captureTree(join(dependencies.install, 'node_modules'), '/workspace/node_modules', async (file, bytes) => { await Bun.write(join(prepared, file), bytes); }));
  for (const input of dependencies.archiveInputs) await add('/workspace/' + input.path, input.bytes);
  for (const asset of application.assets) await add(asset.destination, asset.bytes);
  await Bun.write(join(prepared, 'opencode-build-receipt.json'), application.receiptBytes);
  const support = await prepareOpenCodeRipgrep(prepared, options.bunExecutable);
  assets.push(...support.assets);
  const project: Record<string, string> = {};
  for (const name of options.source) {
    if (name.startsWith('/') || name.split('/').includes('..')) throw Error('Source must be app-relative');
    const path = join(root, name);
    const visit = async (file: string, destination: string) => { project[destination] = await Bun.file(file).text(); };
    if ((await stat(path)).isDirectory()) await walk(path, '/' + name, visit);
    else await visit(path, '/' + name);
  }
  project['/package.json'] = dependencies.provenance.original.manifest;
  project['/bun.lock'] = dependencies.provenance.original.lock;
  project['/.browser-editor/runtime-package.json'] = dependencies.provenance.derived.manifest;
  project['/.browser-editor/runtime-bun.lock'] = dependencies.provenance.derived.lock;
  validateTree(assets);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (const entry of bundleFiles(assets)) chunks.push(new Uint8Array(await readFile(join(prepared, entry.file))));
  const compressed = Bun.gzipSync(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  const bundleHash = hash(compressed), bundle = { file: bundleHash + '.bundle.gz', bytes: compressed.length, sha256: bundleHash };
  await Bun.write(join(prepared, bundle.file), compressed);
  const manifest: PreparedManifest = { format: 'browser-editor-v2', runtimeVersion: runtime.version, assets, project, dependencies: dependencies.provenance,
    bundle,
    opencode: { ...application.provenance, format: openCodeCandidateLaunch.format, receipt: application.receiptBytes.toString('utf8'), support: support.provenance },
    preview: { entry: '/workspace/node_modules/vite/bin/vite.js', args: ['--configLoader', 'native', '--host', '0.0.0.0', '--port', '5173', '--strictPort'], cwd: '/workspace', env: { BROWSER_AGENT_GUEST: '1', NODE_ENV: 'development' } } };
  await Bun.write(join(prepared, 'manifest.json'), JSON.stringify(manifest));
  console.log(`Prepared shared application and ${assets.length} verified dependency/runtime tree entries`);
  return manifest;
  } finally { await dependencies.cleanup(); }
}
