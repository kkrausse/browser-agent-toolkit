import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from './prepare-tree';

type Lock = { lockfileVersion: number; packages: Record<string, any[]> };
export interface BackendPolicy { runtimeVersion: string; sha256: string; aliases: Record<string, string> }
export interface BackendArchiveInput {
  /** Existing runtime-selected override key; e.g. esbuild or @tailwindcss/oxide-wasm32-wasi. */
  override: string;
  packageName: string;
  version: string;
  archivePath: string;
  sha256: string;
  /** SHA-512 Subresource Integrity spelling: sha512-<base64>. */
  sha512: string;
  source: { repository: string; revision: string; buildReceiptSha256: string };
}
export interface BackendArchiveProvenance extends Omit<BackendArchiveInput, 'archivePath'> {
  /** App-relative required input, also used verbatim by the derived manifest/lock. */
  path: string;
  bytes: number;
  files: { path: string; bytes: number; sha256: string }[];
  dependencyClosure: { name: string; version: string; path: string }[];
}
export interface PreparedArchiveInput {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  sha512: string;
}
export interface DependencyProvenance {
  installer: string;
  linker: 'isolated';
  original: { manifest: string; lock: string; manifestSha256: string; lockSha256: string };
  derived: { manifest: string; lock: string; manifestSha256: string; lockSha256: string };
  policy: BackendPolicy;
  overrides: Record<string, string>;
  backendAssertions: { path: string; name: string; version: string }[];
  backendArchives?: BackendArchiveProvenance[];
  lockChanges: { changed: string[]; added: string[]; removed: string[] };
}

