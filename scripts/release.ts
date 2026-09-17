import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { runtimeConfig, runtimeSourcePath } from '../vivari/scripts/runtime-source.mjs';
import { readRuntimeAssets, readRuntimeBackendPolicy } from '../workspace-api/src/assets';
import { readQualifiedOpenCodeApplication } from '../opencode-chat/src/opencode-application';

const root = resolve(import.meta.dir, '..');
const repository = 'https://github.com/kkrausse/browser-agent-toolkit';
const registry = 'https://npm.pkg.github.com';
const names = { workspace: '@kkrausse/browser-agent-workspace', runtime: '@kkrausse/browser-agent-runtime', chat: '@kkrausse/browser-agent-opencode-chat' };
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: bun scripts/release.ts <version> [--check-pack]\nBuild clean pinned source, stage and smoke-test all three packages in .release/<version>. Never publishes.\n--check-pack: inspect existing builds without rebuilding; writes non-publishable checks to .release/<version>-check.');
  process.exit(0);
}
const version = args.shift();
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?$/.test(version) || args.some(arg => arg !== '--check-pack')) throw Error('Expected an explicit version and optional --check-pack; see --help');
const checkPack = args.includes('--check-pack');
async function run(command: string[], cwd = root, capture = false) {
  const child = Bun.spawn(command, { cwd, stdout: capture ? 'pipe' : 'inherit', stderr: 'inherit' });
  const output = capture ? await new Response(child.stdout).text() : '';
  if (await child.exited) throw Error(`Failed: ${command.join(' ')}`);
  return output.trim();
}
const git = (...args: string[]) => run(['git', ...args], root, true);
// Generated directories must be ignored; source inputs must all be committed.
const sourceDirty = !!await git('status', '--porcelain', '--untracked-files=all');
if (!checkPack && sourceDirty) throw Error('Release requires clean committed toolkit source');
const commit = await git('rev-parse', 'HEAD');
const out = resolve(root, '.release', version + (checkPack ? '-check' : ''));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
if (!checkPack) {
  await run(['bun', 'vivari/scripts/build-runtime.ts', '--release']);
  await run(['bun', 'scripts/setup-opencode.ts']);
  await run(['bun', 'install', '--frozen-lockfile'], join(root, 'workspace-api'));
  await run(['bun', 'run', 'build'], join(root, 'workspace-api'));
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
}
const provenance = { schema: 1, repository, commit, sourceDirty, publishable: !checkPack, version, runtimeSource: runtimeConfig, runtimeVersion: distribution.version, toolchain: receipt.toolchain,
  openCodeInput: await Bun.file(join(root, 'vivari/opencode-input.json')).json() };
