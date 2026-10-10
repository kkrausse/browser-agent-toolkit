// `fs` and `fs/promises` over kernel calls. Every operation is one or a few
// synchronous Wasm calls into the shared kernel; the callback and promise
// forms run the same synchronous code and deliver the result asynchronously.
import {
  K_CHAR, K_DIR, K_FIFO, K_FILE, K_SOCKET, K_SYMLINK, O_APPEND, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_RDWR,
  O_TRUNC, O_WRONLY, type Kernel,
} from '../kernel/kernel'
import type { Runtime } from '../process/runtime'
import { registerBuiltin } from './registry'

const MESSAGES: Record<string, string> = {
  ENOENT: 'no such file or directory', EEXIST: 'file already exists', ENOTDIR: 'not a directory', EISDIR: 'illegal operation on a directory',
  ENOTEMPTY: 'directory not empty', EACCES: 'permission denied', EPERM: 'operation not permitted', EBADF: 'bad file descriptor',
  EINVAL: 'invalid argument', EXDEV: 'cross-device link not permitted', ELOOP: 'too many symbolic links encountered', EMFILE: 'too many open files',
  ENAMETOOLONG: 'name too long', EROFS: 'read-only file system', ESPIPE: 'invalid seek', EPIPE: 'broken pipe', EAGAIN: 'resource temporarily unavailable',
  ENOSYS: 'function not implemented', ENOMEM: 'not enough memory', EIO: 'i/o error', ERANGE: 'result too large', ENOTSUP: 'operation not supported',
}

const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const S_IFIFO = 0o010000
const S_IFSOCK = 0o140000
const S_IFCHR = 0o020000
const KIND_MODE = [S_IFREG, S_IFDIR, S_IFLNK, S_IFIFO, S_IFSOCK, S_IFCHR]
const UV_DIRENT = { [K_FILE]: 1, [K_DIR]: 2, [K_SYMLINK]: 3, [K_FIFO]: 4, [K_SOCKET]: 5, [K_CHAR]: 6 } as Record<number, number>

export const constants = {
  UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2, O_RDONLY, O_WRONLY, O_RDWR, UV_DIRENT_UNKNOWN: 0, UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2,
  UV_DIRENT_LINK: 3, UV_DIRENT_FIFO: 4, UV_DIRENT_SOCKET: 5, UV_DIRENT_CHAR: 6, UV_DIRENT_BLOCK: 7, EXTENSIONLESS_FORMAT_JAVASCRIPT: 0,
  EXTENSIONLESS_FORMAT_WASM: 1, S_IFMT, S_IFREG, S_IFDIR, S_IFCHR, S_IFBLK: 0o060000, S_IFIFO, S_IFLNK, S_IFSOCK, O_CREAT, O_EXCL,
  UV_FS_O_FILEMAP: 0, O_NOCTTY: 0o400, O_TRUNC, O_APPEND, O_DIRECTORY, O_NOATIME: 0o1000000, O_NOFOLLOW, O_SYNC: 0o4010000, O_DSYNC: 0o10000,
  O_DIRECT: 0o40000, O_NONBLOCK, S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100, S_IRWXG: 0o70, S_IRGRP: 0o40, S_IWGRP: 0o20,
  S_IXGRP: 0o10, S_IRWXO: 0o7, S_IROTH: 0o4, S_IWOTH: 0o2, S_IXOTH: 0o1, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, UV_FS_COPYFILE_EXCL: 1,
  COPYFILE_EXCL: 1, UV_FS_COPYFILE_FICLONE: 2, COPYFILE_FICLONE: 2, UV_FS_COPYFILE_FICLONE_FORCE: 4, COPYFILE_FICLONE_FORCE: 4,
}

