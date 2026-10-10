// An HTTPS request made by the runtime itself, over a TCP relay.
//
// The browser's fetch cannot make every request a program wants: it refuses to show a
// response that carries no `Access-Control-Allow-Origin`. For hosts named in a process's
// `BAT_FETCH_TUNNEL` (fetch.ts) the runtime therefore is the HTTP client:
//
//   WebSocket to the relay      one WebSocket = one TCP connection to `host:port`; the relay
//                               copies bytes and never looks at them (wire format below)
//   TLS, here, in the tab       rustls compiled to Wasm (tls/bat_tls.wasm): the server's chain
//                               and name are verified against the public roots compiled into
//                               that file. There is no setting, here or there, that skips or
//                               loosens the check; the relay sees ciphertext
//   HTTP/1.1, here              one request per connection (`connection: close`), streamed
//                               both ways; content-length, chunked and until-close bodies
//
// The relay's wire format (wasm-term/web/tcp-relay.ts), both directions:
//   binary frame   bytes of the stream
//   text frame     JSON: relay -> page  {"t":"open"} | {"t":"ack","bytes":n} | {"t":"end"}
//                                       | {"t":"error","code":c,"message":m} (then it closes)
//                        page -> relay  {"t":"ack","bytes":n} | {"t":"end"}
// Flow control is by the acks, WINDOW bytes each way: this side sends no more than a window
// ahead of the relay's acks, and acknowledges received bytes only once TLS has taken them,
// which it does only while the reader of the response body wants more.
import { netError, type WireResponse } from './client'

const WINDOW = 256 * 1024
const SCRATCH = 64 * 1024
const HEAD_MAX = 256 * 1024
const HIGH_WATER = 1 << 20

interface TlsExports {
  memory: WebAssembly.Memory
  _initialize?(): void
  bat_alloc(len: number): number
  tls_test_build(): number
  tls_new(host: number, len: number): number
  tls_free(conn: number): void
  tls_in(conn: number, ptr: number, len: number): number
  tls_in_eof(conn: number): void
  tls_out(conn: number, ptr: number, cap: number): number
  tls_write(conn: number, ptr: number, len: number): number
  tls_read(conn: number, ptr: number, cap: number): number
  tls_close(conn: number): void
  tls_error(conn: number, ptr: number, cap: number): number
  tls_info(conn: number, ptr: number, cap: number): number
}

/** One instance of bat_tls.wasm; every call into it is synchronous, so connections share its scratch buffer. */
export interface TlsEngine {
  x: TlsExports
  /** SCRATCH bytes inside the module's memory. */
  scratch: number
  /** The module trusts a test certificate besides the public roots (never the shipped file). */
  testBuild: boolean
}

const latin1 = new TextDecoder('latin1')
const utf8 = new TextDecoder()
const encoder = new TextEncoder()

/** The module imports a few WASI calls (it is built for wasm32-wasip1): random numbers, the clock, stderr for a panic. */
export function instantiateTls(module: WebAssembly.Module, random: (bytes: Uint8Array) => void = (bytes) => void crypto.getRandomValues(bytes)): TlsEngine {
  let memory: WebAssembly.Memory
  const view = () => new DataView(memory.buffer)
  const wasi: Record<string, (...args: any[]) => number> = {
    random_get(ptr: number, len: number) {
      // getRandomValues takes at most 65536 bytes a call.
      for (let at = 0; at < len; at += 65536) random(new Uint8Array(memory.buffer, ptr + at, Math.min(65536, len - at)))
      return 0
    },
    clock_time_get(_id: number, _precision: bigint, out: number) {
      view().setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true)
      return 0
    },
    fd_write(_fd: number, iovs: number, count: number, written: number) {
      let total = 0
      let text = ''
      for (let i = 0; i < count; i++) {
        const ptr = view().getUint32(iovs + i * 8, true)
        const len = view().getUint32(iovs + i * 8 + 4, true)
        text += utf8.decode(new Uint8Array(memory.buffer, ptr, len).slice())
        total += len
      }
      if (text.trim()) console.warn(`[bat tls] ${text.trimEnd()}`)
      view().setUint32(written, total, true)
      return 0
    },
    environ_sizes_get(count: number, size: number) {
      view().setUint32(count, 0, true)
      view().setUint32(size, 0, true)
      return 0
    },
    environ_get: () => 0,
    proc_exit(code: number) {
      throw new Error(`bat_tls.wasm stopped (exit ${code})`)
    },
  }
  const imports: Record<string, Record<string, unknown>> = {}
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.kind !== 'function') continue
    // Anything else is not used on the paths taken here: ENOSYS.
    ;(imports[entry.module] ??= {})[entry.name] = (entry.module === 'wasi_snapshot_preview1' && wasi[entry.name]) || (() => 52)
  }
  const x = new WebAssembly.Instance(module, imports as WebAssembly.Imports).exports as unknown as TlsExports
  memory = x.memory
  x._initialize?.()
  return { x, scratch: x.bat_alloc(SCRATCH), testBuild: x.tls_test_build() === 1 }
}