/** Read-only archive inspection. Bun install remains the only package installer. */
export async function verifyBackendArchive(input: BackendArchiveInput) {
  if (!/^[a-f0-9]{64}$/.test(input.sha256) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(input.sha512)
    || !/^[a-f0-9]{40}$/.test(input.source.revision) || !/^[a-f0-9]{64}$/.test(input.source.buildReceiptSha256)
    || !/^https:\/\//.test(input.source.repository)) throw Error('Invalid backend archive integrity or source provenance');
  const bytes = new Uint8Array(await readFile(input.archivePath));
  if (sha256(bytes) !== input.sha256 || 'sha512-' + createHash('sha512').update(bytes).digest('base64') !== input.sha512) throw Error(`Backend archive integrity failure: ${input.override}`);
  const contents = await new Bun.Archive(bytes).files();
  const metadata = contents.get('package/package.json');
  if (!metadata) throw Error('Backend archive must contain package/package.json');
  const pkg = await metadata.json();
  if (pkg.name !== input.packageName || pkg.version !== input.version) throw Error('Backend archive package identity mismatch');
  const files: BackendArchiveProvenance['files'] = [];
  for (const [name, file] of contents) {
    if (!name.startsWith('package/') || name.slice(8).split('/').some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) throw Error('Invalid backend archive member');
    const data = new Uint8Array(await file.arrayBuffer());
    files.push({ path: name.slice(8), bytes: data.length, sha256: sha256(data) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const path = `.browser-editor-backends/${input.sha256}.tgz`;
  const { archivePath: _, ...identity } = input;
  const provenance: BackendArchiveProvenance = { ...identity, path, bytes: bytes.length, files, dependencyClosure: [] };
  return { input: { path, bytes, sha256: input.sha256, sha512: input.sha512 } satisfies PreparedArchiveInput, provenance };
}

export function parseLock(text: string): Lock {
  const lock = Bun.JSONC.parse(text) as Lock;
  if (![1, 2].includes(lock.lockfileVersion) || !lock.packages) throw Error('Preparation requires Bun text lockfile v1 or v2');
  return lock;
}

export function selectBackends(lock: Lock, policy: BackendPolicy) {
  const overrides: Record<string, string> = {};
  const assertions: { path: string; name: string; version: string }[] = [];
  for (const [source, target] of Object.entries(policy.aliases)) {
    const versions = new Set(Object.values(lock.packages).map(entry => entry[0]).filter((id): id is string => typeof id === 'string' && id.startsWith(source + '@')).map(id => id.slice(source.length + 1)));
    if (versions.size > 1) throw Error(`Multiple locked versions of ${source}: exact root override cannot preserve them`);
    if (!versions.size) continue;
    const version = [...versions][0]!;
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw Error(`Unsupported locked backend version: ${source}@${version}`);
    overrides[source] = `npm:${target}@${version}`;
    assertions.push({ path: source, name: target, version });
  }
  const oxide = '@tailwindcss/oxide-wasm32-wasi';
  const entries = Object.values(lock.packages).filter(entry => typeof entry[0] === 'string' && entry[0].startsWith(oxide + '@'));
  if (entries.length) {
    const versions = new Set(entries.map(entry => entry[0].slice(oxide.length + 1)));
    if (versions.size !== 1 || [...versions][0] !== '4.3.3') throw Error('Oxide tarball delivery is qualified only for locked 4.3.3');
    overrides[oxide] = 'https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.3.3.tgz';
    if (entries.some(entry => !entry.some(value => typeof value === 'string' && value.startsWith('sha512-')))) throw Error('Original Oxide archive integrity is missing');
    assertions.push({ path: oxide, name: oxide, version: '4.3.3' });
  }
  return { overrides, assertions };
}

/** Bun owns resolution, local package copying, scripts and dependency closure. */
export async function prepareDependencies(options: { appRoot: string; source: string[]; policy: BackendPolicy; bunExecutable?: string; backendArchives?: BackendArchiveInput[] }) {
  const root = resolve(options.appRoot);
  const temporary = await mkdtemp(join(tmpdir(), 'browser-editor-install-'));
  const install = join(temporary, 'tree', root.slice(1));
  const cleanup = () => rm(temporary, { recursive: true, force: true });
  try {
    const manifest = await readFile(join(root, 'package.json'), 'utf8');
    const lock = await readFile(join(root, 'bun.lock'), 'utf8');
    const pkg = JSON.parse(manifest), originalLock = parseLock(lock);
    if (pkg.workspaces) throw Error('Workspace-root preparation is not yet supported');
    const { overrides, assertions } = selectBackends(originalLock, options.policy);
    const archives = new Map<string, Awaited<ReturnType<typeof verifyBackendArchive>>>();
    for (const archive of options.backendArchives ?? []) {
      const selected = assertions.find(item => item.path === archive.override);
      if (!selected || selected.name !== archive.packageName || selected.version !== archive.version) throw Error(`Archive is not the selected backend at its locked version: ${archive.override}`);
      if (archives.has(archive.override)) throw Error(`Duplicate backend archive: ${archive.override}`);
      const verified = await verifyBackendArchive(archive);
      archives.set(archive.override, verified);
      overrides[archive.override] = `file:${verified.input.path}`;
    }
    for (const [name, value] of Object.entries(overrides)) if (pkg.overrides?.[name] && pkg.overrides[name] !== value) throw Error(`Project override conflicts with runtime policy: ${name}`);
    await mkdir(install, { recursive: true });
    for (const source of options.source) {
      if (!source || source.startsWith('/') || source.split('/').some(part => part === '..' || part === '.git' || part === 'node_modules') || source.includes('\\')) throw Error('Source must be app-relative');
      await cp(join(root, source), join(install, source), { recursive: true, verbatimSymlinks: true });
    }
    // Keep relative file: references identical. Copy declared local package inputs
    // into the same relative layout; Bun performs the actual installation.
    const copied = new Set<string>();
    async function localInputs(directory: string, packageJson: any) {
      for (const value of Object.values({ ...packageJson.dependencies, ...packageJson.devDependencies, ...packageJson.optionalDependencies })) {
        if (typeof value !== 'string' || !value.startsWith('file:')) continue;
        if (value.slice(5).startsWith('/')) throw Error('Absolute file dependencies cannot retain staging provenance');
        const source = resolve(directory, value.slice(5));
        if (source === root || root.startsWith(source + '/')) throw Error('Local dependency cannot contain the application');
        if (copied.has(source)) continue;
        copied.add(source);
        const destination = join(temporary, 'tree', source.slice(1));
        await mkdir(dirname(destination), { recursive: true });
        await cp(source, destination, { recursive: true, verbatimSymlinks: true, filter: path => !['node_modules', '.git'].includes(path.split('/').at(-1)!) });
        if (!source.endsWith('.tgz')) await localInputs(source, JSON.parse(await readFile(join(source, 'package.json'), 'utf8')));
      }
    }
    await localInputs(root, pkg);
    await Bun.write(join(install, 'package.json'), manifest);
    await Bun.write(join(install, 'bun.lock'), lock);
    const bun = options.bunExecutable ?? process.execPath;
    const version = Bun.spawn([bun, '--version'], { stdout: 'pipe' });
    const installer = 'bun ' + (await new Response(version.stdout).text()).trim();
    if (await version.exited) throw Error('Cannot identify Bun installer');
    async function run(args: string[]) {
      const child = Bun.spawn([bun, 'install', '--linker', 'isolated', '--cache-dir', join(temporary, 'cache'), ...args], { cwd: install, stdout: 'inherit', stderr: 'inherit' });
      if (await child.exited) throw Error(`Host dependency installation failed (${args.join(' ')})`);
    }
    await run(['--frozen-lockfile']);
    for (const archive of archives.values()) await Bun.write(join(install, archive.input.path), archive.input.bytes);
    const derivedManifest = JSON.stringify({ ...pkg, overrides: { ...pkg.overrides, ...overrides } }, null, 2) + '\n';
    await Bun.write(join(install, 'package.json'), derivedManifest);
    await run([]);
    const derivedLockText = await readFile(join(install, 'bun.lock'), 'utf8');
    const derivedLock = parseLock(derivedLockText);
    for (const assertion of assertions.filter(item => item.name === '@tailwindcss/oxide-wasm32-wasi')) {
      if (archives.has(assertion.path)) continue; // Source artifacts are not registry artifacts.
      const original = Object.values(originalLock.packages).find(entry => entry[0] === assertion.name + '@' + assertion.version)!;
      const integrity = original.find(value => typeof value === 'string' && value.startsWith('sha512-'));
      if (!Object.entries(derivedLock.packages).some(([key, entry]) => (key === assertion.path || key.endsWith('/' + assertion.path)) && entry.includes(integrity))) throw Error('Derived Oxide archive integrity differs from original lock');
    }
    async function verifyStagedInput(key: string, input: PreparedArchiveInput) {
      const staged = await readFile(join(install, input.path));
      if (sha256(staged) !== input.sha256 || 'sha512-' + createHash('sha512').update(staged).digest('base64') !== input.sha512) throw Error(`Staged backend archive changed: ${key}`);
    }
    for (const [key, archive] of archives) {
      const entry = derivedLock.packages[key];
      if (!entry || entry[0] !== `${archive.provenance.packageName}@${archive.input.path}` && entry[0] !== `${archive.provenance.packageName}@file:${archive.input.path}`) throw Error(`Derived backend archive path is not portable: ${key}`);
      // A source artifact has its own SRI, never the original registry SRI.
      const recorded = entry.find(value => typeof value === 'string' && value.startsWith('sha512-'));
      if (recorded !== archive.input.sha512) throw Error(`Derived backend archive integrity mismatch: ${key}`);
      await verifyStagedInput(key, archive.input);
    }
    // Verify reproducibility and platform-filtered delivery, independently of the
    // initial installer cache and node_modules. Scripts follow normal Bun policy.
    await rm(join(install, 'node_modules'), { recursive: true, force: true });
    await run(['--frozen-lockfile', '--cache-dir', join(temporary, 'verification-cache')]);
    if (await readFile(join(install, 'bun.lock'), 'utf8') !== derivedLockText) throw Error('Frozen runtime lock changed');
    for (const [key, archive] of archives) await verifyStagedInput(key, archive.input);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      try { await readFile(join(install, 'node_modules', name, 'package.json')); }
      catch (cause) { throw Error(`Required project dependency was not installed: ${name}`, { cause }); }
    }
    const installed: { directory: string; canonical: string; name: string; version: string }[] = [];
    async function packages(directory: string) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await packages(join(directory, entry.name));
        else if (entry.isFile() && entry.name === 'package.json') {
          // Inspect actual isolated package roots, not package.json fixtures or
          // arbitrary bundled data which happens to have the same filename.
          if (!/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/.test(directory)) continue;
          let pkg;
          try { pkg = JSON.parse(await readFile(join(directory, entry.name), 'utf8')); }
          catch { continue; } // Unrelated test fixtures are not package roots.
          if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue;
          installed.push({ directory, canonical: await realpath(directory), name: pkg.name, version: pkg.version });
        }
      }
    }
    await packages(join(install, 'node_modules'));
    const backendAssertions: DependencyProvenance['backendAssertions'] = [];
    for (const assertion of assertions) {
      const candidates = installed.filter(pkg => pkg.name === assertion.name && pkg.version === assertion.version
        && /^\.bun\/[^/]+\/node_modules\/(?:@[^/]+\/)?[^/]+$/.test(relative(join(install, 'node_modules'), pkg.directory)));
      const archive = archives.get(assertion.path);
      let actual: (typeof installed)[number] | undefined = candidates[0];
      if (archive && candidates.length) {
        // A graph can also contain the ordinary package at this same version.
        // Select the source artifact by its verified bytes, not Bun's store naming.
        actual = undefined;
        let failure: unknown;
        for (const candidate of candidates) {
          try {
            for (const file of archive.provenance.files) {
              const bytes = await readFile(join(candidate.directory, file.path));
              if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw Error(`Installed backend archive content mismatch: ${assertion.path}/${file.path}`);
            }
            actual = candidate;
            break;
          } catch (error) { failure = error; }
        }
        if (!actual) throw failure;
      }
      if (!actual) throw Error(`Missing or incorrect runtime backend: ${assertion.path}`);
      const payload = assertion.path === 'esbuild' ? 'esbuild.wasm' : assertion.path === 'rollup' ? 'dist/wasm-node/bindings_wasm_bg.wasm' : assertion.path === 'lightningcss' ? 'lightningcss_node.wasm' : 'tailwindcss-oxide.wasm32-wasi.wasm';
      await readFile(join(actual.directory, payload));
      backendAssertions.push({ path: relative(join(install, 'node_modules'), actual.directory), name: actual.name, version: actual.version });
      if (archive) {
        const expectedFiles = new Set(archive.provenance.files.map(file => file.path));
        async function checkExtraFiles(directory: string, prefix = '') {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = prefix + entry.name;
            if (entry.isDirectory()) await checkExtraFiles(join(directory, entry.name), path + '/');
            else if (entry.isFile() && !expectedFiles.has(path)) throw Error(`Unexpected installed backend archive file: ${assertion.path}/${path}`);
          }
        }
        await checkExtraFiles(actual.directory);
        const seen = new Set<string>();
        async function closure(directory: string) {
          if (seen.has(directory)) return;
          seen.add(directory);
          const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
          archive!.provenance.dependencyClosure.push({ name: pkg.name, version: pkg.version, path: relative(join(install, 'node_modules'), directory) });
          const requiredPeers = Object.fromEntries(Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => !pkg.peerDependenciesMeta?.[name]?.optional));
          for (const name of Object.keys({ ...pkg.dependencies, ...requiredPeers })) {
            if (name in (pkg.optionalDependencies ?? {})) continue;
            // Use Bun's supported resolver, not a second package graph resolver.
            const entry = await realpath(Bun.resolveSync(name, directory));
            const dependency = installed.filter(item => entry.startsWith(item.canonical + '/')
              && !relative(item.canonical, entry).split('/').includes('node_modules')).sort((a, b) => b.canonical.length - a.canonical.length)[0];
            if (!dependency) throw Error(`Backend dependency closure is absent: ${pkg.name} -> ${name}`);
            await closure(dependency.directory);
          }
        }
        await closure(actual.directory);
        archive.provenance.dependencyClosure.sort((a, b) => a.path.localeCompare(b.path));
      }
    }
    const before = originalLock.packages, after = derivedLock.packages;
    const provenance: DependencyProvenance = {
      installer, linker: 'isolated', original: { manifest, lock, manifestSha256: sha256(manifest), lockSha256: sha256(lock) },
      derived: { manifest: derivedManifest, lock: derivedLockText, manifestSha256: sha256(derivedManifest), lockSha256: sha256(derivedLockText) },
      policy: options.policy, overrides, backendAssertions,
      ...(archives.size ? { backendArchives: [...archives.values()].map(archive => archive.provenance) } : {}),
      lockChanges: { changed: Object.keys(before).filter(key => key in after && JSON.stringify(before[key]) !== JSON.stringify(after[key])), added: Object.keys(after).filter(key => !(key in before)), removed: Object.keys(before).filter(key => !(key in after)) },
    };
    return { install, provenance, archiveInputs: [...archives.values()].map(archive => archive.input), cleanup };
  } catch (error) { await cleanup(); throw error; }
}