const stages: { key: string; directory: string; metadata: any }[] = [];
await licenses(runtime);
await Bun.write(join(runtime, 'README.md'), '# Browser Agent Runtime\n\nResolve `@kkrausse/browser-agent-runtime/distribution.json`, take its parent directory, and pass that directory to the workspace assets helpers. Serve/copy the validated distribution; do not import workers into the host process. See https://github.com/kkrausse/browser-agent-toolkit/blob/main/docs/RELEASING.md.\n');
stages.push({ key: 'runtime', directory: runtime, metadata: { name: names.runtime, type: 'module', license: 'SEE LICENSE IN LICENSES.md', exports: { './distribution.json': './distribution.json' } } });
await Bun.write(join(runtime, 'LICENSES.md'), '# Inherited runtime notices\n\nVivari is MIT licensed: see LICENSE.vivari (also assets/LICENSE.vivari.txt). SQLite-WASM includes Apache-2.0 package terms and public-domain SQLite: see LICENSE.sqlite-wasm (also assets/LICENSE.sqlite-wasm.txt). These notices retain upstream terms; no new umbrella license is granted by this distribution. See BUILD-PROVENANCE.json and distribution.json for source identities.\n');
for (const [key, source, name] of [ ['workspace', 'workspace-api/dist/lib', names.workspace], ['chat', 'opencode-chat/dist', names.chat] ]) {
  const directory = join(out, key!);
  await cp(join(root, source!), directory, { recursive: true });
  const metadata = await Bun.file(join(directory, 'package.json')).json();
  metadata.name = name;
  metadata.license ??= 'UNLICENSED';
  await licenses(directory);
  if (key === 'workspace') {
    // Runtime JS is bundled, but tsc preserves external re-exports. Deliver the
    // matching host declaration tree, without another runtime dependency.
    const source = runtimeSourcePath('packages/core/dist/host-sdk');
    const destination = join(directory, 'vivari-host');
    for (const path of (await files(source)).filter(path => path.endsWith('.d.ts'))) {
      const name = relative(runtimeSourcePath('packages/core/dist'), path).split('\\').join('/');
      const bytes = await readFile(path);
      if (receipt.assets.find((asset: any) => asset.name === name)?.sha256 !== sha256(bytes)) throw Error(`Host declaration differs from runtime receipt: ${name}`);
      await Bun.write(join(destination, relative(source, path)), bytes.toString().replace(/^\/\/# sourceMappingURL=.*$/gm, ''));
    }
    for (const path of (await files(directory)).filter(path => path.endsWith('.d.ts'))) {
      let specifier = relative(dirname(path), join(destination, 'index.js')).split('\\').join('/');
      if (!specifier.startsWith('.')) specifier = './' + specifier;
      const text = await readFile(path, 'utf8');
      await Bun.write(path, text.replace(/(['"])@vivari\/core\/host\1/g, JSON.stringify(specifier)));
    }
    // The React entry deliberately externalizes the development self-import.
    // A relative staged import works under both public names and consumer aliases.
    for (const path of (await files(directory)).filter(path => /\.(?:js|d\.ts)$/.test(path))) {
      let specifier = relative(dirname(path), join(directory, 'index.js')).split('\\').join('/');
      if (!specifier.startsWith('.')) specifier = './' + specifier;
      await Bun.write(path, (await readFile(path, 'utf8')).replace(/(['"])@kev-browser-agent-kit\/workspace\1/g, JSON.stringify(specifier)));
    }
    await Bun.write(join(directory, 'LICENSES.md'), '# Inherited notices\n\nThis workspace integration has no new umbrella license grant and is marked UNLICENSED. Bundled Vivari code and vendored vivari-host declarations retain the MIT terms in LICENSE.vivari. SQLite-WASM notices are retained in LICENSE.sqlite-wasm. BUILD-PROVENANCE.json identifies the exact runtime source.\n');
  }
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
// Resolve real packed exports outside the checkout so source node_modules cannot
// conceal declaration dependencies. Extract aliases locally: the exact GitHub
// versions do not exist until publishing, and staging never contacts that registry.
const consumer = await mkdtemp(join(process.env.RELEASE_SMOKE_TMP ?? tmpdir(), 'browser-agent-release-'));
try {
  await json(join(consumer, 'package.json'), { private: true, type: 'module', dependencies: {
    react: '19.2.4', 'react-dom': '19.2.4', '@types/react': '19.2.14', '@types/react-dom': '19.2.3', '@types/node': '24.10.1', typescript: '5.9.3',
  } });
  await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], consumer);
  for (const [key, alias] of [['runtime', names.runtime], ['workspace', '@kev-browser-agent-kit/workspace'], ['chat', '@kev-browser-agent-kit/opencode-chat']]) {
    const destination = join(consumer, 'node_modules', alias!);
    await mkdir(destination, { recursive: true });
    const artifact = artifacts.find(artifact => artifact.name === names[key as keyof typeof names])!;
    await run(['tar', '-xzf', join(out, artifact.filename), '-C', destination, '--strip-components=1']);
  }
  await Bun.write(join(consumer, 'workspace.tsx'), `
    import { Workspace, Runtime, WorkspaceError, attachPreview, type Distribution } from '@kev-browser-agent-kit/workspace';
    import { WorkspaceProvider, WorkspaceController } from '@kev-browser-agent-kit/workspace/react';
    export * from '@kev-browser-agent-kit/workspace/assets';
    export * from '@kev-browser-agent-kit/workspace/server';
    const distribution: Distribution = {name: 'vivari', version: 'test', assetBaseUrl: '/runtime/'};
    const error: Error = new WorkspaceError('CLOSED', 'smoke');
    export { Workspace, Runtime, WorkspaceController, attachPreview, distribution, error };
    export const view = <WorkspaceProvider><p>smoke</p></WorkspaceProvider>;
  `);
  const tsc = ['node', join(consumer, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', 'false', '--target', 'es2023', '--jsx', 'react-jsx'];
  await run([...tsc, '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'workspace.tsx'], consumer);
  await Bun.write(join(consumer, 'chat.tsx'), `
    import { ChatView, type ChatViewProps } from '@kev-browser-agent-kit/opencode-chat/react';
    import { BrowserEditor, type BrowserEditorProps } from '@kev-browser-agent-kit/opencode-chat/editor';
    export * from '@kev-browser-agent-kit/opencode-chat';
    export * from '@kev-browser-agent-kit/opencode-chat/recipe';
    export * from '@kev-browser-agent-kit/opencode-chat/prepare';
    export * from '@kev-browser-agent-kit/opencode-chat/server';
    export * from '@kev-browser-agent-kit/opencode-chat/config';
    export const chat = (props: ChatViewProps) => <ChatView {...props} />;
    export const editor = (props: BrowserEditorProps) => <BrowserEditor {...props} />;
  `);
  await run([...tsc, '--module', 'esnext', '--moduleResolution', 'bundler', 'chat.tsx'], consumer);
  await Bun.write(join(consumer, 'smoke.tsx'), `
    import { dirname } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { WorkspaceProvider } from '@kev-browser-agent-kit/workspace/react';
    import { readRuntimeAssets, readRuntimeBackendPolicy } from '@kev-browser-agent-kit/workspace/assets';
    import { packagedOpenCodeDirectory } from '@kev-browser-agent-kit/opencode-chat/prepare';
    import { createChatController } from '@kev-browser-agent-kit/opencode-chat';
    const source = dirname(fileURLToPath(import.meta.resolve('${names.runtime}/distribution.json')));
    await readRuntimeAssets(source);
    await readRuntimeBackendPolicy(source);
    if (!packagedOpenCodeDirectory.startsWith(import.meta.dir + '/node_modules/')) throw Error('Application escaped package');
    if (typeof createChatController !== 'function') throw Error('Missing chat export');
    if (!renderToStaticMarkup(<WorkspaceProvider><p>packed consumer</p></WorkspaceProvider>).includes('packed consumer')) throw Error('SSR failed');
    console.log('Isolated packed declarations, runtime resolution, prepared app and SSR passed');
  `);
  await run(['bun', 'smoke.tsx'], consumer);
} finally {
  await rm(consumer, { recursive: true, force: true });
}
if (!checkPack && (await git('status', '--porcelain', '--untracked-files=all') || await git('rev-parse', 'HEAD') !== commit)) throw Error('Toolkit source changed during release');
await json(join(out, 'release.json'), { ...provenance, artifacts });
console.log(JSON.stringify({ output: out, artifacts }, null, 2));
