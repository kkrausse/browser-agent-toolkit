// Binding over the kernel's HTTP/1.1 and WebSocket codecs
// (crates/bat-kernel/src/http.rs, ws.rs). Used by the guest `http` module, the
// page's endpoint fetch and the preview bridge: there is no HTTP or WebSocket
// frame parser in JavaScript.
//
// Receiving: the kernel parses a socket's receive ring in place and reports
// body bytes as ranges inside the ring. `recv` copies each range once into
// private memory and hands it to the sink. Sending: `send` copies the caller's
// bytes once, straight into the free part of the send ring.
import type { Kernel } from '../kernel/kernel'

export const EV_HEAD = 1
export const EV_BODY = 2
export const EV_END = 3
export const EV_EOF = 4
export const EV_ERROR = 5
export const EV_WS_FRAME = 6
export const EV_WS_DATA = 7
export const EV_WS_END = 8

export const F_KEEPALIVE = 1
export const F_CHUNKED = 2
export const F_UPGRADE = 4
export const F_HAS_LENGTH = 8
export const F_EXPECT_CONTINUE = 16
export const F_UNTIL_CLOSE = 32
export const F_HTTP10 = 64
export const F_NO_BODY = 128

export const WS_FIN = 0x100
export const WS_MASK = 0x200

export const EAGAIN = 11
export const EPIPE = 32

export interface HttpHead {
  flags: number
  /** Response status; 0 for a request. */
  status: number
  /** Request method ('' for a response). */
  method: string
  /** Request target as sent ('' for a response). */
  target: string
  /** Response reason phrase. */
  reason: string
  /** Flat [name, value, name, value, ...] in wire order and wire case (Node's rawHeaders). */
  raw: string[]
  contentLength: number
}

export interface HttpSink {
  head(head: HttpHead): void
  body(chunk: Uint8Array): void
  /** The message is complete. */
  end(): void
  /** The peer closed. `clean`: between messages (or at the end of an until-close body). */
  eof(clean: boolean): void
  error(errno: number): void
}

export interface WsSink {
  frame(opcode: number, fin: boolean, length: number): void
  data(chunk: Uint8Array): void
  frameEnd(): void
  eof(clean: boolean): void
  error(errno: number): void
}

export interface HttpParser {
  /**
   * Parse what `fd` has received and deliver it to `sink`. Stops when the
   * socket has nothing more (returns false: wait for readability) or when
   * `more()` says the consumer is full (returns true: call again later).
   */
  recv(fd: number, sink: HttpSink, more?: () => boolean): boolean
  /** The next response answers a HEAD request. */
  expectNoBody(): void
  /** After a head with F_UPGRADE: take the raw connection (true) or go on as HTTP (false). */
  resume(fd: number, raw: boolean): void
  free(): void
}

export interface WsParser {
  recv(fd: number, sink: WsSink, more?: () => boolean): boolean
  free(): void
}

export type Codec = ReturnType<typeof createCodec>

const EV_WORDS = 2048
const latin1 = new TextDecoder('latin1')

/** One per kernel instance (cached on the Kernel object). */
export function getCodec(kernel: Kernel): Codec {
  const k = kernel as Kernel & { __codec?: Codec }
  return (k.__codec ??= createCodec(kernel))
}