export function createFs(rt: Runtime): any {
  const k: Kernel = rt.kernel
  const loop = rt.loop
  const Buffer = rt.require('buffer').Buffer
  const utf8 = new TextDecoder('utf-8', { ignoreBOM: true })
  const encoder = new TextEncoder()

  // ---- errors ----
  function fsError(e: any, syscall?: string, path?: unknown, dest?: unknown): Error {
    if (!e || typeof e.errno !== 'number' || typeof e.code !== 'string' || e.bat) return e
    const call = syscall ?? e.syscall
    const p = path !== undefined ? String(path) : e.path
    let message = `${e.code}: ${MESSAGES[e.code] ?? 'unknown error'}, ${call}`
    if (p !== undefined) message += ` '${p}'`
    if (dest !== undefined) message += ` -> '${dest}'`
    const err: any = new Error(message)
    err.errno = -e.errno
    err.code = e.code
    err.syscall = call
    if (p !== undefined) err.path = p
    if (dest !== undefined) err.dest = String(dest)
    err.bat = true
    Object.defineProperty(err, 'bat', { enumerable: false })
    Error.captureStackTrace?.(err, fsError)
    return err
  }
  const errnoError = (code: string, errno: number, syscall: string, path?: string) => fsError({ code, errno, syscall, path }, syscall, path)
  const argError = (name: string, expected: string, value: unknown) =>
    Object.assign(new TypeError(`The "${name}" argument must be ${expected}. Received ${value === null ? 'null' : typeof value === 'object' ? `an instance of ${(value as object).constructor?.name}` : `type ${typeof value} (${String(value)})`}`), { code: 'ERR_INVALID_ARG_TYPE' })

  // ---- argument helpers ----
  function toPath(p: unknown, name = 'path'): string {
    if (typeof p === 'string') {
      if (p.indexOf('\0') !== -1) throw Object.assign(new TypeError(`The argument '${name}' must be a string, Uint8Array, or URL without null bytes. Received ${JSON.stringify(p)}`), { code: 'ERR_INVALID_ARG_VALUE' })
      return p
    }
    if (p instanceof URL) {
      if (p.protocol !== 'file:') throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' })
      return decodeURIComponent(p.pathname)
    }
    if (p instanceof Uint8Array) return utf8.decode(p)
    throw argError(name, 'of type string or an instance of Buffer or URL', p)
  }
  function toBytes(data: unknown, encoding?: string): Uint8Array {
    if (typeof data === 'string') return !encoding || encoding === 'utf8' || encoding === 'utf-8' ? encoder.encode(data) : Buffer.from(data, encoding)
    if (ArrayBuffer.isView(data)) return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) return new Uint8Array(data)
    throw argError('data', 'of type string or an instance of Buffer, TypedArray, or DataView', data)
  }
  function decode(bytes: Uint8Array, encoding: string | null | undefined): any {
    if (!encoding || encoding === 'buffer') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (encoding === 'utf8' || encoding === 'utf-8') return utf8.decode(bytes)
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding)
  }
  const encodingOf = (opts: unknown): string | undefined => (typeof opts === 'string' ? opts : (opts as any)?.encoding ?? undefined)
  function parseFlags(flags: unknown): number {
    if (flags === undefined || flags === null) return O_RDONLY
    if (typeof flags === 'number') return flags
    switch (flags) {
      case 'r': case 'rs': case 'sr': return O_RDONLY
      case 'r+': case 'rs+': case 'sr+': return O_RDWR
      case 'w': return O_TRUNC | O_CREAT | O_WRONLY
      case 'wx': case 'xw': return O_TRUNC | O_CREAT | O_WRONLY | O_EXCL
      case 'w+': return O_TRUNC | O_CREAT | O_RDWR
      case 'wx+': case 'xw+': return O_TRUNC | O_CREAT | O_RDWR | O_EXCL
      case 'a': case 'as': case 'sa': return O_APPEND | O_CREAT | O_WRONLY
      case 'ax': case 'xa': return O_APPEND | O_CREAT | O_WRONLY | O_EXCL
      case 'a+': case 'as+': case 'sa+': return O_APPEND | O_CREAT | O_RDWR
      case 'ax+': case 'xa+': return O_APPEND | O_CREAT | O_RDWR | O_EXCL
    }
    throw Object.assign(new TypeError(`The argument 'flags' is invalid. Received ${JSON.stringify(flags)}`), { code: 'ERR_INVALID_ARG_VALUE' })
  }
  const parseMode = (mode: unknown, def: number): number => (mode === undefined || mode === null ? def : typeof mode === 'string' ? parseInt(mode, 8) : (mode as number))
  const toMs = (t: unknown): number => {
    if (t instanceof Date) return t.getTime()
    if (typeof t === 'bigint') return Number(t) * 1000
    const n = Number(t)
    return Number.isFinite(n) ? n * 1000 : Date.now()
  }

  // ---- Stats, Dirent ----
  class Stats {
    dev = 0; mode = 0; nlink = 0; uid = 1000; gid = 1000; rdev = 0; blksize = 4096; ino = 0; size = 0; blocks = 0
    atimeMs = 0; mtimeMs = 0; ctimeMs = 0; birthtimeMs = 0
    isFile() { return (this.mode & S_IFMT) === S_IFREG }
    isDirectory() { return (this.mode & S_IFMT) === S_IFDIR }
    isSymbolicLink() { return (this.mode & S_IFMT) === S_IFLNK }
    isFIFO() { return (this.mode & S_IFMT) === S_IFIFO }
    isSocket() { return (this.mode & S_IFMT) === S_IFSOCK }
    isCharacterDevice() { return (this.mode & S_IFMT) === S_IFCHR }
    isBlockDevice() { return false }
    get atime() { return new Date(this.atimeMs) }
    get mtime() { return new Date(this.mtimeMs) }
    get ctime() { return new Date(this.ctimeMs) }
    get birthtime() { return new Date(this.birthtimeMs) }
  }
  for (const key of ['atime', 'mtime', 'ctime', 'birthtime']) {
    const d = Object.getOwnPropertyDescriptor(Stats.prototype, key)!
    Object.defineProperty(Stats.prototype, key, { ...d, enumerable: true, set(v) { Object.defineProperty(this, key, { value: v, writable: true, enumerable: true, configurable: true }) } })
  }
  /** Build a Stats from the kernel's scratch stat (valid until the next kernel call). */
  function takeStat(bigint?: boolean): any {
    const st = k.st
    const s = new Stats()
    s.dev = st.dev
    s.mode = KIND_MODE[st.kind] | st.mode
    s.nlink = st.nlink
    s.ino = st.ino
    s.size = st.size
    s.blocks = Math.ceil(st.size / 512)
    s.atimeMs = s.mtimeMs = st.mtimeMs
    s.ctimeMs = st.ctimeMs
    s.birthtimeMs = st.birthtimeMs
    return bigint ? toBigStats(s) : s
  }
  function toBigStats(s: Stats): any {
    const b: any = Object.create(Stats.prototype)
    for (const key of ['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'ino', 'size', 'blocks'] as const) b[key] = BigInt(Math.trunc(s[key]))
    for (const key of ['atime', 'mtime', 'ctime', 'birthtime'] as const) {
      b[`${key}Ms`] = BigInt(Math.trunc((s as any)[`${key}Ms`]))
      b[`${key}Ns`] = BigInt(Math.trunc((s as any)[`${key}Ms`])) * 1000000n
      Object.defineProperty(b, key, { value: new Date((s as any)[`${key}Ms`]), enumerable: true, writable: true, configurable: true })
    }
    b.isFile = () => s.isFile()
    b.isDirectory = () => s.isDirectory()
    b.isSymbolicLink = () => s.isSymbolicLink()
    return b
  }
  const kType = Symbol('type')
  class Dirent {
    name: any
    parentPath: string
    path: string;
    [kType]: number
    constructor(name: any, type: number, parentPath: string) {
      this.name = name
      this.parentPath = parentPath
      this.path = parentPath
      this[kType] = type
    }
    isFile() { return this[kType] === 1 }
    isDirectory() { return this[kType] === 2 }
    isSymbolicLink() { return this[kType] === 3 }
    isFIFO() { return this[kType] === 4 }
    isSocket() { return this[kType] === 5 }
    isCharacterDevice() { return this[kType] === 6 }
    isBlockDevice() { return false }
  }

  // ---- by path ----
  function statSync(path: unknown, options?: { bigint?: boolean; throwIfNoEntry?: boolean }): any {
    const p = toPath(path)
    const rc = k.statRaw(p, false)
    if (rc === 0) return takeStat(options?.bigint)
    if ((rc === -2 || rc === -20) && options?.throwIfNoEntry === false) return undefined
    throw errnoError(rc === -2 ? 'ENOENT' : codeOf(rc), -rc, 'stat', p)
  }
  function lstatSync(path: unknown, options?: { bigint?: boolean; throwIfNoEntry?: boolean }): any {
    const p = toPath(path)
    const rc = k.statRaw(p, true)
    if (rc === 0) return takeStat(options?.bigint)
    if ((rc === -2 || rc === -20) && options?.throwIfNoEntry === false) return undefined
    throw errnoError(codeOf(rc), -rc, 'lstat', p)
  }
  const CODES: Record<number, string> = { 1: 'EPERM', 2: 'ENOENT', 5: 'EIO', 9: 'EBADF', 11: 'EAGAIN', 12: 'ENOMEM', 13: 'EACCES', 17: 'EEXIST', 18: 'EXDEV', 20: 'ENOTDIR', 21: 'EISDIR', 22: 'EINVAL', 24: 'EMFILE', 29: 'ESPIPE', 30: 'EROFS', 32: 'EPIPE', 34: 'ERANGE', 36: 'ENAMETOOLONG', 38: 'ENOSYS', 39: 'ENOTEMPTY', 40: 'ELOOP' }
  const codeOf = (rc: number) => CODES[-rc] ?? `E${-rc}`
  /** Run a kernel call, converting its error. */
  function sys<T>(syscall: string, path: unknown, fn: () => T, dest?: unknown): T {
    try {
      return fn()
    } catch (e) {
      throw fsError(e, syscall, path, dest)
    }
  }
  function existsSync(path: unknown): boolean {
    try {
      return k.kindOf(toPath(path)) !== -1
    } catch {
      return false
    }
  }
  function accessSync(path: unknown, mode = 0): void {
    const p = toPath(path)
    const rc = k.statRaw(p, false)
    if (rc !== 0) throw errnoError(codeOf(rc), -rc, 'access', p)
    void mode // no users and no permission checks in the kernel
  }
  function readFileSync(path: unknown, options?: any): any {
    const encoding = encodingOf(options)
    if (typeof path === 'number') {
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const buf = new Uint8Array(65536)
        const n = sys('read', undefined, () => k.read(path, buf))
        if (n === 0) break
        chunks.push(n === buf.length ? buf : buf.subarray(0, n))
        total += n
      }
      const all = new Uint8Array(total)
      let off = 0
      for (const c of chunks) {
        all.set(c, off)
        off += c.length
      }
      return decode(all, encoding)
    }
    const p = toPath(path)
    return decode(sys('open', p, () => k.readFile(p)), encoding)
  }
  function writeFileSync(path: unknown, data: unknown, options?: any): void {
    const o = typeof options === 'string' ? { encoding: options } : options ?? {}
    const bytes = toBytes(data, o.encoding)
    if (typeof path === 'number') {
      let off = 0
      while (off < bytes.length) off += sys('write', undefined, () => k.write(path, off ? bytes.subarray(off) : bytes))
      return
    }
    const p = toPath(path)
    const flags = parseFlags(o.flag ?? 'w')
    if (flags & O_APPEND) sys('open', p, () => k.writeFile(p, bytes, { mode: parseMode(o.mode, 0o666) & ~0o22, append: true, excl: !!(flags & O_EXCL) }))
    else if (flags & O_TRUNC || !(flags & 3)) sys('open', p, () => k.writeFile(p, bytes, { mode: parseMode(o.mode, 0o666) & ~0o22, excl: !!(flags & O_EXCL) }))
    else {
      // 'r+': write at the start without truncating
      const fd = openSync(p, flags, o.mode)
      try {
        writeSync(fd, bytes, 0, bytes.length, 0)
      } finally {
        closeSync(fd)
      }
    }
  }
  function appendFileSync(path: unknown, data: unknown, options?: any): void {
    const o = typeof options === 'string' ? { encoding: options } : options ?? {}
    writeFileSync(path, data, { ...o, flag: o.flag ?? 'a' })
  }
  function readdirSync(path: unknown, options?: any): any[] {
    const p = toPath(path)
    const o = typeof options === 'string' ? { encoding: options } : options ?? {}
    const asBuffer = o.encoding === 'buffer'
    const name = (n: string) => (asBuffer ? Buffer.from(n) : n)
    if (!o.recursive) {
      const entries = sys('scandir', p, () => k.readdir(p))
      if (o.withFileTypes) return entries.map((e) => new Dirent(name(e.name), UV_DIRENT[e.kind] ?? 0, p))
      return entries.map((e) => name(e.name))
    }
    const out: any[] = []
    const queue: [string, string][] = [[p, '']]
    for (let i = 0; i < queue.length; i++) {
      const [dir, rel] = queue[i]
      const entries = sys('scandir', dir, () => k.readdir(dir))
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name
        out.push(o.withFileTypes ? new Dirent(name(e.name), UV_DIRENT[e.kind] ?? 0, dir) : name(r))
        if (e.kind === K_DIR) queue.push([`${dir}/${e.name}`, r])
      }
    }
    return out
  }
  function mkdirSync(path: unknown, options?: any): string | undefined {
    const p = toPath(path)
    const o = typeof options === 'number' || typeof options === 'string' ? { mode: options } : options ?? {}
    const mode = parseMode(o.mode, 0o777) & ~0o22
    if (!o.recursive) {
      sys('mkdir', p, () => k.mkdir(p, { mode }))
      return undefined
    }
    // The return value is the first directory that had to be created.
    let first: string | undefined
    let probe = normalize(p)
    while (probe && k.kindOf(probe) === -1) {
      first = probe
      const i = probe.lastIndexOf('/')
      if (i <= 0) break
      probe = probe.slice(0, i)
    }
    sys('mkdir', p, () => k.mkdir(p, { mode, recursive: true }))
    return first
  }
  function normalize(p: string): string {
    if (!p.startsWith('/')) p = `${k.getcwd()}/${p}`
    const out: string[] = []
    for (const part of p.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') out.pop()
      else out.push(part)
    }
    return `/${out.join('/')}`
  }
  function rmdirSync(path: unknown, options?: any): void {
    const p = toPath(path)
    if (options?.recursive) return rmSync(p, { recursive: true, force: false })
    sys('rmdir', p, () => k.rmdir(p))
  }
  function unlinkSync(path: unknown): void {
    const p = toPath(path)
    sys('unlink', p, () => k.unlink(p))
  }
  function removeTree(p: string): void {
    for (const e of k.readdir(p)) {
      const child = `${p}/${e.name}`
      if (e.kind === K_DIR) removeTree(child)
      else k.unlink(child)
    }
    k.rmdir(p)
  }
  function rmSync(path: unknown, options?: any): void {
    const p = toPath(path)
    const rc = k.statRaw(p, true)
    if (rc !== 0) {
      if (options?.force && (rc === -2 || rc === -20)) return
      throw errnoError(codeOf(rc), -rc, 'rm', p)
    }
    if (k.st.kind !== K_DIR) return sys('rm', p, () => k.unlink(p))
    if (!options?.recursive) {
      throw Object.assign(new Error(`Path is a directory: rm returned EISDIR (is a directory) ${p}`), { code: 'ERR_FS_EISDIR', errno: 21, syscall: 'rm', path: p })
    }
    sys('rm', p, () => removeTree(p))
  }
  function copyTree(src: string, dest: string, o: any): void {
    const rc = k.statRaw(src, !o.dereference)
    if (rc !== 0) throw errnoError(codeOf(rc), -rc, 'cp', src)
    const kind = k.st.kind
    const mode = k.st.mode
    if (o.filter && !o.filter(src, dest)) return
    if (kind === K_DIR) {
      if (!o.recursive) throw Object.assign(new Error(`Recursive option not enabled, cannot copy a directory: cp returned EISDIR (${src} is a directory (not copied))`), { code: 'ERR_FS_EISDIR' })
      k.mkdir(dest, { recursive: true, mode: mode || 0o755 })
      for (const e of k.readdir(src)) copyTree(`${src}/${e.name}`, `${dest}/${e.name}`, o)
    } else if (kind === K_SYMLINK) {
      if (k.kindOf(dest) !== -1) k.unlink(dest)
      k.symlink(k.readlink(src), dest)
    } else {
      const exists = k.kindOf(dest) !== -1
      if (exists && o.errorOnExist && !o.force) throw Object.assign(new Error(`Target already exists: cp returned EEXIST (${dest} already exists)`), { code: 'ERR_FS_CP_EEXIST' })
      if (exists && o.force === false) return
      k.writeFile(dest, k.readFile(src), { mode })
    }
  }
  function cpSync(src: unknown, dest: unknown, options?: any): void {
    const s = toPath(src, 'src')
    const d = toPath(dest, 'dest')
    sys('cp', s, () => copyTree(s, d, { force: true, ...options }), d)
  }
  function renameSync(from: unknown, to: unknown): void {
    const a = toPath(from, 'oldPath')
    const b = toPath(to, 'newPath')
    try {
      k.rename(a, b)
    } catch (e: any) {
      if (e.code !== 'EXDEV') throw fsError(e, 'rename', a, b)
      // A directory that lives (partly) in the read-only image: copy, then remove.
      sys('rename', a, () => {
        copyTree(a, b, { recursive: true, force: true })
        removeTree(a)
      }, b)
    }
  }
  function copyFileSync(src: unknown, dest: unknown, mode = 0): void {
    const s = toPath(src, 'src')
    const d = toPath(dest, 'dest')
    sys('copyfile', s, () => {
      const data = k.readFile(s)
      const perm = k.st.mode
      k.writeFile(d, data, { mode: perm || 0o644, excl: !!(mode & 1) })
    }, d)
  }
  function symlinkSync(target: unknown, path: unknown): void {
    const t = toPath(target, 'target')
    const p = toPath(path)
    sys('symlink', t, () => k.symlink(t, p), p)
  }
  function linkSync(existing: unknown, path: unknown): void {
    const a = toPath(existing, 'existingPath')
    const b = toPath(path, 'newPath')
    sys('link', a, () => k.link(a, b), b)
  }
  function readlinkSync(path: unknown, options?: any): any {
    const p = toPath(path)
    const t = sys('readlink', p, () => k.readlink(p))
    return encodingOf(options) === 'buffer' ? Buffer.from(t) : t
  }
  const realpathSync: any = (path: unknown, options?: any): any => {
    const p = toPath(path)
    const r = sys('realpath', p, () => k.realpath(p))
    return encodingOf(options) === 'buffer' ? Buffer.from(r) : r
  }
  realpathSync.native = realpathSync
  function chmodSync(path: unknown, mode: unknown): void {
    const p = toPath(path)
    sys('chmod', p, () => k.chmod(p, parseMode(mode, 0o644)))
  }
  function lchmodSync(path: unknown, mode: unknown): void {
    const p = toPath(path)
    sys('lchmod', p, () => k.chmod(p, parseMode(mode, 0o644), true))
  }
  function chownSync(path: unknown): void {
    accessSync(path)
  }
  function utimesSync(path: unknown, _atime: unknown, mtime: unknown): void {
    const p = toPath(path)
    sys('utime', p, () => k.utimes(p, toMs(mtime)))
  }
  function lutimesSync(path: unknown, _atime: unknown, mtime: unknown): void {
    const p = toPath(path)
    sys('lutime', p, () => k.utimes(p, toMs(mtime), true))
  }
  function truncateSync(path: unknown, len = 0): void {
    const p = toPath(path)
    sys('truncate', p, () => k.truncate(p, len))
  }
  function mkdtempSync(prefix: unknown, options?: any): any {
    const base = toPath(prefix, 'prefix')
    for (let attempt = 0; attempt < 100; attempt++) {
      let suffix = ''
      for (let i = 0; i < 6; i++) suffix += 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]
      const p = base + suffix
      try {
        k.mkdir(p, { mode: 0o700 })
        return encodingOf(options) === 'buffer' ? Buffer.from(p) : p
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw fsError(e, 'mkdtemp', `${base}XXXXXX`)
      }
    }
    throw errnoError('EEXIST', 17, 'mkdtemp', `${base}XXXXXX`)
  }
  function statfsSync(_path: unknown, options?: any): any {
    const v = { type: 0x858458f6, bsize: 4096, blocks: 1 << 20, bfree: 1 << 19, bavail: 1 << 19, files: 1 << 20, ffree: 1 << 19 }
    return options?.bigint ? Object.fromEntries(Object.entries(v).map(([key, n]) => [key, BigInt(n)])) : v
  }

  // ---- by fd ----
  function openSync(path: unknown, flags?: unknown, mode?: unknown): number {
    const p = toPath(path)
    return sys('open', p, () => k.open(p, parseFlags(flags), parseMode(mode, 0o666) & ~0o22))
  }
  function closeSync(fd: number): void {
    sys('close', undefined, () => k.close(fd))
  }
  function readSync(fd: number, buffer: any, offsetOrOptions?: any, length?: number, position?: number | bigint | null): number {
    let offset = 0
    if (offsetOrOptions !== null && typeof offsetOrOptions === 'object') {
      ;({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOptions)
    } else if (offsetOrOptions !== undefined) offset = offsetOrOptions
    length ??= buffer.byteLength - offset
    if (length === 0) return 0
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length)
    const pos = position === null || position === undefined || position === -1 ? undefined : Number(position)
    return sys('read', undefined, () => k.read(fd, view, pos))
  }
  function writeSync(fd: number, data: any, a?: any, b?: any, c?: any): number {
    let bytes: Uint8Array
    let position: number | undefined
    if (typeof data === 'string') {
      // (fd, string, position?, encoding?)
      bytes = toBytes(data, typeof b === 'string' ? b : undefined)
      position = typeof a === 'number' ? a : undefined
    } else {
      let offset = 0
      let length: number | undefined
      if (a !== null && typeof a === 'object') ({ offset = 0, length, position } = a)
      else {
        offset = a ?? 0
        length = b
        position = typeof c === 'number' ? c : undefined
      }
      const all = toBytes(data)
      bytes = all.subarray(offset, offset + (length ?? all.length - offset))
    }
    if (bytes.length === 0) return 0
    const pos = position === null || position === undefined || position < 0 ? undefined : position
    return sys('write', undefined, () => k.write(fd, bytes, pos))
  }
  function fstatViaWrapper(fd: number, options?: any): any {
    const st = sys('fstat', undefined, () => k.fstat(fd))
    const s = new Stats()
    s.dev = st.dev
    s.mode = KIND_MODE[st.kind] | st.mode
    s.nlink = st.nlink
    s.ino = st.ino
    s.size = st.size
    s.blocks = Math.ceil(st.size / 512)
    s.atimeMs = s.mtimeMs = st.mtimeMs
    s.ctimeMs = st.ctimeMs
    s.birthtimeMs = st.birthtimeMs
    return options?.bigint ? toBigStats(s) : s
  }
  function ftruncateSync(fd: number, len = 0): void {
    sys('ftruncate', undefined, () => k.ftruncate(fd, len))
  }
  function fsyncSync(_fd: number): void {
    // Durability is the overlay journal's business (kernel.flush); a per-file sync has nothing to do.
  }
  function futimesSync(fd: number, _atime: unknown, mtime: unknown): void {
    sys('futime', undefined, () => k.fsetmeta(fd, undefined, toMs(mtime)))
  }
  function fchmodSync(fd: number, mode: unknown): void {
    sys('fchmod', undefined, () => k.fsetmeta(fd, parseMode(mode, 0o644), undefined))
  }
  function readvSync(fd: number, buffers: Uint8Array[], position?: number | null): number {
    let total = 0
    for (const b of buffers) {
      const n = readSync(fd, b, 0, b.byteLength, position === null || position === undefined ? null : position + total)
      total += n
      if (n < b.byteLength) break
    }
    return total
  }
  function writevSync(fd: number, buffers: Uint8Array[], position?: number | null): number {
    let total = 0
    for (const b of buffers) total += writeSync(fd, b, 0, b.byteLength, position === null || position === undefined ? undefined : position + total)
    return total
  }

  // ---- directories ----
  class Dir {
    path: string
    #entries: any[] | undefined
    #i = 0
    #closed = false
    constructor(path: string) {
      this.path = path
    }
    #load() {
      this.#entries ??= readdirSync(this.path, { withFileTypes: true })
      return this.#entries
    }
    readSync() {
      if (this.#closed) throw Object.assign(new Error('Directory handle was closed'), { code: 'ERR_DIR_CLOSED' })
      const e = this.#load()
      return this.#i < e.length ? e[this.#i++] : null
    }
    read(cb?: (err: Error | null, e?: any) => void): any {
      if (typeof cb === 'function') {
        let r
        try {
          r = this.readSync()
        } catch (e) {
          loop.nextTick(cb, e)
          return
        }
        loop.nextTick(cb, null, r)
        return
      }
      return new Promise((resolve, reject) => {
        try {
          resolve(this.readSync())
        } catch (e) {
          reject(e)
        }
      })
    }
    closeSync() {
      this.#closed = true
    }
    close(cb?: (err: Error | null) => void): any {
      this.#closed = true
      if (typeof cb === 'function') loop.nextTick(cb, null)
      else return Promise.resolve()
    }
    async *entries() {
      try {
        for (;;) {
          const e = this.readSync()
          if (e === null) break
          yield e
        }
      } finally {
        this.#closed = true
      }
    }
    [Symbol.asyncIterator]() {
      return this.entries()
    }
    [Symbol.asyncDispose]() {
      return this.close()
    }
    [Symbol.dispose]() {
      this.closeSync()
    }
  }
  function opendirSync(path: unknown): Dir {
    const p = toPath(path)
    const rc = k.statRaw(p, false)
    if (rc !== 0) throw errnoError(codeOf(rc), -rc, 'opendir', p)
    if (k.st.kind !== K_DIR) throw errnoError('ENOTDIR', 20, 'opendir', p)
    return new Dir(p)
  }

  // ---- watching ----
  const EventEmitter = rt.require('events')
  class FSWatcher extends EventEmitter {
    #id = -1
    #persistent = false
    #closed = false
    constructor() {
      super()
    }
    _start(path: string, options: any, listener?: (...a: any[]) => void) {
      const p = normalize(path)
      const rc = k.statRaw(p, false)
      if (rc !== 0) throw errnoError(codeOf(rc), -rc, 'watch', path)
      const isDir = k.st.kind === K_DIR
      const base = p.slice(p.lastIndexOf('/') + 1)
      const asBuffer = options.encoding === 'buffer'
      this.#id = sys('watch', path, () => k.watchAdd(p, !!options.recursive))
      this.#persistent = options.persistent !== false
      if (this.#persistent) loop.ref()
      if (listener) this.on('change', listener)
      loop.onWatch(this.#id, (kind, rel) => {
        if (this.#closed) return
        const name = isDir ? rel || base : base
        this.emit('change', kind === 1 ? 'rename' : 'change', asBuffer ? Buffer.from(name) : name)
      })
      options.signal?.addEventListener('abort', () => this.close(), { once: true })
    }
    close() {
      if (this.#closed) return
      this.#closed = true
      loop.offWatch(this.#id)
      k.watchRemove(this.#id)
      if (this.#persistent) loop.unref()
      loop.nextTick(() => this.emit('close'))
    }
    ref() {
      if (!this.#persistent && !this.#closed) {
        this.#persistent = true
        loop.ref()
      }
      return this
    }
    unref() {
      if (this.#persistent && !this.#closed) {
        this.#persistent = false
        loop.unref()
      }
      return this
    }
  }
  function watch(path: unknown, options?: any, listener?: any): any {
    if (typeof options === 'function') {
      listener = options
      options = {}
    } else if (typeof options === 'string') options = { encoding: options }
    const w = new FSWatcher()
    w._start(toPath(path), options ?? {}, listener)
    return w
  }
  // watchFile: stat polling, as in Node.
  const statWatchers = new Map<string, { timer: any; listeners: Set<Function>; prev: any }>()
  const zeroStats = () => new Stats()
  function watchFile(path: unknown, options: any, listener?: any): any {
    if (typeof options === 'function') {
      listener = options
      options = {}
    }
    const p = normalize(toPath(path))
    let w = statWatchers.get(p)
    if (!w) {
      const probe = () => statSync(p, { throwIfNoEntry: false }) ?? zeroStats()
      const state = { timer: undefined as any, listeners: new Set<Function>(), prev: probe() }
      state.timer = (rt.host.global.setInterval as any)(() => {
        const cur = probe()
        if (cur.mtimeMs !== state.prev.mtimeMs || cur.size !== state.prev.size || cur.ino !== state.prev.ino) {
          const prev = state.prev
          state.prev = cur
          for (const l of state.listeners) l(cur, prev)
        }
      }, options?.interval ?? 5007)
      if (options?.persistent === false) state.timer.unref()
      statWatchers.set(p, (w = state))
    }
    w.listeners.add(listener)
    return w
  }
  function unwatchFile(path: unknown, listener?: Function): void {
    const p = normalize(toPath(path))
    const w = statWatchers.get(p)
    if (!w) return
    if (listener) w.listeners.delete(listener)
    else w.listeners.clear()
    if (w.listeners.size === 0) {
      rt.host.global.clearInterval(w.timer)
      statWatchers.delete(p)
    }
  }

  // ---- streams ----
  const { Readable, Writable } = rt.require('stream')
  class ReadStream extends Readable {
    fd: number | null
    path: any
    flags: any
    mode: any
    start: number | undefined
    end: number
    pos: number | undefined
    bytesRead = 0
    autoClose: boolean
    pending = true
    constructor(path: any, options?: any) {
      const o = typeof options === 'string' ? { encoding: options } : options ?? {}
      super({ highWaterMark: o.highWaterMark ?? 65536, encoding: o.encoding, emitClose: o.emitClose ?? true, autoDestroy: o.autoClose ?? true, signal: o.signal })
      this.path = path !== undefined && path !== null && typeof o.fd !== 'number' ? toPath(path) : undefined
      this.fd = typeof o.fd === 'number' ? o.fd : o.fd?.fd ?? null
      this.flags = o.flags ?? 'r'
      this.mode = o.mode ?? 0o666
      this.start = o.start
      this.end = o.end ?? Infinity
      this.pos = o.start
      this.autoClose = o.autoClose ?? true
      if (this.fd !== null) this.pending = false
    }
    _construct(cb: (e?: Error | null) => void) {
      if (this.fd !== null) return cb()
      try {
        this.fd = openSync(this.path, this.flags, this.mode)
        this.pending = false
      } catch (e) {
        return cb(e as Error)
      }
      cb()
      this.emit('open', this.fd)
      this.emit('ready')
    }
    _read(n: number) {
      let want = n
      if (this.end !== Infinity) want = Math.min(want, this.end - (this.pos ?? this.bytesRead + (this.start ?? 0)) + 1)
      if (want <= 0) return void this.push(null)
      const buf = Buffer.allocUnsafeSlow(want)
      let got: number
      try {
        got = readSync(this.fd!, buf, 0, want, this.pos ?? null)
      } catch (e) {
        return void this.destroy(e as Error)
      }
      if (got === 0) return void this.push(null)
      if (this.pos !== undefined) this.pos += got
      this.bytesRead += got
      this.push(got === want ? buf : buf.subarray(0, got))
    }
    _destroy(err: Error | null, cb: (e?: Error | null) => void) {
      if (this.fd !== null && this.autoClose) {
        try {
          k.close(this.fd)
        } catch {
          // already closed
        }
        this.fd = null
      }
      cb(err)
    }
    close(cb?: (e?: Error | null) => void) {
      if (typeof cb === 'function') this.once('close', cb)
      this.destroy()
    }
  }
  class WriteStream extends Writable {
    fd: number | null
    path: any
    flags: any
    mode: any
    start: number | undefined
    pos: number | undefined
    bytesWritten = 0
    autoClose: boolean
    pending = true
    constructor(path: any, options?: any) {
      const o = typeof options === 'string' ? { encoding: options } : options ?? {}
      super({ highWaterMark: o.highWaterMark, decodeStrings: true, defaultEncoding: o.encoding ?? 'utf8', emitClose: o.emitClose ?? true, autoDestroy: o.autoClose ?? true, signal: o.signal })
      this.path = path !== undefined && path !== null && typeof o.fd !== 'number' ? toPath(path) : undefined
      this.fd = typeof o.fd === 'number' ? o.fd : o.fd?.fd ?? null
      this.flags = o.flags ?? 'w'
      this.mode = o.mode ?? 0o666
      this.start = o.start
      this.pos = o.start
      this.autoClose = o.autoClose ?? true
      if (this.fd !== null) this.pending = false
    }
    _construct(cb: (e?: Error | null) => void) {
      if (this.fd !== null) return cb()
      try {
        this.fd = openSync(this.path, this.flags, this.mode)
        this.pending = false
      } catch (e) {
        return cb(e as Error)
      }
      cb()
      this.emit('open', this.fd)
      this.emit('ready')
    }
    _write(chunk: Uint8Array, _enc: string, cb: (e?: Error | null) => void) {
      try {
        let off = 0
        while (off < chunk.length) {
          const n = writeSync(this.fd!, chunk, off, chunk.length - off, this.pos)
          off += n
          if (this.pos !== undefined) this.pos += n
          this.bytesWritten += n
        }
      } catch (e) {
        return cb(e as Error)
      }
      cb()
    }
    _destroy(err: Error | null, cb: (e?: Error | null) => void) {
      if (this.fd !== null && this.autoClose) {
        try {
          k.close(this.fd)
        } catch {
          // already closed
        }
        this.fd = null
      }
      cb(err)
    }
    close(cb?: (e?: Error | null) => void) {
      if (typeof cb === 'function') {
        if (this.closed) return void loop.nextTick(cb)
        this.once('close', cb)
      }
      if (!this.writableFinished && !this.destroyed) this.end(() => this.destroy())
      else this.destroy()
    }
    destroySoon() {
      this.end()
    }
  }
  const createReadStream = (path: unknown, options?: any) => new ReadStream(path, options)
  const createWriteStream = (path: unknown, options?: any) => new WriteStream(path, options)

  // ---- the three API shapes ----
  const sync: Record<string, (...a: any[]) => any> = {
    access: accessSync, appendFile: appendFileSync, chmod: chmodSync, chown: chownSync, close: closeSync, copyFile: copyFileSync, cp: cpSync,
    fchmod: fchmodSync, fchown: () => {}, fdatasync: fsyncSync, fstat: fstatViaWrapper, fsync: fsyncSync, ftruncate: ftruncateSync,
    futimes: futimesSync, lchmod: lchmodSync, lchown: chownSync, link: linkSync, lstat: lstatSync, lutimes: lutimesSync, mkdir: mkdirSync,
    mkdtemp: mkdtempSync, open: openSync, opendir: opendirSync, read: readSync, readdir: readdirSync, readFile: readFileSync,
    readlink: readlinkSync, readv: readvSync, realpath: realpathSync, rename: renameSync, rm: rmSync, rmdir: rmdirSync, stat: statSync,
    statfs: statfsSync, symlink: symlinkSync, truncate: truncateSync, unlink: unlinkSync, utimes: utimesSync, write: writeSync,
    writeFile: writeFileSync, writev: writevSync,
  }
  const fs: any = {
    constants, Stats, Dirent, Dir, FSWatcher, ReadStream, WriteStream, FileReadStream: ReadStream, FileWriteStream: WriteStream,
    existsSync, watch, watchFile, unwatchFile, createReadStream, createWriteStream,
    F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
    [Symbol.for('bat.fs.error')]: fsError,
  }
  for (const [name, fn] of Object.entries(sync)) {
    fs[`${name}Sync`] = fn
    fs[name] = function (...args: any[]) {
      const cb = args.length && typeof args[args.length - 1] === 'function' ? args.pop() : undefined
      if (cb === undefined) throw Object.assign(new TypeError(`The "cb" argument must be of type function. Received undefined`), { code: 'ERR_INVALID_ARG_TYPE' })
      let result
      try {
        result = fn(...args)
      } catch (e) {
        loop.nextTick(cb, e)
        return
      }
      loop.nextTick(cb, null, result)
    }
  }
  fs.realpath.native = fs.realpath
  fs.exists = (path: unknown, cb: (exists: boolean) => void) => loop.nextTick(cb, existsSync(path))
  // read/write callbacks also receive the buffer.
  fs.read = (fd: number, ...args: any[]) => {
    const cb = args.pop()
    let buffer = args[0]
    if (buffer === undefined || (typeof buffer === 'object' && !ArrayBuffer.isView(buffer))) {
      // read(fd, [options], cb)
      const o = buffer ?? {}
      buffer = o.buffer ?? Buffer.alloc(16384)
      args = [buffer, o]
    }
    let n
    try {
      n = readSync(fd, args[0], args[1], args[2], args[3])
    } catch (e) {
      return loop.nextTick(cb, e)
    }
    loop.nextTick(cb, null, n, buffer)
  }
  fs.write = (fd: number, data: any, ...args: any[]) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : () => {}
    let n
    try {
      n = writeSync(fd, data, args[0], args[1], args[2])
    } catch (e) {
      return loop.nextTick(cb, e)
    }
    loop.nextTick(cb, null, n, data)
  }
  fs.readv = (fd: number, buffers: Uint8Array[], ...args: any[]) => {
    const cb = args.pop()
    let n
    try {
      n = readvSync(fd, buffers, args[0])
    } catch (e) {
      return loop.nextTick(cb, e)
    }
    loop.nextTick(cb, null, n, buffers)
  }
  fs.writev = (fd: number, buffers: Uint8Array[], ...args: any[]) => {
    const cb = args.pop()
    let n
    try {
      n = writevSync(fd, buffers, args[0])
    } catch (e) {
      return loop.nextTick(cb, e)
    }
    loop.nextTick(cb, null, n, buffers)
  }
  fs.glob = fs.globSync = () => {
    throw Object.assign(new Error('fs.glob is not implemented in this runtime'), { code: 'ERR_METHOD_NOT_IMPLEMENTED' })
  }
  fs.openAsBlob = async (path: unknown, options?: any) => new Blob([readFileSync(path)], { type: options?.type ?? '' })

  // ---- fs/promises ----
  class FileHandle extends EventEmitter {
    fd: number
    #closed = false
    constructor(fd: number) {
      super()
      this.fd = fd
    }
    async read(buffer?: any, offset?: any, length?: number, position?: number | null) {
      if (buffer === undefined || (typeof buffer === 'object' && !ArrayBuffer.isView(buffer))) {
        const o = buffer ?? {}
        buffer = o.buffer ?? Buffer.alloc(16384)
        offset = o
      }
      return { bytesRead: readSync(this.fd, buffer, offset, length, position), buffer }
    }
    async write(data: any, a?: any, b?: any, c?: any) {
      const bytesWritten = writeSync(this.fd, data, a, b, c)
      return { bytesWritten, buffer: data }
    }
    async readFile(options?: any) {
      return readFileSync(this.fd, options)
    }
    async writeFile(data: unknown, options?: any) {
      writeFileSync(this.fd, data, options)
    }
    async appendFile(data: unknown, options?: any) {
      writeFileSync(this.fd, data, options)
    }
    async stat(options?: any) {
      return fstatViaWrapper(this.fd, options)
    }
    async truncate(len = 0) {
      ftruncateSync(this.fd, len)
    }
    async sync() {}
    async datasync() {}
    async chmod(mode: unknown) {
      fchmodSync(this.fd, mode)
    }
    async chown() {}
    async utimes(atime: unknown, mtime: unknown) {
      futimesSync(this.fd, atime, mtime)
    }
    async readv(buffers: Uint8Array[], position?: number | null) {
      return { bytesRead: readvSync(this.fd, buffers, position), buffers }
    }
    async writev(buffers: Uint8Array[], position?: number | null) {
      return { bytesWritten: writevSync(this.fd, buffers, position), buffers }
    }
    createReadStream(options?: any) {
      return new ReadStream(undefined, { ...options, fd: this.fd })
    }
    createWriteStream(options?: any) {
      return new WriteStream(undefined, { ...options, fd: this.fd })
    }
    readLines(options?: any) {
      return rt.require('readline').createInterface({ input: this.createReadStream(options), crlfDelay: Infinity })
    }
    async close() {
      if (this.#closed) return
      this.#closed = true
      closeSync(this.fd)
      this.fd = -1
      this.emit('close')
    }
    [Symbol.asyncDispose]() {
      return this.close()
    }
  }
  const promises: any = { constants }
  for (const name of ['access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchmod', 'lchown', 'link', 'lstat', 'lutimes', 'mkdir', 'mkdtemp', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'statfs', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile']) {
    const fn = sync[name]
    promises[name] = async (...args: any[]) => fn(...args)
  }
  promises.readFile = async (path: any, options?: any) => readFileSync(path instanceof FileHandle ? path.fd : path, options)
  promises.writeFile = async (path: any, data: any, options?: any) => {
    if (data !== null && typeof data === 'object' && !ArrayBuffer.isView(data) && (Symbol.asyncIterator in data || Symbol.iterator in data)) {
      const parts: Uint8Array[] = []
      for await (const chunk of data as AsyncIterable<unknown>) parts.push(toBytes(chunk, encodingOf(options)))
      data = Buffer.concat(parts)
    }
    writeFileSync(path instanceof FileHandle ? path.fd : path, data, options)
  }
  promises.open = async (path: unknown, flags?: unknown, mode?: unknown) => new FileHandle(openSync(path, flags, mode))
  promises.watch = (path: unknown, options: any = {}) => {
    const events: { eventType: string; filename: string }[] = []
    let wake: (() => void) | undefined
    let done = false
    const w = watch(path, options, (eventType: string, filename: string) => {
      events.push({ eventType, filename })
      wake?.()
    })
    options.signal?.addEventListener('abort', () => {
      done = true
      wake?.()
    }, { once: true })
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (!done) {
            while (events.length) yield events.shift()!
            if (done) break
            await new Promise<void>((r) => (wake = r))
          }
          if (options.signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: options.signal.reason })
        } finally {
          w.close()
        }
      },
    }
  }
  promises.FileHandle = FileHandle
  Object.defineProperty(fs, 'promises', { value: promises, enumerable: true, configurable: true, writable: true })
  return fs
}

registerBuiltin('fs', createFs)
registerBuiltin('fs/promises', (rt) => rt.require('fs').promises)
