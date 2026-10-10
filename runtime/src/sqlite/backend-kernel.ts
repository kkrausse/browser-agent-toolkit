// FsBackend over the library kernel (runtime/src/kernel/kernel.ts).
//
// Durability. Kernel writes land in the in-memory overlay and reach OPFS later
// through one ordered journal of whole records (crates/bat-kernel/src/persist.rs):
// what a crash or a closed tab leaves behind is the state of *all* files as of
// one instant between two writes. SQLite's journals are built to recover from
// exactly that, and from much worse; what fsync buys on a disk (ordering between
// the journal and the database file) the overlay journal already gives. So:
//
//  - consistency never depends on xSync, and the device characteristics below
//    tell SQLite so (it then skips the syncs that only order writes);
//  - xSync is where SQLite says "a commit ends here". `request` (default) asks
//    the supervisor to drain the journal now and does not wait: a transaction
//    reported as committed can still be lost if the tab dies within that drain,
//    but the database is never corrupt. `wait` blocks the process until the
//    drain is durable in OPFS (full durability, one OPFS flush per commit).
//    `none` leaves it to the supervisor's own schedule.
//
// The parameter is structural so this file needs nothing from the kernel
// binding but these methods.
import { IOCAP_POWERSAFE_OVERWRITE, IOCAP_SAFE_APPEND, IOCAP_SEQUENTIAL, resolvePosix, type FsBackend } from './backend'

export interface KernelFs {
  open(path: string, flags?: number, mode?: number): number
  close(fd: number): void
  read(fd: number, dst: Uint8Array, pos?: number): number
  write(fd: number, src: Uint8Array, pos?: number): number
  fstat(fd: number): { size: number }
  ftruncate(fd: number, size?: number): void
  unlink(path: string): void
  /** Kind of the entry or -1 if absent. */
  kindOf(path: string): number
  flush(): Promise<void>
  flushSync(timeoutMs?: number): void
}

export interface KernelBackendOptions {
  cwd(): string
  /** What xSync does; see the header. Default 'request'. */
  sync?: 'request' | 'wait' | 'none'
}

const O_RDONLY = 0
const O_RDWR = 2
const O_CREAT = 0o100
const O_EXCL = 0o200

export function createKernelBackend(kernel: KernelFs, options: KernelBackendOptions): FsBackend {
  const mode = options.sync ?? 'request'
  // At most one drain request is outstanding; syncs that arrive meanwhile fold into one more.
  let draining = false
  let again = false
  const requestDrain = () => {
    if (draining) {
      again = true
      return
    }
    draining = true
    const done = () => {
      draining = false
      if (again) {
        again = false
        requestDrain()
      }
    }
    kernel.flush().then(done, done)
  }
  return {
    deviceCharacteristics: IOCAP_SAFE_APPEND | IOCAP_SEQUENTIAL | IOCAP_POWERSAFE_OVERWRITE,
    open(path, flags) {
      const f = flags.readOnly ? O_RDONLY : O_RDWR | (flags.create ? O_CREAT : 0) | (flags.create && flags.exclusive ? O_EXCL : 0)
      return kernel.open(path, f, 0o644)
    },
    close(fd) {
      kernel.close(fd)
    },
    read(fd, dst, pos) {
      let done = 0
      while (done < dst.length) {
        const n = kernel.read(fd, done === 0 ? dst : dst.subarray(done), pos + done)
        if (n === 0) break
        done += n
      }
      return done
    },
    write(fd, src, pos) {
      let done = 0
      while (done < src.length) done += kernel.write(fd, done === 0 ? src : src.subarray(done), pos + done)
    },
    truncate(fd, size) {
      kernel.ftruncate(fd, size)
    },
    size(fd) {
      return kernel.fstat(fd).size
    },
    sync() {
      if (mode === 'wait') kernel.flushSync()
      else if (mode === 'request') requestDrain()
    },
    delete(path) {
      try {
        kernel.unlink(path)
        return true
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') return false
        throw e
      }
    },
    exists(path) {
      return kernel.kindOf(path) >= 0
    },
    writable(path) {
      return kernel.kindOf(path) >= 0
    },
    fullPath(path) {
      return resolvePosix(options.cwd(), path)
    },
  }
}
