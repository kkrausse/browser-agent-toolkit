/** v2 preserves filesystem identity: links are never flattened into byte copies. */
export type PreparedEntry =
  | { kind: 'file'; destination: string; mode: number; file: string; bytes: number; sha256: string }
  | { kind: 'directory'; destination: string; mode: number }
  | { kind: 'symlink'; destination: string; target: string };

export const treeRoots = ['/workspace/node_modules', '/workspace/.browser-editor-backends', '/opencode-v2', '/app'];

export function validateTree(entries: PreparedEntry[]) {
  const paths = new Map<string, PreparedEntry>();
  const rootFor = (path: string) => treeRoots.find(root => path === root || path.startsWith(root + '/'));
  for (const entry of entries) {
    if (!rootFor(entry.destination) || entry.destination.split('/').slice(1).some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part)) || paths.has(entry.destination)) throw Error('Invalid prepared path');
    if (entry.kind === 'file') {
      if (!/^[a-f0-9]{64}$/.test(entry.sha256) || entry.file !== entry.sha256 + '.bin' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw Error('Invalid prepared file');
    } else if (entry.kind === 'symlink') {
      if (typeof entry.target !== 'string' || !entry.target || entry.target.startsWith('/') || /[\\\0]/.test(entry.target)) throw Error('Invalid prepared symlink');
    } else if (entry.kind !== 'directory') throw Error('Invalid prepared entry kind');
    if (entry.kind !== 'symlink' && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) throw Error('Invalid prepared mode');
    paths.set(entry.destination, entry);
  }
  // No asset may write through a symlink parent. Directories are explicit.
  for (const entry of entries) {
    if (treeRoots.includes(entry.destination)) {
      if (entry.kind !== 'directory') throw Error('Prepared root must be directory');
    } else if (paths.get(entry.destination.slice(0, entry.destination.lastIndexOf('/')))?.kind !== 'directory') throw Error('Missing prepared parent directory');
  }
  function follow(path: string, visited: Set<string>): string {
    const parts = path.split('/').slice(1), resolved: string[] = [];
    let enteredRoot = false;
    while (parts.length) {
      const part = parts.shift()!;
      if (part === '.' || !part) continue;
      if (part === '..') {
        resolved.pop();
        if (enteredRoot && !rootFor('/' + resolved.join('/'))) throw Error('Escaping prepared symlink');
        continue;
      }
      resolved.push(part);
      const current = '/' + resolved.join('/');
      if (rootFor(current)) enteredRoot = true;
      const entry = paths.get(current);
      if (entry?.kind === 'symlink') {
        if (visited.has(current)) throw Error('Cyclic prepared symlink');
        const next = new Set(visited).add(current);
        const target = follow(current.slice(0, current.lastIndexOf('/')) + '/' + entry.target, next);
        resolved.splice(0, resolved.length, ...target.split('/').slice(1));
      }
      const resolvedEntry = paths.get('/' + resolved.join('/'));
      if (enteredRoot && parts.length && resolvedEntry?.kind !== 'directory') throw Error('Invalid prepared symlink parent');
    }
    const result = '/' + resolved.join('/');
    if (!paths.has(result)) throw Error('Dangling prepared symlink');
    return result;
  }
  for (const entry of entries) if (entry.kind === 'symlink' && rootFor(follow(entry.destination, new Set())) !== rootFor(entry.destination)) throw Error('Escaping prepared symlink');
}

/** Run with the public ToolContext.node API, before bytes and after bytes respectively. */
export function treeInstaller(entries: PreparedEntry[], phase: 'reset' | 'metadata') {
  validateTree(entries);
  return `const fs=require('node:fs'); const entries=${JSON.stringify(entries)};
${phase === 'reset' ? `for(const root of ${JSON.stringify(treeRoots)}) fs.rmSync(root,{recursive:true,force:true});
for(const e of entries.filter(e=>e.kind==='directory').sort((a,b)=>a.destination.length-b.destination.length)) fs.mkdirSync(e.destination,{recursive:true});` : `for(const e of entries) if(e.kind==='symlink') fs.symlinkSync(e.target,e.destination);
for(const e of entries.filter(e=>e.kind!=='symlink').sort((a,b)=>b.destination.length-a.destination.length)) fs.chmodSync(e.destination,e.mode);`}
console.log('prepared-tree-${phase}-complete');`;
}
