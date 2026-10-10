// What the SQLite VFS needs from a filesystem. Every call is synchronous.
//
// Failures are thrown; an error's `code` (Node style: 'ENOENT', 'EACCES',
// 'EROFS', 'ENOSPC') is the only thing the VFS looks at.

export interface OpenFlags {
  readOnly: boolean
  /** Create the file if it is missing. */
  create: boolean
  /** With `create`: fail if it exists. */
  exclusive: boolean
}

export interface FsBackend {
  /** Open a regular file and return a handle for the calls below. */
  open(path: string, flags: OpenFlags): number
  close(fd: number): void
  /** Read up to `dst.length` bytes at `pos`. Returns the count; short only at end of file. */
  read(fd: number, dst: Uint8Array, pos: number): number
  /** Write all of `src` at `pos`, extending the file if needed. */
  write(fd: number, src: Uint8Array, pos: number): void
  truncate(fd: number, size: number): void
  size(fd: number): number
  /**
   * SQLite's xSync: called at the points where SQLite needs what it wrote so
   * far to be ordered before what it writes next, and at commit. What it has to
   * do depends on `deviceCharacteristics`.
   */
  sync(fd: number, dataOnly: boolean): void
  /** Remove a file. Returns false if it did not exist. */
  delete(path: string): boolean
  exists(path: string): boolean
  /** May the file be opened for reading and writing? */
  writable(path: string): boolean
  /** Absolute, normalized path (relative names resolve against the working directory). */
  fullPath(path: string): string
  /** SQLITE_IOCAP_* bits describing what a crash can do to written data. */
  deviceCharacteristics: number
}

export const IOCAP_ATOMIC = 0x1
export const IOCAP_SAFE_APPEND = 0x200
export const IOCAP_SEQUENTIAL = 0x400
export const IOCAP_POWERSAFE_OVERWRITE = 0x1000

/** POSIX path resolution without node:path. */
export function resolvePosix(cwd: string, path: string): string {
  const full = path.startsWith('/') ? path : `${cwd}/${path}`
  const out: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}