export function createCodec(kernel: Kernel) {
  const x = kernel.x
  const inst = kernel.inst
  const evP: number = x.bat_alloc(EV_WORDS * 4 + 64) >>> 0
  if (!evP) throw new Error('kernel: out of memory')
  const outP = evP + EV_WORDS * 4
  const ev = new Uint32Array(EV_WORDS)

  /** Copy the event words out of shared memory, so sinks may re-enter the kernel. */
  const take = (n: number) => {
    const u32 = new Uint32Array(inst.u8().buffer, evP, n)
    ev.set(u32)
  }
  const copy = (ptr: number, len: number, alloc?: (n: number) => Uint8Array): Uint8Array => {
    const out = alloc ? alloc(len) : new Uint8Array(len)
    out.set(inst.u8().subarray(ptr, ptr + len))
    return out
  }

  function httpParser(kind: 'request' | 'response', alloc?: (n: number) => Uint8Array): HttpParser {
    let h: number = x.bat_http_parser_new(kind === 'response' ? 1 : 0) >>> 0
    let busy = false
    return {
      recv(fd, sink, more) {
        if (!h || busy) return false
        busy = true
        try {
          for (;;) {
            const n: number = x.bat_http_recv(h, fd, evP, EV_WORDS)
            if (n <= 0) {
              if (n < 0) sink.error(-n)
              return false
            }
            take(n)
            // Lent ranges are valid until the next recv on this parser: copy them all
            // before any sink runs (a sink may free the parser or close the fd).
            const chunks: (Uint8Array | undefined)[] = []
            for (let i = 0; i < n; ) {
              const kindWord = ev[i]
              if (kindWord === EV_BODY) {
                chunks.push(copy(ev[i + 1], ev[i + 2], alloc))
                i += 3
              } else if (kindWord === EV_HEAD) {
                chunks.push(copy(ev[i + 4], ev[i + 5]))
                i += ev[i + 1]
              } else i += 2
            }
            let c = 0
            for (let i = 0; i < n; ) {
              switch (ev[i]) {
                case EV_HEAD: {
                  const text = latin1.decode(chunks[c++]!)
                  const count = ev[i + 12]
                  const raw: string[] = new Array(count * 2)
                  for (let j = 0, w = i + 13; j < count; j++, w += 4) {
                    raw[j * 2] = text.substring(ev[w], ev[w] + ev[w + 1])
                    raw[j * 2 + 1] = text.substring(ev[w + 2], ev[w + 2] + ev[w + 3])
                  }
                  const status = ev[i + 3]
                  const a = text.substring(ev[i + 6], ev[i + 6] + ev[i + 7])
                  const head: HttpHead = {
                    flags: ev[i + 2],
                    status,
                    method: kind === 'request' ? a : '',
                    target: kind === 'request' ? text.substring(ev[i + 8], ev[i + 8] + ev[i + 9]) : '',
                    reason: kind === 'response' ? a : '',
                    raw,
                    contentLength: ev[i + 10] + ev[i + 11] * 4294967296,
                  }
                  i += ev[i + 1]
                  sink.head(head)
                  break
                }
                case EV_BODY:
                  i += 3
                  sink.body(chunks[c++]!)
                  break
                case EV_END:
                  i += 2
                  sink.end()
                  break
                case EV_EOF:
                  sink.eof(ev[i + 1] === 1)
                  i += 2
                  break
                default:
                  sink.error(ev[i + 1])
                  i += 2
              }
            }
            if (!h) return false
            if (more && !more()) return true
          }
        } finally {
          busy = false
        }
      },
      expectNoBody() {
        if (h) x.bat_http_expect_no_body(h)
      },
      resume(fd, raw) {
        if (h) x.bat_http_resume(h, fd, raw ? 1 : 0)
      },
      free() {
        if (h) x.bat_http_parser_free(h)
        h = 0
      },
    }
  }

  function wsParser(): WsParser {
    let h: number = x.bat_ws_new() >>> 0
    let busy = false
    return {
      recv(fd, sink, more) {
        if (!h || busy) return false
        busy = true
        try {
          for (;;) {
            const n: number = x.bat_ws_recv(h, fd, evP, EV_WORDS)
            if (n <= 0) {
              if (n < 0) sink.error(-n)
              return false
            }
            take(n)
            const chunks: Uint8Array[] = []
            for (let i = 0; i < n; ) {
              const w = ev[i]
              if (w === EV_WS_DATA) {
                chunks.push(copy(ev[i + 1], ev[i + 2]))
                i += 3
              } else i += w === EV_WS_FRAME ? 4 : w === EV_WS_END ? 1 : 2
            }
            let c = 0
            for (let i = 0; i < n; ) {
              switch (ev[i]) {
                case EV_WS_FRAME:
                  sink.frame(ev[i + 1] & 15, (ev[i + 1] & WS_FIN) !== 0, ev[i + 2] + ev[i + 3] * 4294967296)
                  i += 4
                  break
                case EV_WS_DATA:
                  i += 3
                  sink.data(chunks[c++])
                  break
                case EV_WS_END:
                  i += 1
                  sink.frameEnd()
                  break
                case EV_EOF:
                  sink.eof(ev[i + 1] === 1)
                  i += 2
                  break
                default:
                  sink.error(ev[i + 1])
                  i += 2
              }
            }
            if (!h) return false
            if (more && !more()) return true
          }
        } finally {
          busy = false
        }
      },
      free() {
        if (h) x.bat_ws_free(h)
        h = 0
      },
    }
  }

  /**
   * Copy `bytes[from..]` into the send ring of `fd`, optionally as chunks of a
   * chunked body. Returns the number of bytes accepted (less than asked: the
   * ring is full, wait for writability) or a negative errno (-EPIPE).
   */
  function send(fd: number, bytes: Uint8Array, from = 0, chunked = false): number {
    const flags = chunked ? 1 : 0
    let done = from
    const end = bytes.length
    while (done < end) {
      const cap: number = x.bat_http_reserve(fd, flags, outP)
      if (cap <= 0) {
        if (cap === -EAGAIN || cap === 0) break
        return cap
      }
      const u8 = inst.u8()
      const u32 = new Uint32Array(u8.buffer, outP, 5)
      const n = Math.min(cap, end - done)
      const l1 = Math.min(n, u32[2])
      u8.set(bytes.subarray(done, done + l1), u32[1])
      if (n > l1) u8.set(bytes.subarray(done + l1, done + n), u32[3])
      const rc: number = x.bat_http_commit(fd, flags, n)
      if (rc < 0) return rc
      done += n
    }
    return done - from
  }

  /** Write a latin1 string (a message head) into the send ring. Same result convention as `send`. */
  function sendText(fd: number, text: string, from = 0): number {
    let done = from
    const end = text.length
    while (done < end) {
      const cap: number = x.bat_http_reserve(fd, 0, outP)
      if (cap <= 0) {
        if (cap === -EAGAIN || cap === 0) break
        return cap
      }
      const u8 = inst.u8()
      const u32 = new Uint32Array(u8.buffer, outP, 5)
      const n = Math.min(cap, end - done)
      const l1 = Math.min(n, u32[2])
      let p = u32[1]
      for (let i = 0; i < l1; i++) u8[p++] = text.charCodeAt(done + i)
      p = u32[3]
      for (let i = l1; i < n; i++) u8[p++] = text.charCodeAt(done + i)
      const rc: number = x.bat_http_commit(fd, 0, n)
      if (rc < 0) return rc
      done += n
    }
    return done - from
  }

  /**
   * Send (part of) one WebSocket message. `first` is false when continuing a
   * message that did not fit before. Returns payload bytes accepted (the frame
   * is cut to the free space and continued later), or a negative errno;
   * -EAGAIN when not even a header fits.
   */
  function wsSend(fd: number, opcode: number, payload: Uint8Array, from: number, first: boolean, mask: boolean): number {
    const left = payload.length - from
    const flags = (first ? opcode : 0) | WS_FIN | (mask ? WS_MASK : 0)
    const n: number = x.bat_ws_reserve(fd, flags, left, outP)
    if (n < 0) return n
    const u8 = inst.u8()
    const u32 = new Uint32Array(u8.buffer, outP, 6)
    const l1 = Math.min(n, u32[3])
    if (l1) u8.set(payload.subarray(from, from + l1), u32[2])
    if (n > l1) u8.set(payload.subarray(from + l1, from + n), u32[4])
    const rc: number = x.bat_ws_commit(fd, u32[0] + n)
    return rc < 0 ? rc : n
  }

  function wsAcceptKey(key: string): string {
    const u8 = inst.u8()
    for (let i = 0; i < key.length; i++) u8[evP + i] = key.charCodeAt(i)
    x.bat_ws_accept_key(evP, key.length, evP + 256)
    let out = ''
    for (let i = 0; i < 28; i++) out += String.fromCharCode(u8[evP + 256 + i])
    return out
  }

  /** Identity of the listener on `port` (0: nothing listens). */
  const portListener = (port: number): number => x.bat_port_listener(port) >>> 0

  /** Resolve when something listens on `port`. Works on any thread. */
  async function waitForListener(port: number, signal?: AbortSignal): Promise<number> {
    const word = x.BAT_PORTS_WORD.value >>> 2
    for (;;) {
      signal?.throwIfAborted()
      const i32 = inst.i32()
      const seen = Atomics.load(i32, word)
      const id = portListener(port)
      if (id) return id
      const r = (Atomics as any).waitAsync(i32, word, seen, 1000)
      if (r.async) {
        if (signal) {
          let onAbort!: () => void
          const aborted = new Promise<void>((resolve) => {
            onAbort = resolve
            signal.addEventListener('abort', onAbort, { once: true })
          })
          await Promise.race([r.value, aborted])
          signal.removeEventListener('abort', onAbort)
        } else await r.value
      }
    }
  }

  return { httpParser, wsParser, send, sendText, wsSend, wsAcceptKey, portListener, waitForListener }
}

/** Lower-cased lookup in a raw header list; the first match. */
export function rawHeader(raw: string[], name: string): string | undefined {
  for (let i = 0; i < raw.length; i += 2) if (raw[i].length === name.length && raw[i].toLowerCase() === name) return raw[i + 1]
  return undefined
}
