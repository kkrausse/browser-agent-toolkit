import { unzipSync, zipSync, type Zippable } from 'fflate';
import createIgnore, { type Ignore } from 'ignore';
import type { RuntimeFs } from './runtime-host';
import { workspaceRoot } from './manifest';

/** Never part of a workspace's source: the agent's state, caches and the dependency tree. */
export const managedNames = ['.git', '.server', '.browser-editor-cache', 'node_modules'] as const;

export interface SourceLimits {
  /** Default 25,000. */
  maxFiles?: number;
  /** Uncompressed. Default 100 MiB. */
  maxBytes?: number;
  /** The archive itself. Default 100 MiB. */
  maxArchiveBytes?: number;
}

export interface CaptureSourceOptions extends SourceLimits {
  /** Directory names left out at any depth, besides `managedNames`. */
  exclude?: readonly string[];
  /** Ignore files honoured in every directory, with Git's semantics. Default `['.gitignore']`. */
  ignoreFiles?: readonly string[];
}

export interface SourceArchive {
  /** A ZIP of the files, paths relative to the workspace (`src/home.tsx`). */
  bytes: Uint8Array;
  /** The same paths, sorted. */
  files: string[];
  uncompressedBytes: number;
}

// fflate validates the local calendar year: a UTC midnight falls in 1979 west of Greenwich.
const zipTime = new Date(1980, 0, 1);
const limit = (limits: SourceLimits) => ({
  files: limits.maxFiles ?? 25_000, bytes: limits.maxBytes ?? 100 * 1024 * 1024, archive: limits.maxArchiveBytes ?? 100 * 1024 * 1024,
});

/**
 * The workspace's source as one archive: every file below `/workspace` that is not managed
 * state (`managedNames`, `exclude`) and not ignored by an ignore file on the way down.
 * Where the archive is kept is the app's business; `unpackSource` reads it back, and
 * `openEditor({ initialWorkspace })` starts a workspace from the result.
 */
export async function captureSource(fs: Pick<RuntimeFs, 'readFile' | 'readdir' | 'stat'>, options: CaptureSourceOptions = {}): Promise<SourceArchive> {
  const max = limit(options);
  const excluded = new Set<string>([...managedNames, ...(options.exclude ?? [])]);
  const ignoreFiles = options.ignoreFiles ?? ['.gitignore'];
  type Scope = { directory: string; matcher: Ignore };
  const ignored = (path: string, directory: boolean, scopes: readonly Scope[]) => {
    let result = false;
    for (const scope of scopes) {
      const below = scope.directory ? path.slice(scope.directory.length + 1) : path;
      const test = scope.matcher.test(directory ? below + '/' : below);
      if (test.ignored) result = true;
      if (test.unignored) result = false;
    }
    return result;
  };
  const archive: Zippable = {}, files: string[] = [];
  let uncompressedBytes = 0;
  const walk = async (directory: string, inherited: readonly Scope[]): Promise<void> => {
    const at = directory ? `${workspaceRoot}/${directory}` : workspaceRoot;
    const names = (await fs.readdir(at)).sort();
    let scopes = inherited;
    for (const name of ignoreFiles) {
      if (!names.includes(name)) continue;
      const text = await fs.readFile(`${at}/${name}`).then(bytes => new TextDecoder().decode(bytes), () => undefined);
      if (text !== undefined) scopes = [...scopes, { directory, matcher: createIgnore().add(text) }];
    }
    for (const name of names) {
      if (excluded.has(name)) continue;
      const path = directory ? `${directory}/${name}` : name;
      const info = await fs.stat(`${workspaceRoot}/${path}`).catch(() => undefined);
      if (!info || ignored(path, info.isDirectory, scopes)) continue;
      if (info.isDirectory) { await walk(path, scopes); continue; }
      if (!info.isFile) continue;
      const bytes = await fs.readFile(`${workspaceRoot}/${path}`);
      if (files.length + 1 > max.files) throw Error(`Workspace source exceeds ${max.files} files`);
      if (uncompressedBytes + bytes.byteLength > max.bytes) throw Error(`Workspace source exceeds ${max.bytes} bytes`);
      archive[path] = [bytes, { mtime: zipTime }];
      files.push(path);
      uncompressedBytes += bytes.byteLength;
    }
  };
  await walk('', []);
  const bytes = zipSync(archive, { level: 6 });
  if (bytes.byteLength > max.archive) throw Error(`Workspace source archive exceeds ${max.archive} bytes`);
  return { bytes, files, uncompressedBytes };
}

/**
 * Read an archive made by `captureSource` (or any ZIP of project files) into workspace files
 * by path (`/src/home.tsx`). The archive is untrusted: paths that escape, name managed state
 * (`managedNames`, `exclude`) or exceed the limits reject the whole archive, before anything
 * is written anywhere.
 */
export function unpackSource(bytes: Uint8Array, options: SourceLimits & { exclude?: readonly string[] } = {}): Record<string, Uint8Array> {
  const max = limit(options);
  const excluded = new Set<string>([...managedNames, ...(options.exclude ?? [])]);
  if (bytes.byteLength > max.archive) throw Error(`Workspace source archive exceeds ${max.archive} bytes`);
  const check = (name: string): string | undefined => {
    if (name.endsWith('/')) return undefined;
    const parts = name.split('/');
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || parts.some(part => !part || part === '.' || part === '..'))
      throw Error(`Invalid path in workspace source archive: ${name.slice(0, 200) || '(empty)'}`);
    if (excluded.has(parts[0]!)) throw Error(`Workspace source archive contains managed state: ${name.slice(0, 200)}`);
    return '/' + name;
  };
  let count = 0, total = 0, entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter(file) {
        if (check(file.name) === undefined) return false;
        count++; total += file.originalSize;
        if (count > max.files) throw Error(`Workspace source archive exceeds ${max.files} files`);
        if (total > max.bytes) throw Error(`Workspace source archive exceeds ${max.bytes} bytes`);
        return true;
      },
    });
  } catch (error) {
    throw Error(`Workspace source archive is not usable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!count) throw Error('Workspace source archive is empty');
  return Object.fromEntries(Object.entries(entries).map(([name, data]) => [check(name)!, data]));
}