export interface TunnelDeps {
  /** The relay's WebSocket address, without the destination: `wss://relay.example/tcp`. */
  relayUrl: string
  WebSocket: typeof WebSocket
  engine(): Promise<TlsEngine>
}

export interface TunnelRequest {
  /** An https URL; the tunnel goes to its host and port. */
  url: URL
  method: string
  headers: [string, string][]
  body: Uint8Array | ReadableStream<Uint8Array> | null
  signal?: AbortSignal
}

export interface TunnelResponse extends WireResponse {
  /** What TLS negotiated, e.g. `TLSv1_3 TLS13_AES_256_GCM_SHA384`. */
  tls: string
}

interface ParserSink {
  head(status: number, reason: string, headers: [string, string][], bodyless: boolean): void
  body(chunk: Uint8Array): void
  end(): void
  error(message: string): void
}

function find(data: Uint8Array, at: number, pattern: number[]): number {
  outer: for (let i = at; i <= data.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (data[i + j] !== pattern[j]) continue outer
    return i
  }
  return -1
}

/** An HTTP/1.1 response as it arrives, in pieces of any size. */
export function createResponseParser(headRequest: boolean, sink: ParserSink) {
  let state: 'head' | 'length' | 'close' | 'chunk-size' | 'chunk-data' | 'chunk-end' | 'trailers' | 'done' = 'head'
  let held: Uint8Array = new Uint8Array(0)
  let remaining = 0
  const bad = (message: string) => {
    state = 'done'
    sink.error(message)
  }
  /** The bytes from `at` are kept for the next push; false when that is more than a line or head may be. */
  const hold = (data: Uint8Array, at: number, limit: number): boolean => {
    if (data.length - at > limit) return false
    held = data.slice(at)
    return true
  }
  function push(chunk: Uint8Array): void {
    let data = chunk
    if (held.length) {
      data = new Uint8Array(held.length + chunk.length)
      data.set(held)
      data.set(chunk, held.length)
      held = new Uint8Array(0)
    }
    let at = 0
    for (;;) {
      switch (state) {
        case 'done':
          return
        case 'head': {
          const end = find(data, at, [13, 10, 13, 10])
          if (end < 0) {
            if (!hold(data, at, HEAD_MAX)) bad('the response head is too large')
            return
          }
          const lines = latin1.decode(data.subarray(at, end)).split('\r\n')
          at = end + 4
          const status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0]!)
          if (!status) return bad('not an HTTP/1.1 response')
          const code = Number(status[1])
          const headers: [string, string][] = []
          for (const line of lines.slice(1)) {
            const colon = line.indexOf(':')
            if (colon <= 0 || /[\s]/.test(line.slice(0, colon))) return bad('a malformed response header')
            headers.push([line.slice(0, colon), line.slice(colon + 1).trim()])
          }
          // 100 Continue, 103 Early Hints: the real head follows.
          if (code < 200) continue
          const all = (name: string) => headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v)
          const bodyless = headRequest || code === 204 || code === 304
          if (bodyless) state = 'done'
          else if (all('transfer-encoding').some((v) => /(^|,)\s*chunked\s*$/i.test(v))) state = 'chunk-size'
          else {
            const lengths = [...new Set(all('content-length'))]
            if (lengths.length > 1 || (lengths.length && !/^\d+$/.test(lengths[0]!))) return bad('an invalid content-length')
            if (lengths.length) {
              remaining = Number(lengths[0])
              state = remaining ? 'length' : 'done'
            } else state = 'close'
          }
          sink.head(code, status[2] ?? '', headers, bodyless)
          if (state === 'done') return sink.end()
          continue
        }
        case 'close':
          if (at < data.length) sink.body(data.subarray(at))
          return
        case 'length':
        case 'chunk-data': {
          const n = Math.min(remaining, data.length - at)
          if (n) sink.body(data.subarray(at, at + n))
          at += n
          remaining -= n
          if (remaining) return
          if (state === 'length') {
            state = 'done'
            return sink.end()
          }
          state = 'chunk-end'
          continue
        }
        case 'chunk-end':
          if (data.length - at < 2) return void hold(data, at, 2)
          if (data[at] !== 13 || data[at + 1] !== 10) return bad('a malformed chunk')
          at += 2
          state = 'chunk-size'
          continue
        case 'chunk-size': {
          const end = find(data, at, [13, 10])
          if (end < 0) {
            if (!hold(data, at, 1024)) bad('a malformed chunk size')
            return
          }
          const size = latin1.decode(data.subarray(at, end)).split(';')[0]!.trim()
          if (!/^[0-9a-fA-F]{1,12}$/.test(size)) return bad('a malformed chunk size')
          at = end + 2
          remaining = parseInt(size, 16)
          state = remaining ? 'chunk-data' : 'trailers'
          continue
        }
        case 'trailers': {
          const end = find(data, at, [13, 10])
          if (end < 0) {
            if (!hold(data, at, HEAD_MAX)) bad('the response trailers are too large')
            return
          }
          const empty = end === at
          at = end + 2
          if (!empty) continue
          state = 'done'
          return sink.end()
        }
      }
    }
  }
  return {
    push,
    /** The stream ended. `clean`: by TLS close_notify, which is what makes an until-close body complete. */
    eof(clean: boolean): void {
      if (state === 'done') return
      if (state === 'close' && clean) {
        state = 'done'
        return sink.end()
      }
      bad(state === 'head' ? 'the connection closed before a response' : 'the connection closed in the middle of the response')
    },
    get done() {
      return state === 'done'
    },
  }
}

