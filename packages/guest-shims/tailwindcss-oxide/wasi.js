'use strict';
// A minimal synchronous WASI preview1 over Node's `fs`, with exactly the calls
// the Tailwind scanner's wasm32-wasip1 build imports. Read-only: the scanner
// never writes. One preopened directory, "/", so every absolute path resolves.
// No threads, no SharedArrayBuffer, no `node:wasi`.

const fs = require('fs');

const ERRNO = {
  SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, LOOP: 32,
  NAMETOOLONG: 37, NOENT: 44, NOSYS: 52, NOTDIR: 54, PERM: 63, ROFS: 69,
};
const FILETYPE = { UNKNOWN: 0, BLOCK: 1, CHAR: 2, DIR: 3, FILE: 4, SYMLINK: 7 };
const OFLAGS_CREAT = 1, OFLAGS_DIRECTORY = 2, OFLAGS_EXCL = 4, OFLAGS_TRUNC = 8;
const LOOKUP_SYMLINK_FOLLOW = 1;
const ALL_RIGHTS = 0x1fffffffn;
const DIRENT_SIZE = 24;

function errnoOf(error) {
  switch (error && error.code) {
    case 'ENOENT': return ERRNO.NOENT;
    case 'ENOTDIR': return ERRNO.NOTDIR;
    case 'EISDIR': return ERRNO.ISDIR;
    case 'EACCES': return ERRNO.ACCES;
    case 'EPERM': return ERRNO.PERM;
    case 'ELOOP': return ERRNO.LOOP;
    case 'EEXIST': return ERRNO.EXIST;
    case 'EINVAL': return ERRNO.INVAL;
    case 'ENAMETOOLONG': return ERRNO.NAMETOOLONG;
    case 'EBADF': return ERRNO.BADF;
    default: return ERRNO.IO;
  }
}

function filetypeOf(stat) {
  if (stat.isDirectory()) return FILETYPE.DIR;
  if (stat.isFile()) return FILETYPE.FILE;
  if (stat.isSymbolicLink()) return FILETYPE.SYMLINK;
  if (stat.isCharacterDevice && stat.isCharacterDevice()) return FILETYPE.CHAR;
  if (stat.isBlockDevice && stat.isBlockDevice()) return FILETYPE.BLOCK;
  return FILETYPE.UNKNOWN;
}

const nanoseconds = (ms) => {
  const whole = Math.floor(ms || 0);
  return BigInt(whole) * 1000000n + BigInt(Math.round(((ms || 0) - whole) * 1e6));
};

/**
 * @param {{ stderr?: (text: string) => void }} [options]
 * @returns {{ imports: Record<string, Function>, bind: (memory: WebAssembly.Memory) => void }}
 */
