// Readiness dispatch for a thread that is not a guest process: the page (pid
// 1), the preview bridge worker. One loop over the process event word
// (`Atomics.waitAsync`, so the thread never blocks) fans events out to fd
// handlers, child-exit handlers and watch listeners.
import type { Kernel } from '../kernel/kernel'
import { TOKEN_CHILD, TOKEN_SIGNAL, TOKEN_WATCH } from '../kernel/kernel'
import type { FdIo } from '../net/client'

export interface Reactor extends FdIo {
  /** Exit status of a direct child, once. */
  onChild(pid: number, cb: (status: number) => void): void
  /** Records of one kernel watch id. */
  onWatch(id: number, cb: (kind: number, path: string) => void): void
  offWatch(id: number): void
  stop(): void
}

export function createReactor(kernel: Kernel): Reactor {
  const fds = new Map<number, (mask: number) => void>()
  const children = new Map<number, (status: number) => void>()
  const exited = new Map<number, number>()
  const watches = new Map<number, (kind: number, path: string) => void>()
  const stop = kernel.runEvents((token, mask) => {
    if (token === TOKEN_WATCH) {
      for (const e of kernel.watchRead()) watches.get(e.id)?.(e.kind, e.path)
    } else if (token === TOKEN_SIGNAL) {
      kernel.sigTake()
    } else if (token >= TOKEN_CHILD) {
      const pid = token - TOKEN_CHILD
      const cb = children.get(pid)
      if (cb) {
        children.delete(pid)
        cb(mask)
      } else exited.set(pid, mask)
    } else fds.get(token)?.(mask)
  })
  return {
    on(fd, mask, cb) {
      fds.set(fd, cb)
      kernel.subscribe(fd, mask)
    },
    off(fd) {
      if (fds.delete(fd)) {
        try {
          kernel.subscribe(fd, 0)
        } catch {
          // already closed
        }
      }
    },
    onChild(pid, cb) {
      const status = exited.get(pid)
      if (status !== undefined) {
        exited.delete(pid)
        queueMicrotask(() => cb(status))
      } else children.set(pid, cb)
    },
    onWatch: (id, cb) => void watches.set(id, cb),
    offWatch: (id) => void watches.delete(id),
    stop,
  }
}