const HOP = /^(host|connection|keep-alive|proxy-connection|transfer-encoding|content-length|upgrade|te|trailer|expect)$/i

/** The request as HTTP/1.1 text. Throws for a header that could not be sent as written. */
function requestHead(req: TunnelRequest, framing: string): string {
  const method = req.method.toUpperCase()
  if (!/^[A-Z]+$/.test(method)) throw new TypeError(`fetch failed: invalid method ${JSON.stringify(req.method)}`)
  let head = `${method} ${req.url.pathname}${req.url.search} HTTP/1.1\r\nhost: ${req.url.host}\r\n`
  for (const [name, value] of req.headers) {
    if (HOP.test(name)) continue
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\r\n\0]/.test(value)) throw new TypeError(`fetch failed: invalid header ${JSON.stringify(name)}`)
    head += `${name}: ${value}\r\n`
  }
  return `${head}${framing}connection: close\r\n\r\n`
}

/**
 * One request through the relay. Resolves with the response head; the body streams as it
 * arrives. Rejects with an error whose message says which layer failed (the relay, TLS, HTTP).
 */
export function tunnelRequest(deps: TunnelDeps, req: TunnelRequest): Promise<TunnelResponse> {
  return new Promise<TunnelResponse>((resolve, reject) => {
    const host = req.url.hostname
    const port = Number(req.url.port) || 443
    let ws: WebSocket | undefined
    let engine: TlsEngine | undefined
    let conn = 0
    /** Nothing more happens on this connection. */
    let over = false
    let settled = false
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let relayOpen = false
    // Towards the relay: ciphertext not yet sent, and sent but not yet acknowledged.
    const outQueue: Uint8Array[] = []
    let outQueued = 0
    let unacked = 0
    // From the relay: ciphertext TLS has not taken yet.
    const inQueue: Uint8Array[] = []
    let inEnded = false
    let eofFed = false
    let pumping = false
    const waiters: (() => void)[] = []
    const wake = () => {
      for (const waiter of waiters.splice(0)) waiter()
    }

    const cleanup = () => {
      req.signal?.removeEventListener('abort', onAbort)
      if (conn && engine) engine.x.tls_free(conn)
      conn = 0
      try {
        ws?.close(1000)
      } catch {
        // already closing
      }
      wake()
    }
    const fail = (error: unknown) => {
      if (over) return
      over = true
      cleanup()
      if (!settled) {
        settled = true
        reject(error)
      } else {
        try {
          controller?.error(error)
        } catch {
          // already closed or cancelled
        }
      }
    }
    const onAbort = () => fail(req.signal!.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    const tlsError = (): string => {
      const { x, scratch } = engine!
      const n = x.tls_error(conn, scratch, 1024)
      return utf8.decode(new Uint8Array(x.memory.buffer, scratch, n).slice())
    }

    const send = () => {
      while (outQueue.length && relayOpen && ws?.readyState === 1) {
        const chunk = outQueue[0]!
        if (unacked && unacked + chunk.length > WINDOW) return
        ws.send(chunk)
        unacked += chunk.length
        outQueued -= chunk.length
        outQueue.shift()
      }
    }
    /** Whatever TLS wants on the wire (handshake messages, records, alerts). */
    const flush = () => {
      const { x, scratch } = engine!
      for (let n: number; conn && (n = x.tls_out(conn, scratch, SCRATCH)) > 0; ) {
        outQueue.push(new Uint8Array(x.memory.buffer, scratch, n).slice())
        outQueued += n
      }
      send()
    }
    async function write(bytes: Uint8Array): Promise<void> {
      const { x, scratch } = engine!
      for (let at = 0; at < bytes.length; ) {
        if (over) throw netError('ECONNRESET', 'the connection is closed')
        const n = Math.min(bytes.length - at, SCRATCH)
        new Uint8Array(x.memory.buffer, scratch, n).set(bytes.subarray(at, at + n))
        const took = x.tls_write(conn, scratch, n)
        if (took < 0) throw netError('EPROTO', `TLS: ${tlsError()}`)
        at += took
        flush()
        // TLS's buffer is full (the handshake is not over), or the relay is a window behind.
        if (took === 0 || outQueued > WINDOW) await new Promise<void>((next) => waiters.push(next))
      }
    }

    const finish = () => {
      if (over) return
      over = true
      // close_notify, as far as the window allows; the connection is not used again.
      engine!.x.tls_close(conn)
      flush()
      cleanup()
      try {
        controller?.close()
      } catch {
        // cancelled
      }
    }
    const parser = createResponseParser(req.method.toUpperCase() === 'HEAD', {
      head(status, reason, headers, bodyless) {
        const { x, scratch } = engine!
        const tls = utf8.decode(new Uint8Array(x.memory.buffer, scratch, x.tls_info(conn, scratch, 256)).slice())
        const body = new ReadableStream<Uint8Array>(
          {
            start(c) {
              controller = c
            },
            pull() {
              pump()
            },
            cancel() {
              fail(netError('ECONNRESET', 'response body cancelled'))
            },
          },
          new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER }),
        )
        settled = true
        resolve({ status, statusText: reason, headers, body: bodyless ? null : body, tls })
      },
      body(chunk) {
        try {
          controller?.enqueue(chunk)
        } catch {
          // cancelled
        }
      },
      end: finish,
      error: (message) => fail(netError('HPE_INVALID', `HTTP over the tunnel to ${host}: ${message}`)),
    })
    const wantMore = () => !controller || (controller.desiredSize ?? 1) > 0

    /** Received ciphertext into TLS, plaintext out of it into the parser, for as long as the body's reader wants more. */
    function pump(): void {
      if (over || !conn || pumping) return
      pumping = true
      const { x, scratch } = engine!
      let taken = 0
      try {
        for (let progressed = true; progressed && !over; ) {
          progressed = false
          while (inQueue.length) {
            const chunk = inQueue[0]!
            const n = Math.min(chunk.length, SCRATCH)
            new Uint8Array(x.memory.buffer, scratch, n).set(chunk.subarray(0, n))
            const took = x.tls_in(conn, scratch, n)
            if (took < 0) {
              const message = tlsError()
              flush() // the alert
              return fail(netError('EPROTO', `TLS with ${host}: ${message}`))
            }
            if (took === 0) break
            progressed = true
            taken += took
            if (took === chunk.length) inQueue.shift()
            else inQueue[0] = chunk.subarray(took)
            if (took < n) break
          }
          if (inEnded && !inQueue.length && !eofFed) {
            eofFed = true
            x.tls_in_eof(conn)
            progressed = true
          }
          flush()
          while (wantMore() && !over) {
            const n = x.tls_read(conn, scratch, SCRATCH)
            if (n === 0) break
            if (n < 0) {
              // -1: close_notify. -2: the stream stopped without it (or TLS failed), which
              // only a response that was already complete survives.
              const detail = n === -2 ? tlsError() : ''
              parser.eof(n === -1)
              if (!over) fail(netError('ECONNRESET', `TLS with ${host}: ${detail || 'closed'}`))
              return
            }
            progressed = true
            parser.push(new Uint8Array(x.memory.buffer, scratch, n).slice())
          }
          if (!wantMore()) break
        }
      } finally {
        pumping = false
        if (taken && relayOpen && ws?.readyState === 1) ws.send(JSON.stringify({ t: 'ack', bytes: taken }))
        wake()
      }
    }

    async function sendRequest(): Promise<void> {
      const method = req.method.toUpperCase()
      const body = req.body
      if (body instanceof Uint8Array) {
        await write(encoder.encode(requestHead(req, `content-length: ${body.length}\r\n`)))
        await write(body)
      } else if (body) {
        await write(encoder.encode(requestHead(req, 'transfer-encoding: chunked\r\n')))
        const reader = body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (over) return
            if (done) break
            if (!value?.length) continue
            await write(encoder.encode(`${value.length.toString(16)}\r\n`))
            await write(value)
            await write(encoder.encode('\r\n'))
          }
          await write(encoder.encode('0\r\n\r\n'))
        } finally {
          if (over) void reader.cancel().catch(() => {})
        }
      } else {
        await write(encoder.encode(requestHead(req, method === 'GET' || method === 'HEAD' ? '' : 'content-length: 0\r\n')))
      }
    }

    function onControl(text: string): void {
      let control: { t?: string; bytes?: number; code?: string; message?: string }
      try {
        control = JSON.parse(text)
      } catch {
        return
      }
      if (control.t === 'open') {
        if (relayOpen) return
        relayOpen = true
        const { x, scratch } = engine!
        const name = encoder.encode(host)
        new Uint8Array(x.memory.buffer, scratch, name.length).set(name)
        conn = x.tls_new(scratch, name.length)
        if (!conn) {
          const n = x.tls_error(0, scratch, 1024)
          return fail(netError('EPROTO', `TLS with ${host}: ${utf8.decode(new Uint8Array(x.memory.buffer, scratch, n).slice())}`))
        }
        flush() // ClientHello
        // The request is written now; TLS holds it until the handshake is over.
        sendRequest().catch((error) => {
          if (!over) fail(error)
        })
      } else if (control.t === 'ack' && Number.isFinite(control.bytes)) {
        unacked = Math.max(0, unacked - Number(control.bytes))
        send()
        wake()
      } else if (control.t === 'end') {
        inEnded = true
        pump()
      } else if (control.t === 'error') {
        const code = String(control.code ?? 'reset')
        const what = code === 'denied' ? `the relay refused ${host}:${port}` : `the relay could not carry the connection to ${host}:${port}`
        fail(netError(code === 'denied' ? 'EACCES' : code === 'refused' ? 'ECONNREFUSED' : code === 'timeout' ? 'ETIMEDOUT' : code === 'dns' ? 'ENOTFOUND' : 'ECONNRESET', `${what} (${code}: ${String(control.message ?? '').slice(0, 200)})`))
      }
    }

    if (req.signal?.aborted) return onAbort()
    req.signal?.addEventListener('abort', onAbort, { once: true })
    deps.engine().then((loaded) => {
      if (over) return
      engine = loaded
      const relay = new URL(deps.relayUrl)
      relay.searchParams.set('host', host)
      relay.searchParams.set('port', String(port))
      ws = new deps.WebSocket(relay.href)
      ws.binaryType = 'arraybuffer'
      ws.onmessage = (event) => {
        if (over) return
        if (typeof event.data === 'string') return onControl(event.data)
        inQueue.push(new Uint8Array(event.data as ArrayBuffer))
        pump()
      }
      ws.onclose = () => {
        if (over) return
        // A browser says nothing about a WebSocket that did not open: the relay is down, or it refused this page's origin.
        if (!relayOpen) return fail(netError('ECONNREFUSED', `the relay at ${relay.host} did not accept the WebSocket (it is unreachable, or this page's origin is not one it allows)`))
        inEnded = true
        pump()
        if (!over && !inQueue.length) fail(netError('ECONNRESET', `the relay closed the connection to ${host}:${port}`))
      }
    }, fail)
  })
}
