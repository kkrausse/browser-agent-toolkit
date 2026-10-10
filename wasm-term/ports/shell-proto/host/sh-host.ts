// The filesystem side of bat-sh's host calls (bat-rust crates/bat-sh/src/sys.rs),
// served from wasm-term's vfs: the same tree the WASI guest reads and writes
// through path_open / fd_read / fd_write. One ShHost per shell run; it owns the
// run's descriptor table, so everything a killed shell had open goes with it.
//
// Every call has one shape, `call(op, n1, n2, s1, s2, data) -> { rc, data }`,
// so that it can be made directly (shell in this Worker) or carried over a
// SharedArrayBuffer channel (shell in its own Worker) without a second
// description of the interface. `rc` is >= 0 or a negated Linux errno, which
// is what sys.rs expects.

import { type DirNode, ERRNO, type FileNode, type Vfs, type VfsNode } from "../../../host/vfs";

export const OP = {
  OPEN: 1, CLOSE: 2, READ: 3, WRITE: 4, STAT: 5, READDIR: 6, READLINK: 7, REALPATH: 8, MKDIR: 9, RMDIR: 10,
  UNLINK: 11, RENAME: 12, SYMLINK: 13, CHMOD: 14, UTIMES: 15,
  /** Only on the channel: the shell worker reports that the run ended; n1 = exit status, n2 = signal. */
  EXIT: 100,
} as const;

export interface Reply {
  rc: number;
  data?: Uint8Array;
}
export type Call = (op: number, n1: number, n2: number, s1: string, s2: string, data: Uint8Array | null) => Reply;

// Linux errno, as sys.rs names them.
const L = { PERM: 1, NOENT: 2, IO: 5, BADF: 9, EXIST: 17, NOTDIR: 20, ISDIR: 21, INVAL: 22, NOSYS: 38, NOTEMPTY: 39, LOOP: 40 };
const FROM_WASI = new Map<number, number>([
  [ERRNO.NOENT, L.NOENT], [ERRNO.EXIST, L.EXIST], [ERRNO.NOTDIR, L.NOTDIR], [ERRNO.ISDIR, L.ISDIR], [ERRNO.NOTEMPTY, L.NOTEMPTY],
  [ERRNO.LOOP, L.LOOP], [ERRNO.INVAL, L.INVAL], [ERRNO.BADF, L.BADF],
]);
const err = (wasi: number) => -(FROM_WASI.get(wasi) ?? L.IO);

const O_ACCMODE = 3, O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0o100, O_EXCL = 0o200, O_TRUNC = 0o1000, O_APPEND = 0o2000;
const K_FILE = 0, K_DIR = 1, K_SYMLINK = 2;

/** wasm-term's vfs has no permission bits; chmod needs somewhere to keep them (`chmod +x f && [ -x f ]`). */
const modes = new WeakMap<VfsNode, number>();
const modeOf = (node: VfsNode) => modes.get(node) ?? (node.kind === "dir" ? 0o755 : node.kind === "symlink" ? 0o777 : 0o644);

type ShFd =
  | { kind: "file"; node: FileNode; pos: number; append: boolean; write: boolean }
  | { kind: "null" }
  | { kind: "out"; stream: 1 | 2 };

export interface ShHost {
  call: Call;
  /** Calls served so far (the cost unit of running the shell in another Worker). */
  calls(): number;
}

