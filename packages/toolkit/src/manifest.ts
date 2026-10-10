import type { Launch } from './runtime-host';
import type { ModelCatalog } from './model-catalog';

/** Text stays readable in the manifest; non-UTF-8 files keep their bytes. */
export type SourceFile = string | { encoding: 'base64'; data: string };

/** A Node program with a port, as `bat-prepare` describes it (`data/guest-policy.json`). */
export interface LaunchDescription {
  /** Guest path of the JS entry, run with `node`. */
  entry: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  port: number;
  /** Prepared program scripts this launch loads (names from `manifest.programs`). */
  programs?: string[];
}

/**
 * `manifest.json` in the prepared directory, format `bat-prepared-v1`, written by the
 * `bat-prepare` CLI (crates/bat-prepare/src/app.rs). The toolkit reads `launch` and
 * `project`; `image`, `programs`, `application` and `dependencies` belong to the runtime.
 */
export interface EditorManifest {
  format: 'bat-prepared-v1';
  /** Absent only in a manifest written for the development fake host. */
  image?: { file: string; bytes: number; sha256: string; mount: string } & Record<string, unknown>;
  programs?: { name: string; file: string; modules: string[] }[];
  launch: { preview: LaunchDescription; agent?: LaunchDescription };
  /** Guest directory the project lives in. */
  workspace: string;
  /** Editable project files by path below the workspace (`/src/home.tsx`). */
  project: Record<string, SourceFile>;
  /** Files derived from the project and the image at prepare time (Vite's dependency
   * optimizer cache): one JSON file beside the manifest, `{ path: SourceFile }` with paths
   * below the workspace. Fetched and installed only when it differs from what the workspace
   * holds; the `owns` directories are removed first. */
  derived?: { file: string; bytes: number; sha256: string; owns: string[] } | null;
  /** Runtime module to import, relative to the manifest. Default `runtime/host.js`. */
  runtime?: { entry?: string };
  /** Added by the server handler when it was given a catalog; never written by prepare. */
  modelCatalog?: ModelCatalog['models'];
  defaultModel?: string;
}

export const workspaceRoot = '/workspace';

/** The guest launch from the design appendix; `prepare({ preview })` is merged over it. */
export const defaultPreview: LaunchDescription = {
  entry: '/workspace/node_modules/vite/bin/vite.js',
  args: ['--configLoader', 'native', '--host', '0.0.0.0', '--port', '5173', '--strictPort'],
  cwd: workspaceRoot,
  env: { BROWSER_AGENT_GUEST: '1', NODE_ENV: 'development' },
  port: 5173,
  programs: [],
};

export function toLaunch(description: LaunchDescription, env: Record<string, string> = {}): Launch {
  return {
    argv: ['node', description.entry, ...(description.args ?? [])], cwd: description.cwd ?? workspaceRoot,
    env: { PATH: '/bin', HOME: `${workspaceRoot}/.server/home`, ...description.env, ...env },
    programs: description.programs ?? [],
  };
}

export function encodeSourceFile(bytes: Uint8Array): SourceFile {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch {
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return { encoding: 'base64', data: btoa(binary) };
  }
}

export function decodeSourceFile(file: SourceFile): Uint8Array {
  if (typeof file === 'string') return new TextEncoder().encode(file);
  if (!file || file.encoding !== 'base64' || typeof file.data !== 'string') throw Error('Invalid prepared project file');
  return Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
}

export function parseManifest(input: unknown): EditorManifest {
  const manifest = input as Partial<EditorManifest> | null;
  if (!manifest || manifest.format !== 'bat-prepared-v1') throw Error('Prepared manifest has an unknown format; run prepare again');
  const preview = manifest.launch?.preview;
  if (!preview || typeof preview.entry !== 'string' || !Number.isInteger(preview.port)) throw Error('Prepared manifest has no preview launch');
  if (!manifest.project || typeof manifest.project !== 'object') throw Error('Prepared manifest has no project files');
  if (manifest.workspace !== workspaceRoot) throw Error(`Prepared workspace must be ${workspaceRoot}`);
  return manifest as EditorManifest;
}
