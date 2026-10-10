// `node:net` over kernel sockets. A Socket is a Duplex on a non-blocking
// kernel fd driven by the process event loop; a Server is a kernel listener.
// There is one loopback namespace: the host argument of listen/connect only
// has to name this machine. Unix-domain paths are mapped onto ports.
import type { Runtime } from '../process/runtime'
import { createOutbox, POLLERR, POLLHUP, POLLIN, POLLOUT, type FdIo } from './client'
import { EAGAIN, getCodec, type Codec } from './codec'

export interface NetInternals {
  net: any
  io: FdIo
  codec: Codec
  /** Is `host` this machine as far as a guest is concerned? */
  isLoopback(host: string | undefined): boolean
}

const LOOPBACK = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '::', '[::]', 'ip6-localhost'])
const V4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const V6 = /^(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|:(?:(?::[0-9a-f]{1,4}){1,7}|:)|(?:[0-9a-f]{1,4}:){1,4}:(?:\d{1,3}\.){3}\d{1,3}|::(?:ffff(?::0{1,4})?:)?(?:\d{1,3}\.){3}\d{1,3})(?:%.+)?$/i

export const isIPv4 = (s: unknown) => typeof s === 'string' && V4.test(s)
export const isIPv6 = (s: unknown) => typeof s === 'string' && V6.test(s)
export const isIP = (s: unknown) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0)
export const isLoopback = (host: string | undefined) => host === undefined || LOOPBACK.has(host.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(host) || host.toLowerCase().endsWith('.localhost')

/** A Unix-domain path has no kernel object: it is a port derived from the path. */
export function pathPort(path: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 20000 + ((h >>> 0) % 20000)
}

const kInternals = Symbol.for('bat.net.internals')

export function getNet(rt: Runtime): NetInternals {
  const r = rt as any
  return (r[kInternals] ??= createNet(rt))
}

function createNet(rt: Runtime): NetInternals {
  const kernel = rt.kernel
  const loop = rt.loop
  const codec = getCodec(kernel)
  const { Duplex } = rt.require('stream')
  const EventEmitter = rt.require('events')
  const { Buffer } = rt.require('buffer')
  const io: FdIo = { on: (fd, mask, cb) => loop.onFd(fd, mask, cb), off: (fd) => loop.offFd(fd) }
  const alloc = (n: number) => Buffer.allocUnsafe(n) as Uint8Array

  const sysError = (code: string, syscall: string, extra: Record<string, unknown> = {}) => {
    const address = extra.address !== undefined ? ` ${extra.address}${extra.port !== undefined ? `:${extra.port}` : ''}` : ''
    return Object.assign(new Error(`${syscall} ${code}${address}`), { code, syscall, errno: -({ ECONNREFUSED: 111, EADDRINUSE: 98, EPIPE: 32, ECONNRESET: 104, ENETUNREACH: 101, ENOTFOUND: 3008 } as any)[code] || -1, ...extra })
  }

  class Socket extends Duplex {
    _fd = -1
    _out: ReturnType<typeof createOutbox> | undefined
    _wantOut = false
    _reading = false
    /** Set while another layer (the HTTP server) reads this socket through the kernel codec. */
    _consumer: ((mask: number) => void) | null = null
    _refed = true
    _held = false
    _timer: any
    _timeoutMs = 0
    _pendingWrites: { chunk: any; cb: (err?: Error | null) => void }[] = []
    connecting = false
    server: any = null
    bytesRead = 0
    bytesWritten = 0
    remoteAddress: string | undefined
    remoteFamily: string | undefined
    remotePort: number | undefined
    localAddress: string | undefined
    localPort: number | undefined
    _path: string | undefined

    constructor(options: any = {}) {
      super({ allowHalfOpen: options.allowHalfOpen ?? false, emitClose: true, autoDestroy: true, highWaterMark: options.highWaterMark })
      if (typeof options.fd === 'number') this._attach(options.fd)
      if (options.signal) {
        const onAbort = () => this.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }))
        if (options.signal.aborted) loop.nextTick(onAbort)
        else options.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    _attach(fd: number) {
      this._fd = fd
      kernel.setNonblock(fd, true)
      this._out = createOutbox(codec, fd, (on) => {
        this._wantOut = on
        this._arm()
      })
      const ports = kernel.sockPorts(fd)
      this.localAddress = '127.0.0.1'
      this.localPort = ports.local
      this.remoteAddress = '127.0.0.1'
      this.remoteFamily = 'IPv4'
      this.remotePort = ports.peer
      this._hold()
      this._arm()
    }
    _hold() {
      const want = this._refed && this._fd >= 0
      if (want !== this._held) {
        this._held = want
        if (want) loop.ref()
        else loop.unref()
      }
    }
    _arm() {
      if (this._fd < 0) return
      const mask = POLLHUP | POLLERR | (this._reading || this._consumer ? POLLIN : 0) | (this._wantOut ? POLLOUT : 0)
      io.on(this._fd, mask, this._onReady)
    }
    _onReady = (mask: number) => {
      if (this._fd < 0) return
      if (mask & (POLLOUT | POLLERR)) this._out!.flush()
      if (this._fd < 0) return
      if (mask & (POLLIN | POLLHUP)) {
        if (this._consumer) this._consumer(mask)
        else if (this._reading) this._doRead()
      }
    }
    _doRead() {
      while (this._reading && this._fd >= 0 && !this._consumer) {
        const r = codec.read(this._fd, alloc)
        if (typeof r === 'number') {
          if (r === -EAGAIN) return
          this._reading = false
          this._arm()
          if (r === 0) this.push(null)
          else this.destroy(sysError('ECONNRESET', 'read'))
          return
        }
        this.bytesRead += r.length
        this._active()
        if (!this.push(r)) {
          this._reading = false
          this._arm()
          return
        }
      }
    }
    _read() {
      if (this._fd < 0 || this._consumer) {
        this._reading = true // picked up when the socket is attached or handed back
        return
      }
      if (!this._reading) {
        this._reading = true
        this._arm()
      }
      this._doRead()
    }
    /** Hand reading back to the socket (after an HTTP upgrade). */
    _release() {
      this._consumer = null
      if (this._fd >= 0) {
        this._arm()
        if (this._reading) this._doRead()
      }
    }
    _write(chunk: any, _encoding: string, cb: (err?: Error | null) => void) {
      if (this.connecting) return void this._pendingWrites.push({ chunk, cb })
      if (this._fd < 0 || !this._out) return cb(sysError('EPIPE', 'write'))
      this.bytesWritten += chunk.length
      this._active()
      this._out.write(chunk, false, (err) => cb(err ? sysError('EPIPE', 'write') : null))
    }
    _writev(chunks: { chunk: any }[], cb: (err?: Error | null) => void) {
      if (this.connecting) return void this._pendingWrites.push({ chunk: Buffer.concat(chunks.map((c) => c.chunk)), cb })
      if (this._fd < 0 || !this._out) return cb(sysError('EPIPE', 'write'))
      this._active()
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1
        this.bytesWritten += chunks[i].chunk.length
        this._out.write(chunks[i].chunk, false, last ? (err) => cb(err ? sysError('EPIPE', 'write') : null) : undefined)
      }
    }
    _final(cb: (err?: Error | null) => void) {
      if (this.connecting) return void this.once('connect', () => this._final(cb))
      if (this._fd < 0 || !this._out) return cb()
      const fd = this._fd
      this._out.write('', false, () => {
        if (this._fd === fd) {
          try {
            kernel.shutdown(fd)
          } catch {
            // peer already gone
          }
        }
        cb()
      })
    }
    _destroy(err: Error | null, cb: (err?: Error | null) => void) {
      this.connecting = false
      if (this._timer) this._timer.close?.()
      this._timer = undefined
      const fd = this._fd
      if (fd >= 0) {
        this._fd = -1
        io.off(fd)
        this._out?.fail(sysError('EPIPE', 'write'))
        try {
          kernel.close(fd)
        } catch {
          // already closed
        }
        this._hold()
      }
      for (const w of this._pendingWrites.splice(0)) w.cb(err ?? sysError('EPIPE', 'write'))
      const server = this.server
      if (server) {
        this.server = null
        server._connectionClosed(this)
      }
      cb(err)
    }
    _active() {
      if (this._timer) this._timer.refresh()
    }

    connect(...args: any[]) {
      const { options, cb } = normalizeConnectArgs(args)
      if (cb) this.once('connect', cb)
      if (this._fd >= 0 || this.connecting) throw Object.assign(new Error('Socket is already connected'), { code: 'ERR_SOCKET_ALREADY_CONNECTED' })
      this.connecting = true
      this._path = options.path
      const host: string = options.host ?? 'localhost'
      const port: number = options.path !== undefined ? pathPort(String(options.path)) : Number(options.port)
      loop.ref()
      loop.nextTick(() => {
        loop.unref()
        if (!this.connecting || this.destroyed) return
        if (options.path === undefined && !isLoopback(host)) {
          // There is no route out of the tab for a raw TCP connection.
          return this.destroy(sysError(isIP(host) ? 'ENETUNREACH' : 'ENOTFOUND', isIP(host) ? 'connect' : 'getaddrinfo', { address: host, port, hostname: host }))
        }
        if (options.lookup || !isIP(host)) this.emit('lookup', null, '127.0.0.1', 4, host)
        const fd: number = kernel.x.bat_connect(port)
        if (fd < 0) {
          return this.destroy(sysError('ECONNREFUSED', 'connect', options.path !== undefined ? { address: options.path } : { address: '127.0.0.1', port }))
        }
        this.connecting = false
        const wasReading = this._reading
        this._reading = false
        this._attach(fd)
        this.emit('connect')
        this.emit('ready')
        for (const w of this._pendingWrites.splice(0)) this._write(w.chunk, 'buffer', w.cb)
        if (wasReading || this.readableFlowing) this._read()
      })
      return this
    }
    setTimeout(ms: number, cb?: () => void) {
      if (this._timer) this._timer.close?.()
      this._timer = undefined
      this._timeoutMs = ms
      if (ms > 0) {
        this._timer = loop.setTimeout(() => {
          this._timer = undefined
          this.emit('timeout')
        }, ms)
        this._timer.unref?.()
        if (cb) this.once('timeout', cb)
      } else if (cb) this.removeListener('timeout', cb)
      return this
    }
    get timeout() {
      return this._timeoutMs || undefined
    }
    setNoDelay() {
      return this
    }
    setKeepAlive() {
      return this
    }
    ref() {
      this._refed = true
      this._hold()
      return this
    }
    unref() {
      this._refed = false
      this._hold()
      return this
    }
    address() {
      if (this._fd < 0) return {}
      return { address: this.localAddress, family: 'IPv4', port: this.localPort }
    }
    get pending() {
      return this._fd < 0 && !this.destroyed
    }
    get readyState() {
      if (this.connecting) return 'opening'
      if (this.readable && this.writable) return 'open'
      if (this.readable && !this.writable) return 'readOnly'
      if (!this.readable && this.writable) return 'writeOnly'
      return 'closed'
    }
    get bufferSize() {
      return this.writableLength
    }
    get remoteFamilyName() {
      return this.remoteFamily
    }
    destroySoon() {
      if (this.writable) this.end()
      if (this.writableFinished) this.destroy()
      else this.once('finish', this.destroy)
    }
    resetAndDestroy() {
      return this.destroy()
    }
  }

  function normalizeConnectArgs(args: any[]): { options: any; cb?: () => void } {
    if (Array.isArray(args[0])) args = args[0]
    let options: any = {}
    const first = args[0]
    if (typeof first === 'object' && first !== null) options = { ...first }
    else if (typeof first === 'string' && !/^\d+$/.test(first)) options = { path: first }
    else {
      options = { port: Number(first) }
      if (typeof args[1] === 'string') options.host = args[1]
    }
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined
    return { options, cb }
  }

  class Server extends EventEmitter {
    _fd = -1
    _refed = true
    _held = false
    _connections = new Set<any>()
    _address: any = null
    listening = false
    allowHalfOpen: boolean
    pauseOnConnect: boolean
    maxConnections: number | undefined
    _options: any

    constructor(options?: any, listener?: (socket: any) => void) {
      super()
      if (typeof options === 'function') {
        listener = options
        options = {}
      }
      this._options = options ?? {}
      this.allowHalfOpen = !!this._options.allowHalfOpen
      this.pauseOnConnect = !!this._options.pauseOnConnect
      if (listener) this.on('connection', listener)
    }
    _hold() {
      const want = this._refed && this._fd >= 0
      if (want !== this._held) {
        this._held = want
        if (want) loop.ref()
        else loop.unref()
      }
    }
    listen(...args: any[]) {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
      let port = 0
      let host: string | undefined
      let path: string | undefined
      const first = args[0]
      if (typeof first === 'object' && first !== null) {
        port = Number(first.port ?? 0)
        host = first.host
        path = first.path
        if (first.signal) first.signal.addEventListener('abort', () => this.close(), { once: true })
      } else if (typeof first === 'string' && !/^\d+$/.test(first)) path = first
      else {
        port = Number(first ?? 0)
        if (typeof args[1] === 'string') host = args[1]
      }
      if (this._fd >= 0) throw Object.assign(new Error('Listen method has been called more than once without closing.'), { code: 'ERR_SERVER_ALREADY_LISTEN' })
      if (cb) this.once('listening', cb)
      const want = path !== undefined ? pathPort(path) : port
      const fd: number = kernel.x.bat_listen(want)
      if (fd < 0) {
        const err = sysError(fd === -98 ? 'EADDRINUSE' : 'EACCES', 'listen', path !== undefined ? { address: path } : { address: host ?? '::', port })
        loop.ref()
        loop.nextTick(() => {
          loop.unref()
          this.emit('error', err)
        })
        return this
      }
      this._fd = fd
      kernel.setNonblock(fd, true)
      const bound = kernel.sockPorts(fd).local
      const address = host === undefined ? '::' : host === 'localhost' ? '127.0.0.1' : host
      this._address = path !== undefined ? path : { address, family: isIPv6(address) ? 'IPv6' : 'IPv4', port: bound }
      this.listening = true
      this._hold()
      io.on(fd, POLLIN, () => this._accept())
      loop.nextTick(() => {
        if (this._fd === fd) this.emit('listening')
      })
      return this
    }
    _accept() {
      while (this._fd >= 0) {
        const fd = kernel.accept(this._fd)
        if (fd === undefined) return
        if (this.maxConnections !== undefined && this._connections.size >= this.maxConnections) {
          kernel.close(fd)
          this.emit('drop', {})
          continue
        }
        const socket = new Socket({ allowHalfOpen: this.allowHalfOpen, highWaterMark: this._options.highWaterMark })
        socket.server = this
        this._connections.add(socket)
        socket._attach(fd)
        if (this.pauseOnConnect) socket.pause()
        this.emit('connection', socket)
      }
    }
    _connectionClosed(socket: any) {
      this._connections.delete(socket)
      if (this._fd < 0 && this._connections.size === 0 && this._closing) {
        this._closing = false
        loop.nextTick(() => this.emit('close'))
      }
    }
    _closing = false
    close(cb?: (err?: Error) => void) {
      if (this._fd < 0) {
        const err = Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' })
        if (cb) loop.nextTick(cb, err)
        return this
      }
      if (cb) this.once('close', cb)
      const fd = this._fd
      this._fd = -1
      this.listening = false
      io.off(fd)
      kernel.close(fd)
      this._hold()
      if (this._connections.size === 0) loop.nextTick(() => this.emit('close'))
      else this._closing = true
      return this
    }
    address() {
      return this._fd >= 0 ? this._address : null
    }
    getConnections(cb: (err: Error | null, count: number) => void) {
      loop.nextTick(cb, null, this._connections.size)
      return this
    }
    get connections() {
      return this._connections.size
    }
    ref() {
      this._refed = true
      this._hold()
      return this
    }
    unref() {
      this._refed = false
      this._hold()
      return this
    }
    [Symbol.asyncDispose]() {
      return new Promise<void>((resolve) => (this._fd >= 0 ? this.close(() => resolve()) : resolve()))
    }
  }

  const connect = (...args: any[]) => {
    const { options } = normalizeConnectArgs(args)
    const socket = new Socket(options)
    if (options.timeout) socket.setTimeout(options.timeout)
    return socket.connect(...args)
  }

  let autoSelectFamily = false
  let autoSelectTimeout = 250
  class BlockList {
    addAddress() {}
    addRange() {}
    addSubnet() {}
    check() {
      return false
    }
    get rules() {
      return []
    }
  }
  class SocketAddress {
    address: string
    family: string
    port: number
    flowlabel = 0
    constructor(o: any = {}) {
      this.address = o.address ?? '127.0.0.1'
      this.family = o.family ?? 'ipv4'
      this.port = o.port ?? 0
    }
  }
  const net = {
    Socket,
    Stream: Socket,
    Server,
    BlockList,
    SocketAddress,
    createServer: (options?: any, listener?: any) => new Server(options, listener),
    connect,
    createConnection: connect,
    isIP,
    isIPv4,
    isIPv6,
    getDefaultAutoSelectFamily: () => autoSelectFamily,
    setDefaultAutoSelectFamily: (v: boolean) => void (autoSelectFamily = !!v),
    getDefaultAutoSelectFamilyAttemptTimeout: () => autoSelectTimeout,
    setDefaultAutoSelectFamilyAttemptTimeout: (v: number) => void (autoSelectTimeout = v),
  }
  return { net, io, codec, isLoopback }
}