function createWasi(options) {
  const onStderr = (options && options.stderr) || (() => {});
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  /** @type {WebAssembly.Memory} */
  let memory;
  /** @type {Uint8Array} */ let u8;
  /** @type {DataView} */ let dv;
  // The buffer is replaced whenever the memory grows.
  const view = () => {
    if (!u8 || u8.buffer !== memory.buffer) {
      u8 = new Uint8Array(memory.buffer);
      dv = new DataView(memory.buffer);
    }
    return dv;
  };

  // fd -> { type: 'dir', path, entries? } | { type: 'file', path, data, offset } | { type: 'tty' }
  const fds = new Map([
    [0, { type: 'tty' }], [1, { type: 'tty' }], [2, { type: 'tty' }],
    [3, { type: 'dir', path: '/', preopen: true }],
  ]);
  let nextFd = 4;

  const string = (ptr, len) => { view(); return decoder.decode(u8.subarray(ptr, ptr + len)); };
  const pathAt = (fd, ptr, len) => {
    const dir = fds.get(fd);
    if (!dir || dir.type !== 'dir') return null;
    const rel = string(ptr, len);
    if (rel.startsWith('/')) return rel;
    return dir.path.endsWith('/') ? dir.path + rel : dir.path + '/' + rel;
  };
  const writeFilestat = (ptr, stat) => {
    const d = view();
    u8.fill(0, ptr, ptr + 64);
    d.setBigUint64(ptr, BigInt(stat.dev || 0), true);
    d.setBigUint64(ptr + 8, BigInt(stat.ino || 0), true);
    d.setUint8(ptr + 16, filetypeOf(stat));
    d.setBigUint64(ptr + 24, BigInt(stat.nlink || 1), true);
    d.setBigUint64(ptr + 32, BigInt(stat.size || 0), true);
    d.setBigUint64(ptr + 40, nanoseconds(stat.atimeMs), true);
    d.setBigUint64(ptr + 48, nanoseconds(stat.mtimeMs), true);
    d.setBigUint64(ptr + 56, nanoseconds(stat.ctimeMs), true);
  };
  const attempt = (fn) => {
    try { return fn(); } catch (error) { return errnoOf(error); }
  };

  const imports = {
    environ_sizes_get(countPtr, sizePtr) {
      const d = view();
      d.setUint32(countPtr, 0, true);
      d.setUint32(sizePtr, 0, true);
      return ERRNO.SUCCESS;
    },
    environ_get() { return ERRNO.SUCCESS; },
    clock_time_get(_id, _precision, timePtr) {
      view().setBigUint64(timePtr, BigInt(Date.now()) * 1000000n, true);
      return ERRNO.SUCCESS;
    },
    random_get(ptr, len) {
      // Only seeds hash maps; nothing security relevant is derived from it.
      view();
      for (let i = 0; i < len; i++) u8[ptr + i] = (Math.random() * 256) | 0;
      return ERRNO.SUCCESS;
    },
    sched_yield() { return ERRNO.SUCCESS; },
    proc_exit(code) { throw new Error(`tailwindcss-oxide wasm called exit(${code})`); },

    fd_prestat_get(fd, ptr) {
      const entry = fds.get(fd);
      if (!entry || !entry.preopen) return ERRNO.BADF;
      const d = view();
      d.setUint32(ptr, 0, true); // tag: directory
      d.setUint32(ptr + 4, encoder.encode(entry.path).length, true);
      return ERRNO.SUCCESS;
    },
    fd_prestat_dir_name(fd, ptr, len) {
      const entry = fds.get(fd);
      if (!entry || !entry.preopen) return ERRNO.BADF;
      view();
      u8.set(encoder.encode(entry.path).subarray(0, len), ptr);
      return ERRNO.SUCCESS;
    },
    fd_fdstat_get(fd, ptr) {
      const entry = fds.get(fd);
      if (!entry) return ERRNO.BADF;
      const d = view();
      u8.fill(0, ptr, ptr + 24);
      d.setUint8(ptr, entry.type === 'dir' ? FILETYPE.DIR : entry.type === 'file' ? FILETYPE.FILE : FILETYPE.CHAR);
      d.setBigUint64(ptr + 8, ALL_RIGHTS, true);
      d.setBigUint64(ptr + 16, ALL_RIGHTS, true);
      return ERRNO.SUCCESS;
    },
    fd_filestat_get(fd, ptr) {
      const entry = fds.get(fd);
      if (!entry) return ERRNO.BADF;
      if (entry.type === 'tty') {
        view();
        u8.fill(0, ptr, ptr + 64);
        dv.setUint8(ptr + 16, FILETYPE.CHAR);
        return ERRNO.SUCCESS;
      }
      return attempt(() => {
        writeFilestat(ptr, fs.statSync(entry.path));
        return ERRNO.SUCCESS;
      });
    },
    fd_close(fd) {
      const entry = fds.get(fd);
      if (!entry) return ERRNO.BADF;
      if (!entry.preopen && entry.type !== 'tty') fds.delete(fd);
      return ERRNO.SUCCESS;
    },
    fd_seek(fd, offset, whence, resultPtr) {
      const entry = fds.get(fd);
      if (!entry || entry.type !== 'file') return ERRNO.BADF;
      const base = whence === 0 ? 0 : whence === 1 ? entry.offset : entry.data.length;
      const next = base + Number(offset);
      if (next < 0) return ERRNO.INVAL;
      entry.offset = next;
      view().setBigUint64(resultPtr, BigInt(next), true);
      return ERRNO.SUCCESS;
    },
    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      const entry = fds.get(fd);
      if (!entry) return ERRNO.BADF;
      if (entry.type === 'dir') return ERRNO.ISDIR;
      let total = 0;
      if (entry.type === 'file') {
        for (let i = 0; i < iovsLen; i++) {
          const d = view();
          const ptr = d.getUint32(iovsPtr + i * 8, true);
          const len = d.getUint32(iovsPtr + i * 8 + 4, true);
          const chunk = entry.data.subarray(entry.offset, entry.offset + len);
          u8.set(chunk, ptr);
          entry.offset += chunk.length;
          total += chunk.length;
          if (chunk.length < len) break;
        }
      }
      view().setUint32(nreadPtr, total, true);
      return ERRNO.SUCCESS;
    },
    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      // Only stdout/stderr (panic messages, tracing). Nothing is written to disk.
      if (fd !== 1 && fd !== 2) return fds.has(fd) ? ERRNO.ROFS : ERRNO.BADF;
      let total = 0;
      let text = '';
      for (let i = 0; i < iovsLen; i++) {
        const d = view();
        const ptr = d.getUint32(iovsPtr + i * 8, true);
        const len = d.getUint32(iovsPtr + i * 8 + 4, true);
        text += decoder.decode(u8.subarray(ptr, ptr + len), { stream: true });
        total += len;
      }
      onStderr(text);
      view().setUint32(nwrittenPtr, total, true);
      return ERRNO.SUCCESS;
    },
    fd_readdir(fd, bufPtr, bufLen, cookie, usedPtr) {
      const entry = fds.get(fd);
      if (!entry || entry.type !== 'dir') return ERRNO.BADF;
      return attempt(() => {
        if (!entry.entries) {
          entry.entries = fs.readdirSync(entry.path, { withFileTypes: true }).map((dirent) => ({
            name: encoder.encode(dirent.name),
            type: filetypeOf(dirent),
          }));
        }
        let used = 0;
        const head = new Uint8Array(DIRENT_SIZE);
        const headView = new DataView(head.buffer);
        for (let i = Number(cookie); i < entry.entries.length && used < bufLen; i++) {
          const { name, type } = entry.entries[i];
          headView.setBigUint64(0, BigInt(i + 1), true); // d_next
          // A zero inode makes wasi-libc stat every entry; the scanner never reads it.
          headView.setBigUint64(8, BigInt(i + 1), true);
          headView.setUint32(16, name.length, true);
          headView.setUint8(20, type);
          view();
          // A truncated last entry tells the caller the buffer was too small.
          const headPart = head.subarray(0, Math.min(DIRENT_SIZE, bufLen - used));
          u8.set(headPart, bufPtr + used);
          used += headPart.length;
          const namePart = name.subarray(0, Math.min(name.length, bufLen - used));
          u8.set(namePart, bufPtr + used);
          used += namePart.length;
        }
        view().setUint32(usedPtr, used, true);
        return ERRNO.SUCCESS;
      });
    },

    path_open(dirFd, dirFlags, pathPtr, pathLen, oflags, _rightsBase, _rightsInheriting, _fdFlags, fdPtr) {
      const path = pathAt(dirFd, pathPtr, pathLen);
      if (path === null) return ERRNO.BADF;
      if (oflags & (OFLAGS_CREAT | OFLAGS_EXCL | OFLAGS_TRUNC)) return ERRNO.ROFS;
      return attempt(() => {
        let entry;
        if (!(dirFlags & LOOKUP_SYMLINK_FOLLOW) && fs.lstatSync(path).isSymbolicLink()) return ERRNO.LOOP;
        if (oflags & OFLAGS_DIRECTORY) {
          if (!fs.statSync(path).isDirectory()) return ERRNO.NOTDIR;
          entry = { type: 'dir', path };
        } else {
          try {
            // One host call per file; the scanner reads every file it opens to the end.
            entry = { type: 'file', path, data: fs.readFileSync(path), offset: 0 };
          } catch (error) {
            if (!error || error.code !== 'EISDIR') throw error;
            entry = { type: 'dir', path };
          }
        }
        const fd = nextFd++;
        fds.set(fd, entry);
        view().setUint32(fdPtr, fd, true);
        return ERRNO.SUCCESS;
      });
    },
    path_filestat_get(dirFd, flags, pathPtr, pathLen, ptr) {
      const path = pathAt(dirFd, pathPtr, pathLen);
      if (path === null) return ERRNO.BADF;
      return attempt(() => {
        writeFilestat(ptr, flags & LOOKUP_SYMLINK_FOLLOW ? fs.statSync(path) : fs.lstatSync(path));
        return ERRNO.SUCCESS;
      });
    },
    path_readlink(dirFd, pathPtr, pathLen, bufPtr, bufLen, usedPtr) {
      const path = pathAt(dirFd, pathPtr, pathLen);
      if (path === null) return ERRNO.BADF;
      return attempt(() => {
        const target = encoder.encode(fs.readlinkSync(path)).subarray(0, bufLen);
        view();
        u8.set(target, bufPtr);
        dv.setUint32(usedPtr, target.length, true);
        return ERRNO.SUCCESS;
      });
    },
    path_create_directory() { return ERRNO.ROFS; },
  };

  return { imports, bind(instanceMemory) { memory = instanceMemory; } };
}

module.exports = { createWasi };
