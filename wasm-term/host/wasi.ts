// The guest ABI: WASI preview1 (`wasi_snapshot_preview1`) plus the custom
// `wasm_term` import module. The contract is written down in docs/abi.md;
// keep the two in step.

import { TERMIOS_SIZE } from "./kernel";
import { type HttpHandle, type Machine, NSIG, ProcessExit, SIG_CATCH, SIGKILL, type SignalQueue, type TcpHandle, type WsHandle } from "./machine";
import { type Proc, type Processes, SPAWN_STDIN } from "./proc";
import { TCP_WINDOW, WS_BINARY, WS_TEXT } from "./protocol";
import { MAX_JOB_BYTES } from "./sh/channel";
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
const RIGHT_FD_WRITE = 1n << 6n;
const RIGHTS_ALL = (1n << 30n) - 1n;
const EVENTTYPE_CLOCK = 0;
const EVENTTYPE_FD_READ = 1;
const EVENTTYPE_FD_WRITE = 2;
/** `flags` bit of ws_recv / http_head: fail with EAGAIN instead of blocking. */
const NET_NONBLOCK = 1;
/** `flags` bit of tcp_connect: readiness is reported once per change (for reactors that cache it). */
const TCP_EDGE = 1;
const SDFLAGS_WR = 2;

type Fd =
  | { kind: "tty"; flags: number; readOnly?: boolean }
  | { kind: "null"; flags: number }
  | { kind: "file"; flags: number; node: FileNode; pos: number }
  | { kind: "dir"; flags: number; node: DirNode; preopen?: string }
  | { kind: "sig"; flags: number; queue: SignalQueue }
  | { kind: "ws"; flags: number; handle: WsHandle }
  | { kind: "http"; flags: number; handle: HttpHandle; headTaken: boolean }
  | { kind: "tcp"; flags: number; handle: TcpHandle }
  | { kind: "proc"; flags: number; proc: Proc };

export interface WasiOptions {
  args: string[];
  env: Record<string, string>;
  machine: Machine;
  vfs: Vfs;
  /** Called after a call that may have changed files (close, sync, rename, unlink): the persistence hook. */
  onFsChange?: () => void;
  /** The process table behind `proc_*`; without it `proc_spawn` fails with NOSYS. */
  processes?: Processes;
}

export interface Wasi {
  imports: WebAssembly.Imports;
  /** Must be called with the guest's exported memory before `_start`. */
  setMemory(memory: WebAssembly.Memory): void;
}

