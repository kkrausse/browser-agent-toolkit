// Typed binding over the kernel's C-ABI exports (docs/design/kernel-abi.md).
// One Kernel per attached instance (per worker, and one on the page). Every
// function is synchronous: a syscall is a wasm call. Functions throw a
// KernelError; the `try*` variants return undefined for "not there".

import type { KernelInstance } from './attach'
import { EAGAIN, ENOENT, ENOTDIR, ERANGE, kernelError } from './errno'

export const K_FILE = 0
export const K_DIR = 1
export const K_SYMLINK = 2
export const K_FIFO = 3
export const K_SOCKET = 4
export const K_CHAR = 5

export const O_RDONLY = 0
export const O_WRONLY = 1
export const O_RDWR = 2
export const O_CREAT = 0o100
export const O_EXCL = 0o200
export const O_TRUNC = 0o1000
export const O_APPEND = 0o2000
export const O_NONBLOCK = 0o4000
export const O_DIRECTORY = 0o200000
export const O_NOFOLLOW = 0o400000

export const POLLIN = 1
export const POLLOUT = 4
export const POLLERR = 8
export const POLLHUP = 16

export const TOKEN_CHILD = 0x80000000
export const TOKEN_WATCH = 0x40000000
export const TOKEN_SIGNAL = 0x40000001

export const STDIO_INHERIT = 0
export const STDIO_PIPE = 1
export const STDIO_NULL = 2
export const STDIO_FD = 3

export const WATCH_RENAME = 1
export const WATCH_CHANGE = 2

/** Module facts bits 0..7 (docs/design/image-format.md). */
export const FACT_KNOWN = 1
export const FACT_ESM = 2
export const FACT_TLA = 4
export const FACT_JSON = 8
export const FACT_FAILED = 16
export const FACT_IN_PROGRAM = 32

export interface Stat {
  kind: number
  mode: number
  size: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  ino: number
  nlink: number
  /** 0 = overlay, 1 + image id otherwise. */
  dev: number
  /** Module facts word of an image entry (0 elsewhere). */
  facts: number
  /** Length of the precompiled module body of an image entry, 0 if none. */
  compiledLen: number
}

export interface DirEntry {
  name: string
  kind: number
}

export interface SpawnRequest {
  exec: string
  argv: string[]
  env?: Record<string, string>
  /** Empty or omitted: inherit the caller's. */
  cwd?: string
  /** Per stdio slot: 'inherit' | 'pipe' | 'null' | { fd } (one of the caller's fds). */
  stdio?: [StdioSpec?, StdioSpec?, StdioSpec?]
}
export type StdioSpec = 'inherit' | 'pipe' | 'null' | { fd: number }

export interface SpawnResult {
  pid: number
  /** The caller's ends of the pipes requested, else -1. stdin is a write end. */
  stdio: [number, number, number]
}

export interface ProcInfo {
  exec: string
  cwd: string
  argv: string[]
  env: Record<string, string>
}

export interface WatchEvent {
  id: number
  kind: number
  /** Path relative to the watched directory ('' for the watched path itself). */
  path: string
}

export interface FileRead {
  data: Uint8Array
  stat: Stat
  /** True if `data` is the precompiled module body rather than the source. */
  compiled: boolean
}

const SCRATCH = 256 * 1024
const PATH_A = 0
const PATH_B = 8192
const STAT = 16384
const OUT = 16512
const DATA = 20480
const DATA_CAP = SCRATCH - DATA

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type Kernel = ReturnType<typeof createKernel>

