// errno names for the kernel's return values (Linux numbering, as in crates/bat-kernel/src/errno.rs).
export const ERRNO: Record<number, string> = {
  1: 'EPERM', 2: 'ENOENT', 3: 'ESRCH', 4: 'EINTR', 5: 'EIO', 9: 'EBADF', 10: 'ECHILD', 11: 'EAGAIN',
  12: 'ENOMEM', 13: 'EACCES', 14: 'EFAULT', 17: 'EEXIST', 18: 'EXDEV', 20: 'ENOTDIR', 21: 'EISDIR',
  22: 'EINVAL', 24: 'EMFILE', 29: 'ESPIPE', 30: 'EROFS', 32: 'EPIPE', 34: 'ERANGE', 36: 'ENAMETOOLONG',
  38: 'ENOSYS', 39: 'ENOTEMPTY', 40: 'ELOOP', 88: 'ENOTSOCK', 98: 'EADDRINUSE', 104: 'ECONNRESET',
  107: 'ENOTCONN', 110: 'ETIMEDOUT', 111: 'ECONNREFUSED',
}
export const ENOENT = 2
export const EAGAIN = 11
export const EEXIST = 17
export const ENOTDIR = 20
export const ERANGE = 34
export const EPIPE = 32

export interface KernelError extends Error {
  code: string
  errno: number
  syscall: string
  path?: string
}

export function kernelError(rc: number, syscall: string, path?: string): KernelError {
  const errno = -rc
  const code = ERRNO[errno] ?? `E${errno}`
  const e = new Error(`${code}: ${syscall}${path !== undefined ? ` '${path}'` : ''}`) as KernelError
  e.code = code
  e.errno = errno
  e.syscall = syscall
  if (path !== undefined) e.path = path
  return e
}
