// HTTP/1.1 client over kernel sockets, written on web streams so the same
// code serves three callers: the page (`endpoint.fetch`), the preview bridge
// worker (service-worker requests) and the guest's global `fetch` to loopback.
// It never blocks: sockets are non-blocking and readiness comes from the
// caller's reactor (`FdIo`).
import type { Kernel } from '../kernel/kernel'
import { EPIPE, F_KEEPALIVE, F_UPGRADE, getCodec, type Codec, type HttpHead, type HttpParser } from './codec'

export const POLLIN = 1
export const POLLOUT = 4
export const POLLERR = 8
export const POLLHUP = 16

/** Readiness source: the guest's event loop or the page's reactor. */
export interface FdIo {
  /** `cb(mask)` when `fd` is ready for something in `mask`. Replaces the previous registration. */
  on(fd: number, mask: number, cb: (mask: number) => void): void
  off(fd: number): void
}

export interface NetContext {
  kernel: Kernel
  io: FdIo
}

export interface WireRequest {
  method: string
  /** Request target as the server should see it (`/api/health?x=1`). */
  path: string
  headers: [string, string][]
  body?: Uint8Array | ReadableStream<Uint8Array> | null
  signal?: AbortSignal
}

export interface WireResponse {
  status: number
  statusText: string
  headers: [string, string][]
  /** Null for a response that has no body by definition (HEAD, 204, 304). */
  body: ReadableStream<Uint8Array> | null
}

export interface NetError extends Error {
  code: string
}

export function netError(code: string, message: string): NetError {
  const e = new Error(message) as NetError
  e.code = code
  return e
}

interface Conn {
  fd: number
  parser: HttpParser
  port: number
  reused: boolean
  dead: boolean
}

interface Pool {
  idle: Conn[]
  active: number
  waiters: (() => void)[]
}

/** Concurrent connections per port; further requests queue (a browser allows 6 per host). */
const MAX_PER_PORT = 48
const IDLE_MAX = 8
const HIGH_WATER = 1 << 20

const encoder = new TextEncoder()

/** Queue of outgoing data on a non-blocking socket. */
export function createOutbox(codec: Codec, fd: number, wantWrite: (on: boolean) => void) {
  type Item = { data: Uint8Array | string; at: number; chunked: boolean; done?: (err?: Error) => void }
  const queue: Item[] = []
  let failed: Error | undefined
  let queued = 0
  let blocked = false
  const drains: (() => void)[] = []
  function flush(): void {
    while (queue.length) {
      const item = queue[0]
      const len = item.data.length
      const n = typeof item.data === 'string' ? codec.sendText(fd, item.data, item.at) : codec.send(fd, item.data, item.at, item.chunked)
      if (n < 0) {
        fail(netError(n === -EPIPE ? 'EPIPE' : 'ECONNRESET', 'socket closed by the peer'))
        return
      }
      item.at += n
      queued -= n
      if (item.at < len) {
        if (!blocked) {
          blocked = true
          wantWrite(true)
        }
        return
      }
      queue.shift()
      item.done?.()
    }
    if (blocked) {
      blocked = false
      wantWrite(false)
    }
    while (drains.length) drains.shift()!()
  }
  function fail(err: Error) {
    if (failed) return
    failed = err
    for (const item of queue.splice(0)) item.done?.(err)
    queued = 0
    while (drains.length) drains.shift()!()
  }
  return {
    /** Returns true when everything queued so far has reached the ring. */
    write(data: Uint8Array | string, chunked = false, done?: (err?: Error) => void): boolean {
      if (failed) {
        done?.(failed)
        return false
      }
      if (data.length === 0) {
        if (queue.length) queue.push({ data, at: 0, chunked, done })
        else done?.()
        return queue.length === 0
      }
      queue.push({ data, at: 0, chunked, done })
      queued += data.length
      if (queue.length === 1) flush()
      return queue.length === 0
    },
    flush,
    fail,
    get failed() {
      return failed
    },
    get queued() {
      return queued
    },
    /** Resolves when the queue is empty (or the socket failed). */
    drained(): Promise<void> {
      if (queue.length === 0 || failed) return Promise.resolve()
      return new Promise((resolve) => drains.push(resolve))
    },
  }
}

export type HttpClient = ReturnType<typeof createHttpClient>

