// The guest ABI: WASI preview1 (`wasi_snapshot_preview1`) plus the custom
// `wasm_term` import module. The contract is written down in docs/abi.md;
// keep the two in step.

import { TERMIOS_SIZE } from "./kernel";
import { type HttpHandle, type Machine, NSIG, ProcessExit, SIG_CATCH, SIGKILL, type WsHandle } from "./machine";
import { WS_BINARY, WS_TEXT } from "./protocol";
import { type DirNode, ERRNO, type FileNode, type Vfs, type VfsNode } from "./vfs";

const FILETYPE = { UNKNOWN: 0, CHARACTER_DEVICE: 2, DIRECTORY: 3, REGULAR_FILE: 4, SOCKET_STREAM: 6, SYMBOLIC_LINK: 7 } as const;
const FDFLAG_APPEND = 1;
const FDFLAG_NONBLOCK = 4;
const OFLAG_CREAT = 1;
const OFLAG_DIRECTORY = 2;
const OFLAG_EXCL = 4;
const OFLAG_TRUNC = 8;
const RIGHT_FD_SEEK = 1n << 2n;
const RIGHT_FD_TELL = 1n << 5n;
const RIGHTS_ALL = (1n << 30n) - 1n;
const EVENTTYPE_CLOCK = 0;
const EVENTTYPE_FD_READ = 1;
const EVENTTYPE_FD_WRITE = 2;
/** `flags` bit of ws_recv / http_head: fail with EAGAIN instead of blocking. */
const NET_NONBLOCK = 1;

type Fd =
  | { kind: "tty"; flags: number }
  | { kind: "null"; flags: number }
  | { kind: "file"; flags: number; node: FileNode; pos: number }
  | { kind: "dir"; flags: number; node: DirNode; preopen?: string }
  | { kind: "sig"; flags: number }
  | { kind: "ws"; flags: number; handle: WsHandle }
  | { kind: "http"; flags: number; handle: HttpHandle; headTaken: boolean };

export interface WasiOptions {
  args: string[];
  env: Record<string, string>;
  machine: Machine;
  vfs: Vfs;
}

export interface Wasi {
  imports: WebAssembly.Imports;
  /** Must be called with the guest's exported memory before `_start`. */
  setMemory(memory: WebAssembly.Memory): void;
}

