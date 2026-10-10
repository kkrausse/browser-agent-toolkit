import type { Launch } from './runtime-host';
import type { ModelCatalog } from './model-catalog';

/** Text stays readable in the manifest; non-UTF-8 files keep their bytes. */
export type SourceFile = string | { encoding: 'base64'; data: string };

export interface ServiceLaunch extends Launch { port: number }

/** `manifest.json` in the prepared directory. Written by `prepare()`; the runtime reads
 * only `image`, `programs` and `runtime`, and must ignore the rest. */
export interface EditorManifest {
  format: 'bat-editor-1';
  /** Whatever `bat-prepare` reported: image file, program scripts, runtime assets. Paths
   * are relative to the manifest. Absent only in a manifest prepared for the fake host. */
  image?: unknown;
  programs?: unknown;
  runtime?: { entry?: string } & Record<string, unknown>;
  /** The app's dev server. */
  preview: ServiceLaunch;
  /** Editable project files by guest path below `/workspace` (`/src/home.tsx`). */
  source: Record<string, SourceFile>;
  /** Added by the server handler when it was given a catalog; never written by prepare. */
  modelCatalog?: ModelCatalog['models'];
  defaultModel?: string;
}

export const workspaceRoot = '/workspace';

/** The guest launch from the design appendix; `prepare({ preview })` replaces it. */
export const defaultPreview: ServiceLaunch = {
  argv: ['node', '/workspace/node_modules/vite/bin/vite.js', '--configLoader', 'native', '--host', '0.0.0.0', '--port', '5173', '--strictPort'],
  cwd: workspaceRoot,
  env: { PATH: '/bin', HOME: '/workspace/.server/home', NODE_ENV: 'development', BROWSER_AGENT_GUEST: '1', BROWSER_AGENT_PORT: '5173' },
  port: 5173,
};

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
  if (!file || file.encoding !== 'base64' || typeof file.data !== 'string') throw Error('Invalid prepared source file');
  return Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
}

export function parseManifest(input: unknown): EditorManifest {
  const manifest = input as Partial<EditorManifest> | null;
  if (!manifest || manifest.format !== 'bat-editor-1') throw Error('Prepared manifest has an unknown format; run prepare again');
  const preview = manifest.preview;
  if (!preview || !Array.isArray(preview.argv) || !preview.argv.length || !Number.isInteger(preview.port)) throw Error('Prepared manifest has no preview launch');
  if (!manifest.source || typeof manifest.source !== 'object') throw Error('Prepared manifest has no source');
  return manifest as EditorManifest;
}