export function createHttpClient(ctx: NetContext) {
  const { kernel, io } = ctx
  const codec = getCodec(kernel)
  const pools = new Map<number, Pool>()
  let closed = false
  const live = new Set<Conn>()

  const poolOf = (port: number): Pool => {
    let p = pools.get(port)
    if (!p) pools.set(port, (p = { idle: [], active: 0, waiters: [] }))
    return p
  }

  function destroy(conn: Conn) {
    if (conn.dead) return
    conn.dead = true
    live.delete(conn)
    io.off(conn.fd)
    conn.parser.free()
    try {
      kernel.close(conn.fd)
    } catch {
      // already closed
    }
  }

  function connect(port: number): Conn {
    const fd: number = kernel.x.bat_connect(port)
    if (fd < 0) throw netError(fd === -111 ? 'ECONNREFUSED' : `E${-fd}`, `connect ECONNREFUSED 127.0.0.1:${port}`)
    kernel.setNonblock(fd, true)
    const conn: Conn = { fd, parser: codec.httpParser('response'), port, reused: false, dead: false }
    live.add(conn)
    return conn
  }

  async function acquire(port: number, signal?: AbortSignal): Promise<Conn> {
    const pool = poolOf(port)
    while (pool.active >= MAX_PER_PORT) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          const i = pool.waiters.indexOf(wake)
          if (i >= 0) pool.waiters.splice(i, 1)
          reject(signal!.reason)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        pool.waiters.push(wake)
      })
      if (closed) throw netError('ECONNRESET', 'runtime closed')
    }
    let conn: Conn | undefined
    while ((conn = pool.idle.pop())) {
      if (!conn.dead) {
        io.off(conn.fd)
        conn.reused = true
        break
      }
    }
    conn ??= connect(port)
    pool.active++
    return conn
  }

  function release(conn: Conn, reusable: boolean) {
    const pool = poolOf(conn.port)
    pool.active--
    if (reusable && !conn.dead && !closed && pool.idle.length < IDLE_MAX) {
      pool.idle.push(conn)
      // Anything arriving on an idle connection (normally the server's close) retires it.
      io.on(conn.fd, POLLIN | POLLHUP | POLLERR, () => {
        const i = pool.idle.indexOf(conn)
        if (i >= 0) pool.idle.splice(i, 1)
        destroy(conn)
      })
    } else destroy(conn)
    pool.waiters.shift()?.()
  }

  function exchange(conn: Conn, req: WireRequest): Promise<WireResponse> {
    return new Promise<WireResponse>((resolve, reject) => {
      const { fd, parser } = conn
      const method = req.method.toUpperCase()
      let settled = false
      let finished = false
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      let keepAlive = false
      let requestSent = false
      let responseDone = false
      let interim = false
      let wantOut = false
      let paused = false

      const arm = () => io.on(fd, POLLIN | POLLHUP | POLLERR | (wantOut ? POLLOUT : 0), onReady)
      const outbox = createOutbox(codec, fd, (on) => {
        wantOut = on
        if (!finished) arm()
      })

      const finish = (reusable: boolean) => {
        if (finished) return
        finished = true
        req.signal?.removeEventListener('abort', onAbort)
        release(conn, reusable)
      }
      const fail = (err: unknown) => {
        if (finished) return
        outbox.fail(err instanceof Error ? err : new Error(String(err)))
        finish(false)
        if (!settled) {
          settled = true
          reject(err)
        } else {
          try {
            controller?.error(err)
          } catch {
            // already closed
          }
        }
      }
      const onAbort = () => fail(req.signal!.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      const maybeDone = () => {
        if (responseDone && requestSent) finish(keepAlive)
      }

      const sink = {
        head(head: HttpHead) {
          if (head.status >= 100 && head.status < 200 && !(head.flags & F_UPGRADE)) {
            interim = true // 100 Continue / 103 Early Hints: the real head follows
            return
          }
          interim = false
          keepAlive = (head.flags & F_KEEPALIVE) !== 0 && !(head.flags & F_UPGRADE)
          const headers: [string, string][] = []
          for (let i = 0; i < head.raw.length; i += 2) headers.push([head.raw[i], head.raw[i + 1]])
          const noBody = method === 'HEAD' || head.status === 204 || head.status === 205 || head.status === 304
          const body = new ReadableStream<Uint8Array>(
            {
              start(c) {
                controller = c
              },
              pull() {
                if (paused) {
                  paused = false
                  pump()
                }
              },
              cancel() {
                fail(netError('ECONNRESET', 'response body cancelled'))
              },
            },
            new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER }),
          )
          settled = true
          resolve({ status: head.status, statusText: head.reason, headers, body: noBody ? null : body })
        },
        body(chunk: Uint8Array) {
          if (finished) return
          try {
            controller?.enqueue(chunk)
          } catch {
            // cancelled
          }
        },
        end() {
          if (interim) {
            interim = false
            return
          }
          responseDone = true
          try {
            controller?.close()
          } catch {
            // cancelled
          }
          maybeDone()
          // A response that ends before the request was fully sent: stop sending.
          if (!finished && !requestSent) finish(false)
        },
        eof(clean: boolean) {
          if (finished) return
          if (responseDone) return finish(false)
          if (!settled) {
            const e = netError('ECONNRESET', 'socket hang up')
            ;(e as any).beforeResponse = clean
            return fail(e)
          }
          fail(new TypeError('terminated'))
        },
        error(errno: number) {
          fail(netError('HPE_INVALID', `invalid HTTP response from the guest (errno ${errno})`))
        },
      }
      const more = () => !finished && (!controller || (controller.desiredSize ?? 1) > 0)
      const pump = () => {
        if (finished) return
        if (parser.recv(fd, sink, more)) paused = true
      }
      const onReady = (mask: number) => {
        if (finished) return
        if (mask & POLLOUT) outbox.flush()
        if (mask & (POLLIN | POLLHUP) && !paused) pump()
        if (mask & POLLERR && !requestSent && !finished) outbox.flush()
      }

      if (req.signal?.aborted) return onAbort()
      req.signal?.addEventListener('abort', onAbort, { once: true })
      if (method === 'HEAD') parser.expectNoBody()

      // ---- the request ----
      let head = `${method} ${req.path} HTTP/1.1\r\n`
      let hasHost = false
      for (const [name, value] of req.headers) {
        const lower = name.toLowerCase()
        if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection' || lower === 'keep-alive') continue
        if (lower === 'host') hasHost = true
        head += `${name}: ${value}\r\n`
      }
      if (!hasHost) head += `host: localhost:${conn.port}\r\n`
      const body = req.body
      if (body instanceof Uint8Array) {
        head += `content-length: ${body.length}\r\n\r\n`
        outbox.write(head)
        outbox.write(body, false, (err) => {
          if (err) return
          requestSent = true
          maybeDone()
        })
      } else if (body) {
        head += 'transfer-encoding: chunked\r\n\r\n'
        outbox.write(head)
        const reader = body.getReader()
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (finished) return void reader.cancel().catch(() => {})
              if (done) break
              if (value?.length) {
                outbox.write(value, true)
                await outbox.drained()
                if (outbox.failed) throw outbox.failed
              }
            }
            outbox.write('0\r\n\r\n', false, (err) => {
              if (err) return
              requestSent = true
              maybeDone()
            })
          } catch (e) {
            fail(e)
          }
        })()
      } else {
        if (method !== 'GET' && method !== 'HEAD') head += 'content-length: 0\r\n'
        head += '\r\n'
        outbox.write(head, false, (err) => {
          if (err) return
          requestSent = true
          maybeDone()
        })
      }
      if (!finished) {
        arm()
        pump()
      }
    })
  }

  /** One request to the guest listener on `port`. Rejects with `code: 'ECONNREFUSED'` when nothing listens. */
  async function request(port: number, req: WireRequest): Promise<WireResponse> {
    if (closed) throw netError('ECONNRESET', 'runtime closed')
    req.signal?.throwIfAborted()
    for (let attempt = 0; ; attempt++) {
      const conn = await acquire(port, req.signal)
      try {
        return await exchange(conn, req)
      } catch (e) {
        // A kept-alive connection the server closed while it was idle: retry once on a new one.
        const stale = conn.reused && (e as any)?.beforeResponse === true && !(req.body instanceof ReadableStream)
        if (!stale || attempt > 0 || req.signal?.aborted) throw e
      }
    }
  }

  function close() {
    closed = true
    for (const conn of [...live]) destroy(conn)
    for (const pool of pools.values()) for (const wake of pool.waiters.splice(0)) wake()
  }

  return { request, close, codec }
}