export function createWasi({ args, env, machine, vfs }: WasiOptions): Wasi {
  let memory: WebAssembly.Memory;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const { pty } = machine;

  const fds = new Map<number, Fd>([
    [0, { kind: "tty", flags: 0 }],
    [1, { kind: "tty", flags: 0 }],
    [2, { kind: "tty", flags: 0 }],
    [3, { kind: "dir", flags: 0, node: vfs.root, preopen: "/" }],
  ]);
  let nextFd = 4;
  const allocFd = (entry: Fd): number => {
    while (fds.has(nextFd)) nextFd++;
    fds.set(nextFd, entry);
    return nextFd++;
  };

  const view = () => new DataView(memory.buffer);
  const bytes = (ptr: number, len: number) => new Uint8Array(memory.buffer, ptr >>> 0, len >>> 0);
  const readString = (ptr: number, len: number) => decoder.decode(bytes(ptr, len));
  const nonblocking = (fd: Fd) => (fd.flags & FDFLAG_NONBLOCK) !== 0;

  // ---- blocking reads ---------------------------------------------------

  /** Reads from the terminal. A caught signal that arrives during the call interrupts it (EINTR). */
  function ttyRead(cap: number, nonblock: boolean): Uint8Array | number {
    const signalsBefore = machine.caughtSeq();
    pty.slaveReadBegin();
    for (;;) {
      machine.pump();
      const result = pty.slaveRead(cap);
      if (result instanceof Uint8Array) return result;
      if (machine.caughtSeq() !== signalsBefore) return ERRNO.INTR;
      if (nonblock) return ERRNO.AGAIN;
      machine.waitUntil(result.retryAt);
    }
  }

  /** Runs `attempt` until it yields something other than undefined, sleeping on the event ring in between. */
  function blockOn<T>(nonblock: boolean, attempt: () => T | undefined): T | number {
    for (;;) {
      machine.pump();
      const result = attempt();
      if (result !== undefined) return result;
      if (nonblock) return ERRNO.AGAIN;
      machine.waitUntil(Infinity);
    }
  }

  function sigRead(cap: number, nonblock: boolean): Uint8Array | number {
    if (cap < 4) return ERRNO.INVAL;
    return blockOn(nonblock, () => {
      if (machine.caught.length === 0) return undefined;
      const count = Math.min(machine.caught.length, Math.floor(cap / 4));
      const out = new Uint8Array(count * 4);
      const outView = new DataView(out.buffer);
      machine.caught.splice(0, count).forEach((signo, index) => outView.setUint32(index * 4, signo, true));
      return out;
    });
  }

  function httpRead(fdNumber: number, fd: Extract<Fd, { kind: "http" }>, cap: number): Uint8Array | number {
    const { handle } = fd;
    fd.headTaken = true; // reading the body without asking for the head skips it
    return blockOn<Uint8Array | number>(nonblocking(fd), () => {
      const chunk = handle.chunks[0];
      if (chunk) {
        const taken = chunk.subarray(0, cap);
        if (taken.length === chunk.length) handle.chunks.shift();
        else handle.chunks[0] = chunk.subarray(taken.length);
        machine.post({ t: "http_ack", handle: fdNumber, bytes: taken.length });
        return taken;
      }
      if (handle.error !== null) {
        machine.lastError = handle.error;
        return ERRNO.IO;
      }
      if (handle.ended) return new Uint8Array(0);
      return undefined;
    });
  }

  function readFd(fdNumber: number, cap: number): Uint8Array | number {
    const fd = fds.get(fdNumber);
    if (!fd) return ERRNO.BADF;
    switch (fd.kind) {
      case "tty": return ttyRead(cap, nonblocking(fd));
      case "null": return new Uint8Array(0);
      case "file": {
        const end = Math.min(fd.node.size, fd.pos + cap);
        const out = fd.node.data.subarray(Math.min(fd.pos, end), end);
        fd.pos = Math.max(fd.pos, end);
        return out;
      }
      case "dir": return ERRNO.ISDIR;
      case "sig": return sigRead(cap, nonblocking(fd));
      case "http": return httpRead(fdNumber, fd, cap);
      case "ws": return ERRNO.INVAL; // message boundaries matter: use wasm_term.ws_recv
    }
  }

  function writeFd(fdNumber: number, data: Uint8Array): number {
    const fd = fds.get(fdNumber);
    if (!fd) return ERRNO.BADF;
    switch (fd.kind) {
      case "tty":
        machine.pump();
        pty.slaveWrite(data);
        machine.flushOutput();
        return ERRNO.SUCCESS;
      case "null": return ERRNO.SUCCESS;
      case "file":
        if (fd.flags & FDFLAG_APPEND) fd.pos = fd.node.size;
        vfs.write(fd.node, fd.pos, data);
        fd.pos += data.length;
        return ERRNO.SUCCESS;
      case "dir": return ERRNO.ISDIR;
      default: return ERRNO.INVAL;
    }
  }

  /** Total length and (ptr, len) pairs of an iovec array. */
  function iovecs(ptr: number, count: number): { ptr: number; len: number }[] {
    const v = view();
    return Array.from({ length: count }, (_, index) => ({
      ptr: v.getUint32(ptr + index * 8, true),
      len: v.getUint32(ptr + index * 8 + 4, true),
    }));
  }

  function scatter(data: Uint8Array, vecs: { ptr: number; len: number }[]): void {
    let at = 0;
    for (const vec of vecs) {
      if (at >= data.length) break;
      const part = data.subarray(at, at + vec.len);
      bytes(vec.ptr, part.length).set(part);
      at += part.length;
    }
  }

  function gather(vecs: { ptr: number; len: number }[]): Uint8Array {
    const total = vecs.reduce((sum, vec) => sum + vec.len, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const vec of vecs) {
      out.set(bytes(vec.ptr, vec.len), at);
      at += vec.len;
    }
    return out;
  }

  // ---- stat helpers -------------------------------------------------------

  function nodeFiletype(node: VfsNode): number {
    if (node.kind === "dir") return FILETYPE.DIRECTORY;
    if (node.kind === "file") return FILETYPE.REGULAR_FILE;
    if (node.kind === "symlink") return FILETYPE.SYMBOLIC_LINK;
    return FILETYPE.CHARACTER_DEVICE;
  }

  function fdFiletype(fd: Fd): number {
    if (fd.kind === "tty" || fd.kind === "null") return FILETYPE.CHARACTER_DEVICE;
    if (fd.kind === "file") return FILETYPE.REGULAR_FILE;
    if (fd.kind === "dir") return FILETYPE.DIRECTORY;
    return FILETYPE.SOCKET_STREAM;
  }

  function writeFilestat(ptr: number, filetype: number, node: VfsNode | null): void {
    const v = view();
    const time = node ? node : { ino: 0, atime: 0n, mtime: 0n, ctime: 0n };
    v.setBigUint64(ptr, 1n, true);
    v.setBigUint64(ptr + 8, BigInt(time.ino), true);
    v.setUint8(ptr + 16, filetype);
    v.setBigUint64(ptr + 24, 1n, true);
    v.setBigUint64(ptr + 32, BigInt(node?.kind === "file" ? node.size : 0), true);
    v.setBigUint64(ptr + 40, time.atime, true);
    v.setBigUint64(ptr + 48, time.mtime, true);
    v.setBigUint64(ptr + 56, time.ctime, true);
  }

  function dirOf(fdNumber: number): DirNode | number {
    const fd = fds.get(fdNumber);
    if (!fd) return ERRNO.BADF;
    if (fd.kind !== "dir") return ERRNO.NOTDIR;
    return fd.node;
  }

  function lookup(fdNumber: number, pathPtr: number, pathLen: number, follow: boolean) {
    const dir = dirOf(fdNumber);
    if (typeof dir === "number") return dir;
    return vfs.resolve(dir, readString(pathPtr, pathLen), follow);
  }

  // ---- clocks -------------------------------------------------------------

  const realtimeNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
  const monotonicNs = () => BigInt(Math.round(performance.now() * 1e6));
  const clockNs = (id: number) => (id === 0 ? realtimeNs() : monotonicNs());

  // ---- WASI preview1 ----------------------------------------------------------

  const encodedArgs = args.map(arg => encoder.encode(`${arg}\0`));
  const encodedEnv = Object.entries(env).map(([key, value]) => encoder.encode(`${key}=${value}\0`));

  function writeStringList(list: Uint8Array[], pointersPtr: number, bufferPtr: number): number {
    const v = view();
    let at = bufferPtr;
    list.forEach((item, index) => {
      v.setUint32(pointersPtr + index * 4, at, true);
      bytes(at, item.length).set(item);
      at += item.length;
    });
    return ERRNO.SUCCESS;
  }

  function writeSizes(list: Uint8Array[], countPtr: number, sizePtr: number): number {
    const v = view();
    v.setUint32(countPtr, list.length, true);
    v.setUint32(sizePtr, list.reduce((sum, item) => sum + item.length, 0), true);
    return ERRNO.SUCCESS;
  }

  const wasi = {
    args_get: (argvPtr: number, bufPtr: number) => writeStringList(encodedArgs, argvPtr, bufPtr),
    args_sizes_get: (countPtr: number, sizePtr: number) => writeSizes(encodedArgs, countPtr, sizePtr),
    environ_get: (environPtr: number, bufPtr: number) => writeStringList(encodedEnv, environPtr, bufPtr),
    environ_sizes_get: (countPtr: number, sizePtr: number) => writeSizes(encodedEnv, countPtr, sizePtr),

    clock_res_get(_id: number, resPtr: number) {
      view().setBigUint64(resPtr, 1000n, true);
      return ERRNO.SUCCESS;
    },
    clock_time_get(id: number, _precision: bigint, timePtr: number) {
      view().setBigUint64(timePtr, clockNs(id), true);
      return ERRNO.SUCCESS;
    },

    random_get(ptr: number, len: number) {
      // getRandomValues refuses more than 64 KiB per call.
      const target = bytes(ptr, len);
      for (let at = 0; at < len; at += 65536) crypto.getRandomValues(target.subarray(at, Math.min(len, at + 65536)));
      return ERRNO.SUCCESS;
    },

    sched_yield() {
      machine.pump();
      return ERRNO.SUCCESS;
    },
    proc_exit(code: number) {
      throw new ProcessExit(code);
    },
    proc_raise(signo: number) {
      machine.raise(signo);
      return ERRNO.SUCCESS;
    },

    fd_read(fdNumber: number, iovsPtr: number, iovsLen: number, nreadPtr: number) {
      const vecs = iovecs(iovsPtr, iovsLen);
      const cap = vecs.reduce((sum, vec) => sum + vec.len, 0);
      const result = readFd(fdNumber, cap);
      if (typeof result === "number") return result;
      scatter(result, vecs);
      view().setUint32(nreadPtr, result.length, true);
      return ERRNO.SUCCESS;
    },
    fd_write(fdNumber: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) {
      const data = gather(iovecs(iovsPtr, iovsLen));
      const errno = writeFd(fdNumber, data);
      if (errno !== ERRNO.SUCCESS) return errno;
      view().setUint32(nwrittenPtr, data.length, true);
      return ERRNO.SUCCESS;
    },
    fd_pread(fdNumber: number, iovsPtr: number, iovsLen: number, offset: bigint, nreadPtr: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      if (fd.kind !== "file") return ERRNO.SPIPE;
      const vecs = iovecs(iovsPtr, iovsLen);
      const cap = vecs.reduce((sum, vec) => sum + vec.len, 0);
      const start = Math.min(Number(offset), fd.node.size);
      const data = fd.node.data.subarray(start, Math.min(fd.node.size, start + cap));
      scatter(data, vecs);
      view().setUint32(nreadPtr, data.length, true);
      return ERRNO.SUCCESS;
    },
    fd_pwrite(fdNumber: number, iovsPtr: number, iovsLen: number, offset: bigint, nwrittenPtr: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      if (fd.kind !== "file") return ERRNO.SPIPE;
      const data = gather(iovecs(iovsPtr, iovsLen));
      vfs.write(fd.node, Number(offset), data);
      view().setUint32(nwrittenPtr, data.length, true);
      return ERRNO.SUCCESS;
    },
    fd_seek(fdNumber: number, offset: bigint, whence: number, newOffsetPtr: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      if (fd.kind !== "file") return ERRNO.SPIPE;
      const origin = whence === 0 ? 0 : whence === 1 ? fd.pos : fd.node.size;
      const target = origin + Number(offset);
      if (target < 0) return ERRNO.INVAL;
      fd.pos = target;
      view().setBigUint64(newOffsetPtr, BigInt(target), true);
      return ERRNO.SUCCESS;
    },
    fd_tell(fdNumber: number, offsetPtr: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      if (fd.kind !== "file") return ERRNO.SPIPE;
      view().setBigUint64(offsetPtr, BigInt(fd.pos), true);
      return ERRNO.SUCCESS;
    },
    fd_close(fdNumber: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      if (fd.kind === "ws" || fd.kind === "http") {
        machine.net.delete(fdNumber);
        machine.post({ t: "net_close", handle: fdNumber });
      }
      fds.delete(fdNumber);
      if (fdNumber < nextFd) nextFd = Math.max(fdNumber, 4);
      return ERRNO.SUCCESS;
    },
    fd_renumber(from: number, to: number) {
      const fd = fds.get(from);
      if (!fd || !fds.has(to)) return ERRNO.BADF;
      fds.set(to, fd);
      fds.delete(from);
      return ERRNO.SUCCESS;
    },
    fd_fdstat_get(fdNumber: number, statPtr: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      const v = view();
      // A character device without seek/tell rights is what wasi-libc's isatty() accepts.
      const rights = fd.kind === "tty" ? RIGHTS_ALL & ~(RIGHT_FD_SEEK | RIGHT_FD_TELL) : RIGHTS_ALL;
      bytes(statPtr, 24).fill(0);
      v.setUint8(statPtr, fdFiletype(fd));
      v.setUint16(statPtr + 2, fd.flags, true);
      v.setBigUint64(statPtr + 8, rights, true);
      v.setBigUint64(statPtr + 16, rights, true);
      return ERRNO.SUCCESS;
    },
    fd_fdstat_set_flags(fdNumber: number, flags: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      fd.flags = flags;
      return ERRNO.SUCCESS;
    },
    fd_fdstat_set_rights: (fdNumber: number) => (fds.has(fdNumber) ? ERRNO.SUCCESS : ERRNO.BADF),
    fd_filestat_get(fdNumber: number, statPtr: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      writeFilestat(statPtr, fdFiletype(fd), fd.kind === "file" || fd.kind === "dir" ? fd.node : null);
      return ERRNO.SUCCESS;
    },
    fd_filestat_set_size(fdNumber: number, size: bigint) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      if (fd.kind !== "file") return ERRNO.INVAL;
      vfs.truncate(fd.node, Number(size));
      return ERRNO.SUCCESS;
    },
    fd_filestat_set_times: (fdNumber: number) => (fds.has(fdNumber) ? ERRNO.SUCCESS : ERRNO.BADF),
    fd_advise: (fdNumber: number) => (fds.has(fdNumber) ? ERRNO.SUCCESS : ERRNO.BADF),
    fd_allocate: (fdNumber: number) => (fds.has(fdNumber) ? ERRNO.SUCCESS : ERRNO.BADF),
    fd_datasync: (fdNumber: number) => (fds.has(fdNumber) ? ERRNO.SUCCESS : ERRNO.BADF),
    fd_sync: (fdNumber: number) => (fds.has(fdNumber) ? ERRNO.SUCCESS : ERRNO.BADF),
    fd_prestat_get(fdNumber: number, prestatPtr: number) {
      const fd = fds.get(fdNumber);
      if (!fd || fd.kind !== "dir" || fd.preopen === undefined) return ERRNO.BADF;
      const v = view();
      v.setUint32(prestatPtr, 0, true);
      v.setUint32(prestatPtr + 4, encoder.encode(fd.preopen).length, true);
      return ERRNO.SUCCESS;
    },
    fd_prestat_dir_name(fdNumber: number, pathPtr: number, pathLen: number) {
      const fd = fds.get(fdNumber);
      if (!fd || fd.kind !== "dir" || fd.preopen === undefined) return ERRNO.BADF;
      const name = encoder.encode(fd.preopen);
      bytes(pathPtr, pathLen).set(name.subarray(0, pathLen));
      return ERRNO.SUCCESS;
    },
    fd_readdir(fdNumber: number, bufPtr: number, bufLen: number, cookie: bigint, usedPtr: number) {
      const dir = dirOf(fdNumber);
      if (typeof dir === "number") return dir;
      const entries: [string, VfsNode][] = [[".", dir], ["..", dir.parent], ...[...dir.entries].sort(([a], [b]) => (a < b ? -1 : 1))];
      let used = 0;
      for (let index = Number(cookie); index < entries.length && used < bufLen; index++) {
        const [name, node] = entries[index]!;
        const encoded = encoder.encode(name);
        const record = new Uint8Array(24 + encoded.length);
        const recordView = new DataView(record.buffer);
        recordView.setBigUint64(0, BigInt(index + 1), true);
        recordView.setBigUint64(8, BigInt(node.ino), true);
        recordView.setUint32(16, encoded.length, true);
        recordView.setUint8(20, nodeFiletype(node));
        record.set(encoded, 24);
        const part = record.subarray(0, bufLen - used);
        bytes(bufPtr + used, part.length).set(part);
        used += part.length;
      }
      view().setUint32(usedPtr, used, true);
      return ERRNO.SUCCESS;
    },

    path_open(
      dirFd: number, dirFlags: number, pathPtr: number, pathLen: number, oflags: number,
      _rightsBase: bigint, _rightsInheriting: bigint, fdFlags: number, fdPtr: number,
    ) {
      const found = lookup(dirFd, pathPtr, pathLen, (dirFlags & 1) !== 0);
      if (typeof found === "number") return found;
      let node = found.node;
      if (!node) {
        if (!(oflags & OFLAG_CREAT)) return ERRNO.NOENT;
        node = vfs.createFile(found.dir, found.name);
      } else if ((oflags & OFLAG_CREAT) && (oflags & OFLAG_EXCL)) {
        return ERRNO.EXIST;
      }
      if ((oflags & OFLAG_DIRECTORY) && node.kind !== "dir") return ERRNO.NOTDIR;
      let entry: Fd;
      if (node.kind === "dir") entry = { kind: "dir", flags: fdFlags, node };
      else if (node.kind === "file") {
        if (oflags & OFLAG_TRUNC) vfs.truncate(node, 0);
        entry = { kind: "file", flags: fdFlags, node, pos: 0 };
      } else if (node.kind === "dev") entry = { kind: node.dev, flags: fdFlags };
      else return ERRNO.LOOP;
      view().setUint32(fdPtr, allocFd(entry), true);
      return ERRNO.SUCCESS;
    },
    path_create_directory(dirFd: number, pathPtr: number, pathLen: number) {
      const found = lookup(dirFd, pathPtr, pathLen, false);
      if (typeof found === "number") return found;
      if (found.node) return ERRNO.EXIST;
      vfs.mkdir(found.dir, found.name);
      return ERRNO.SUCCESS;
    },
    path_filestat_get(dirFd: number, flags: number, pathPtr: number, pathLen: number, statPtr: number) {
      const found = lookup(dirFd, pathPtr, pathLen, (flags & 1) !== 0);
      if (typeof found === "number") return found;
      if (!found.node) return ERRNO.NOENT;
      writeFilestat(statPtr, nodeFiletype(found.node), found.node);
      return ERRNO.SUCCESS;
    },
    path_filestat_set_times(dirFd: number, flags: number, pathPtr: number, pathLen: number) {
      const found = lookup(dirFd, pathPtr, pathLen, (flags & 1) !== 0);
      if (typeof found === "number") return found;
      return found.node ? ERRNO.SUCCESS : ERRNO.NOENT;
    },
    path_readlink(dirFd: number, pathPtr: number, pathLen: number, bufPtr: number, bufLen: number, usedPtr: number) {
      const found = lookup(dirFd, pathPtr, pathLen, false);
      if (typeof found === "number") return found;
      if (!found.node) return ERRNO.NOENT;
      if (found.node.kind !== "symlink") return ERRNO.INVAL;
      const target = encoder.encode(found.node.target).subarray(0, bufLen);
      bytes(bufPtr, target.length).set(target);
      view().setUint32(usedPtr, target.length, true);
      return ERRNO.SUCCESS;
    },
    path_remove_directory(dirFd: number, pathPtr: number, pathLen: number) {
      const found = lookup(dirFd, pathPtr, pathLen, false);
      if (typeof found === "number") return found;
      if (!found.node) return ERRNO.NOENT;
      if (found.node.kind !== "dir") return ERRNO.NOTDIR;
      if (found.node.entries.size > 0) return ERRNO.NOTEMPTY;
      found.dir.entries.delete(found.name);
      return ERRNO.SUCCESS;
    },
    path_unlink_file(dirFd: number, pathPtr: number, pathLen: number) {
      const found = lookup(dirFd, pathPtr, pathLen, false);
      if (typeof found === "number") return found;
      if (!found.node) return ERRNO.NOENT;
      if (found.node.kind === "dir") return ERRNO.ISDIR;
      found.dir.entries.delete(found.name);
      return ERRNO.SUCCESS;
    },
    path_rename(oldFd: number, oldPtr: number, oldLen: number, newFd: number, newPtr: number, newLen: number) {
      const from = lookup(oldFd, oldPtr, oldLen, false);
      if (typeof from === "number") return from;
      if (!from.node) return ERRNO.NOENT;
      const to = lookup(newFd, newPtr, newLen, false);
      if (typeof to === "number") return to;
      if (to.node?.kind === "dir" && to.node.entries.size > 0) return ERRNO.NOTEMPTY;
      from.dir.entries.delete(from.name);
      to.dir.entries.set(to.name, from.node);
      if (from.node.kind === "dir") from.node.parent = to.dir;
      return ERRNO.SUCCESS;
    },
    path_symlink(targetPtr: number, targetLen: number, dirFd: number, pathPtr: number, pathLen: number) {
      const found = lookup(dirFd, pathPtr, pathLen, false);
      if (typeof found === "number") return found;
      if (found.node) return ERRNO.EXIST;
      vfs.symlink(found.dir, found.name, readString(targetPtr, targetLen));
      return ERRNO.SUCCESS;
    },
    path_link(oldFd: number, _flags: number, oldPtr: number, oldLen: number, newFd: number, newPtr: number, newLen: number) {
      const from = lookup(oldFd, oldPtr, oldLen, false);
      if (typeof from === "number") return from;
      if (!from.node) return ERRNO.NOENT;
      if (from.node.kind === "dir") return ERRNO.PERM;
      const to = lookup(newFd, newPtr, newLen, false);
      if (typeof to === "number") return to;
      if (to.node) return ERRNO.EXIST;
      to.dir.entries.set(to.name, from.node);
      return ERRNO.SUCCESS;
    },

    poll_oneoff(inPtr: number, outPtr: number, count: number, neventsPtr: number) {
      if (count === 0) return ERRNO.INVAL;
      interface Sub { userdata: bigint; type: number; fd: number; deadlineMs: number }
      const subs: Sub[] = [];
      {
        const v = view();
        for (let index = 0; index < count; index++) {
          const at = inPtr + index * 48;
          const type = v.getUint8(at + 8);
          const sub: Sub = { userdata: v.getBigUint64(at, true), type, fd: -1, deadlineMs: Infinity };
          if (type === EVENTTYPE_CLOCK) {
            const clockId = v.getUint32(at + 16, true);
            const timeout = v.getBigUint64(at + 24, true);
            const absolute = (v.getUint16(at + 40, true) & 1) !== 0;
            const relativeNs = absolute ? timeout - clockNs(clockId) : timeout;
            sub.deadlineMs = performance.now() + Number(relativeNs) / 1e6;
          } else {
            sub.fd = v.getUint32(at + 16, true);
          }
          subs.push(sub);
        }
      }

      const readable = (fdNumber: number): boolean | number => {
        const fd = fds.get(fdNumber);
        if (!fd) return ERRNO.BADF;
        switch (fd.kind) {
          case "tty": return pty.pollIn();
          case "sig": return machine.caught.length > 0;
          case "ws": return fd.handle.events.length > 0;
          case "http": return (!fd.headTaken && fd.handle.head !== null) || fd.handle.chunks.length > 0 || fd.handle.ended;
          default: return true;
        }
      };

      for (;;) {
        machine.pump();
        const now = performance.now();
        const events: { sub: Sub; errno: number }[] = [];
        let nextDeadline = Infinity;
        for (const sub of subs) {
          if (sub.type === EVENTTYPE_CLOCK) {
            if (now >= sub.deadlineMs) events.push({ sub, errno: 0 });
            else nextDeadline = Math.min(nextDeadline, sub.deadlineMs);
          } else if (sub.type === EVENTTYPE_FD_READ) {
            const ready = readable(sub.fd);
            if (typeof ready === "number") events.push({ sub, errno: ready });
            else if (ready) events.push({ sub, errno: 0 });
          } else {
            events.push({ sub, errno: fds.has(sub.fd) ? 0 : ERRNO.BADF });
          }
        }
        if (events.length > 0) {
          const v = view();
          events.forEach(({ sub, errno }, index) => {
            const at = outPtr + index * 32;
            bytes(at, 32).fill(0);
            v.setBigUint64(at, sub.userdata, true);
            v.setUint16(at + 8, errno, true);
            v.setUint8(at + 10, sub.type);
            if (sub.type !== EVENTTYPE_CLOCK) v.setBigUint64(at + 16, 1n, true);
          });
          v.setUint32(neventsPtr, events.length, true);
          return ERRNO.SUCCESS;
        }
        machine.waitUntil(nextDeadline);
      }
    },

    // Sockets: fds from wasm_term.http_open are byte streams, so the socket
    // calls std's TcpStream uses are mapped onto them.
    sock_recv(fdNumber: number, iovsPtr: number, iovsLen: number, _flags: number, nreadPtr: number, roFlagsPtr: number) {
      view().setUint16(roFlagsPtr, 0, true);
      return wasi.fd_read(fdNumber, iovsPtr, iovsLen, nreadPtr);
    },
    sock_send: (fdNumber: number, iovsPtr: number, iovsLen: number, _flags: number, nwrittenPtr: number) =>
      wasi.fd_write(fdNumber, iovsPtr, iovsLen, nwrittenPtr),
    sock_shutdown: (fdNumber: number) => (fds.has(fdNumber) ? ERRNO.SUCCESS : ERRNO.BADF),
    sock_accept: () => ERRNO.NOTSUP,
  };

  // ---- wasm_term: what WASI lacks -----------------------------------------

  function ttyOnly(fdNumber: number): number {
    const fd = fds.get(fdNumber);
    if (!fd) return ERRNO.BADF;
    return fd.kind === "tty" ? ERRNO.SUCCESS : ERRNO.NOTTY;
  }

  function netFd<K extends "ws" | "http">(fdNumber: number, kind: K): Extract<Fd, { kind: K }> | number {
    const fd = fds.get(fdNumber);
    if (!fd) return ERRNO.BADF;
    if (fd.kind !== kind) return ERRNO.INVAL;
    return fd as Extract<Fd, { kind: K }>;
  }

  const custom = {
    tcgetattr(fdNumber: number, termiosPtr: number) {
      const errno = ttyOnly(fdNumber);
      if (errno) return errno;
      bytes(termiosPtr, TERMIOS_SIZE).set(pty.getTermios());
      return ERRNO.SUCCESS;
    },
    tcsetattr(fdNumber: number, action: number, termiosPtr: number) {
      const errno = ttyOnly(fdNumber);
      if (errno) return errno;
      if (action > 2) return ERRNO.INVAL;
      machine.pump(); // input typed before this call is processed under the old settings
      pty.setTermios(action, bytes(termiosPtr, TERMIOS_SIZE));
      return ERRNO.SUCCESS;
    },
    winsize_get(fdNumber: number, winsizePtr: number) {
      const errno = ttyOnly(fdNumber);
      if (errno) return errno;
      machine.pump(); // pick up a resize that is still in the ring
      bytes(winsizePtr, 8).set(pty.getWinsize());
      return ERRNO.SUCCESS;
    },
    sig_action(signo: number, action: number, oldActionPtr: number) {
      if (signo < 1 || signo >= NSIG || signo === SIGKILL || action > SIG_CATCH) return ERRNO.INVAL;
      const previous = machine.setDisposition(signo, action);
      if (oldActionPtr) view().setUint32(oldActionPtr, previous, true);
      return ERRNO.SUCCESS;
    },
    sig_fd(fdPtr: number) {
      view().setUint32(fdPtr, allocFd({ kind: "sig", flags: 0 }), true);
      return ERRNO.SUCCESS;
    },
    last_error(bufPtr: number, bufLen: number, lenPtr: number) {
      const message = encoder.encode(machine.lastError).subarray(0, bufLen);
      bytes(bufPtr, message.length).set(message);
      view().setUint32(lenPtr, message.length, true);
      return ERRNO.SUCCESS;
    },

    ws_open(urlPtr: number, urlLen: number, protocolsPtr: number, protocolsLen: number, fdPtr: number) {
      const url = readString(urlPtr, urlLen);
      if (!/^wss?:\/\//i.test(url)) {
        machine.lastError = `ws_open: not a ws:// or wss:// URL: ${url}`;
        return ERRNO.INVAL;
      }
      const protocols = readString(protocolsPtr, protocolsLen).split(",").map(item => item.trim()).filter(Boolean);
      const handle: WsHandle = { kind: "ws", events: [], finished: false };
      const fdNumber = allocFd({ kind: "ws", flags: 0, handle });
      machine.net.set(fdNumber, handle);
      machine.post({ t: "ws_open", handle: fdNumber, url, protocols });
      view().setUint32(fdPtr, fdNumber, true);
      return ERRNO.SUCCESS;
    },
    ws_send(fdNumber: number, kind: number, ptr: number, len: number) {
      const fd = netFd(fdNumber, "ws");
      if (typeof fd === "number") return fd;
      if (kind !== WS_TEXT && kind !== WS_BINARY) return ERRNO.INVAL;
      machine.pump();
      if (fd.handle.finished) return ERRNO.NOTCONN;
      const data = bytes(ptr, len).slice();
      machine.post({ t: "ws_send", handle: fdNumber, data: kind === WS_TEXT ? decoder.decode(data) : data });
      return ERRNO.SUCCESS;
    },
    ws_recv(fdNumber: number, bufPtr: number, bufLen: number, outPtr: number, flags: number) {
      const fd = netFd(fdNumber, "ws");
      if (typeof fd === "number") return fd;
      const nonblock = (flags & NET_NONBLOCK) !== 0 || nonblocking(fd);
      return blockOn(nonblock, () => {
        const event = fd.handle.events[0];
        if (!event) return fd.handle.finished ? ERRNO.NOTCONN : undefined;
        const v = view();
        v.setUint32(outPtr, event.kind, true);
        v.setUint32(outPtr + 4, event.data.length, true);
        if (event.data.length > bufLen) return ERRNO.RANGE;
        bytes(bufPtr, event.data.length).set(event.data);
        fd.handle.events.shift();
        return ERRNO.SUCCESS;
      });
    },
    ws_close(fdNumber: number, code: number, reasonPtr: number, reasonLen: number) {
      const fd = netFd(fdNumber, "ws");
      if (typeof fd === "number") return fd;
      machine.post({ t: "ws_close", handle: fdNumber, code, reason: readString(reasonPtr, reasonLen) });
      return ERRNO.SUCCESS;
    },

    http_open(
      methodPtr: number, methodLen: number, urlPtr: number, urlLen: number,
      headersPtr: number, headersLen: number, bodyPtr: number, bodyLen: number, fdPtr: number,
    ) {
      const headers: [string, string][] = [];
      for (const line of readString(headersPtr, headersLen).split("\n")) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
      }
      const handle: HttpHandle = { kind: "http", head: null, chunks: [], ended: false, error: null };
      const fdNumber = allocFd({ kind: "http", flags: 0, handle, headTaken: false });
      machine.net.set(fdNumber, handle);
      machine.post({
        t: "http_open",
        handle: fdNumber,
        method: readString(methodPtr, methodLen) || "GET",
        url: readString(urlPtr, urlLen),
        headers,
        body: bodyLen > 0 ? bytes(bodyPtr, bodyLen).slice() : null,
      });
      view().setUint32(fdPtr, fdNumber, true);
      return ERRNO.SUCCESS;
    },
    http_head(fdNumber: number, bufPtr: number, bufLen: number, outPtr: number, flags: number) {
      const fd = netFd(fdNumber, "http");
      if (typeof fd === "number") return fd;
      const nonblock = (flags & NET_NONBLOCK) !== 0 || nonblocking(fd);
      return blockOn(nonblock, () => {
        const { head, error } = fd.handle;
        if (!head) {
          if (error === null) return undefined;
          machine.lastError = error;
          return ERRNO.IO;
        }
        const v = view();
        v.setUint32(outPtr, head.status, true);
        v.setUint32(outPtr + 4, head.headers.length, true);
        if (head.headers.length > bufLen) return ERRNO.RANGE;
        bytes(bufPtr, head.headers.length).set(head.headers);
        fd.headTaken = true;
        return ERRNO.SUCCESS;
      });
    },
  };

  return {
    imports: { wasi_snapshot_preview1: wasi, wasm_term: custom },
    setMemory(value) {
      memory = value;
    },
  };
}
