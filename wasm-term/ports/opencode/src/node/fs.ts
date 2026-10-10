// node:fs for the browser client: a small in-memory tree, enough for what the
// opencode TUI keeps on disk (kv state, prompt history, themes lookups, logs).
// Nothing persists across page loads yet; see NOTES.md (remaining work).
import { Buffer } from "node:buffer"

interface FileNode {
  kind: "file"
  data: Uint8Array
  mtimeMs: number
}
interface DirNode {
  kind: "dir"
  entries: Map<string, FsNode>
  mtimeMs: number
}
type FsNode = FileNode | DirNode

const root: DirNode = { kind: "dir", entries: new Map(), mtimeMs: Date.now() }

function fsError(code: string, syscall: string, path: string): Error {
  const error = new Error(`${code}: ${syscall} '${path}'`) as Error & { code: string; syscall: string; path: string; errno: number }
  error.code = code
  error.syscall = syscall
  error.path = path
  error.errno = code === "ENOENT" ? -2 : code === "EEXIST" ? -17 : -1
  return error
}

function parts(path: unknown): string[] {
  const text = path instanceof URL ? decodeURIComponent(path.pathname) : String(path)
  const out: string[] = []
  const cwd = (globalThis as any).process?.cwd?.() ?? "/"
  for (const part of (text.startsWith("/") ? text : `${cwd}/${text}`).split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return out
}

function lookup(path: unknown): FsNode | undefined {
  let node: FsNode = root
  for (const part of parts(path)) {
    if (node.kind !== "dir") return undefined
    const next = node.entries.get(part)
    if (next === undefined) return undefined
    node = next
  }
  return node
}

function parentOf(path: unknown, syscall: string): { dir: DirNode; name: string } {
  const segments = parts(path)
  const name = segments.pop()
  if (name === undefined) throw fsError("EEXIST", syscall, String(path))
  const dir = lookup("/" + segments.join("/"))
  if (dir === undefined || dir.kind !== "dir") throw fsError("ENOENT", syscall, String(path))
  return { dir, name }
}

function toBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
  if (data instanceof ArrayBuffer) return new Uint8Array(data).slice()
  return new TextEncoder().encode(String(data))
}

function encodingOf(options: unknown): string | undefined {
  if (typeof options === "string") return options
  if (options && typeof options === "object") return (options as { encoding?: string }).encoding ?? undefined
  return undefined
}

function stats(node: FsNode) {
  const time = new Date(node.mtimeMs)
  return {
    isFile: () => node.kind === "file",
    isDirectory: () => node.kind === "dir",
    isSymbolicLink: () => false,
    size: node.kind === "file" ? node.data.byteLength : 0,
    mode: node.kind === "file" ? 0o100644 : 0o040755,
    mtimeMs: node.mtimeMs,
    ctimeMs: node.mtimeMs,
    atimeMs: node.mtimeMs,
    birthtimeMs: node.mtimeMs,
    mtime: time,
    ctime: time,
    atime: time,
    birthtime: time,
    dev: 1,
    ino: 1,
    nlink: 1,
    uid: 0,
    gid: 0,
  }
}

export function existsSync(path: unknown): boolean {
  return lookup(path) !== undefined
}

export function statSync(path: unknown, options?: { throwIfNoEntry?: boolean }) {
  const node = lookup(path)
  if (node === undefined) {
    if (options?.throwIfNoEntry === false) return undefined as never
    throw fsError("ENOENT", "stat", String(path))
  }
  return stats(node)
}
export const lstatSync = statSync

export function mkdirSync(path: unknown, options?: { recursive?: boolean } | number): string | undefined {
  const recursive = typeof options === "object" && options?.recursive === true
  let node: DirNode = root
  const segments = parts(path)
  for (let index = 0; index < segments.length; index++) {
    const name = segments[index]!
    const existing = node.entries.get(name)
    const last = index === segments.length - 1
    if (existing === undefined) {
      if (!last && !recursive) throw fsError("ENOENT", "mkdir", String(path))
      const created: DirNode = { kind: "dir", entries: new Map(), mtimeMs: Date.now() }
      node.entries.set(name, created)
      node = created
    } else if (existing.kind === "dir") {
      if (last && !recursive) throw fsError("EEXIST", "mkdir", String(path))
      node = existing
    } else throw fsError("EEXIST", "mkdir", String(path))
  }
  return undefined
}

export function readFileSync(path: unknown, options?: unknown): any {
  const node = lookup(path)
  if (node === undefined) throw fsError("ENOENT", "open", String(path))
  if (node.kind !== "file") throw fsError("EISDIR", "read", String(path))
  const encoding = encodingOf(options)
  return encoding ? Buffer.from(node.data).toString(encoding as BufferEncoding) : Buffer.from(node.data)
}

