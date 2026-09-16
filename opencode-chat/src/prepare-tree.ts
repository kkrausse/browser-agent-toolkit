import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { PreparedEntry } from './package-tree';

export const sha256 = (bytes: Uint8Array | string) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/** Capture without dereferencing links. Reject special files and links outside root. */
export async function captureTree(root: string, destination: string, write: (file: string, bytes: Uint8Array) => Promise<void>): Promise<PreparedEntry[]> {
  const entries: PreparedEntry[] = [];
  const canonical = await realpath(root);
  async function walk(path: string, target: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const link = await readlink(path);
      const resolved = relative(canonical, await realpath(path));
      if (link.startsWith('/') || resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) throw Error(`Escaping package link: ${path}`);
      entries.push({ kind: 'symlink', destination: target, target: link });
    } else if (info.isDirectory()) {
      entries.push({ kind: 'directory', destination: target, mode: info.mode & 0o777 });
      for (const name of (await readdir(path)).sort()) await walk(join(path, name), target + '/' + name);
    } else if (info.isFile()) {
      const bytes = new Uint8Array(await readFile(path)), hash = sha256(bytes), file = hash + '.bin';
      await write(file, bytes);
      entries.push({ kind: 'file', destination: target, mode: info.mode & 0o777, sha256: hash, bytes: bytes.length, file });
    } else throw Error(`Unsupported package filesystem entry: ${path}`);
  }
  await walk(root, destination);
  return entries;
}
