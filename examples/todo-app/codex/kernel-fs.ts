// One directory of a wasm-term guest's filesystem, served by the toolkit's kernel.
//
// wasm-term's WASI host (wasm-term/host/wasi.ts) keeps a guest's files in a tree
// of its own, in the guest's Worker. The app's source, its dependency image and
// its dev server live in the toolkit's kernel (crates/bat-kernel), in shared
// memory. For codex to edit what Vite serves there must be one copy, so this
// file takes the WASI `path_*` / `fd_*` imports wasm-term built and puts a
// second filesystem below one absolute path (`/workspace`): a call whose path
// resolves there, or whose descriptor was opened there, is a kernel call made
// right here, in the guest's Worker, which is attached to the kernel like any
// process worker. Everything else (codex's home, /tmp, the terminal, sockets)
// goes to wasm-term's own implementation untouched.
//
// What that buys: a write by codex is in the kernel when the call returns, the
// kernel's watch tells Vite, and a read by codex sees whatever Vite, OpenCode
// or a `node` child wrote last. There is no second copy to go stale.
//
// Not covered, and answered with an error instead of something wrong:
//   - rename or link between the two filesystems: EXDEV
//   - a path that leaves the mount through `..` relative to a descriptor opened
//     inside it: ENOTCAPABLE (wasi-libc resolves from the `/` preopen, so a
//     guest built on it does not do this)
//   - a symlink in wasm-term's tree that points into the mount is not followed
//     into it (paths are compared as text)
//   - fd_renumber of a mounted descriptor: ENOTSUP
//   - poll_oneoff on a mounted file: not routed (regular files are never polled
//     by tokio or std)
import { K_DIR, K_FILE, K_SYMLINK, O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY, type Kernel, type Stat } from '../../../runtime/src/kernel/kernel'

// WASI preview1 errno, and the kernel's (Linux numbering) on the left.
const W = { SUCCESS: 0, ACCES: 2, AGAIN: 6, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, LOOP: 32, NAMETOOLONG: 37, NOENT: 44, NOMEM: 48, NOSPC: 51, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, PERM: 63, PIPE: 64, ROFS: 69, SPIPE: 70, XDEV: 75, NOTCAPABLE: 76 } as const
const FROM_LINUX: Record<number, number> = {
  1: W.PERM, 2: W.NOENT, 5: W.IO, 9: W.BADF, 11: W.AGAIN, 12: W.NOMEM, 13: W.ACCES, 17: W.EXIST, 18: W.XDEV, 20: W.NOTDIR, 21: W.ISDIR,
  22: W.INVAL, 28: W.NOSPC, 29: W.SPIPE, 30: W.ROFS, 32: W.PIPE, 36: W.NAMETOOLONG, 38: W.NOSYS, 39: W.NOTEMPTY, 40: W.LOOP,
}
const FILETYPE_DIRECTORY = 3, FILETYPE_REGULAR = 4, FILETYPE_SYMLINK = 7
const OFLAG_CREAT = 1, OFLAG_DIRECTORY = 2, OFLAG_EXCL = 4, OFLAG_TRUNC = 8
const FDFLAG_APPEND = 1
const RIGHT_FD_READ = 1n << 1n, RIGHT_FD_WRITE = 1n << 6n
const RIGHTS_ALL = (1n << 30n) - 1n
const LOOKUP_SYMLINK_FOLLOW = 1
/** Mounted descriptors are numbered from here, far above anything wasm-term hands out (it counts up from 4). */
const FD_BASE = 1 << 20

type Mounted =
  | { kind: 'file'; path: string; kfd: number; flags: number }
  | { kind: 'dir'; path: string; flags: number; listing?: { name: string; kind: number }[] }

type Imports = Record<string, (...args: any[]) => number>

export interface KernelMount {
  /** Replaces the filesystem entries of `imports.wasi_snapshot_preview1`. */
  install(imports: WebAssembly.Imports): void
  setMemory(memory: WebAssembly.Memory): void
  /** Calls served by the kernel so far, and the last failure that was not a plain errno (a bug here). */
  stats(): { calls: number }
}

