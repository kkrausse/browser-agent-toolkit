import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const hashFile = file => sha256(readFileSync(file));
export function fileManifest(root, paths) {
  return [...new Set(paths)].sort().map(name => ({ name, sha256: existsSync(join(root, name)) ? hashFile(join(root, name)) : null }));
}
export function treeFiles(root, path = '', excluded = new Set()) {
  if (!existsSync(join(root, path))) return [];
  return readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (excluded.has(entry.name)) return [];
    const name = join(path, entry.name);
    return entry.isDirectory() ? treeFiles(root, name, excluded) : [name];
  });
}
export function fingerprint(value) { return sha256(JSON.stringify(value)); }
export function cacheMatches(previous, inputs, outputs) {
  return previous?.fingerprint === fingerprint(inputs) && outputs.length > 0
    && outputs.every(file => file.sha256 !== null)
    && fingerprint(previous.outputs) === fingerprint(outputs);
}
