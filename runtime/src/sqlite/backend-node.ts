// FsBackend over node:fs, for development and verification under native Node.
// A real disk reorders writes across a power loss, so this backend claims only
// what the stock unix VFS claims and really calls fsync.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { IOCAP_POWERSAFE_OVERWRITE, type FsBackend } from './backend'

export interface NodeBackendStats {
  opens: number
  reads: number
  readBytes: number
  writes: number
  writeBytes: number
  syncs: number
  truncates: number
  deletes: number
}

export function createNodeBackend(options: { fsync?: boolean } = {}): FsBackend & { stats: NodeBackendStats } {
  const fsync = options.fsync ?? true
  const stats: NodeBackendStats = { opens: 0, reads: 0, readBytes: 0, writes: 0, writeBytes: 0, syncs: 0, truncates: 0, deletes: 0 }
  return {
    stats,
    deviceCharacteristics: IOCAP_POWERSAFE_OVERWRITE,
    open(p, flags) {
      stats.opens++
      const c = fs.constants
      const mode = flags.readOnly ? c.O_RDONLY : c.O_RDWR | (flags.create ? c.O_CREAT : 0) | (flags.create && flags.exclusive ? c.O_EXCL : 0)
      return fs.openSync(p, mode, 0o644)
    },
    close(fd) {
      fs.closeSync(fd)
    },
    read(fd, dst, pos) {
      stats.reads++
      let done = 0
      while (done < dst.length) {
        const n = fs.readSync(fd, dst, done, dst.length - done, pos + done)
        if (n === 0) break
        done += n
      }
      stats.readBytes += done
      return done
    },
    write(fd, src, pos) {
      stats.writes++
      stats.writeBytes += src.length
      let done = 0
      while (done < src.length) done += fs.writeSync(fd, src, done, src.length - done, pos + done)
    },
    truncate(fd, size) {
      stats.truncates++
      fs.ftruncateSync(fd, size)
    },
    size(fd) {
      return fs.fstatSync(fd).size
    },
    sync(fd, dataOnly) {
      stats.syncs++
      if (!fsync) return
      if (dataOnly) fs.fdatasyncSync(fd)
      else fs.fsyncSync(fd)
    },
    delete(p) {
      stats.deletes++
      try {
        fs.unlinkSync(p)
        return true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw e
      }
    },
    exists(p) {
      return fs.existsSync(p)
    },
    writable(p) {
      try {
        fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK)
        return true
      } catch {
        return false
      }
    },
    fullPath(p) {
      return path.resolve(p)
    },
  }
}
