import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseModelCatalog, type ModelCatalog } from './model-catalog';
import { defaultPreview, encodeSourceFile, workspaceRoot, type EditorManifest, type LaunchDescription, type SourceFile } from './manifest';

export type { EditorManifest, LaunchDescription } from './manifest';
export { defaultPreview } from './manifest';
export { parseModelCatalog, type ModelCatalog, type CatalogModel } from './model-catalog';

export interface PrepareOptions {
  /** The application directory (package.json + lockfile): its dependencies become the guest image. */
  appRoot: string;
  /** Receives `manifest.json`, the image and the program scripts. Serve it with `createEditorHandler`. */
  outDir: string;
  /** Files and directories (relative to `appRoot`) the agent may edit; they are installed
   * into `/workspace` on first open. Everything else the guest sees comes from the image. */
  source: string[];
  /** Changes to the app's dev-server launch, merged over the default (Vite on port 5173). */
  preview?: Partial<LaunchDescription>;
  /** Extra project files: path below the workspace → local file. */
  files?: Record<string, string>;
  /** Project paths (below the workspace, as in `files` or `source`) that stay the app's:
   * a workspace kept in a browser gets the newly prepared content at its next open, where
   * every other project file is the visitor's once installed. For configuration the app
   * injects, not for source the agent edits. */
  refresh?: string[];
  /** Public model catalog and default, written into the manifest: the editor then offers only
   * these models. Never a credential. `createEditorHandler({ modelCatalog })` replaces it at
   * serve time, when the catalog should change without a new preparation. */
  modelCatalog?: ModelCatalog;
  /** Scratch and cache directory of `bat-prepare` (the installed dependency tree, hundreds
   * of megabytes). Default `<outDir>.work`; name one outside a directory that gets shipped. */
  workDir?: string;
  /** Directory holding the pinned OpenCode `server.js` and tree-sitter wasm. Default:
   * `$BAT_OPENCODE_DIR`, then the copy a released package carries (`prepare/opencode`). */
  openCodeDir?: string;
  /** The `bat-prepare` executable. Default: `$BAT_PREPARE`; then the released binary package
   * for this machine, `@kkrausse/browser-agent-prepare-<platform>-<arch>` (resolved from the
   * app, then from this package); then `release/bat-prepare` under `target` or
   * `target-prepare` in an enclosing cargo workspace; then `bat-prepare` on PATH. */
  bin?: string;
  /** Guest policy file (what replaces native packages in the guest, what is pruned, the
   * launches). Default: the one a released package carries (`prepare/guest-policy.json`,
   * with its shim packages beside it), else the one built into `bat-prepare`, whose shims
   * are in the repository it was built from. */
  policy?: string;
  /** Directory of built runtime assets (`host.js`, worker scripts, Wasm, `sw.js`), copied to
   * `<outDir>/runtime/` where the manifest's default `runtime/host.js` points. Default:
   * `$BAT_RUNTIME_DIR`, then `runtime/` beside this module (the published package), then
   * `runtime/dist` in an enclosing repository (`bun runtime/build.ts`). */
  runtimeDir?: string;
  /** A start-up order file (`bat-prepare order`, from a recorded first open): the file
   * bodies a start-up reads are laid out first in the image, so a visitor's first open can
   * start while the rest of the image is still downloading. Paths the tree no longer has
   * are ignored. Changing it gives the image a new identity. */
  startupOrder?: string;
  /** A recorded start-up module list: JSON `{ preview?: string[], agent?: string[] }` of guest
   * paths each program had loaded once it was up (the example's is recorded by
   * `bench/startup/run.ts --record-modules`). Those modules are also emitted as one module
   * script per launch, which the browser keeps compiled between visits (V8 code cache), instead
   * of compiling each again in every process. Paths the tree no longer has are ignored; a
   * missing or stale file only loses the speed-up. */
  startupModules?: string;
  /** zstd level (1–19) of the copy of the image browsers download. Default 9; 19 is about
   * 14% smaller and takes tens of seconds when the dependency tree changes. */
  compressionLevel?: number;
  /** Write only the manifest (launches and project files), no image: for development
   * against the fake host (`./fake`), which runs the programs natively. */
  manifestOnly?: boolean;
}