export function writeFileSync(path: unknown, data: unknown, options?: unknown): void {
  const { dir, name } = parentOf(path, "open")
  const existing = dir.entries.get(name)
  if (existing?.kind === "dir") throw fsError("EISDIR", "open", String(path))
  const flag = typeof options === "object" && options ? (options as { flag?: string }).flag : undefined
  if (existing && flag?.includes("x")) throw fsError("EEXIST", "open", String(path))
  const bytes = toBytes(data)
  if (existing && flag?.startsWith("a")) {
    const joined = new Uint8Array(existing.data.byteLength + bytes.byteLength)
    joined.set(existing.data)
    joined.set(bytes, existing.data.byteLength)
    existing.data = joined
    existing.mtimeMs = Date.now()
    return
  }
  dir.entries.set(name, { kind: "file", data: bytes, mtimeMs: Date.now() })
}

export function appendFileSync(path: unknown, data: unknown): void {
  writeFileSync(path, data, { flag: "a" })
}

export function readdirSync(path: unknown, options?: { withFileTypes?: boolean }): any[] {
  const node = lookup(path)
  if (node === undefined) throw fsError("ENOENT", "scandir", String(path))
  if (node.kind !== "dir") throw fsError("ENOTDIR", "scandir", String(path))
  const names = [...node.entries.keys()].sort()
  if (!options?.withFileTypes) return names
  return names.map((name) => ({ name, parentPath: String(path), path: String(path), ...stats(node.entries.get(name)!) }))
}

export function unlinkSync(path: unknown): void {
  const { dir, name } = parentOf(path, "unlink")
  if (!dir.entries.delete(name)) throw fsError("ENOENT", "unlink", String(path))
}

export function rmSync(path: unknown, options?: { force?: boolean; recursive?: boolean }): void {
  if (lookup(path) === undefined) {
    if (options?.force) return
    throw fsError("ENOENT", "rm", String(path))
  }
  const { dir, name } = parentOf(path, "rm")
  dir.entries.delete(name)
}
export const rmdirSync = rmSync

export function renameSync(from: unknown, to: unknown): void {
  const source = parentOf(from, "rename")
  const node = source.dir.entries.get(source.name)
  if (node === undefined) throw fsError("ENOENT", "rename", String(from))
  const target = parentOf(to, "rename")
  source.dir.entries.delete(source.name)
  target.dir.entries.set(target.name, node)
}

export function copyFileSync(from: unknown, to: unknown): void {
  writeFileSync(to, readFileSync(from))
}

export function realpathSync(path: unknown): string {
  if (lookup(path) === undefined) throw fsError("ENOENT", "realpath", String(path))
  return "/" + parts(path).join("/")
}

export function accessSync(path: unknown): void {
  if (lookup(path) === undefined) throw fsError("ENOENT", "access", String(path))
}

export function chmodSync(): void {}
export function utimesSync(): void {}

export function watch(): { close(): void; on(): unknown; off(): unknown; unref(): unknown; ref(): unknown } {
  const watcher = { close() {}, on: () => watcher, off: () => watcher, unref: () => watcher, ref: () => watcher }
  return watcher
}

export function createWriteStream(path: unknown) {
  const stream = {
    write(chunk: unknown) {
      appendFileSync(path, chunk)
      return true
    },
    end() {},
    on: () => stream,
    once: () => stream,
    destroy() {},
  }
  return stream
}

const settle =
  <Args extends unknown[], Result>(fn: (...args: Args) => Result) =>
  async (...args: Args): Promise<Result> =>
    fn(...args)

export const promises = {
  access: settle(accessSync),
  appendFile: settle(appendFileSync),
  chmod: settle(chmodSync),
  copyFile: settle(copyFileSync),
  lstat: settle(lstatSync),
  mkdir: settle(mkdirSync),
  readFile: settle(readFileSync),
  readdir: settle(readdirSync),
  realpath: settle(realpathSync),
  rename: settle(renameSync),
  rm: settle(rmSync),
  rmdir: settle(rmdirSync),
  stat: settle(statSync),
  unlink: settle(unlinkSync),
  utimes: settle(utimesSync),
  writeFile: settle(writeFileSync),
  async open(path: unknown, flags?: string) {
    if (flags?.includes("x") && existsSync(path)) throw fsError("EEXIST", "open", String(path))
    if (!existsSync(path)) {
      if (!flags || flags.startsWith("r")) throw fsError("ENOENT", "open", String(path))
      writeFileSync(path, "")
    }
    return {
      writeFile: async (data: unknown) => writeFileSync(path, data),
      appendFile: async (data: unknown) => appendFileSync(path, data),
      readFile: async (options?: unknown) => readFileSync(path, options),
      stat: async () => statSync(path),
      close: async () => {},
    }
  },
}

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2 }

export default {
  accessSync, appendFileSync, chmodSync, constants, copyFileSync, createWriteStream, existsSync, lstatSync,
  mkdirSync, promises, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync,
  unlinkSync, utimesSync, watch, writeFileSync,
}
