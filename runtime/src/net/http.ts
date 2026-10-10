// `node:http` (and the client half of `node:https`).
//
// Server: an `http.Server` is a `net.Server`; each connection's socket is read
// by the kernel's HTTP parser (crates/bat-kernel/src/http.rs) directly from
// the socket ring, so request bodies reach `IncomingMessage` with one copy
// and there is no parser here. `ServerResponse` writes through the socket's
// outbox; chunk framing is added by the kernel. An upgrade request hands the
// raw socket to the `upgrade` listener (the `ws` package works unmodified).
//
// Client: `http.request` to a loopback port uses the kernel-socket client;
// any other host (and every `https.request`) leaves through `fetch`.
import type { Runtime } from '../process/runtime'
import { POLLHUP } from './client'
import { F_EXPECT_CONTINUE, F_HTTP10, F_KEEPALIVE, F_UPGRADE, type HttpHead } from './codec'
import { getGuestFetch } from './fetch'
import { getNet } from './net'

export const STATUS_CODES: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints', 200: 'OK', 201: 'Created', 202: 'Accepted',
  203: 'Non-Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content', 207: 'Multi-Status',
  208: 'Already Reported', 226: 'IM Used', 300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 305: 'Use Proxy', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized',
  402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
  407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 411: 'Length Required',
  412: 'Precondition Failed', 413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable',
  417: 'Expectation Failed', 418: "I'm a Teapot", 421: 'Misdirected Request', 422: 'Unprocessable Entity', 423: 'Locked',
  424: 'Failed Dependency', 425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests',
  431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons', 500: 'Internal Server Error', 501: 'Not Implemented',
  502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates', 507: 'Insufficient Storage', 508: 'Loop Detected', 509: 'Bandwidth Limit Exceeded', 510: 'Not Extended',
  511: 'Network Authentication Required',
}
export const METHODS = [
  'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD', 'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR',
  'MKCOL', 'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH', 'PURGE', 'PUT', 'QUERY', 'REBIND', 'REPORT', 'SEARCH',
  'SOURCE', 'SUBSCRIBE', 'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE',
]

/** Headers of which only the first occurrence counts (Node's list). */
const SINGLE = new Set(['age', 'authorization', 'content-length', 'content-type', 'etag', 'expires', 'from', 'host', 'if-modified-since', 'if-unmodified-since', 'last-modified', 'location', 'max-forwards', 'proxy-authorization', 'referer', 'retry-after', 'server', 'user-agent'])

const kHttp = Symbol.for('bat.net.http')

export function getHttp(rt: Runtime): { http: any; https: any } {
  const r = rt as any
  return (r[kHttp] ??= createHttp(rt))
}

