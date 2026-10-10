// In-memory filesystem for the emulated machine. Nothing here persists; a
// program gets a fresh tree (plus any files the page supplies) on each start.

export const ERRNO = {
  SUCCESS: 0, ACCES: 2, AGAIN: 6, BADF: 8, EXIST: 20, FAULT: 21, INTR: 27, INVAL: 28, IO: 29, ISDIR: 31,
  LOOP: 32, NAMETOOLONG: 37, NOENT: 44, NOSYS: 52, NOTCONN: 53, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, NOTTY: 59,
  PERM: 63, PIPE: 64, RANGE: 68, SPIPE: 70, XDEV: 75,
} as const;

interface NodeBase {
  ino: number;
  atime: bigint;
  mtime: bigint;
  ctime: bigint;
}
export interface DirNode extends NodeBase {
  kind: "dir";
  entries: Map<string, VfsNode>;
  parent: DirNode;
}
export interface FileNode extends NodeBase {
  kind: "file";
  /** Backing store; only the first `size` bytes are file contents. */
  data: Uint8Array;
  size: number;
}
export interface SymlinkNode extends NodeBase {
  kind: "symlink";
  target: string;
}
export interface DevNode extends NodeBase {
  kind: "dev";
  dev: "tty" | "null";
}
export type VfsNode = DirNode | FileNode | SymlinkNode | DevNode;

export interface Resolved {
  /** Directory that holds (or would hold) the final component. */
  dir: DirNode;
  name: string;
  node: VfsNode | null;
}

export interface Vfs {
  root: DirNode;
  nowNs(): bigint;
  /** Walks `path` from `base`. Returns an errno when an intermediate component is missing or not a directory. */
  resolve(base: DirNode, path: string, followFinal: boolean): Resolved | number;
  mkdir(dir: DirNode, name: string): DirNode;
  createFile(dir: DirNode, name: string): FileNode;
  symlink(dir: DirNode, name: string, target: string): SymlinkNode;
  mkdirp(path: string): DirNode;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array | null;
  /** Writes into a file at `offset`, growing it as needed. */
  write(file: FileNode, offset: number, data: Uint8Array): void;
  truncate(file: FileNode, size: number): void;
}

export function createVfs(): Vfs {
  let nextIno = 1;
  const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
  const base = (): NodeBase => {
    const time = nowNs();
    return { ino: nextIno++, atime: time, mtime: time, ctime: time };
  };

  const root = { ...base(), kind: "dir", entries: new Map() } as DirNode;
  root.parent = root;

  function mkdir(dir: DirNode, name: string): DirNode {
    const node: DirNode = { ...base(), kind: "dir", entries: new Map(), parent: dir };
    dir.entries.set(name, node);
    dir.mtime = nowNs();
    return node;
  }

  function createFile(dir: DirNode, name: string): FileNode {
    const node: FileNode = { ...base(), kind: "file", data: new Uint8Array(0), size: 0 };
    dir.entries.set(name, node);
    dir.mtime = nowNs();
    return node;
  }

  function symlink(dir: DirNode, name: string, target: string): SymlinkNode {
    const node: SymlinkNode = { ...base(), kind: "symlink", target };
    dir.entries.set(name, node);
    return node;
  }

  function resolve(start: DirNode, path: string, followFinal: boolean, depth = 0): Resolved | number {
    if (depth > 40) return ERRNO.LOOP;
    let dir = path.startsWith("/") ? root : start;
    const parts = path.split("/").filter(part => part !== "" && part !== ".");
    if (parts.length === 0) return { dir: dir.parent, name: ".", node: dir };
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!;
      const last = index === parts.length - 1;
      let node: VfsNode | null = name === ".." ? dir.parent : dir.entries.get(name) ?? null;
      if (node?.kind === "symlink" && (!last || followFinal)) {
        const rest = parts.slice(index + 1).join("/");
        const target = rest ? `${node.target}/${rest}` : node.target;
        return resolve(dir, target, followFinal, depth + 1);
      }
      if (last) {
        if (name === "..") return { dir: dir.parent.parent, name: ".", node };
        return { dir, name, node };
      }
      if (!node) return ERRNO.NOENT;
      if (node.kind !== "dir") return ERRNO.NOTDIR;
      dir = node;
    }
    return ERRNO.NOENT;
  }

  function mkdirp(path: string): DirNode {
    let dir = root;
    for (const name of path.split("/").filter(Boolean)) {
      const existing = dir.entries.get(name);
      if (existing && existing.kind !== "dir") throw new Error(`${path}: ${name} is not a directory`);
      dir = (existing as DirNode | undefined) ?? mkdir(dir, name);
    }
    return dir;
  }

  function truncate(file: FileNode, size: number): void {
    if (size > file.data.length) {
      const grown = new Uint8Array(Math.max(size, file.data.length * 2, 64));
      grown.set(file.data.subarray(0, file.size));
      file.data = grown;
    } else if (size < file.size) {
      file.data.fill(0, size, file.size);
    }
    file.size = size;
    file.mtime = nowNs();
  }

  function write(file: FileNode, offset: number, data: Uint8Array): void {
    if (offset + data.length > file.size) truncate(file, offset + data.length);
    file.data.set(data, offset);
    file.mtime = nowNs();
  }

  function writeFile(path: string, data: Uint8Array): void {
    const slash = path.lastIndexOf("/");
    const dir = mkdirp(path.slice(0, slash));
    const name = path.slice(slash + 1);
    const existing = dir.entries.get(name);
    const file = existing?.kind === "file" ? existing : createFile(dir, name);
    truncate(file, 0);
    write(file, 0, data);
  }

  function readFile(path: string): Uint8Array | null {
    const found = resolve(root, path, true);
    if (typeof found === "number" || found.node?.kind !== "file") return null;
    return found.node.data.subarray(0, found.node.size);
  }

  const dev = mkdirp("/dev");
  dev.entries.set("tty", { ...base(), kind: "dev", dev: "tty" });
  dev.entries.set("null", { ...base(), kind: "dev", dev: "null" });
  mkdirp("/tmp");
  mkdirp("/etc");
  mkdirp("/home/user");

  return { root, nowNs, resolve, mkdir, createFile, symlink, mkdirp, writeFile, readFile, write, truncate };
}

/** Serves the page's `Program.readFile` / `listFiles`: a copy of the file's bytes, or a JSON
 * array of `{ path, size }` for every regular file below a directory; null when `path` is neither. */
export function serveFile(vfs: Vfs, op: number, path: string): Uint8Array | null {
  if (op === 0) return vfs.readFile(path)?.slice() ?? null;
  const found = vfs.resolve(vfs.root, path, true);
  if (typeof found === "number" || found.node?.kind !== "dir") return null;
  const files: { path: string; size: number }[] = [];
  const walk = (dir: DirNode, prefix: string): void => {
    for (const [name, node] of dir.entries) {
      if (node.kind === "dir") walk(node, `${prefix}/${name}`);
      else if (node.kind === "file") files.push({ path: `${prefix}/${name}`, size: node.size });
    }
  };
  walk(found.node, path.replace(/\/+$/, ""));
  return new TextEncoder().encode(JSON.stringify(files));
}
