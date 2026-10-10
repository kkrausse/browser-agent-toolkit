import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { defaultPreview, encodeSourceFile, type EditorManifest, type ServiceLaunch, type SourceFile } from './manifest';

export type { EditorManifest, ServiceLaunch } from './manifest';

export interface PrepareOptions {
  /** The application directory: its `node_modules` becomes the guest dependency tree. */
  appRoot: string;
  /** Receives `manifest.json`, the image, program scripts and runtime assets. Serve it with `createEditorHandler`. */
  outDir: string;
  /** Files and directories (relative to `appRoot`) the agent may edit; they are installed
   * into `/workspace` on first open. Everything else the guest sees comes from the image. */
  source: string[];
  /** The app's dev server in the guest. Default: Vite on port 5173 with `BROWSER_AGENT_GUEST=1`. */
  preview?: ServiceLaunch;
  /** Extra read-only files for the image: guest path → local file. */
  files?: Record<string, string>;
  /** The `bat-prepare` executable. Default: `$BAT_PREPARE`, then the workspace's
   * `target/release/bat-prepare`, then `bat-prepare` on PATH. */
  bin?: string;
  /** Write only the manifest: no image, for development against the fake host (`./fake`). */
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
    const candidate = join(directory, 'target/release/bat-prepare');
    if (existsSync(candidate)) return candidate;
    if (resolve(directory, '..') === directory) return 'bat-prepare';
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', error => fail(Error(`Could not run ${command}: ${error.message}. Build it with \`cargo build --release -p bat-prepare\` or set BAT_PREPARE.`)));
    child.on('exit', code => code === 0 ? done() : fail(Error(`${command} exited with code ${code}`)));
  });
}

/**
 * Build the prepared directory. The heavy part is the Rust CLI:
 *
 *   bat-prepare app --app-root <appRoot> --out <outDir> [--file <guest>=<local>]...
 *
 * which must write the image, program scripts and runtime assets into `outDir` together
 * with `prepare.json` = `{ image, programs, runtime }` (paths relative to `outDir`). This
 * function adds the preview launch and the editable source and writes `manifest.json`.
 */
export async function prepare(options: PrepareOptions): Promise<EditorManifest> {
  const outDir = resolve(options.outDir), appRoot = resolve(options.appRoot);
  await mkdir(outDir, { recursive: true });
  let built: Pick<EditorManifest, 'image' | 'programs' | 'runtime'> = {};
  if (!options.manifestOnly) {
    const files = Object.entries(options.files ?? {}).flatMap(([guest, local]) => ['--file', `${guest}=${resolve(local)}`]);
    await run(findBin(options.bin), ['app', '--app-root', appRoot, '--out', outDir, ...files]);
    const report = JSON.parse(await readFile(join(outDir, 'prepare.json'), 'utf8'));
    if (!report.image) throw Error('bat-prepare wrote no image description (prepare.json)');
    built = { image: report.image, programs: report.programs, runtime: report.runtime };
  }
  const manifest: EditorManifest = {
    format: 'bat-editor-1', ...built,
    preview: options.preview ?? defaultPreview,
    source: await readSource(appRoot, options.source),
  };
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