const skipped = new Set(['node_modules', '.git', '.server', '.editor', '.browser-editor-cache', 'build', '.react-router', '.DS_Store']);

/** The editable project files by guest path below `/workspace`. */
export async function readSource(appRoot: string, source: string[]): Promise<Record<string, SourceFile>> {
  const root = resolve(appRoot), files: Record<string, SourceFile> = {};
  const add = async (path: string): Promise<void> => {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) if (!skipped.has(name)) await add(join(path, name));
      return;
    }
    const name = path.slice(path.lastIndexOf(sep) + 1);
    // Never ship a credential file to browsers.
    if (name === '.env' || name.startsWith('.env.')) return;
    files['/' + relative(root, path).split(sep).join('/')] = encodeSourceFile(await readFile(path));
  };
  for (const entry of source) {
    const path = resolve(root, entry);
    if (path !== root && !path.startsWith(root + sep)) throw Error(`Source entry escapes the app root: ${entry}`);
    await add(path);
  }
  return files;
}

/** `prepare/` of a released package (scripts/release.ts): the policy with its shim packages, and OpenCode. */
const packaged = (name: string): string | undefined => {
  const path = resolve(import.meta.dirname, '../prepare', name);
  return existsSync(path) ? path : undefined;
};

export const preparePackage = `@kkrausse/browser-agent-prepare-${process.platform}-${process.arch}`;

function findBin(explicit?: string, appRoot?: string): string {
  if (explicit) return explicit;
  if (process.env.BAT_PREPARE) return process.env.BAT_PREPARE;
  for (const from of [appRoot, import.meta.dirname]) {
    if (!from) continue;
    try { return createRequire(join(from, 'package.json')).resolve(`${preparePackage}/bat-prepare`); } catch { /* not installed */ }
  }
  for (let directory = import.meta.dirname; ; directory = resolve(directory, '..')) {
    for (const target of ['target', 'target-prepare']) {
      const candidate = join(directory, target, 'release/bat-prepare');
      if (existsSync(candidate)) return candidate;
    }
    if (resolve(directory, '..') === directory) return 'bat-prepare';
  }
}

function findRuntime(explicit?: string): string {
  const given = explicit ?? process.env.BAT_RUNTIME_DIR;
  if (given) return resolve(given);
  if (existsSync(join(import.meta.dirname, 'runtime/host.js'))) return join(import.meta.dirname, 'runtime');
  for (let directory = import.meta.dirname; ; directory = resolve(directory, '..')) {
    if (existsSync(join(directory, 'runtime/dist/host.js'))) return join(directory, 'runtime/dist');
    if (resolve(directory, '..') === directory) throw Error('Runtime assets not found: run `bun runtime/build.ts`, or set BAT_RUNTIME_DIR / `runtimeDir`.');
  }
}

/** Put the runtime the browser boots next to the manifest (`<outDir>/runtime/`). */
/** A `.zst` beside every program script that has none (start-up programs are written after
 * `bat-prepare` made its own): megabytes a first open would otherwise download as they are. */
async function compressPrograms(outDir: string): Promise<void> {
  const zlib = await import('node:zlib') as unknown as { zstdCompressSync?: (data: Uint8Array, options?: unknown) => Uint8Array; constants: Record<string, number> };
  if (!zlib.zstdCompressSync) return;
  const names = await readdir(outDir);
  for (const name of names) {
    if (!name.startsWith('program-') || !name.endsWith('.js') || names.includes(name + '.zst')) continue;
    await writeFile(join(outDir, name + '.zst'), zlib.zstdCompressSync(await readFile(join(outDir, name)), { params: { [zlib.constants.ZSTD_c_compressionLevel ?? 100]: 12 } }));
  }
}