/** Copy of a `HeadersInit` as wire pairs. */
export function headerPairs(init: HeadersInit | undefined): [string, string][] {
  if (!init) return []
  const out: [string, string][] = []
  new Headers(init).forEach((value, name) => out.push([name, value]))
  return out
}

/** A fetch `BodyInit` as bytes or a stream, plus the content type it implies. */
export async function wireBody(body: BodyInit | null | undefined): Promise<{ body: Uint8Array | ReadableStream<Uint8Array> | null; type?: string }> {
  if (body == null) return { body: null }
  if (typeof body === 'string') return { body: encoder.encode(body), type: 'text/plain;charset=UTF-8' }
  if (body instanceof Uint8Array) return { body }
  if (body instanceof ArrayBuffer) return { body: new Uint8Array(body) }
  if (ArrayBuffer.isView(body)) return { body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) }
  if (body instanceof ReadableStream) return { body }
  // Blob, FormData, URLSearchParams: let the platform serialise them.
  const r = new Response(body)
  return { body: new Uint8Array(await r.arrayBuffer()), type: r.headers.get('content-type') ?? undefined }
}

/** A `Response` for a wire response (invalid guest header names or values are dropped, not fatal). */
export function toResponse(res: WireResponse): Response {
  const headers = new Headers()
  for (const [name, value] of res.headers) {
    try {
      headers.append(name, value)
    } catch {
      // not representable in a Headers object
    }
  }
  const status = res.status >= 200 && res.status <= 599 ? res.status : 502
  const nullBody = status === 204 || status === 205 || status === 304
  return new Response(nullBody ? null : res.body, { status, statusText: /^[\t\x20-\x7e\x80-\xff]*$/.test(res.statusText) ? res.statusText : '', headers })
}
