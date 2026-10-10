import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { defaultPreview, encodeSourceFile, workspaceRoot, type EditorManifest, type LaunchDescription, type SourceFile } from './manifest';

export type { EditorManifest, LaunchDescription } from './manifest';

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
  /** Directory holding the pinned OpenCode `server.js` and tree-sitter wasm. Default: `$BAT_OPENCODE_DIR`. */
  openCodeDir?: string;
  /** The `bat-prepare` executable. Default: `$BAT_PREPARE`, then `release/bat-prepare` under `target` or `target-prepare`
   * in an enclosing cargo workspace, then `bat-prepare` on PATH. */
  bin?: string;
  /** Directory of built runtime assets (`host.js`, worker scripts, Wasm, `sw.js`), copied to
   * `<outDir>/runtime/` where the manifest's default `runtime/host.js` points. Default:
   * `$BAT_RUNTIME_DIR`, then `runtime/` beside this module (the published package), then
   * `runtime/dist` in an enclosing repository (`bun runtime/build.ts`). */
  runtimeDir?: string;
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

function findBin(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.BAT_PREPARE) return process.env.BAT_PREPARE;
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
async function installRuntime(outDir: string, runtimeDir: string): Promise<void> {
  const target = join(outDir, 'runtime');
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(runtimeDir, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith('.')) await copyFile(join(runtimeDir, entry.name), join(target, entry.name));
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    // Its stdout is a JSON summary; progress and errors are on stderr.
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', error => fail(Error(`Could not run ${command}: ${error.message}. Build it with \`cargo build --release -p bat-prepare\` or set BAT_PREPARE.`)));
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
    return manifest;
  }
  await run(findBin(options.bin), [
    'app', appRoot, '-o', outDir,
    ...options.source.flatMap(path => ['--source', path]),
    ...Object.entries(options.files ?? {}).flatMap(([guest, local]) => ['--file', `${guest}=${resolve(local)}`]),
    ...(options.preview ? ['--preview', JSON.stringify(options.preview)] : []),
    ...(options.openCodeDir ? ['--opencode', resolve(options.openCodeDir)] : []),
  ]);
  await installRuntime(outDir, findRuntime(options.runtimeDir));
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}
