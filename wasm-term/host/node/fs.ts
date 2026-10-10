// node:fs over the machine's vfs (../vfs.ts), so a JavaScript program and a
// wasm guest see the same kind of filesystem and share its persistence. The
// surface is what terminal programs actually use (the sync calls, their
// promise twins, a write stream); it is not all of node:fs.
//
// A bundled program does not import this file: it imports `node:fs`, which the
// bundler plugin (bun-plugin.ts) maps to modules/fs.ts, which re-exports the
// instance the worker runtime installed.

import { Buffer } from "node:buffer";
import type { DirNode, FileNode, Vfs, VfsNode } from "../vfs";

export interface NodeFsOptions {
  cwd(): string;
  /** Called (at most once per microtask turn) after something was written, renamed or removed. */
  changed?(): void;
}

const ERRNO: Record<string, number> = { ENOENT: -2, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, EINVAL: -22, ENOTEMPTY: -39 };

function fsError(code: string, syscall: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path, errno: ERRNO[code] ?? -1 });
}

function toBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new TextEncoder().encode(String(data));
}

function encodingOf(options: unknown): string | undefined {
  if (typeof options === "string") return options;
  if (options && typeof options === "object") return (options as { encoding?: string }).encoding ?? undefined;
  return undefined;
}

export type NodeFs = ReturnType<typeof createNodeFs>;