async function installRuntime(outDir: string, runtimeDir: string): Promise<void> {
  const target = join(outDir, 'runtime');
  await mkdir(target, { recursive: true });
  // A first open downloads all of it (about 5 MB of scripts and Wasm): a `.zst` beside
  // each file, which the server handler answers with (`Content-Encoding: zstd`).
  const { unlink } = await import('node:fs/promises');
  const zlib = await import('node:zlib') as unknown as { zstdCompressSync?: (data: Uint8Array, options?: unknown) => Uint8Array; constants: Record<string, number> };
  const zstd = zlib.zstdCompressSync && ((data: Uint8Array) => zlib.zstdCompressSync!(data, { params: { [zlib.constants.ZSTD_c_compressionLevel ?? 100]: 19 } }));
  for (const entry of await readdir(runtimeDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.') || entry.name.endsWith('.zst')) continue;
    await copyFile(join(runtimeDir, entry.name), join(target, entry.name));
    const bytes = await readFile(join(target, entry.name));
    if (zstd && bytes.length > 1024) await writeFile(join(target, entry.name + '.zst'), zstd(bytes));
    else await unlink(join(target, entry.name + '.zst')).catch(() => {});
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    // Its stdout is a JSON summary; progress and errors are on stderr.
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', error => fail(Error(`Could not run ${command}: ${error.message}. No ${preparePackage} package is installed for this machine: build the tool from the toolkit repository (\`cargo build --release -p bat-prepare\`) and set BAT_PREPARE to it.`)));
    child.on('exit', code => code === 0 ? done() : fail(Error(`${command} exited with code ${code}`)));
  });
}

/**
 * Build the prepared directory. The work is the Rust CLI's:
 *
 *   bat-prepare app <appRoot> -o <outDir> --source <path>... [--file <guest>=<local>]...
 *                   [--preview <json>] [--opencode <dir>]
 *
 * It installs and prunes the dependency tree, packs the image, emits program scripts and
 * writes `manifest.json` (format `bat-prepared-v1`) with the launch descriptions and the
 * editable project files. This function only maps options and returns that manifest.
 */