function createHttp(rt: Runtime): { http: any; https: any } {
  const { net, codec } = getNet(rt)
  const loop = rt.loop
  const kernel = rt.kernel
  const { Readable, Writable } = rt.require('stream')
  const EventEmitter = rt.require('events')
  const { Buffer } = rt.require('buffer')
  const alloc = (n: number) => Buffer.allocUnsafe(n) as Uint8Array
  const invalidArg = (code: string, message: string) => Object.assign(new TypeError(message), { code })

  let dateCache = ''
  let dateAt = 0
  const utcDate = () => {
    const now = Date.now()
    if (now - dateAt >= 1000) {
      dateAt = now - (now % 1000)
      dateCache = new Date(now).toUTCString()
    }
    return dateCache
  }

  function headersObject(raw: string[], distinct: boolean): Record<string, any> {
    const out: Record<string, any> = Object.create(null)
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i].toLowerCase()
      const value = raw[i + 1]
      const have = out[name]
      if (distinct) {
        if (have) have.push(value)
        else out[name] = [value]
      } else if (have === undefined) out[name] = name === 'set-cookie' ? [value] : value
      else if (name === 'set-cookie') have.push(value)
      else if (SINGLE.has(name)) continue
      else out[name] = `${have}${name === 'cookie' ? '; ' : ', '}${value}`
    }
    return out
  }

  class IncomingMessage extends Readable {
    socket: any
    httpVersionMajor = 1
    httpVersionMinor = 1
    httpVersion = '1.1'
    complete = false
    aborted = false
    rawHeaders: string[] = []
    rawTrailers: string[] = []
    trailers: Record<string, string> = {}
    trailersDistinct: Record<string, string[]> = {}
    method: string | null = null
    url = ''
    statusCode: number | null = null
    statusMessage: string | null = null
    upgrade = false
    _headers: Record<string, any> | undefined
    _distinct: Record<string, any> | undefined
    /** Body delivery is paused because the stream's buffer is full. */
    _full = false
    _resume: (() => void) | undefined
    _dumped = false
    _keepAlive = true
    /** The ClientRequest this message answers (client side). */
    req: any

    constructor(socket?: any) {
      super({ autoDestroy: false, emitClose: true })
      this.socket = socket
    }
    get connection() {
      return this.socket
    }
    set connection(v) {
      this.socket = v
    }
    get headers() {
      return (this._headers ??= headersObject(this.rawHeaders, false))
    }
    set headers(v) {
      this._headers = v
    }
    get headersDistinct() {
      return (this._distinct ??= headersObject(this.rawHeaders, true))
    }
    _read() {
      if (this._full) {
        this._full = false
        this._resume?.()
      }
    }
    _destroy(err: Error | null, cb: (err?: Error | null) => void) {
      if (!this.complete) this.aborted = true
      this._full = false
      this._resume?.()
      cb(err)
    }
    setTimeout(ms: number, cb?: () => void) {
      if (cb) this.on('timeout', cb)
      this.socket?.setTimeout?.(ms)
      return this
    }
    /** Discard the rest of the body. */
    _dump() {
      if (this._dumped) return
      this._dumped = true
      this.removeAllListeners('data')
      this._full = false
      this._resume?.()
    }
  }

  // ---- outgoing headers, shared by ServerResponse and ClientRequest ----

  const tokenRe = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/
  function checkName(name: unknown): string {
    if (typeof name !== 'string' || !name || !tokenRe.test(name)) throw invalidArg('ERR_INVALID_HTTP_TOKEN', `Header name must be a valid HTTP token ["${name}"]`)
    return name
  }
  function checkValue(name: string, value: unknown) {
    if (value === undefined) throw invalidArg('ERR_HTTP_INVALID_HEADER_VALUE', `Invalid value "undefined" for header "${name}"`)
    const bad = (v: unknown) => /[^\t\x20-\x7e\x80-\xff]/.test(String(v))
    if (Array.isArray(value) ? value.some(bad) : bad(value)) throw invalidArg('ERR_INVALID_CHAR', `Invalid character in header content ["${name}"]`)
  }
  function headerStore() {
    const map = new Map<string, [string, any]>()
    return {
      map,
      set(name: string, value: any) {
        checkName(name)
        checkValue(name, value)
        map.set(name.toLowerCase(), [name, Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value : String(value)])
      },
      append(name: string, value: any) {
        checkName(name)
        checkValue(name, value)
        const have = map.get(name.toLowerCase())
        if (!have) return this.set(name, value)
        const list = Array.isArray(have[1]) ? have[1] : [have[1]]
        have[1] = list.concat(Array.isArray(value) ? value.map(String) : String(value))
      },
      get: (name: string) => map.get(String(name).toLowerCase())?.[1],
      has: (name: string) => map.has(String(name).toLowerCase()),
      remove: (name: string) => void map.delete(String(name).toLowerCase()),
      names: () => [...map.keys()],
      rawNames: () => [...map.values()].map((v) => v[0]),
      object() {
        const out: Record<string, any> = Object.create(null)
        for (const [key, [, value]] of map) out[key] = value
        return out
      },
      /** Accepts an object, a Map/Headers, a flat [k, v, k, v] array or an array of pairs. */
      assign(headers: any, append = false) {
        if (!headers) return
        const put = (k: string, v: any) => (append ? this.append(k, v) : this.set(k, v))
        if (Array.isArray(headers)) {
          if (headers.length && Array.isArray(headers[0])) for (const [k, v] of headers) this.append(k, v)
          else {
            // A flat list replaces what was set before, but repeats within it accumulate.
            const seen = new Set<string>()
            for (let i = 0; i + 1 < headers.length; i += 2) {
              const k = String(headers[i]).toLowerCase()
              if (seen.has(k)) this.append(headers[i], headers[i + 1])
              else {
                seen.add(k)
                this.set(headers[i], headers[i + 1])
              }
            }
          }
        } else if (typeof headers.forEach === 'function' && typeof headers.get === 'function') headers.forEach((v: any, k: string) => put(k, v))
        else for (const k of Object.keys(headers)) if (headers[k] !== undefined) put(k, headers[k])
      },
    }
  }

  // ---- server ----

  interface Connection {
    socket: any
    responseDone(res: any): void
    pump(): void
  }

  class ServerResponse extends Writable {
    statusCode = 200
    statusMessage: string | undefined
    headersSent = false
    sendDate = true
    finished = false
    shouldKeepAlive = true
    chunkedEncoding = false
    useChunkedEncodingByDefault = true
    strictContentLength = false
    req: any
    socket: any
    _h = headerStore()
    _conn: Connection | undefined
    _hasBody = true
    _knownLength: number | undefined
    _closedEarly = false

    constructor(req: any, options?: any) {
      super({ highWaterMark: options?.highWaterMark, emitClose: true, autoDestroy: true })
      this.req = req
      this.socket = req.socket
      this.shouldKeepAlive = req._keepAlive !== false
    }
    get connection() {
      return this.socket
    }
    get _header() {
      return this.headersSent ? 'sent' : null
    }
    get writableFinishedCompat() {
      return this.writableFinished
    }
    setHeader(name: string, value: any) {
      if (this.headersSent) throw Object.assign(new Error('Cannot set headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' })
      this._h.set(name, value)
      return this
    }
    appendHeader(name: string, value: any) {
      if (this.headersSent) throw Object.assign(new Error('Cannot append headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' })
      this._h.append(name, value)
      return this
    }
    setHeaders(headers: any) {
      if (this.headersSent) throw Object.assign(new Error('Cannot set headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' })
      this._h.assign(headers)
      return this
    }
    getHeader(name: string) {
      return this._h.get(name)
    }
    getHeaders() {
      return this._h.object()
    }
    getHeaderNames() {
      return this._h.names()
    }
    getRawHeaderNames() {
      return this._h.rawNames()
    }
    hasHeader(name: string) {
      return this._h.has(name)
    }
    removeHeader(name: string) {
      if (this.headersSent) throw Object.assign(new Error('Cannot remove headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' })
      this._h.remove(name)
    }
    writeHead(statusCode: number, reason?: any, headers?: any) {
      if (this.headersSent) throw Object.assign(new Error('Cannot write headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' })
      if (typeof reason !== 'string') {
        headers = reason
        reason = undefined
      }
      statusCode |= 0
      if (statusCode < 100 || statusCode > 999) throw Object.assign(new RangeError(`Invalid status code: ${statusCode}`), { code: 'ERR_HTTP_INVALID_STATUS_CODE' })
      this.statusCode = statusCode
      if (reason !== undefined) this.statusMessage = reason
      this._h.assign(headers)
      return this
    }
    writeContinue(cb?: () => void) {
      this.socket?._out?.write('HTTP/1.1 100 Continue\r\n\r\n', false, () => cb?.())
    }
    writeProcessing() {
      this.socket?._out?.write('HTTP/1.1 102 Processing\r\n\r\n')
    }
    writeEarlyHints(hints: Record<string, string | string[]>, cb?: () => void) {
      let head = 'HTTP/1.1 103 Early Hints\r\n'
      for (const [k, v] of Object.entries(hints)) for (const one of Array.isArray(v) ? v : [v]) head += `${k}: ${one}\r\n`
      this.socket?._out?.write(`${head}\r\n`, false, () => cb?.())
    }
    addTrailers() {}
    flushHeaders() {
      if (!this.headersSent) this._sendHead()
    }
    setTimeout(ms: number, cb?: () => void) {
      if (cb) this.on('timeout', cb)
      this.socket?.setTimeout?.(ms)
      return this
    }
    assignSocket() {}
    detachSocket() {}

    _sendHead() {
      const req = this.req
      const code = this.statusCode
      const h = this._h
      this.headersSent = true
      this._hasBody = !(req.method === 'HEAD' || code === 204 || code === 304 || (code >= 100 && code < 200))
      let head = `HTTP/1.1 ${code} ${this.statusMessage ?? STATUS_CODES[code] ?? 'unknown'}\r\n`
      this.statusMessage ??= STATUS_CODES[code] ?? 'unknown'
      for (const [name, value] of h.map.values()) {
        if (Array.isArray(value)) for (const v of value) head += `${name}: ${v}\r\n`
        else head += `${name}: ${value}\r\n`
      }
      if (this.sendDate && !h.has('date')) head += `Date: ${utcDate()}\r\n`
      const connection = h.get('connection')
      if (typeof connection === 'string' && /\bclose\b/i.test(connection)) this.shouldKeepAlive = false
      if (this._hasBody) {
        const te = h.get('transfer-encoding')
        if (h.has('content-length')) this.chunkedEncoding = false
        else if (typeof te === 'string' && /\bchunked\b/i.test(te)) this.chunkedEncoding = true
        else if (this._knownLength !== undefined) {
          head += `Content-Length: ${this._knownLength}\r\n`
          this.chunkedEncoding = false
        } else if (req.httpVersionMinor >= 1 && this.useChunkedEncodingByDefault) {
          head += 'Transfer-Encoding: chunked\r\n'
          this.chunkedEncoding = true
        } else {
          // HTTP/1.0 without a length: the body ends when the connection does.
          this.shouldKeepAlive = false
          this.chunkedEncoding = false
        }
      } else this.chunkedEncoding = false
      if (connection === undefined) {
        const timeout = req.socket?.server?.keepAliveTimeout ?? 5000
        if (this.shouldKeepAlive) head += `Connection: keep-alive\r\nKeep-Alive: timeout=${Math.max(1, Math.floor(timeout / 1000))}\r\n`
        else head += 'Connection: close\r\n'
      }
      const out = this.socket?._out
      if (out) out.write(`${head}\r\n`)
    }
    end(chunk?: any, encoding?: any, cb?: any) {
      if (typeof chunk === 'function') {
        cb = chunk
        chunk = undefined
      } else if (typeof encoding === 'function') {
        cb = encoding
        encoding = undefined
      }
      if (!this.headersSent && this.writableLength === 0 && !this.writableEnded) {
        // The whole body is known: send it with a length instead of chunked.
        if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding)
        else if (chunk != null && !Buffer.isBuffer(chunk) && ArrayBuffer.isView(chunk)) chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        this._knownLength = chunk == null ? 0 : chunk.length
        if (chunk != null && chunk.length === 0) chunk = undefined
      }
      this.finished = true
      return super.end(chunk, encoding, cb)
    }
    _write(chunk: any, _encoding: string, cb: (err?: Error | null) => void) {
      if (!this.headersSent) this._sendHead()
      const out = this.socket?._out
      if (!out || this.socket.destroyed) return cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      if (!this._hasBody || chunk.length === 0) return cb()
      this.socket.bytesWritten += chunk.length
      out.write(chunk, this.chunkedEncoding, (err?: Error) => cb(err ? Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) : null))
    }
    _final(cb: (err?: Error | null) => void) {
      if (!this.headersSent) {
        this._knownLength ??= 0
        this._sendHead()
      }
      const out = this.socket?._out
      const done = () => {
        this.finished = true
        cb()
        const conn = this._conn
        this._conn = undefined
        conn?.responseDone(this)
      }
      if (!out || this.socket.destroyed) return done()
      out.write(this.chunkedEncoding && this._hasBody ? '0\r\n\r\n' : '', false, done)
    }
    _destroy(err: Error | null, cb: (err?: Error | null) => void) {
      const conn = this._conn
      this._conn = undefined
      // Destroyed before it finished: the connection cannot be reused.
      if (conn && !this.finished) conn.socket.destroy()
      cb(err)
    }
  }

  function serveConnection(server: any, socket: any) {
    const fd: number = socket._fd
    const parser = codec.httpParser('request', alloc)
    let req: any
    let res: any
    let reqDone = false
    let responding = false
    let upgraded = false
    let closed = false
    let idle: any

    const clearIdle = () => {
      if (idle) idle.close?.()
      idle = undefined
      socket._httpIdle = false
    }
    const armIdle = () => {
      clearIdle()
      socket._httpIdle = true
      if (server._fd < 0) return void socket.destroy() // the server is closing: no more requests
      const ms = server.keepAliveTimeout
      if (ms > 0) {
        idle = loop.setTimeout(() => {
          idle = undefined
          if (!responding && !closed) socket.destroy()
        }, ms)
        idle.unref?.()
      }
    }

    const conn: Connection = {
      socket,
      pump,
      responseDone(done) {
        if (done !== res) return
        const keep = res.shouldKeepAlive && !closed
        const finishedReq = req
        responding = false
        res = undefined
        req = undefined
        if (finishedReq && !finishedReq.complete) {
          // The handler answered without reading the request: skip the rest of it.
          finishedReq._dump()
          req = finishedReq
        } else {
          reqDone = false
          if (finishedReq && !finishedReq.destroyed) finishedReq.destroy()
        }
        if (!keep) return void socket.destroySoon()
        if (!req) {
          armIdle()
          pump()
        }
      },
    }

    const sink = {
      head(head: HttpHead) {
        clearIdle()
        const message = new IncomingMessage(socket)
        message.rawHeaders = head.raw
        message.method = head.method
        message.url = head.target
        if (head.flags & F_HTTP10) {
          message.httpVersionMinor = 0
          message.httpVersion = '1.0'
        }
        message._keepAlive = (head.flags & F_KEEPALIVE) !== 0
        message._resume = pump
        if (head.flags & F_UPGRADE) {
          if (server.listenerCount('upgrade') > 0) {
            upgraded = true
            message.upgrade = true
            message.complete = true
            message.push(null)
            parser.resume(fd, true)
            parser.free()
            socket._release()
            server.emit('upgrade', message, socket, Buffer.alloc(0))
            return
          }
          parser.resume(fd, false)
        }
        req = message
        reqDone = false
        responding = true
        res = new server._ServerResponse(message)
        res._conn = conn
        if (head.flags & F_EXPECT_CONTINUE) {
          if (server.listenerCount('checkContinue') > 0) return void server.emit('checkContinue', req, res)
          res.writeContinue()
        }
        server.emit('request', req, res)
      },
      body(chunk: Uint8Array) {
        if (!req || req._dumped || req.destroyed) return
        socket.bytesRead += chunk.length
        if (!req.push(chunk)) req._full = true
      },
      end() {
        if (!req) return
        const message = req
        message.complete = true
        reqDone = true
        if (!responding) {
          // A dumped request finished: the connection is free for the next one.
          req = undefined
          reqDone = false
          if (!message.destroyed) message.destroy()
          armIdle()
        } else if (!message._dumped && !message.destroyed) message.push(null)
      },
      eof() {
        if (!closed) socket.destroy()
      },
      error() {
        if (closed) return
        if (server.listenerCount('clientError') > 0) return void server.emit('clientError', Object.assign(new Error('Parse Error'), { code: 'HPE_INVALID' }), socket)
        socket._out?.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n', false, () => socket.destroy())
      },
    }
    const more = () => !closed && !upgraded && !(req && req._full) && !(reqDone && responding)
    function pump() {
      if (closed || upgraded) return
      parser.recv(fd, sink, more)
    }
    socket._consumer = () => {
      if (reqDone && responding) {
        // Nothing to read until the response is out; a hang-up means the client left.
        // The event's own mask is not trusted: fd numbers are reused, and an event queued
        // for a closed connection can be delivered to the one that got its number.
        if (kernel.pollFd(fd) & POLLHUP) socket.destroy()
        return
      }
      pump()
    }
    socket.on('close', () => {
      closed = true
      clearIdle()
      if (!upgraded) parser.free()
      const message = req
      const response = res
      req = undefined
      res = undefined
      if (message && !message.destroyed) {
        if (!message.complete) {
          message.aborted = true
          message.emit('aborted')
          message.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
        } else message.destroy()
      }
      if (response && !response.destroyed) {
        response._conn = undefined
        response.destroy()
      }
    })
    socket.on('timeout', () => {
      if (req?.listenerCount('timeout') || res?.listenerCount('timeout') || server.listenerCount('timeout')) {
        req?.emit('timeout', socket)
        res?.emit('timeout', socket)
        server.emit('timeout', socket)
      } else socket.destroy()
    })
    // Errors on the socket surface through the request and response.
    socket.on('error', () => {})
    if (server.timeout > 0) socket.setTimeout(server.timeout)
    armIdle()
    socket._arm()
    pump()
  }

  class Server extends net.Server {
    timeout = 0
    keepAliveTimeout = 5000
    headersTimeout = 60000
    requestTimeout = 300000
    maxHeadersCount: number | null = null
    maxRequestsPerSocket = 0
    httpAllowHalfOpen = false
    _ServerResponse: any
    _IncomingMessage: any

    constructor(options?: any, listener?: any) {
      if (typeof options === 'function') {
        listener = options
        options = {}
      }
      super({ ...options, allowHalfOpen: true })
      this._ServerResponse = options?.ServerResponse ?? ServerResponse
      this._IncomingMessage = options?.IncomingMessage ?? IncomingMessage
      if (options?.keepAliveTimeout !== undefined) this.keepAliveTimeout = options.keepAliveTimeout
      if (listener) this.on('request', listener)
      this.on('connection', (socket: any) => serveConnection(this, socket))
    }
    setTimeout(ms: number, cb?: () => void) {
      this.timeout = ms
      if (cb) this.on('timeout', cb)
      return this
    }
    closeAllConnections() {
      for (const socket of [...this._connections]) socket.destroy()
    }
    closeIdleConnections() {
      for (const socket of [...this._connections]) if (socket._httpIdle) socket.destroy()
    }
    close(cb?: any) {
      // As in Node 19+: idle keep-alive connections do not hold the close up.
      super.close(cb)
      this.closeIdleConnections()
      return this
    }
  }

  // ---- client ----

  class Agent extends EventEmitter {
    options: any
    defaultPort = 80
    protocol = 'http:'
    maxSockets = Infinity
    maxFreeSockets = 256
    maxTotalSockets = Infinity
    keepAlive: boolean
    keepAliveMsecs = 1000
    requests = {}
    sockets = {}
    freeSockets = {}
    constructor(options: any = {}) {
      super()
      this.options = { ...options }
      this.keepAlive = !!options.keepAlive
      if (options.maxSockets !== undefined) this.maxSockets = options.maxSockets
    }
    destroy() {}
    getName(o: any = {}) {
      return `${o.host ?? 'localhost'}:${o.port ?? ''}:${o.localAddress ?? ''}`
    }
  }

  function makeClient(defaultProtocol: 'http:' | 'https:', globalAgent: any) {
    class ClientRequest extends Writable {
      method: string
      path: string
      host: string
      protocol: string
      agent: any
      aborted = false
      finished = false
      reusedSocket = false
      maxHeadersCount = null
      socket: any = null
      res: any
      _h = headerStore()
      _chunks: Uint8Array[] = []
      _url: URL
      _abort = new AbortController()
      _timer: any
      _sent = false
      _held = false

      constructor(input: any, options?: any, cb?: any) {
        // Not autoDestroy: finishing the request body is not the end of the exchange.
        super({ emitClose: true, autoDestroy: false })
        let url: URL | undefined
        if (typeof input === 'string') url = new URL(input)
        else if (input instanceof URL) url = input
        else {
          cb = options
          options = input
        }
        if (typeof options === 'function') {
          cb = options
          options = {}
        }
        options = { ...(options ?? {}) }
        const protocol: string = options.protocol ?? url?.protocol ?? options.agent?.protocol ?? defaultProtocol
        const hostname: string = options.hostname ?? options.host?.replace(/:\d+$/, '') ?? url?.hostname ?? 'localhost'
        const port = options.port ?? url?.port ?? options.defaultPort ?? ''
        const path: string = options.path ?? (url ? url.pathname + url.search : '/')
        if (/[\u0000- ]/.test(path)) throw invalidArg('ERR_UNESCAPED_CHARACTERS', 'Request path contains unescaped characters')
        const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
        this._url = new URL(`${protocol}//${host}${port !== '' && port != null ? `:${port}` : ''}${path.startsWith('/') ? path : `/${path}`}`)
        this.protocol = protocol
        this.host = hostname
        this.path = path
        this.method = String(options.method ?? 'GET').toUpperCase()
        this.agent = options.agent === undefined ? globalAgent : options.agent
        this._h.assign(options.headers)
        const auth = options.auth ?? (url?.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined)
        if (auth && !this._h.has('authorization')) this._h.set('Authorization', `Basic ${Buffer.from(auth).toString('base64')}`)
        if (cb) this.once('response', cb)
        if (options.signal) {
          const onAbort = () => this.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }))
          if (options.signal.aborted) loop.nextTick(onAbort)
          else options.signal.addEventListener('abort', onAbort, { once: true })
        }
        if (options.timeout) this.setTimeout(options.timeout)
        this._hold(true)
        // Programs wait for 'socket' before they write; there is no socket object to give them.
        loop.nextTick(() => {
          if (this.destroyed) return
          this.socket = Object.assign(new EventEmitter(), {
            setTimeout: () => {}, setNoDelay: () => {}, setKeepAlive: () => {}, ref: () => {}, unref: () => {}, destroy: () => this.destroy(),
            remoteAddress: '127.0.0.1', connecting: false, writable: true, readable: true, destroyed: false, encrypted: this.protocol === 'https:',
          })
          this.emit('socket', this.socket)
        })
      }
      _hold(on: boolean) {
        if (on !== this._held) {
          this._held = on
          if (on) loop.ref()
          else loop.unref()
        }
      }
      get connection() {
        return this.socket
      }
      get headersSent() {
        return this._sent
      }
      setHeader(name: string, value: any) {
        this._h.set(name, value)
        return this
      }
      appendHeader(name: string, value: any) {
        this._h.append(name, value)
        return this
      }
      getHeader(name: string) {
        return this._h.get(name)
      }
      getHeaders() {
        return this._h.object()
      }
      getHeaderNames() {
        return this._h.names()
      }
      getRawHeaderNames() {
        return this._h.rawNames()
      }
      hasHeader(name: string) {
        return this._h.has(name)
      }
      removeHeader(name: string) {
        this._h.remove(name)
      }
      flushHeaders() {}
      setNoDelay() {}
      setSocketKeepAlive() {}
      setTimeout(ms: number, cb?: () => void) {
        if (cb) this.once('timeout', cb)
        if (this._timer) this._timer.close?.()
        this._timer = undefined
        if (ms > 0) {
          this._timer = loop.setTimeout(() => this.emit('timeout'), ms)
          this._timer.unref?.()
        }
        return this
      }
      abort() {
        this.aborted = true
        this.destroy()
      }
      _write(chunk: any, _encoding: string, cb: (err?: Error | null) => void) {
        this._chunks.push(chunk)
        cb()
      }
      _final(cb: (err?: Error | null) => void) {
        this.finished = true
        this._send()
        cb()
      }
      _destroy(err: Error | null, cb: (err?: Error | null) => void) {
        if (this._timer) this._timer.close?.()
        this._abort.abort()
        this._hold(false)
        if (this.res && !this.res.complete && !this.res.destroyed) {
          this.res.aborted = true
          this.res.emit('aborted')
          this.res.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
        }
        if (!err && !this.res && !this.aborted && this._sent) err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
        cb(err)
      }
      _send() {
        if (this._sent) return
        this._sent = true
        const headers: [string, string][] = []
        for (const [name, value] of this._h.map.values()) {
          if (Array.isArray(value)) for (const v of value) headers.push([name, v])
          else headers.push([name, value])
        }
        const total = this._chunks.reduce((n, c) => n + c.length, 0)
        const body = total || (this.method !== 'GET' && this.method !== 'HEAD') ? (Buffer.concat(this._chunks, total) as Uint8Array) : null
        this._chunks = []
        getGuestFetch(rt)
          .route(this._url, { method: this.method, headers, body, signal: this._abort.signal })
          .then(
            (wire) => {
              if (this.destroyed) return void wire.body?.cancel().catch(() => {})
              const res = new IncomingMessage(this.socket)
              this.res = res
              res.req = this
              res.statusCode = wire.status
              res.statusMessage = wire.statusText || STATUS_CODES[wire.status] || ''
              res.rawHeaders = wire.headers.flat()
              const finish = () => {
                this._hold(false)
                if (this._timer) this._timer.close?.()
                if (!this.destroyed) this.destroy()
              }
              const reader = wire.body?.getReader()
              let reading = false
              res._read = () => {
                if (reading) return
                if (!reader) {
                  res.complete = true
                  res.push(null)
                  return
                }
                reading = true
                reader.read().then(
                  ({ done, value }) => {
                    reading = false
                    if (res.destroyed) return
                    if (done) {
                      res.complete = true
                      res.push(null)
                    } else if (res.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))) res._read()
                  },
                  (err) => {
                    reading = false
                    if (!res.destroyed) res.destroy(Object.assign(err instanceof Error ? err : new Error(String(err)), { code: 'ECONNRESET' }))
                  },
                )
              }
              res._destroy = (err: Error | null, cb: (err?: Error | null) => void) => {
                if (!res.complete) void reader?.cancel().catch(() => {})
                cb(err)
              }
              res.once('end', () => {
                res.destroy()
                finish()
              })
              res.once('close', finish)
              if (!this.emit('response', res)) res.resume() // nobody listens: drain it
            },
            (err) => {
              if (this.destroyed) return
              const cause = (err as any)?.cause ?? err
              const code = cause?.code ?? (err?.name === 'AbortError' ? 'ABORT_ERR' : 'ECONNRESET')
              this.destroy(Object.assign(err instanceof Error ? err : new Error(String(err)), { code }))
            },
          )
      }
    }
    const request = (input: any, options?: any, cb?: any) => new ClientRequest(input, options, cb)
    const get = (input: any, options?: any, cb?: any) => {
      const req = request(input, options, cb)
      req.end()
      return req
    }
    return { ClientRequest, request, get }
  }

  const globalAgent = new Agent({ keepAlive: true })
  const client = makeClient('http:', globalAgent)
  const http = {
    METHODS,
    STATUS_CODES,
    Agent,
    globalAgent,
    Server,
    ServerResponse,
    IncomingMessage,
    OutgoingMessage: ServerResponse,
    ClientRequest: client.ClientRequest,
    createServer: (options?: any, listener?: any) => new Server(options, listener),
    request: client.request,
    get: client.get,
    maxHeaderSize: 1 << 20,
    validateHeaderName: (name: string) => void checkName(name),
    validateHeaderValue: (name: string, value: unknown) => checkValue(name, value),
    setMaxIdleHTTPParsers() {},
  }

  class HttpsAgent extends Agent {
    defaultPort = 443
    protocol = 'https:'
  }
  const httpsAgent = new HttpsAgent({ keepAlive: true })
  const secure = makeClient('https:', httpsAgent)
  const https = {
    Agent: HttpsAgent,
    globalAgent: httpsAgent,
    Server: class Server {
      constructor() {
        throw Object.assign(new Error('https.createServer is not supported in this runtime: serve HTTP and let the page origin provide TLS'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
      }
    },
    createServer() {
      throw Object.assign(new Error('https.createServer is not supported in this runtime: serve HTTP and let the page origin provide TLS'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
    },
    request: secure.request,
    get: secure.get,
  }
  return { http, https }
}