export function createNodeFs(vfs: Vfs, options: NodeFsOptions) {
  let notifying = false;
  function changed(): void {
    if (!options.changed || notifying) return;
    notifying = true;
    queueMicrotask(() => {
      notifying = false;
      options.changed!();
    });
  }

  function absolute(path: unknown): string {
    const text = path instanceof URL ? decodeURIComponent(path.pathname) : String(path);
    return text.startsWith("/") ? text : `${options.cwd()}/${text}`;
  }

  function lookup(path: unknown, follow = true): VfsNode | undefined {
    const found = vfs.resolve(vfs.root, absolute(path), follow);
    return typeof found === "number" ? undefined : found.node ?? undefined;
  }

  function parentOf(path: unknown, syscall: string): { dir: DirNode; name: string; node: VfsNode | null } {
    const found = vfs.resolve(vfs.root, absolute(path), false);
    if (typeof found === "number") throw fsError("ENOENT", syscall, String(path));
    return found;
  }

  function stats(node: VfsNode) {
    const ms = (ns: bigint) => Number(ns / 1_000_000n);
    const mtimeMs = ms(node.mtime);
    const time = new Date(mtimeMs);
    return {
      isFile: () => node.kind === "file",
      isDirectory: () => node.kind === "dir",
      isSymbolicLink: () => node.kind === "symlink",
      isCharacterDevice: () => node.kind === "dev",
      isFIFO: () => false,
      isSocket: () => false,
      isBlockDevice: () => false,
      size: node.kind === "file" ? node.size : 0,
      mode: node.kind === "file" ? 0o100644 : node.kind === "dir" ? 0o040755 : node.kind === "symlink" ? 0o120777 : 0o020666,
      mtimeMs, ctimeMs: ms(node.ctime), atimeMs: ms(node.atime), birthtimeMs: ms(node.ctime),
      mtime: time, ctime: time, atime: time, birthtime: time,
      dev: 1, ino: node.ino, nlink: 1, uid: 1000, gid: 1000,
    };
  }

  function existsSync(path: unknown): boolean {
    return lookup(path) !== undefined;
  }

  function statWith(follow: boolean, syscall: string) {
    return (path: unknown, statOptions?: { throwIfNoEntry?: boolean }) => {
      const node = lookup(path, follow);
      if (node === undefined) {
        if (statOptions?.throwIfNoEntry === false) return undefined as never;
        throw fsError("ENOENT", syscall, String(path));
      }
      return stats(node);
    };
  }
  const statSync = statWith(true, "stat");
  const lstatSync = statWith(false, "lstat");

  function mkdirSync(path: unknown, mkdirOptions?: { recursive?: boolean } | number): string | undefined {
    const recursive = typeof mkdirOptions === "object" && mkdirOptions?.recursive === true;
    if (recursive) {
      try {
        vfs.mkdirp(absolute(path));
      } catch {
        throw fsError("EEXIST", "mkdir", String(path));
      }
      return undefined;
    }
    const found = parentOf(path, "mkdir");
    if (found.node) throw fsError("EEXIST", "mkdir", String(path));
    vfs.mkdir(found.dir, found.name);
    return undefined;
  }

  function fileAt(path: unknown, syscall: string): FileNode {
    const node = lookup(path);
    if (node === undefined) throw fsError("ENOENT", syscall, String(path));
    if (node.kind === "dir") throw fsError("EISDIR", syscall, String(path));
    if (node.kind !== "file") throw fsError("EINVAL", syscall, String(path));
    return node;
  }

  function readFileSync(path: unknown, readOptions?: unknown): any {
    const file = fileAt(path, "open");
    const copy = Buffer.from(file.data.slice(0, file.size));
    const encoding = encodingOf(readOptions);
    return encoding ? copy.toString(encoding as BufferEncoding) : copy;
  }

  function writeFileSync(path: unknown, data: unknown, writeOptions?: unknown): void {
    const flag = typeof writeOptions === "object" && writeOptions ? (writeOptions as { flag?: string }).flag : undefined;
    const found = vfs.resolve(vfs.root, absolute(path), true);
    if (typeof found === "number") throw fsError("ENOENT", "open", String(path));
    if (found.node?.kind === "dir") throw fsError("EISDIR", "open", String(path));
    if (found.node && flag?.includes("x")) throw fsError("EEXIST", "open", String(path));
    if (found.node && found.node.kind !== "file") return; // /dev/null and friends
    const file = found.node ?? vfs.createFile(found.dir, found.name);
    const bytes = toBytes(data);
    if (flag?.startsWith("a")) vfs.write(file, file.size, bytes);
    else {
      vfs.truncate(file, 0);
      vfs.write(file, 0, bytes);
    }
    changed();
  }

  function appendFileSync(path: unknown, data: unknown): void {
    writeFileSync(path, data, { flag: "a" });
  }

  function readdirSync(path: unknown, readdirOptions?: { withFileTypes?: boolean }): any[] {
    const node = lookup(path);
    if (node === undefined) throw fsError("ENOENT", "scandir", String(path));
    if (node.kind !== "dir") throw fsError("ENOTDIR", "scandir", String(path));
    const names = [...node.entries.keys()].sort();
    if (!readdirOptions?.withFileTypes) return names;
    return names.map(name => ({ name, parentPath: String(path), path: String(path), ...stats(node.entries.get(name)!) }));
  }

  function unlinkSync(path: unknown): void {
    const found = parentOf(path, "unlink");
    if (!found.node) throw fsError("ENOENT", "unlink", String(path));
    if (found.node.kind === "dir") throw fsError("EISDIR", "unlink", String(path));
    found.dir.entries.delete(found.name);
    changed();
  }

  function rmSync(path: unknown, rmOptions?: { force?: boolean; recursive?: boolean }): void {
    const found = vfs.resolve(vfs.root, absolute(path), false);
    if (typeof found === "number" || !found.node) {
      if (rmOptions?.force) return;
      throw fsError("ENOENT", "rm", String(path));
    }
    if (found.node.kind === "dir" && found.node.entries.size > 0 && !rmOptions?.recursive) throw fsError("ENOTEMPTY", "rm", String(path));
    found.dir.entries.delete(found.name);
    changed();
  }

  function rmdirSync(path: unknown, rmOptions?: { recursive?: boolean }): void {
    const node = lookup(path, false);
    if (node && node.kind !== "dir") throw fsError("ENOTDIR", "rmdir", String(path));
    rmSync(path, rmOptions);
  }

  function renameSync(from: unknown, to: unknown): void {
    const source = parentOf(from, "rename");
    if (!source.node) throw fsError("ENOENT", "rename", String(from));
    const target = parentOf(to, "rename");
    if (target.node?.kind === "dir" && target.node.entries.size > 0) throw fsError("ENOTEMPTY", "rename", String(to));
    source.dir.entries.delete(source.name);
    target.dir.entries.set(target.name, source.node);
    if (source.node.kind === "dir") source.node.parent = target.dir;
    changed();
  }

  function copyFileSync(from: unknown, to: unknown): void {
    writeFileSync(to, readFileSync(from));
  }

  function realpathSync(path: unknown): string {
    if (lookup(path) === undefined) throw fsError("ENOENT", "realpath", String(path));
    const out: string[] = [];
    for (const part of absolute(path).split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return "/" + out.join("/");
  }

  function accessSync(path: unknown): void {
    if (lookup(path) === undefined) throw fsError("ENOENT", "access", String(path));
  }

  function chmodSync(): void {}
  function utimesSync(): void {}

  /** Nothing else writes to this filesystem, so a watcher never has anything to report. */
  function watch() {
    const watcher = { close() {}, on: () => watcher, off: () => watcher, once: () => watcher, unref: () => watcher, ref: () => watcher };
    return watcher;
  }

  function createWriteStream(path: unknown, streamOptions?: { flags?: string }) {
    if (!streamOptions?.flags?.startsWith("a")) writeFileSync(path, "");
    const stream = {
      write(chunk: unknown) {
        appendFileSync(path, chunk);
        return true;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined && typeof chunk !== "function") appendFileSync(path, chunk);
      },
      on: () => stream,
      once: () => stream,
      destroy() {},
    };
    return stream;
  }

  const settle = <Args extends unknown[], Result>(fn: (...args: Args) => Result) =>
    async (...args: Args): Promise<Result> => fn(...args);

  const promises = {
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
      if (flags?.includes("x") && existsSync(path)) throw fsError("EEXIST", "open", String(path));
      if (!existsSync(path)) {
        if (!flags || flags.startsWith("r")) throw fsError("ENOENT", "open", String(path));
        writeFileSync(path, "");
      } else if (flags?.startsWith("w")) writeFileSync(path, "");
      return {
        writeFile: async (data: unknown) => writeFileSync(path, data),
        appendFile: async (data: unknown) => appendFileSync(path, data),
        write: async (data: unknown) => (appendFileSync(path, data), { bytesWritten: toBytes(data).length }),
        readFile: async (readOptions?: unknown) => readFileSync(path, readOptions),
        stat: async () => statSync(path),
        sync: async () => {},
        datasync: async () => {},
        close: async () => {},
      };
    },
  };

  const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2 };

  return {
    accessSync, appendFileSync, chmodSync, constants, copyFileSync, createWriteStream, existsSync, lstatSync,
    mkdirSync, promises, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync,
    unlinkSync, utimesSync, watch, writeFileSync,
  };
}