export async function prepare(options: PrepareOptions): Promise<EditorManifest> {
  const outDir = resolve(options.outDir), appRoot = resolve(options.appRoot);
  await mkdir(outDir, { recursive: true });
  const manifestPath = join(outDir, 'manifest.json');
  if (options.manifestOnly) {
    const project = await readSource(appRoot, options.source);
    for (const [guest, local] of Object.entries(options.files ?? {})) project['/' + guest.replace(/^\//, '')] = encodeSourceFile(await readFile(resolve(local)));
    const manifest: EditorManifest = {
      format: 'bat-prepared-v1', workspace: workspaceRoot,
      launch: { preview: { ...defaultPreview, ...options.preview, env: { ...defaultPreview.env, ...options.preview?.env } } },
      project,
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await addAppFields(manifestPath, options);
    return manifest;
  }
  const bin = findBin(options.bin, appRoot);
  const policy = options.policy ?? packaged('guest-policy.json');
  const openCodeDir = options.openCodeDir ?? (process.env.BAT_OPENCODE_DIR ? undefined : packaged('opencode'));
  await run(bin, [
    'app', appRoot, '-o', outDir,
    ...(policy ? ['--policy', resolve(policy)] : []),
    ...(options.workDir ? ['--work', resolve(options.workDir)] : []),
    ...options.source.flatMap(path => ['--source', path]),
    ...Object.entries(options.files ?? {}).flatMap(([guest, local]) => ['--file', `${guest}=${resolve(local)}`]),
    ...(options.preview ? ['--preview', JSON.stringify(options.preview)] : []),
    ...(openCodeDir ? ['--opencode', resolve(openCodeDir)] : []),
    ...(options.startupOrder ? ['--order', resolve(options.startupOrder)] : []),
    ...(options.compressionLevel ? ['--zstd-level', String(options.compressionLevel)] : []),
  ]);
  await addAppFields(manifestPath, options);
  await installRuntime(outDir, findRuntime(options.runtimeDir));
  if (options.startupModules) await addStartupPrograms(bin, outDir, manifestPath, resolve(appRoot, options.startupModules));
  await compressPrograms(outDir);
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

/** What `bat-prepare` does not know about: the app-owned paths and the model catalog. */
async function addAppFields(manifestPath: string, options: PrepareOptions): Promise<void> {
  if (!options.refresh?.length && !options.modelCatalog) return;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EditorManifest;
  if (options.refresh?.length) {
    manifest.refresh = options.refresh.map(path => '/' + path.replace(/^\//, ''));
    const missing = manifest.refresh.find(path => !Object.hasOwn(manifest.project, path));
    if (missing) throw Error(`prepare({ refresh }): ${missing} is not a project file`);
  }
  if (options.modelCatalog) {
    const catalog = parseModelCatalog(options.modelCatalog);
    manifest.modelCatalog = catalog.models;
    manifest.defaultModel = catalog.defaultModel;
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
}

function capture(command: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.on('error', fail);
    child.on('exit', code => done({ code, stdout }));
  });
}

/** One start-up program per launch that has a recorded module list (see `PrepareOptions.startupModules`). */
async function addStartupPrograms(bin: string, outDir: string, manifestPath: string, listPath: string): Promise<void> {
  if (!existsSync(listPath)) return;
  const lists = JSON.parse(await readFile(listPath, 'utf8')) as Record<string, string[]>;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EditorManifest;
  if (!manifest.image) return;
  const images = [manifest.image as { file: string; mount?: string }, ...(manifest.layers ?? [])].flatMap(image => ['--image', `${join(outDir, image.file)}=${image.mount ?? '/'}`]);
  let changed = false;
  for (const [launch, modules] of Object.entries(lists)) {
    const description = (manifest.launch as Record<string, LaunchDescription | undefined>)[launch];
    if (!description || !Array.isArray(modules) || modules.length === 0) continue;
    const name = `start-${launch}`, list = join(outDir, `.${name}.modules.json`);
    await writeFile(list, JSON.stringify(modules));
    const built = await capture(bin, ['startup-program', ...images, '--name', name, '--modules', list, '-o', outDir]);
    await rm(list, { force: true });
    if (built.code !== 0) { console.warn(`[prepare] no start-up program for ${launch}: bat-prepare exited with code ${built.code}`); continue; }
    const record = JSON.parse(built.stdout) as { name: string; file: string; bytes: number; sha256: string; modules: string[]; sloppy: number; absent: number };
    // The script is loaded as a module: it has to parse as one (`await` as an identifier and
    // HTML-like comments are errors there, which no per-module rule above catches).
    const check = join(outDir, `.${name}.check.mjs`);
    await copyFile(join(outDir, record.file), check);
    const parsed = await capture('node', ['--check', check]).catch(() => ({ code: 127, stdout: '' }));
    await rm(check, { force: true });
    if (parsed.code !== 0) {
      await rm(join(outDir, record.file), { force: true });
      console.warn(`[prepare] start-up program for ${launch} dropped: it does not parse as a module`);
      continue;
    }
    manifest.programs = [...(manifest.programs ?? []).filter(program => program.name !== name), { name, file: record.file, bytes: record.bytes, sha256: record.sha256, modules: [], moduleCount: record.modules.length } as never];
    description.programs = [...(description.programs ?? []).filter(other => other !== name), name];
    changed = true;
    console.log(`[prepare] start-up program ${record.file}: ${record.modules.length} of ${modules.length} modules, ${(record.bytes / 1e6).toFixed(1)} MB (${record.sloppy} sloppy CommonJS and ${record.absent} files outside the images stay with the loader)`);
  }
  if (changed) await writeFile(manifestPath, JSON.stringify(manifest));
}
