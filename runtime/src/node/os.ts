// `node:os`: a single-CPU Linux machine.
import { registerBuiltin } from './registry'
import { SIGNALS } from './process'

registerBuiltin('os', (rt) => {
  const env = () => rt.process.env as Record<string, string | undefined>
  const cpu = { model: 'WebAssembly', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }
  const errno = { E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99, EAGAIN: 11, EBADF: 9, EBUSY: 16, ECONNABORTED: 103, ECONNREFUSED: 111, ECONNRESET: 104, EEXIST: 17, EINTR: 4, EINVAL: 22, EIO: 5, EISDIR: 21, EMFILE: 24, ENOENT: 2, ENOMEM: 12, ENOSPC: 28, ENOSYS: 38, ENOTDIR: 20, ENOTEMPTY: 39, ENOTSUP: 95, EPERM: 1, EPIPE: 32, ERANGE: 34, EROFS: 30, ETIMEDOUT: 110, EXDEV: 18 }
  const os: any = {
    EOL: '\n',
    devNull: '/dev/null',
    arch: () => rt.process.arch,
    machine: () => 'wasm32',
    platform: () => 'linux',
    type: () => 'Linux',
    release: () => '6.8.0-bat',
    version: () => '#1 SMP bat-kernel',
    hostname: () => 'localhost',
    homedir: () => env().HOME || '/home/user',
    tmpdir: () => {
      const t = env().TMPDIR || env().TMP || env().TEMP || '/tmp'
      return t.length > 1 && t.endsWith('/') ? t.slice(0, -1) : t
    },
    endianness: () => 'LE',
    cpus: () => [{ ...cpu }],
    availableParallelism: () => 1,
    totalmem: () => 4 * 2 ** 30,
    freemem: () => 2 * 2 ** 30,
    uptime: () => performance.now() / 1000,
    loadavg: () => [0, 0, 0],
    networkInterfaces: () => ({ lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }] }),
    userInfo: (options?: { encoding?: string }) => {
      void options
      return { uid: 1000, gid: 1000, username: env().USER || 'user', homedir: os.homedir(), shell: '/bin/sh' }
    },
    getPriority: () => 0,
    setPriority: () => {},
    constants: { signals: SIGNALS, errno, priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 }, dlopen: {}, UV_UDP_REUSEADDR: 4 },
  }
  return os
})