export function createKernelMount(k: Kernel, mount: string): KernelMount {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let memory: WebAssembly.Memory
  let calls = 0
  const view = () => new DataView(memory.buffer)
  const bytes = (ptr: number, len: number) => new Uint8Array(memory.buffer, ptr >>> 0, len >>> 0)
  const text = (ptr: number, len: number) => decoder.decode(bytes(ptr, len))

  const mounted = new Map<number, Mounted>()
  let nextFd = FD_BASE
  /** Absolute paths of the directories wasm-term has open, so that a path relative to one can be placed. 3 is its `/` preopen. */
  const outside = new Map<number, string>([[3, '/']])

  const inside = (path: string) => path === mount || path.startsWith(`${mount}/`)
  function join(base: string, rel: string): string {
    const parts = rel.startsWith('/') ? [] : base.split('/').filter(Boolean)
    for (const part of rel.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    return `/${parts.join('/')}`
  }
  /** Where `(dirFd, path)` is: an absolute path in the mount, 'outside', or an errno. */
  function place(dirFd: number, pathPtr: number, pathLen: number): string | 'outside' | number {
    const own = mounted.get(dirFd)
    if (own) {
      if (own.kind !== 'dir') return W.NOTDIR
      const path = join(own.path, text(pathPtr, pathLen))
      return inside(path) ? path : W.NOTCAPABLE
    }
    const base = outside.get(dirFd)
    if (base === undefined) return 'outside'
    const path = join(base, text(pathPtr, pathLen))
    return inside(path) ? path : 'outside'
  }
  /** Runs a kernel call; a KernelError becomes its WASI errno. */
  function sys(fn: () => number | void): number {
    calls++
    try {
      return fn() ?? W.SUCCESS
    } catch (error) {
      const errno = (error as { errno?: number })?.errno
      if (typeof errno === 'number' && errno > 0) return FROM_LINUX[errno] ?? W.IO
      console.error('codex kernel mount:', error)
      return W.IO
    }
  }

  const filetype = (kind: number) => (kind === K_DIR ? FILETYPE_DIRECTORY : kind === K_SYMLINK ? FILETYPE_SYMLINK : FILETYPE_REGULAR)
  const ns = (ms: number) => BigInt(Math.round(ms * 1e6))
  function writeFilestat(ptr: number, st: Stat): void {
    const v = view()
    v.setBigUint64(ptr, 2n, true) // a device of its own: not wasm-term's tree
    v.setBigUint64(ptr + 8, BigInt(st.ino), true)
    v.setUint8(ptr + 16, filetype(st.kind))
    v.setBigUint64(ptr + 24, BigInt(Math.max(1, st.nlink)), true)
    v.setBigUint64(ptr + 32, BigInt(st.size), true)
    v.setBigUint64(ptr + 40, ns(st.mtimeMs), true)
    v.setBigUint64(ptr + 48, ns(st.mtimeMs), true)
    v.setBigUint64(ptr + 56, ns(st.ctimeMs), true)
  }
  const iovecs = (ptr: number, count: number) => {
    const v = view()
    return Array.from({ length: count }, (_, index) => ({ ptr: v.getUint32(ptr + index * 8, true), len: v.getUint32(ptr + index * 8 + 4, true) }))
  }
  function read(fd: Extract<Mounted, { kind: 'file' }>, iovsPtr: number, iovsLen: number, nreadPtr: number, pos?: number): number {
    return sys(() => {
      let total = 0
      for (const vec of iovecs(iovsPtr, iovsLen)) {
        if (vec.len === 0) continue
        // Through a buffer of our own: the kernel binding copies out of its memory into whatever it is given.
        const chunk = new Uint8Array(vec.len)
        const got = k.read(fd.kfd, chunk, pos === undefined ? undefined : pos + total)
        bytes(vec.ptr, got).set(chunk.subarray(0, got))
        total += got
        if (got < vec.len) break
      }
      view().setUint32(nreadPtr, total, true)
    })
  }
  function write(fd: Extract<Mounted, { kind: 'file' }>, iovsPtr: number, iovsLen: number, nwrittenPtr: number, pos?: number): number {
    return sys(() => {
      let total = 0
      for (const vec of iovecs(iovsPtr, iovsLen)) {
        if (vec.len === 0) continue
        total += k.write(fd.kfd, bytes(vec.ptr, vec.len).slice(), pos === undefined ? undefined : pos + total)
      }
      view().setUint32(nwrittenPtr, total, true)
    })
  }

  function install(imports: WebAssembly.Imports): void {
    const wasi = imports.wasi_snapshot_preview1 as Imports
    const inner: Imports = { ...wasi }
    const file = (fd: number) => {
      const entry = mounted.get(fd)
      return entry?.kind === 'file' ? entry : undefined
    }
    /** `name(fd, ...)`: ours when the descriptor is mounted, wasm-term's otherwise. */
    const onFd = (name: string, ours: (entry: Mounted, ...args: any[]) => number) => {
      wasi[name] = (fd: number, ...args: any[]) => {
        const entry = mounted.get(fd)
        return entry ? ours(entry, ...args) : inner[name]!(fd, ...args)
      }
    }
    /** `name(dirFd, <flags>, pathPtr, pathLen, ...)`: ours when the path is in the mount. `at` is where the path pointer is among the arguments after dirFd. */
    const onPath = (name: string, at: number, ours: (path: string, ...args: any[]) => number) => {
      wasi[name] = (dirFd: number, ...args: any[]) => {
        const where = place(dirFd, args[at], args[at + 1])
        if (typeof where === 'number') return where
        return where === 'outside' ? inner[name]!(dirFd, ...args) : ours(where, ...args)
      }
    }

    onFd('fd_read', (entry, iovsPtr, iovsLen, nreadPtr) => (entry.kind === 'file' ? read(entry, iovsPtr, iovsLen, nreadPtr) : W.ISDIR))
    onFd('fd_pread', (entry, iovsPtr, iovsLen, offset: bigint, nreadPtr) => (entry.kind === 'file' ? read(entry, iovsPtr, iovsLen, nreadPtr, Number(offset)) : W.ISDIR))
    onFd('fd_write', (entry, iovsPtr, iovsLen, nwrittenPtr) => (entry.kind === 'file' ? write(entry, iovsPtr, iovsLen, nwrittenPtr) : W.ISDIR))
    onFd('fd_pwrite', (entry, iovsPtr, iovsLen, offset: bigint, nwrittenPtr) => (entry.kind === 'file' ? write(entry, iovsPtr, iovsLen, nwrittenPtr, Number(offset)) : W.ISDIR))
    onFd('fd_seek', (entry, offset: bigint, whence: number, newOffsetPtr) => {
      if (entry.kind !== 'file') return W.SPIPE
      return sys(() => view().setBigUint64(newOffsetPtr, BigInt(k.seek(entry.kfd, Number(offset), whence as 0 | 1 | 2)), true))
    })
    onFd('fd_tell', (entry, offsetPtr) => {
      if (entry.kind !== 'file') return W.SPIPE
      return sys(() => view().setBigUint64(offsetPtr, BigInt(k.seek(entry.kfd, 0, 1)), true))
    })
    wasi.fd_close = (fd: number) => {
      const entry = mounted.get(fd)
      if (!entry) {
        const rc = inner.fd_close!(fd)
        if (rc === W.SUCCESS) outside.delete(fd)
        return rc
      }
      mounted.delete(fd)
      return entry.kind === 'file' ? sys(() => k.close(entry.kfd)) : W.SUCCESS
    }
    wasi.fd_renumber = (from: number, to: number) => {
      if (mounted.has(from) || mounted.has(to)) return W.NOTSUP
      const rc = inner.fd_renumber!(from, to)
      if (rc === W.SUCCESS) {
        const path = outside.get(from)
        outside.delete(from)
        if (path !== undefined) outside.set(to, path)
        else outside.delete(to)
      }
      return rc
    }
    onFd('fd_fdstat_get', (entry, statPtr) => {
      const v = view()
      bytes(statPtr, 24).fill(0)
      v.setUint8(statPtr, entry.kind === 'dir' ? FILETYPE_DIRECTORY : FILETYPE_REGULAR)
      v.setUint16(statPtr + 2, entry.flags, true)
      v.setBigUint64(statPtr + 8, RIGHTS_ALL, true)
      v.setBigUint64(statPtr + 16, RIGHTS_ALL, true)
      return W.SUCCESS
    })
    onFd('fd_fdstat_set_flags', (entry, flags) => {
      entry.flags = flags
      return W.SUCCESS
    })
    onFd('fd_fdstat_set_rights', () => W.SUCCESS)
    onFd('fd_filestat_get', (entry, statPtr) => sys(() => writeFilestat(statPtr, entry.kind === 'file' ? k.fstat(entry.kfd) : k.stat(entry.path))))
    onFd('fd_filestat_set_size', (entry, size: bigint) => (entry.kind === 'file' ? sys(() => k.ftruncate(entry.kfd, Number(size))) : W.ISDIR))
    onFd('fd_filestat_set_times', () => W.SUCCESS)
    onFd('fd_advise', () => W.SUCCESS)
    onFd('fd_allocate', () => W.SUCCESS)
    // Durability is the kernel's journal (kerneld drains it to OPFS); nothing to do per descriptor.
    onFd('fd_datasync', () => W.SUCCESS)
    onFd('fd_sync', () => W.SUCCESS)
    onFd('fd_prestat_get', () => W.BADF)
    onFd('fd_prestat_dir_name', () => W.BADF)
    onFd('fd_readdir', (entry, bufPtr, bufLen, cookie: bigint, usedPtr) => {
      if (entry.kind !== 'dir') return W.NOTDIR
      return sys(() => {
        // One listing per pass over the directory, so that cookies mean the same thing in every call of the pass.
        if (cookie === 0n || !entry.listing) {
          entry.listing = [{ name: '.', kind: K_DIR }, { name: '..', kind: K_DIR }, ...k.readdir(entry.path).sort((a, b) => (a.name < b.name ? -1 : 1))]
        }
        let used = 0
        for (let index = Number(cookie); index < entry.listing.length && used < bufLen; index++) {
          const item = entry.listing[index]!
          const name = encoder.encode(item.name)
          const record = new Uint8Array(24 + name.length)
          const recordView = new DataView(record.buffer)
          recordView.setBigUint64(0, BigInt(index + 1), true)
          recordView.setBigUint64(8, BigInt(index + 1), true)
          recordView.setUint32(16, name.length, true)
          recordView.setUint8(20, filetype(item.kind))
          record.set(name, 24)
          const part = record.subarray(0, bufLen - used)
          bytes(bufPtr + used, part.length).set(part)
          used += part.length
        }
        view().setUint32(usedPtr, used, true)
      })
    })

    wasi.path_open = (dirFd: number, dirFlags: number, pathPtr: number, pathLen: number, oflags: number, rightsBase: bigint, rightsInheriting: bigint, fdFlags: number, fdPtr: number) => {
      const where = place(dirFd, pathPtr, pathLen)
      if (typeof where === 'number') return where
      if (where === 'outside') {
        const rc = inner.path_open!(dirFd, dirFlags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdFlags, fdPtr)
        const base = outside.get(dirFd)
        if (rc === W.SUCCESS && base !== undefined) outside.set(view().getUint32(fdPtr, true), join(base, text(pathPtr, pathLen)))
        return rc
      }
      return sys(() => {
        const follow = (dirFlags & LOOKUP_SYMLINK_FOLLOW) !== 0
        const st = k.tryStat(where, !follow)
        let entry: Mounted
        if (st?.kind === K_DIR) {
          if (oflags & OFLAG_CREAT && oflags & OFLAG_EXCL) return W.EXIST
          entry = { kind: 'dir', path: where, flags: fdFlags }
        } else {
          if (oflags & OFLAG_DIRECTORY) return st ? W.NOTDIR : W.NOENT
          const writes = (rightsBase & RIGHT_FD_WRITE) !== 0n || (oflags & (OFLAG_CREAT | OFLAG_TRUNC)) !== 0 || (fdFlags & FDFLAG_APPEND) !== 0
          const reads = (rightsBase & RIGHT_FD_READ) !== 0n || !writes
          const flags = (writes ? (reads ? O_RDWR : O_WRONLY) : O_RDONLY)
            | (oflags & OFLAG_CREAT ? O_CREAT : 0) | (oflags & OFLAG_EXCL ? O_EXCL : 0) | (oflags & OFLAG_TRUNC ? O_TRUNC : 0)
            | (fdFlags & FDFLAG_APPEND ? O_APPEND : 0) | (follow ? 0 : O_NOFOLLOW)
          entry = { kind: 'file', path: where, kfd: k.open(where, flags, 0o644), flags: fdFlags }
        }
        const fd = nextFd++
        mounted.set(fd, entry)
        view().setUint32(fdPtr, fd, true)
      })
    }
    onPath('path_create_directory', 0, path => sys(() => k.mkdir(path)))
    onPath('path_filestat_get', 1, (path, flags, _p, _n, statPtr) => sys(() => writeFilestat(statPtr, k.stat(path, (flags & LOOKUP_SYMLINK_FOLLOW) === 0))))
    onPath('path_filestat_set_times', 1, (path, flags) => sys(() => void k.stat(path, (flags & LOOKUP_SYMLINK_FOLLOW) === 0)))
    onPath('path_readlink', 0, (path, _p, _n, bufPtr, bufLen, usedPtr) => sys(() => {
      const target = encoder.encode(k.readlink(path)).subarray(0, bufLen)
      bytes(bufPtr, target.length).set(target)
      view().setUint32(usedPtr, target.length, true)
    }))
    onPath('path_remove_directory', 0, path => sys(() => k.rmdir(path)))
    onPath('path_unlink_file', 0, path => sys(() => (k.kindOf(path) === K_DIR ? W.ISDIR : k.unlink(path))))
    const two = (name: string, fromAt: (args: any[]) => [number, number, number], toAt: (args: any[]) => [number, number, number], ours: (from: string, to: string) => void) => {
      wasi[name] = (...args: any[]) => {
        const from = place(...fromAt(args))
        const to = place(...toAt(args))
        if (typeof from === 'number') return from
        if (typeof to === 'number') return to
        if (from === 'outside' && to === 'outside') return inner[name]!(...args)
        if (from === 'outside' || to === 'outside') return W.XDEV
        return sys(() => ours(from, to))
      }
    }
    // path_rename(oldFd, oldPtr, oldLen, newFd, newPtr, newLen); path_link(oldFd, oldFlags, oldPtr, oldLen, newFd, newPtr, newLen)
    two('path_rename', a => [a[0], a[1], a[2]], a => [a[3], a[4], a[5]], (from, to) => k.rename(from, to))
    two('path_link', a => [a[0], a[2], a[3]], a => [a[4], a[5], a[6]], (from, to) => k.link(from, to))
    // path_symlink(targetPtr, targetLen, dirFd, pathPtr, pathLen): the target is kept as written.
    wasi.path_symlink = (targetPtr: number, targetLen: number, dirFd: number, pathPtr: number, pathLen: number) => {
      const where = place(dirFd, pathPtr, pathLen)
      if (typeof where === 'number') return where
      if (where === 'outside') return inner.path_symlink!(targetPtr, targetLen, dirFd, pathPtr, pathLen)
      return sys(() => k.symlink(text(targetPtr, targetLen), where))
    }
    void K_FILE
  }

  return {
    install,
    setMemory(value) {
      memory = value
    },
    stats: () => ({ calls }),
  }
}