export function createKernel(inst: KernelInstance) {
  const x = inst.x
  const scratch: number = x.bat_alloc(SCRATCH) >>> 0
  if (!scratch) throw new Error('kernel: out of memory')
  let u8 = inst.u8()
  let i32 = inst.i32()
  let f64 = new Float64Array(u8.buffer)
  let u32 = new Uint32Array(u8.buffer)
  const genIdx = x.BAT_MEM_GEN.value >>> 2
  let gen = Atomics.load(i32, genIdx)
  /** Refresh views if any instance grew the memory. Old views stay valid for old addresses. */
  const sync = () => {
    const g = Atomics.load(i32, genIdx)
    if (g !== gen) {
      gen = g
      u8 = inst.u8()
      i32 = inst.i32()
      f64 = new Float64Array(u8.buffer)
      u32 = new Uint32Array(u8.buffer)
    }
  }

  const pathA = scratch + PATH_A
  const pathB = scratch + PATH_B
  const statP = scratch + STAT
  const outP = scratch + OUT
  const dataP = scratch + DATA

  /** Write a string at `at`; returns its byte length. ASCII fast path. */
  const put = (s: string, at: number, cap = 8192): number => {
    const n = s.length
    if (n <= cap) {
      let i = 0
      for (; i < n; i++) {
        const c = s.charCodeAt(i)
        if (c > 127) break
        u8[at + i] = c
      }
      if (i === n) return n
    }
    const bytes = encoder.encode(s)
    if (bytes.length > cap) throw kernelError(-36, 'path', s)
    u8.set(bytes, at)
    return bytes.length
  }
  const text = (ptr: number, len: number): string => {
    // Short ASCII strings decode faster by hand, and TextDecoder cannot read shared memory.
    if (len < 64) {
      let s = ''
      for (let i = 0; i < len; i++) {
        const c = u8[ptr + i]
        if (c > 127) return decoder.decode(u8.slice(ptr, ptr + len))
        s += String.fromCharCode(c)
      }
      return s
    }
    return decoder.decode(u8.slice(ptr, ptr + len))
  }
  const readStat = (): Stat => {
    const w = statP >>> 2
    const d = statP >>> 3
    return {
      kind: u32[w],
      mode: u32[w + 1],
      size: f64[d + 1],
      mtimeMs: f64[d + 2],
      ctimeMs: f64[d + 3],
      ino: f64[d + 4],
      nlink: u32[w + 10],
      dev: u32[w + 11],
      facts: u32[w + 12],
      compiledLen: u32[w + 13],
      birthtimeMs: f64[d + 7],
    }
  }
  const check = (rc: number, syscall: string, path?: string): number => {
    if (rc < 0) throw kernelError(rc, syscall, path)
    return rc
  }
  /** Call with a kernel buffer of at least `size` bytes (scratch if it fits). */
  const withBuf = <T>(size: number, fn: (ptr: number, cap: number) => T): T => {
    if (size <= DATA_CAP) return fn(dataP, DATA_CAP)
    const p = x.bat_alloc(size) >>> 0
    if (!p) throw kernelError(-12, 'alloc')
    try {
      sync()
      return fn(p, size)
    } finally {
      x.bat_free(p, size)
    }
  }

  // ---- filesystem by path ----

  function tryStat(path: string, nofollow = false): Stat | undefined {
    sync()
    const rc = x.bat_stat(pathA, put(path, pathA), nofollow ? 1 : 0, statP)
    if (rc === 0) return readStat()
    if (rc === -ENOENT || rc === -ENOTDIR) return undefined
    throw kernelError(rc, nofollow ? 'lstat' : 'stat', path)
  }
  function stat(path: string, nofollow = false): Stat {
    sync()
    check(x.bat_stat(pathA, put(path, pathA), nofollow ? 1 : 0, statP), nofollow ? 'lstat' : 'stat', path)
    return readStat()
  }
  /** Kind of the entry (K_*) or -1 if absent. The cheapest existence probe: no object allocation. */
  function kindOf(path: string): number {
    sync()
    const rc = x.bat_stat(pathA, put(path, pathA), 0, statP)
    return rc === 0 ? u32[statP >>> 2] : -1
  }
  function readFileRaw(path: string, compiled: boolean): FileRead | number {
    sync()
    const n = put(path, pathA)
    let rc = x.bat_read_file(pathA, n, compiled ? 1 : 0, dataP, DATA_CAP, statP)
    if (rc >= 0) {
      sync()
      const st = readStat()
      return { data: u8.slice(dataP, dataP + rc), stat: st, compiled: compiled && st.compiledLen !== 0 }
    }
    if (rc !== -ERANGE) return rc
    // Too big for the scratch area: the size is in the stat; use a temporary kernel buffer.
    for (let attempt = 0; attempt < 4; attempt++) {
      const size = f64[(statP >>> 3) + 1]
      const p = x.bat_alloc(size || 1) >>> 0
      if (!p) return -12
      try {
        sync()
        rc = x.bat_read_file(pathA, put(path, pathA), compiled ? 1 : 0, p, size, statP)
        if (rc >= 0) {
          sync()
          const st = readStat()
          return { data: u8.slice(p, p + rc), stat: st, compiled: compiled && st.compiledLen !== 0 }
        }
      } finally {
        x.bat_free(p, size || 1)
      }
      if (rc !== -ERANGE) return rc // grew between the two calls: retry
    }
    return rc
  }
  /** Whole file as a private (non-shared) Uint8Array. */
  function readFile(path: string): Uint8Array {
    const r = readFileRaw(path, false)
    if (typeof r === 'number') throw kernelError(r, 'open', path)
    return r.data
  }
  function tryReadFile(path: string): Uint8Array | undefined {
    const r = readFileRaw(path, false)
    if (typeof r !== 'number') return r.data
    if (r === -ENOENT || r === -ENOTDIR) return undefined
    throw kernelError(r, 'open', path)
  }
  /** For the module loader: the precompiled body when the image has one, with the stat (facts). */
  function readModule(path: string): FileRead | undefined {
    const r = readFileRaw(path, true)
    if (typeof r !== 'number') return r
    if (r === -ENOENT || r === -ENOTDIR) return undefined
    throw kernelError(r, 'open', path)
  }
  function readText(path: string): string {
    return decoder.decode(readFile(path))
  }
  function writeFile(path: string, data: Uint8Array | string, opts: { mode?: number; append?: boolean; excl?: boolean } = {}): void {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    const flags = (opts.append ? 1 : 0) | (opts.excl ? 2 : 0)
    withBuf(bytes.length, (ptr) => {
      u8.set(bytes, ptr)
      check(x.bat_write_file(pathA, put(path, pathA), ptr, bytes.length, opts.mode ?? 0o644, flags), 'open', path)
    })
  }
  function mkdir(path: string, opts: { recursive?: boolean; mode?: number } = {}): void {
    sync()
    check(x.bat_mkdir(pathA, put(path, pathA), opts.mode ?? 0o755, opts.recursive ? 1 : 0), 'mkdir', path)
  }
  function rmdir(path: string): void {
    sync()
    check(x.bat_rmdir(pathA, put(path, pathA)), 'rmdir', path)
  }
  function unlink(path: string): void {
    sync()
    check(x.bat_unlink(pathA, put(path, pathA)), 'unlink', path)
  }
  function rename(from: string, to: string): void {
    sync()
    check(x.bat_rename(pathA, put(from, pathA), pathB, put(to, pathB)), 'rename', from)
  }
  function symlink(target: string, path: string): void {
    sync()
    check(x.bat_symlink(pathB, put(target, pathB), pathA, put(path, pathA)), 'symlink', path)
  }
  function link(existing: string, path: string): void {
    sync()
    check(x.bat_link(pathA, put(existing, pathA), pathB, put(path, pathB)), 'link', path)
  }
  function readlink(path: string): string {
    sync()
    const n = check(x.bat_readlink(pathA, put(path, pathA), dataP, DATA_CAP), 'readlink', path)
    return text(dataP, n)
  }
  function realpath(path: string): string {
    sync()
    const n = check(x.bat_realpath(pathA, put(path, pathA), dataP, DATA_CAP), 'realpath', path)
    return text(dataP, n)
  }
  function chmod(path: string, mode: number, nofollow = false): void {
    sync()
    check(x.bat_chmod(pathA, put(path, pathA), mode, nofollow ? 1 : 0), 'chmod', path)
  }
  function utimes(path: string, mtimeMs: number, nofollow = false): void {
    sync()
    check(x.bat_utimes(pathA, put(path, pathA), mtimeMs, nofollow ? 1 : 0), 'utime', path)
  }
  function truncate(path: string, size = 0): void {
    sync()
    check(x.bat_truncate(pathA, put(path, pathA), size), 'truncate', path)
  }
  /** One call for the whole directory, kinds included. */
  function readdir(path: string): DirEntry[] {
    sync()
    const n = put(path, pathA)
    const parse = (ptr: number, len: number): DirEntry[] => {
      const out: DirEntry[] = []
      let i = ptr
      const end = ptr + len
      while (i < end) {
        const l = u8[i + 1] | (u8[i + 2] << 8)
        out.push({ kind: u8[i], name: text(i + 3, l) })
        i += 3 + l
      }
      return out
    }
    let rc = x.bat_readdir(pathA, n, dataP, DATA_CAP)
    if (rc >= 0) return parse(dataP, rc)
    if (rc !== -ERANGE) throw kernelError(rc, 'scandir', path)
    const need = u32[dataP >>> 2] + 4096
    return withBuf(Math.max(need, DATA_CAP + 1), (ptr, cap) => {
      rc = check(x.bat_readdir(pathA, put(path, pathA), ptr, cap), 'scandir', path)
      return parse(ptr, rc)
    })
  }

  // ---- file descriptors ----

  function open(path: string, flags = O_RDONLY, mode = 0o644): number {
    sync()
    return check(x.bat_open(pathA, put(path, pathA), flags, mode), 'open', path)
  }
  function close(fd: number): void {
    check(x.bat_close(fd), 'close')
  }
  /** Read into `dst`. Returns bytes read, 0 at end. Throws EAGAIN when it would block and may not. */
  function read(fd: number, dst: Uint8Array, pos?: number): number {
    sync()
    return withBuf(dst.length, (ptr) => {
      const rc = pos === undefined ? x.bat_read(fd, ptr, dst.length) : x.bat_pread(fd, ptr, dst.length, pos)
      if (rc < 0) throw kernelError(rc, 'read')
      sync()
      dst.set(u8.subarray(ptr, ptr + rc))
      return rc
    })
  }
  /** Like `read` but returns -errno instead of throwing (for event-driven callers). */
  function readRaw(fd: number, dst: Uint8Array): number {
    sync()
    return withBuf(dst.length, (ptr) => {
      const rc = x.bat_read(fd, ptr, dst.length)
      if (rc > 0) {
        sync()
        dst.set(u8.subarray(ptr, ptr + rc))
      }
      return rc
    })
  }
  function write(fd: number, src: Uint8Array, pos?: number): number {
    sync()
    return withBuf(src.length, (ptr) => {
      u8.set(src, ptr)
      return check(pos === undefined ? x.bat_write(fd, ptr, src.length) : x.bat_pwrite(fd, ptr, src.length, pos), 'write')
    })
  }
  function writeRaw(fd: number, src: Uint8Array): number {
    sync()
    return withBuf(src.length, (ptr) => {
      u8.set(src, ptr)
      return x.bat_write(fd, ptr, src.length)
    })
  }
  function seek(fd: number, offset: number, whence: 0 | 1 | 2 = 0): number {
    const r = x.bat_seek(fd, offset, whence)
    if (r < 0) throw kernelError(r, 'lseek')
    return r
  }
  function fstat(fd: number): Stat {
    sync()
    check(x.bat_fstat(fd, statP), 'fstat')
    return readStat()
  }
  function ftruncate(fd: number, size = 0): void {
    check(x.bat_ftruncate(fd, size), 'ftruncate')
  }
  function fsetmeta(fd: number, mode: number | undefined, mtimeMs: number | undefined): void {
    check(x.bat_fsetmeta(fd, mode ?? -1, mtimeMs ?? -1), 'futimes')
  }
  function setNonblock(fd: number, on: boolean): void {
    check(x.bat_set_nonblock(fd, on ? 1 : 0), 'fcntl')
  }
  function dup(fd: number): number {
    return check(x.bat_dup(fd), 'dup')
  }
  function fdPath(fd: number): string {
    sync()
    return text(dataP, check(x.bat_fd_path(fd, dataP, DATA_CAP), 'fcntl'))
  }
  /** [read end, write end] */
  function pipe(): [number, number] {
    sync()
    check(x.bat_pipe(outP), 'pipe')
    return [i32[outP >>> 2], i32[(outP >>> 2) + 1]]
  }

  // ---- sockets ----

  /** Listen on a loopback port (0 picks one). Returns the listener fd. */
  function listen(port: number): number {
    return check(x.bat_listen(port), 'listen')
  }
  function connect(port: number): number {
    return check(x.bat_connect(port), 'connect')
  }
  /** Accept a connection; undefined when none is queued and the call may not block. */
  function accept(fd: number): number | undefined {
    const rc = x.bat_accept(fd)
    if (rc === -EAGAIN) return undefined
    return check(rc, 'accept')
  }
  function shutdown(fd: number): void {
    check(x.bat_shutdown(fd), 'shutdown')
  }
  function sockPorts(fd: number): { local: number; peer: number } {
    sync()
    check(x.bat_sock_ports(fd, outP), 'getsockname')
    return { local: u32[outP >>> 2], peer: u32[(outP >>> 2) + 1] }
  }
  function socketpair(): [number, number] {
    sync()
    check(x.bat_socketpair(outP), 'socketpair')
    return [i32[outP >>> 2], i32[(outP >>> 2) + 1]]
  }

  // ---- readiness ----

  /** Queue an event (token = fd) on this process's event word when `fd` becomes ready. mask 0 unsubscribes. */
  function subscribe(fd: number, mask: number): void {
    check(x.bat_fd_subscribe(fd, mask), 'poll')
  }
  function pollFd(fd: number): number {
    return check(x.bat_fd_poll(fd), 'poll')
  }
  /** Blocking poll (workers). Returns revents per fd. timeoutMs < 0 waits forever. */
  function poll(fds: { fd: number; events: number }[], timeoutMs: number): number[] {
    sync()
    const base = dataP >>> 2
    fds.forEach((f, i) => {
      i32[base + i * 3] = f.fd
      u32[base + i * 3 + 1] = f.events
      u32[base + i * 3 + 2] = 0
    })
    check(x.bat_poll(dataP, fds.length, timeoutMs), 'poll')
    sync()
    return fds.map((_, i) => u32[base + i * 3 + 2])
  }
  /** Drain queued readiness events as [token, mask] pairs. */
  function takeEvents(): [number, number][] {
    sync()
    const n = x.bat_events_take(dataP, 256)
    const out: [number, number][] = []
    const base = dataP >>> 2
    for (let i = 0; i < n; i++) out.push([u32[base + i * 2], u32[base + i * 2 + 1]])
    return out
  }
  /**
   * The process event loop: calls `on(token, mask)` for every queued event,
   * sleeping with Atomics.waitAsync on the event word in between, so timers
   * and promises keep running. Returns a stop function.
   */
  function runEvents(on: (token: number, mask: number) => void): () => void {
    let stopped = false
    const word = x.bat_event_word() >>> 2
    const loop = async () => {
      while (!stopped) {
        sync()
        const seen = Atomics.load(i32, word)
        const events = takeEvents()
        for (const [token, mask] of events) {
          try {
            on(token, mask)
          } catch (e) {
            inst.host.log(3, `event handler: ${(e as Error)?.stack ?? e}`)
          }
        }
        if (events.length === 0) {
          const r = (Atomics as any).waitAsync(i32, word, seen)
          if (r.async) await r.value
        }
      }
    }
    void loop()
    return () => {
      stopped = true
      Atomics.notify(i32, word)
    }
  }
  function watchAdd(path: string, recursive: boolean): number {
    sync()
    return check(x.bat_watch_add(pathA, put(path, pathA), recursive ? 1 : 0), 'watch', path)
  }
  function watchRemove(id: number): void {
    x.bat_watch_remove(id)
  }
  function watchRead(): WatchEvent[] {
    sync()
    const out: WatchEvent[] = []
    for (;;) {
      const n = x.bat_watch_read(dataP, DATA_CAP)
      if (n <= 0) break
      const dv = inst.dv()
      let i = dataP
      const end = dataP + n
      while (i < end) {
        // records are byte-packed, so not necessarily aligned
        const len = dv.getUint16(i + 8, true)
        out.push({ id: dv.getUint32(i, true), kind: dv.getUint32(i + 4, true), path: text(i + 10, len) })
        i += 10 + len
      }
    }
    return out
  }

  // ---- processes ----

  function getpid(): number {
    return check(x.bat_getpid(), 'getpid')
  }
  function getppid(): number {
    return check(x.bat_getppid(), 'getppid')
  }
  function chdir(path: string): void {
    sync()
    check(x.bat_chdir(pathA, put(path, pathA)), 'chdir', path)
  }
  function getcwd(): string {
    sync()
    return text(dataP, check(x.bat_getcwd(dataP, DATA_CAP), 'getcwd'))
  }
  function spawn(req: SpawnRequest): SpawnResult {
    const env = Object.entries(req.env ?? {}).map(([k, v]) => `${k}=${v}`)
    const strings = [req.exec, req.cwd ?? '', ...req.argv, ...env].map((s) => encoder.encode(s))
    const size = 4 + 24 + 8 + strings.reduce((n, s) => n + 4 + s.length, 0)
    return withBuf(size + 16, (ptr) => {
      const dv = inst.dv()
      let o = ptr
      const w32 = (v: number) => {
        dv.setUint32(o, v, true)
        o += 4
      }
      w32(0)
      for (let i = 0; i < 3; i++) {
        const s = req.stdio?.[i] ?? 'inherit'
        if (typeof s === 'object') {
          w32(STDIO_FD)
          w32(s.fd)
        } else {
          w32(s === 'pipe' ? STDIO_PIPE : s === 'null' ? STDIO_NULL : STDIO_INHERIT)
          w32(0)
        }
      }
      w32(req.argv.length)
      w32(env.length)
      for (const s of strings) {
        w32(s.length)
        u8.set(s, o)
        o += s.length
      }
      const fdsP = (o + 3) & ~3
      const pid = check(x.bat_spawn(ptr, size, fdsP), 'spawn', req.exec)
      sync()
      const b = fdsP >>> 2
      return { pid, stdio: [i32[b], i32[b + 1], i32[b + 2]] }
    })
  }
  function procInfo(pid: number): ProcInfo {
    sync()
    const parse = (ptr: number): ProcInfo => {
      const dv = inst.dv()
      let o = ptr
      const r32 = () => {
        const v = dv.getUint32(o, true)
        o += 4
        return v
      }
      const str = () => {
        const n = r32()
        const s = decoder.decode(u8.slice(o, o + n))
        o += n
        return s
      }
      const argc = r32()
      const envc = r32()
      const exec = str()
      const cwd = str()
      const argv = Array.from({ length: argc }, str)
      const env: Record<string, string> = {}
      for (let i = 0; i < envc; i++) {
        const kv = str()
        const eq = kv.indexOf('=')
        env[kv.slice(0, eq)] = kv.slice(eq + 1)
      }
      return { exec, cwd, argv, env }
    }
    const rc = x.bat_proc_info(pid, dataP, DATA_CAP)
    if (rc >= 0) return parse(dataP)
    if (rc !== -ERANGE) throw kernelError(rc, 'procinfo')
    const need = u32[dataP >>> 2]
    return withBuf(Math.max(need, DATA_CAP + 1), (ptr, cap) => {
      check(x.bat_proc_info(pid, ptr, cap), 'procinfo')
      return parse(ptr)
    })
  }
  /** Mark the calling process exited. The worker should stop running guest code afterwards. */
  function exit(code: number): void {
    x.bat_proc_exit(code)
  }
  /** Exit status of a child (0..255, or 128+signal), or undefined if it is still running and `nohang`. Blocks otherwise (workers). */
  function waitpid(pid: number, nohang = false): number | undefined {
    const rc = x.bat_waitpid(pid, nohang || !inst.canBlock ? 1 : 0)
    if (rc === -EAGAIN) return undefined
    return check(rc, 'waitpid')
  }
  function kill(pid: number, signal: number): void {
    check(x.bat_kill(pid, signal), 'kill')
  }
  /** Pending signal mask (bit n = signal n), cleared by the call. */
  function sigTake(): number {
    return x.bat_sig_take() >>> 0
  }
  function procList(): { pid: number; ppid: number; state: number; status: number }[] {
    sync()
    const n = x.bat_proc_list(dataP, 1024)
    const b = dataP >>> 2
    return Array.from({ length: n }, (_, i) => ({
      pid: u32[b + i * 4],
      ppid: u32[b + i * 4 + 1],
      state: u32[b + i * 4 + 2],
      status: i32[b + i * 4 + 3],
    }))
  }

  // ---- images ----

  /** Names of mounted images by id (undefined for an id reserved but not mounted). */
  function imageNames(): (string | undefined)[] {
    sync()
    const n = x.bat_image_count()
    return Array.from({ length: n }, (_, id) => {
      const rc = x.bat_image_name(id, dataP, DATA_CAP)
      return rc >= 0 ? text(dataP, rc) : undefined
    })
  }
  function imageStats(id: number): { entries: number; fileLen: number; cachedBytes: number; hostReads: number } {
    sync()
    check(x.bat_image_stats(id, outP), 'imagestats')
    const d = outP >>> 3
    return { entries: f64[d], fileLen: f64[d + 1], cachedBytes: f64[d + 2], hostReads: f64[d + 3] }
  }
  /** Copy of an in-head section of an image (program scripts list, meta), or undefined. */
  function imageSection(id: number, section: number): Uint8Array | undefined {
    sync()
    if (x.bat_image_section(id, section, outP) < 0) return undefined
    const ptr = u32[outP >>> 2]
    return u8.slice(ptr, ptr + u32[(outP >>> 2) + 1])
  }

  // ---- persistence ----

  /**
   * Resolve when everything written so far is durable in OPFS (immediately if
   * persistence is off). Works on the page: waits with Atomics.waitAsync.
   */
  async function flush(): Promise<void> {
    const target = x.bat_flush_begin()
    if (target < 0) return
    const word = x.BAT_PERSIST_WORD.value >>> 2
    for (;;) {
      sync()
      const seen = Atomics.load(i32, word)
      if (x.bat_persist_durable() >= target) return
      const r = (Atomics as any).waitAsync(i32, word, seen, 1000)
      if (r.async) await r.value
    }
  }
  /** Blocking flush (workers only). */
  function flushSync(timeoutMs = -1): void {
    const target = x.bat_flush_begin()
    if (target < 0) return
    check(x.bat_flush_wait(target, timeoutMs), 'fsync')
  }
  /** Changes whenever the overlay's namespace changes; key resolution caches on it. */
  const overlayGenIdx = x.BAT_OVERLAY_GEN.value >>> 2
  function overlayGeneration(): number {
    return Atomics.load(i32, overlayGenIdx)
  }
  /**
   * On a thread without image file handles that cannot block (the page), a
   * read of an image body that is not cached yet throws EAGAIN while the
   * supervisor faults it in. Retry such a call until it succeeds.
   */
  async function retrying<T>(fn: () => T): Promise<T> {
    const word = x.BAT_FAULT_WORD.value >>> 2
    for (;;) {
      sync()
      const seen = Atomics.load(i32, word)
      try {
        return fn()
      } catch (e) {
        if ((e as any)?.errno !== EAGAIN) throw e
      }
      const r = (Atomics as any).waitAsync(i32, word, seen, 100)
      if (r.async) await r.value
    }
  }

  return {
    inst,
    x,
    stat, tryStat, kindOf, readFile, tryReadFile, readModule, readText, writeFile, mkdir, rmdir, unlink, rename,
    symlink, link, readlink, realpath, chmod, utimes, truncate, readdir,
    open, close, read, readRaw, write, writeRaw, seek, fstat, ftruncate, fsetmeta, setNonblock, dup, fdPath, pipe,
    listen, connect, accept, shutdown, sockPorts, socketpair,
    subscribe, pollFd, poll, takeEvents, runEvents, watchAdd, watchRemove, watchRead,
    getpid, getppid, chdir, getcwd, spawn, procInfo, exit, waitpid, kill, sigTake, procList,
    imageNames, imageStats, imageSection,
    flush, flushSync, overlayGeneration, retrying,
  }
}
