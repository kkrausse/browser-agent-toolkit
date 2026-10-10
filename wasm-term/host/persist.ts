// Persistent directories. The vfs itself stays in memory; what makes a
// directory persistent is that the program's Worker reports every change
// below it to the page (`persist` messages), the page stores the files
// (persist-store.ts, IndexedDB), and hands them back as `files` on the next
// start. The page does the storing because a wasm guest's Worker is blocked
// in Atomics.wait and never runs IndexedDB callbacks; postMessage still works.

import type { PersistRoots, WorkerMessage } from "./protocol";
import type { DirNode, Vfs } from "./vfs";

export interface Persister {
  /** Reports files that changed since the last call. Cheap when nothing did. */
  sync(): void;
}

interface Seen {
  ino: number;
  mtime: bigint;
  size: number;
}

/** Call after the persisted files have been loaded into `vfs`: what is there now counts as saved. */
export function createPersister(vfs: Vfs, options: PersistRoots, post: (message: WorkerMessage) => void): Persister {
  const seen = new Map<string, Seen>();
  const excluded = (path: string) => (options.exclude ?? []).some(part => path.includes(part));

  function walk(dir: DirNode, path: string, visit: (path: string, data: Uint8Array, stamp: Seen) => void): void {
    for (const [name, node] of dir.entries) {
      const child = `${path}/${name}`;
      if (excluded(child)) continue;
      if (node.kind === "dir") walk(node, child, visit);
      else if (node.kind === "file") visit(child, node.data.subarray(0, node.size), { ino: node.ino, mtime: node.mtime, size: node.size });
    }
  }

  function scan(report: boolean): void {
    const present = new Set<string>();
    for (const root of options.roots) {
      const found = vfs.resolve(vfs.root, root, true);
      if (typeof found === "number" || found.node?.kind !== "dir") continue;
      walk(found.node, root.replace(/\/+$/, ""), (path, data, stamp) => {
        present.add(path);
        const before = seen.get(path);
        if (before && before.ino === stamp.ino && before.mtime === stamp.mtime && before.size === stamp.size) return;
        seen.set(path, stamp);
        if (report) post({ t: "persist", path, data: data.slice() });
      });
    }
    for (const path of seen.keys()) {
      if (present.has(path)) continue;
      seen.delete(path);
      if (report) post({ t: "persist", path, data: null });
    }
  }

  scan(false);
  return { sync: () => scan(true) };
}