export function createWasi({ args, env, machine, vfs, onFsChange, processes }: WasiOptions): Wasi {
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

  function sigRead(queue: SignalQueue, cap: number, nonblock: boolean): Uint8Array | number {
    if (cap < 4) return ERRNO.INVAL;
    return blockOn(nonblock, () => {
      if (queue.pending.length === 0) return undefined;
      const count = Math.min(queue.pending.length, Math.floor(cap / 4));
      const out = new Uint8Array(count * 4);
      const outView = new DataView(out.buffer);
      queue.pending.splice(0, count).forEach((signo, index) => outView.setUint32(index * 4, signo, true));
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

  /** What a failed stream answers every call with. */
  function tcpFailure(handle: TcpHandle): number {
    machine.lastError = handle.error;
    return handle.errno;
  }

  function tcpRead(fdNumber: number, fd: Extract<Fd, { kind: "tcp" }>, cap: number): Uint8Array | number {
    const { handle } = fd;
    return blockOn<Uint8Array | number>(nonblocking(fd), () => {
      if (handle.buffered > 0) {
        // As much as fits, across chunks: a short read then means "nothing more is buffered",
        // which is what a reactor that caches readiness concludes from one.
        const out = new Uint8Array(Math.min(cap, handle.buffered));
        let at = 0;
        while (at < out.length) {
          const chunk = handle.chunks[0]!;
          const part = chunk.subarray(0, out.length - at);
          out.set(part, at);
          at += part.length;
          if (part.length === chunk.length) handle.chunks.shift();
          else handle.chunks[0] = chunk.subarray(part.length);
        }
        handle.buffered -= out.length;
        handle.readEdge = handle.buffered > 0 || handle.eof || handle.state === "failed";
        if (out.length > 0) machine.post({ t: "tcp_ack", handle: fdNumber, bytes: out.length });
        return out;
      }
      // End of file before a failure: after the peer's FIN the only "failure" left is the
      // connection going away, which a reader has already been told.
      if (handle.eof) return new Uint8Array(0);
      if (handle.state === "failed") return tcpFailure(handle);
      return undefined;
    });
  }

  /** Bytes a write could take now. */
  const tcpSpace = (handle: TcpHandle) => TCP_WINDOW - (handle.sent - handle.acked);

  /** Takes as much of `data` as the window allows: `{ written }`, or an errno. */
  function tcpWrite(fdNumber: number, fd: Extract<Fd, { kind: "tcp" }>, data: Uint8Array): { written: number } | number {
    const { handle } = fd;
    for (;;) {
      machine.pump();
      if (handle.state === "failed") return tcpFailure(handle);
      if (handle.writeShut) return ERRNO.PIPE;
      const space = handle.state === "open" ? tcpSpace(handle) : 0;
      if (space > 0 || (data.length === 0 && handle.state === "open")) {
        const taken = data.subarray(0, space);
        if (taken.length > 0) {
          machine.post({ t: "tcp_send", handle: fdNumber, data: taken.slice() });
          handle.sent += taken.length;
        }
        // Cut short: the window is full now, and its reopening is the next writable edge.
        if (taken.length < data.length) handle.writeEdge = true;
        return { written: taken.length };
      }
      if (nonblocking(fd)) {
        handle.writeEdge = true;
        return ERRNO.AGAIN;
      }
      machine.waitUntil(Infinity);
    }
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
      case "sig": return sigRead(fd.queue, cap, nonblocking(fd));
      case "http": return httpRead(fdNumber, fd, cap);
      case "tcp": return tcpRead(fdNumber, fd, cap);
      case "ws": return ERRNO.INVAL; // message boundaries matter: use wasm_term.ws_recv
      case "proc": return ERRNO.INVAL; // events, not a byte stream: use wasm_term.proc_recv
    }
  }

  function writeFd(fdNumber: number, data: Uint8Array): number {
    const fd = fds.get(fdNumber);
    if (!fd) return ERRNO.BADF;
    switch (fd.kind) {
      case "tty":
        if (fd.readOnly) return ERRNO.BADF;
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
      const target = fds.get(fdNumber);
      if (target?.kind === "tcp") {
        // The one descriptor that takes part of a write: the rest waits for the relay.
        const result = tcpWrite(fdNumber, target, data);
        if (typeof result === "number") return result;
        view().setUint32(nwrittenPtr, result.written, true);
        return ERRNO.SUCCESS;
      }
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
      if (fd.kind === "sig") machine.closeSignalQueue(fd.queue);
      if (fd.kind === "proc") processes?.close(fd.proc);
      if (fd.kind === "ws" || fd.kind === "http" || fd.kind === "tcp") {
        machine.net.delete(fdNumber);
        machine.post({ t: "net_close", handle: fdNumber });
      }
      fds.delete(fdNumber);
      if (fd.kind === "file") onFsChange?.();
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
    fd_datasync: (fdNumber: number) => (fds.has(fdNumber) ? (onFsChange?.(), ERRNO.SUCCESS) : ERRNO.BADF),
    fd_sync: (fdNumber: number) => (fds.has(fdNumber) ? (onFsChange?.(), ERRNO.SUCCESS) : ERRNO.BADF),
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
      rightsBase: bigint, _rightsInheriting: bigint, fdFlags: number, fdPtr: number,
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
      } else if (node.kind === "dev") entry = { kind: node.dev, flags: fdFlags, readOnly: (rightsBase & RIGHT_FD_WRITE) === 0n };
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
      onFsChange?.();
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
      onFsChange?.();
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

      /** Bytes (or records) a read would return now; 0 = not readable. An errno is returned as a negative number. */
      /** A TCP stream takes a write now (or would answer it with its error). With edge-triggered
       * readiness: only if that is news since the last report. */
      const tcpWritable = (handle: TcpHandle): boolean => {
        if (handle.edge && !handle.writeEdge) return false;
        return handle.state === "failed" || (handle.state === "open" && (handle.writeShut || tcpSpace(handle) > 0));
      };
      const readable = (fdNumber: number): number => {
        const fd = fds.get(fdNumber);
        if (!fd) return -ERRNO.BADF;
        switch (fd.kind) {
          case "tty": return pty.pollIn() ? Math.max(1, pty.readableLen()) : 0;
          case "sig": return fd.queue.pending.length * 4;
          case "ws": return fd.handle.events[0] ? Math.max(1, fd.handle.events[0].data.length) : fd.handle.finished ? 1 : 0;
          case "http":
            if (fd.handle.chunks[0]) return fd.handle.chunks[0].length;
            return (!fd.headTaken && fd.handle.head !== null) || fd.handle.ended ? 1 : 0;
          case "proc": return fd.proc.events[0] ? Math.max(1, fd.proc.events[0].data.length) : 0;
          case "tcp": {
            const { handle } = fd;
            if (handle.edge && !handle.readEdge) return 0;
            return handle.buffered > 0 ? handle.buffered : handle.eof || handle.state === "failed" ? 1 : 0;
          }
          case "file": return Math.max(1, fd.node.size - fd.pos);
          default: return 1;
        }
      };

      for (;;) {
        machine.pump();
        const now = performance.now();
        const events: { sub: Sub; errno: number; nbytes?: number }[] = [];
        let nextDeadline = Infinity;
        for (const sub of subs) {
          if (sub.type === EVENTTYPE_CLOCK) {
            if (now >= sub.deadlineMs) events.push({ sub, errno: 0 });
            else nextDeadline = Math.min(nextDeadline, sub.deadlineMs);
          } else if (sub.type === EVENTTYPE_FD_READ) {
            const ready = readable(sub.fd);
            if (ready < 0) events.push({ sub, errno: -ready });
            else if (ready > 0) events.push({ sub, errno: 0, nbytes: ready });
          } else if (fds.get(sub.fd)?.kind === "tcp") {
            // The one network descriptor that is written with fd_write, so the one that polls
            // writable: while the relay has room. A reactor must ask for edges (tcp_connect flag 1).
            if (tcpWritable((fds.get(sub.fd) as Extract<Fd, { kind: "tcp" }>).handle)) events.push({ sub, errno: 0 });
          } else {
            // Descriptors that cannot be written with fd_write never poll
            // writable: signal, WebSocket, HTTP and process descriptors, and a terminal
            // opened read-only. Reporting them writable would make a
            // level-triggered reactor (mio on wasi, under tokio) spin.
            const fd = fds.get(sub.fd);
            if (!fd) events.push({ sub, errno: ERRNO.BADF });
            else if (!(fd.kind === "sig" || fd.kind === "ws" || fd.kind === "http" || fd.kind === "proc" || (fd.kind === "tty" && fd.readOnly))) events.push({ sub, errno: 0 });
          }
        }
        if (events.length > 0) {
          // An edge is reported once: the next one needs a change (machine.ts) or a call that came up short.
          for (const { sub } of events) {
            const fd = sub.type === EVENTTYPE_CLOCK ? undefined : fds.get(sub.fd);
            if (fd?.kind !== "tcp" || !fd.handle.edge) continue;
            if (sub.type === EVENTTYPE_FD_READ) fd.handle.readEdge = false;
            else fd.handle.writeEdge = false;
          }
          const v = view();
          events.forEach(({ sub, errno, nbytes }, index) => {
            const at = outPtr + index * 32;
            bytes(at, 32).fill(0);
            v.setBigUint64(at, sub.userdata, true);
            v.setUint16(at + 8, errno, true);
            v.setUint8(at + 10, sub.type);
            // wasi-libc answers ioctl(FIONREAD) from this field.
            if (sub.type !== EVENTTYPE_CLOCK) v.setBigUint64(at + 16, BigInt(nbytes ?? 65536), true);
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
    sock_shutdown(fdNumber: number, how: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      // A TCP stream's sending side really closes (the peer reads end of file); the receiving side needs nothing.
      if (fd.kind === "tcp" && how & SDFLAGS_WR && !fd.handle.writeShut) {
        fd.handle.writeShut = true;
        if (fd.handle.state !== "failed") machine.post({ t: "tcp_end", handle: fdNumber });
      }
      return ERRNO.SUCCESS;
    },
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
    sig_fd(mask: number, fdPtr: number) {
      view().setUint32(fdPtr, allocFd({ kind: "sig", flags: 0, queue: machine.openSignalQueue(mask >>> 0) }), true);
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

    // ---- TCP through the relay (docs/abi.md 3.3) ------------------------------

    tcp_connect(hostPtr: number, hostLen: number, port: number, flags: number, fdPtr: number) {
      const host = readString(hostPtr, hostLen);
      if (!host || /[\s/?#@]/.test(host) || port < 1 || port > 65535) {
        machine.lastError = `tcp_connect: not a host and port: ${host}:${port}`;
        return ERRNO.INVAL;
      }
      const edge = (flags & TCP_EDGE) !== 0;
      const handle: TcpHandle = {
        kind: "tcp", state: "connecting", errno: 0, error: "", chunks: [], buffered: 0, eof: false,
        sent: 0, acked: 0, writeShut: false, edge, readEdge: false, writeEdge: true,
      };
      const fdNumber = allocFd({ kind: "tcp", flags: 0, handle });
      machine.net.set(fdNumber, handle);
      machine.post({ t: "tcp_open", handle: fdNumber, host, port });
      view().setUint32(fdPtr, fdNumber, true);
      return ERRNO.SUCCESS;
    },
    tcp_status(fdNumber: number, flags: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      if (fd.kind !== "tcp") return ERRNO.INVAL;
      const { handle } = fd;
      const nonblock = (flags & NET_NONBLOCK) !== 0 || nonblocking(fd);
      return blockOn(nonblock, () => {
        if (handle.state === "failed") return tcpFailure(handle);
        return handle.state === "open" ? ERRNO.SUCCESS : undefined;
      });
    },

    // ---- child processes (docs/abi.md 3.4) ----------------------------------

    proc_spawn(reqPtr: number, reqLen: number, flags: number, fdPtr: number) {
      if (!processes) {
        machine.lastError = "proc_spawn: this machine has no shell";
        return ERRNO.NOSYS;
      }
      if (reqLen > MAX_JOB_BYTES) {
        machine.lastError = `proc_spawn: request of ${reqLen} bytes is larger than ${MAX_JOB_BYTES}`;
        return ERRNO.INVAL;
      }
      machine.pump();
      const proc = processes.spawn(bytes(reqPtr, reqLen), flags & SPAWN_STDIN);
      if (typeof proc === "number") {
        machine.lastError = "proc_spawn: malformed request";
        return proc;
      }
      view().setUint32(fdPtr, allocFd({ kind: "proc", flags: 0, proc }), true);
      return ERRNO.SUCCESS;
    },
    proc_recv(fdNumber: number, bufPtr: number, bufLen: number, outPtr: number, flags: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      if (fd.kind !== "proc" || !processes) return ERRNO.INVAL;
      const { proc } = fd;
      const nonblock = (flags & NET_NONBLOCK) !== 0 || nonblocking(fd);
      return blockOn(nonblock, () => {
        const next = proc.events[0];
        // After the exit event nothing more arrives.
        if (!next) return proc.done ? ERRNO.NOTCONN : undefined;
        const v = view();
        v.setUint32(outPtr, next.kind, true);
        v.setUint32(outPtr + 4, next.data.length, true);
        const event = processes.take(proc, candidate => candidate.data.length <= bufLen);
        if (!event) return ERRNO.RANGE;
        bytes(bufPtr, event.data.length).set(event.data);
        return ERRNO.SUCCESS;
      });
    },
    proc_send(fdNumber: number, ptr: number, len: number, flags: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      if (fd.kind !== "proc" || !processes) return ERRNO.INVAL;
      const errno = processes.send(fd.proc, bytes(ptr, len).slice(), (flags & 1) !== 0);
      machine.pump(); // a shell waiting in a read of stdin gets it now
      return errno;
    },
    proc_signal(fdNumber: number, signo: number) {
      const fd = fds.get(fdNumber);
      if (!fd) return ERRNO.BADF;
      if (fd.kind !== "proc" || !processes) return ERRNO.INVAL;
      const errno = processes.signal(fd.proc, signo);
      machine.pump();
      return errno;
    },
  };

  return {
    imports: { wasi_snapshot_preview1: wasi, wasm_term: custom },
    setMemory(value) {
      memory = value;
    },
  };
}
