import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { runtimeConfig } from '../vivari/scripts/runtime-source.mjs';
import { readRuntimeAssets, readRuntimeBackendPolicy } from '../workspace-api/src/assets';
import { readQualifiedOpenCodeApplication } from '../opencode-chat/src/opencode-application';

const root = resolve(import.meta.dir, '..');
const repository = 'https://github.com/kkrausse/browser-agent-toolkit';
const registry = 'https://npm.pkg.github.com';
const names = { workspace: '@kkrausse/browser-agent-workspace', runtime: '@kkrausse/browser-agent-runtime', chat: '@kkrausse/browser-agent-opencode-chat' };
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: bun scripts/release.ts <version> [--chat]\nBuild clean pinned source, stage and smoke-test tarballs in .release/<version>. Never publishes.\n--chat requires OPENCODE_PACKAGE_DIR containing the qualified prepared application.');
  process.exit(0);
}
const version = args.shift();
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?$/.test(version) || args.some(arg => arg !== '--chat')) throw Error('Expected an explicit version and optional --chat; see --help');
const chat = args.includes('--chat');
if (chat && !process.env.OPENCODE_PACKAGE_DIR) throw Error('--chat requires OPENCODE_PACKAGE_DIR');
async function run(command: string[], cwd = root, capture = false) {
  const child = Bun.spawn(command, { cwd, stdout: capture ? 'pipe' : 'inherit', stderr: 'inherit' });
  const output = capture ? await new Response(child.stdout).text() : '';
  if (await child.exited) throw Error(`Failed: ${command.join(' ')}`);
  return output.trim();
}
const git = (...args: string[]) => run(['git', ...args], root, true);
// Generated directories must be ignored; source inputs must all be committed.
if (await git('status', '--porcelain', '--untracked-files=all')) throw Error('Release requires clean committed toolkit source');
const commit = await git('rev-parse', 'HEAD');
const out = resolve(root, '.release', version);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await run(['bun', 'vivari/scripts/build-runtime.ts', '--release']);
await run(['bun', 'install', '--frozen-lockfile'], join(root, 'workspace-api'));
await run(['bun', 'run', 'build'], join(root, 'workspace-api'));
if (chat) {
  await run(['bun', 'install', '--force', '--linker', 'isolated', '--frozen-lockfile'], join(root, 'opencode-chat'));
  await run(['bun', 'run', 'build'], join(root, 'opencode-chat'));
}
const runtime = join(out, 'runtime');
await run(['bun', 'workspace-api/scripts/distribution.ts', runtime]);
const distribution = await readRuntimeAssets(runtime);
await readRuntimeBackendPolicy(runtime);
const receipt = JSON.parse(await readFile(join(root, 'vivari/.runtime/patched-build.json'), 'utf8'));
if (!receipt.release || receipt.source?.dirty || receipt.revision !== runtimeConfig.revision || receipt.assets.some((asset: any) => asset.retained)) throw Error('Expected clean pinned release runtime without retained assets');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function json(path: string, value: unknown) { await Bun.write(path, JSON.stringify(value, null, 2) + '\n'); }
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error(`Symlink in release: ${directory}/${entry.name}`);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
    else throw Error(`Unexpected release file: ${path}`);
  }
  return result.sort();
}
async function licenses(destination: string) {
  await cp(join(root, 'vivari/LICENSE.vivari'), join(destination, 'LICENSE.vivari'));
  await cp(join(root, 'vivari/LICENSE.sqlite-wasm'), join(destination, 'LICENSE.sqlite-wasm'));
  // The toolkit's own license must be supplied by its source owner.
  await cp(join(root, 'LICENSE'), join(destination, 'LICENSE'));
}
const provenance = { schema: 1, repository, commit, version, runtimeSource: runtimeConfig, runtimeVersion: distribution.version, toolchain: receipt.toolchain };
const stages: { key: string; directory: string; metadata: any }[] = [];
await licenses(runtime);
await Bun.write(join(runtime, 'README.md'), '# Browser Agent Runtime\n\nResolve `@kkrausse/browser-agent-runtime/distribution.json`, take its parent directory, and pass that directory to the workspace assets helpers. Serve/copy the validated distribution; do not import workers into the host process. See https://github.com/kkrausse/browser-agent-toolkit/blob/main/docs/RELEASING.md.\n');
stages.push({ key: 'runtime', directory: runtime, metadata: { name: names.runtime, type: 'module', license: 'MIT', exports: { './distribution.json': './distribution.json' } } });
for (const [key, source, name] of [ ['workspace', 'workspace-api/dist/lib', names.workspace], ...(chat ? [['chat', 'opencode-chat/dist', names.chat]] : []) ]) {
  const directory = join(out, key!);
  await cp(join(root, source!), directory, { recursive: true });
  const metadata = await Bun.file(join(directory, 'package.json')).json();
  metadata.name = name;
  metadata.license ??= 'MIT';
  await licenses(directory);
  if (key === 'chat') {
    delete metadata.peerDependencies?.['@kev-browser-agent-kit/workspace'];
    delete metadata.peerDependenciesMeta?.['@kev-browser-agent-kit/workspace'];
    metadata.dependencies = { ...metadata.dependencies, '@kev-browser-agent-kit/workspace': `npm:${names.workspace}@${version}` };
  }
  stages.push({ key: key!, directory, metadata });
}
const artifacts = [];
for (const { key, directory, metadata } of stages) {
  delete metadata.private;
  delete metadata.scripts;
  delete metadata.devDependencies;
  metadata.version = version;
  metadata.repository = { type: 'git', url: `${repository}.git` };
  metadata.publishConfig = { registry, access: 'public' };
  metadata.files = ['**/*', 'application/.runtime/**'];
  for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(metadata[group] ?? {})) {
      if (name === '@vivari/core' || /^(file:|link:|workspace:)/.test(String(spec))) throw Error(`Local dependency leaked into ${key}: ${name}=${spec}`);
    }
  }
  await json(join(directory, 'package.json'), metadata);
  await json(join(directory, 'BUILD-PROVENANCE.json'), provenance);
  const entries = await files(directory);
  for (const path of entries.filter(path => /\.(?:js|mjs|cjs|ts)$/.test(path))) {
    if (/(?:from\s*|import\s*\(|require\s*\()\s*['"]@vivari\/core(?:['"/])/.test(await readFile(path, 'utf8'))) throw Error(`Unbundled @vivari/core import: ${path}`);
  }
  const packed = JSON.parse(await run(['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', out], directory, true))[0];
  if (packed.size >= 256 * 1024 * 1024 || packed.unpackedSize >= 256 * 1024 * 1024) throw Error(`${key} exceeds 256 MiB packed/unpacked limit`);
  const archive = join(out, packed.filename);
  const unpack = join(out, 'smoke', key);
  await mkdir(unpack, { recursive: true });
  await run(['tar', '-xzf', archive, '-C', unpack]);
  const extracted = join(unpack, 'package');
  // Verify actual npm inclusion (not merely source/staging files), including hidden application assets.
  for (const path of entries) {
    const rel = relative(directory, path);
    if (sha256(await readFile(path)) !== sha256(await readFile(join(extracted, rel)))) throw Error(`Packed content mismatch: ${key}/${rel}`);
  }
  const checkExports = async (value: unknown): Promise<void> => {
    if (typeof value === 'string') { if (!value.startsWith('./') || !(await stat(resolve(extracted, value))).isFile()) throw Error(`Invalid export: ${value}`); }
    else if (value && typeof value === 'object') for (const child of Object.values(value)) await checkExports(child);
  };
  await checkExports(metadata.exports);
  if (key === 'runtime') { await readRuntimeAssets(extracted); await readRuntimeBackendPolicy(extracted); }
  if (key === 'chat') {
    await readQualifiedOpenCodeApplication(join(extracted, 'application'));
    for (const entry of ['index.js', 'react.js', 'editor.js', 'recipe.js']) {
      const built = await Bun.build({ entrypoints: [join(extracted, entry)], target: 'browser', external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/*', '@kev-browser-agent-kit/workspace', '@kev-browser-agent-kit/workspace/*'] });
      if (!built.success) throw new AggregateError(built.logs, `Packed chat smoke failed: ${entry}`);
    }
  }
  if (key === 'workspace') {
    const assets = await import(join(extracted, 'assets.js'));
    await assets.readRuntimeAssets(join(out, 'smoke/runtime/package'));
    await assets.readRuntimeBackendPolicy(join(out, 'smoke/runtime/package'));
    for (const entry of ['index.js', 'react.js']) {
      const built = await Bun.build({ entrypoints: [join(extracted, entry)], target: 'browser', external: ['react', 'react/jsx-runtime'] });
      if (!built.success) throw new AggregateError(built.logs, `Packed workspace smoke failed: ${entry}`);
    }
  }
  artifacts.push({ name: metadata.name, filename: packed.filename, size: packed.size, unpackedSize: packed.unpackedSize, integrity: packed.integrity, sha256: sha256(await readFile(archive)) });
}
if (await git('status', '--porcelain', '--untracked-files=all') || await git('rev-parse', 'HEAD') !== commit) throw Error('Toolkit source changed during release');
await json(join(out, 'release.json'), { ...provenance, artifacts });
console.log(JSON.stringify({ output: out, artifacts }, null, 2));