export function createShHost(vfs: Vfs, onOutput: (stream: 1 | 2, data: Uint8Array) => void): ShHost {
  const encoder = new TextEncoder();
  const fds = new Map<number, ShFd>([[0, { kind: "null" }], [1, { kind: "out", stream: 1 }], [2, { kind: "out", stream: 2 }]]);
  let nextFd = 3;
  let calls = 0;

  const lookup = (path: string, follow: boolean) => vfs.resolve(vfs.root, path, follow);

  function realpath(path: string): string | number {
    let parts = path.split("/").filter(part => part !== "" && part !== ".");
    const done: string[] = [];
    let hops = 0;
    while (parts.length > 0) {
      const name = parts.shift()!;
      if (name === "..") {
        done.pop();
        continue;
      }
      const found = lookup(`/${[...done, name].join("/")}`, false);
      if (typeof found === "number") return err(found);
      if (!found.node) return -L.NOENT;
      if (found.node.kind === "symlink") {
        if (++hops > 40) return -L.LOOP;
        const target = found.node.target.split("/").filter(part => part !== "" && part !== ".");
        if (found.node.target.startsWith("/")) done.length = 0;
        parts = [...target, ...parts];
        continue;
      }
      if (parts.length > 0 && found.node.kind !== "dir") return -L.NOTDIR;
      done.push(name);
    }
    return `/${done.join("/")}`;
  }

  const call: Call = (op, n1, n2, s1, s2, data) => {
    calls++;
    switch (op) {
      case OP.OPEN: {
        const flags = n1;
        const found = lookup(s1, true);
        if (typeof found === "number") return { rc: err(found) };
        let node = found.node;
        if (node && flags & O_CREAT && flags & O_EXCL) return { rc: -L.EXIST };
        if (!node) {
          if (!(flags & O_CREAT)) return { rc: -L.NOENT };
          node = vfs.createFile(found.dir, found.name);
          modes.set(node, n2 & 0o777 || 0o644);
        }
        const write = (flags & O_ACCMODE) === O_WRONLY || (flags & O_ACCMODE) === O_RDWR;
        if (node.kind === "dir") return { rc: -L.ISDIR };
        const fd = nextFd++;
        if (node.kind === "dev") fds.set(fd, { kind: "null" });
        else if (node.kind === "file") {
          if (flags & O_TRUNC && write) vfs.truncate(node, 0);
          fds.set(fd, { kind: "file", node, pos: 0, append: (flags & O_APPEND) !== 0, write });
        } else return { rc: -L.INVAL };
        return { rc: fd };
      }
      case OP.CLOSE:
        return { rc: fds.delete(n1) ? 0 : -L.BADF };
      case OP.READ: {
        const fd = fds.get(n1);
        if (!fd) return { rc: -L.BADF };
        if (fd.kind !== "file") return { rc: 0 };
        const chunk = fd.node.data.subarray(fd.pos, Math.min(fd.node.size, fd.pos + n2));
        fd.pos += chunk.length;
        return { rc: chunk.length, data: chunk };
      }
      case OP.WRITE: {
        const fd = fds.get(n1);
        if (!fd || !data) return { rc: -L.BADF };
        if (fd.kind === "out") onOutput(fd.stream, data.slice());
        else if (fd.kind === "file") {
          if (!fd.write) return { rc: -L.BADF };
          if (fd.append) fd.pos = fd.node.size;
          vfs.write(fd.node, fd.pos, data);
          fd.pos += data.length;
        }
        return { rc: data.length };
      }
      case OP.STAT: {
        const found = lookup(s1, n1 !== 0);
        if (typeof found === "number") return { rc: err(found) };
        const node = found.node;
        if (!node) return { rc: -L.NOENT };
        const kind = node.kind === "dir" ? K_DIR : node.kind === "symlink" ? K_SYMLINK : K_FILE;
        const size = node.kind === "file" ? node.size : node.kind === "symlink" ? node.target.length : 0;
        return { rc: 0, data: new Uint8Array(new Float64Array([kind, modeOf(node), size, Number(node.mtime / 1000000n)]).buffer) };
      }
      case OP.READDIR: {
        const found = lookup(s1, true);
        if (typeof found === "number") return { rc: err(found) };
        if (!found.node) return { rc: -L.NOENT };
        if (found.node.kind !== "dir") return { rc: -L.NOTDIR };
        const list: string[] = [];
        for (const [name, node] of found.node.entries) list.push(`${node.kind === "dir" ? K_DIR : node.kind === "symlink" ? K_SYMLINK : K_FILE}${name}`);
        const bytes = encoder.encode(list.join("\0"));
        return { rc: bytes.length, data: bytes };
      }
      case OP.READLINK: {
        const found = lookup(s1, false);
        if (typeof found === "number") return { rc: err(found) };
        if (!found.node) return { rc: -L.NOENT };
        if (found.node.kind !== "symlink") return { rc: -L.INVAL };
        const bytes = encoder.encode(found.node.target);
        return { rc: bytes.length, data: bytes };
      }
      case OP.REALPATH: {
        const real = realpath(s1);
        if (typeof real === "number") return { rc: real };
        const bytes = encoder.encode(real);
        return { rc: bytes.length, data: bytes };
      }
      case OP.MKDIR: {
        const found = lookup(s1, true);
        if (typeof found === "number") return { rc: err(found) };
        if (found.node) return { rc: -L.EXIST };
        modes.set(vfs.mkdir(found.dir, found.name), n1 & 0o777 || 0o755);
        return { rc: 0 };
      }
      case OP.RMDIR: {
        const found = lookup(s1, false);
        if (typeof found === "number") return { rc: err(found) };
        if (!found.node) return { rc: -L.NOENT };
        if (found.node.kind !== "dir") return { rc: -L.NOTDIR };
        if (found.node.entries.size > 0) return { rc: -L.NOTEMPTY };
        found.dir.entries.delete(found.name);
        return { rc: 0 };
      }
      case OP.UNLINK: {
        const found = lookup(s1, false);
        if (typeof found === "number") return { rc: err(found) };
        if (!found.node) return { rc: -L.NOENT };
        if (found.node.kind === "dir") return { rc: -L.ISDIR };
        found.dir.entries.delete(found.name);
        return { rc: 0 };
      }
      case OP.RENAME: {
        const from = lookup(s1, false);
        const to = lookup(s2, false);
        if (typeof from === "number") return { rc: err(from) };
        if (typeof to === "number") return { rc: err(to) };
        if (!from.node) return { rc: -L.NOENT };
        if (to.node === from.node) return { rc: 0 };
        if (to.node?.kind === "dir") {
          if (from.node.kind !== "dir") return { rc: -L.ISDIR };
          if (to.node.entries.size > 0) return { rc: -L.NOTEMPTY };
        } else if (to.node && from.node.kind === "dir") return { rc: -L.NOTDIR };
        from.dir.entries.delete(from.name);
        to.dir.entries.set(to.name, from.node);
        if (from.node.kind === "dir") (from.node as DirNode).parent = to.dir;
        return { rc: 0 };
      }
      case OP.SYMLINK: {
        const found = lookup(s2, false);
        if (typeof found === "number") return { rc: err(found) };
        if (found.node) return { rc: -L.EXIST };
        vfs.symlink(found.dir, found.name, s1);
        return { rc: 0 };
      }
      case OP.CHMOD: {
        const found = lookup(s1, true);
        if (typeof found === "number") return { rc: err(found) };
        if (!found.node) return { rc: -L.NOENT };
        modes.set(found.node, n1 & 0o7777);
        return { rc: 0 };
      }
      case OP.UTIMES: {
        const found = lookup(s1, true);
        if (typeof found === "number") return { rc: err(found) };
        if (!found.node) return { rc: -L.NOENT };
        found.node.mtime = BigInt(Math.round(n1)) * 1000000n;
        return { rc: 0 };
      }
      default:
        return { rc: -L.NOSYS };
    }
  };

  return { call, calls: () => calls };
}
