// WebSocket client over a kernel socket: the HTTP upgrade and all framing go
// through the kernel codec. Used by the preview bridge (the preview frame's
// `WebSocket` shim) and by the guest's own `WebSocket` to loopback ports.
import { EAGAIN, F_UPGRADE, getCodec, rawHeader, type HttpHead } from './codec'
import { POLLERR, POLLHUP, POLLIN, POLLOUT, type NetContext } from './client'

export interface WsHandlers {
  open(protocol: string, extensions: string): void
  message(data: string | Uint8Array): void
  /** Always the last call. */
  close(code: number, reason: string, wasClean: boolean): void
  /** Followed by `close`. */
  error(message: string): void
}

export interface WsConnection {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  /** Payload bytes queued but not yet in the socket ring. */
  readonly bufferedAmount: number
  /** Drop the connection without a closing handshake. */
  destroy(): void
}

const OP_TEXT = 1
const OP_BINARY = 2
const OP_CLOSE = 8
const OP_PING = 9
const OP_PONG = 10

const encoder = new TextEncoder()

export function wsConnect(
  ctx: NetContext,
  port: number,
  path: string,
  options: { protocols?: string[]; headers?: [string, string][] },
  handlers: WsHandlers,
): WsConnection {
  const { kernel, io } = ctx
  const codec = getCodec(kernel)
  let state: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting'
  let fd = -1
  let wantOut = false
  let buffered = 0
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let sentClose = false
  type Out = { opcode: number; payload: Uint8Array; at: number; first: boolean }
  const queue: Out[] = []
  let handshake = ''
  let handshakeAt = 0
  let http = codec.httpParser('response')
  const ws = codec.wsParser()

  const finish = (code: number, reason: string, clean: boolean, error?: string) => {
    if (state === 'closed') return
    state = 'closed'
    if (closeTimer) clearTimeout(closeTimer)
    if (fd >= 0) {
      io.off(fd)
      try {
        kernel.close(fd)
      } catch {
        // already closed
      }
    }
    http.free()
    ws.free()
    queue.length = 0
    buffered = 0
    if (error !== undefined) handlers.error(error)
    handlers.close(code, reason, clean)
  }

  const arm = () => {
    if (state !== 'closed') io.on(fd, POLLIN | POLLHUP | POLLERR | (wantOut ? POLLOUT : 0), onReady)
  }
  const setWantOut = (on: boolean) => {
    if (wantOut !== on) {
      wantOut = on
      arm()
    }
  }

  const flush = () => {
    if (state === 'closed') return
    if (handshakeAt < handshake.length) {
      const n = codec.sendText(fd, handshake, handshakeAt)
      if (n < 0) return finish(1006, '', false, 'connection closed during the handshake')
      handshakeAt += n
      if (handshakeAt < handshake.length) return setWantOut(true)
    }
    if (state === 'connecting') return setWantOut(false)
    while (queue.length) {
      const item = queue[0]
      const n = codec.wsSend(fd, item.opcode, item.payload, item.at, item.first, true)
      if (n === -EAGAIN) return setWantOut(true)
      if (n < 0) return finish(1006, '', false)
      item.at += n
      item.first = false
      if (item.opcode < 8) buffered -= n
      if (item.at < item.payload.length) return setWantOut(true)
      queue.shift()
    }
    setWantOut(false)
  }
  const enqueue = (opcode: number, payload: Uint8Array) => {
    queue.push({ opcode, payload, at: 0, first: true })
    if (opcode < 8) buffered += payload.length
    if (queue.length === 1 && !wantOut) flush()
  }

  // ---- receiving ----
  let op = 0
  let parts: Uint8Array[] = []
  let size = 0
  let frameOp = 0
  let frameFin = false
  let control: Uint8Array[] = []
  const join = (list: Uint8Array[], total: number) => {
    if (list.length === 1) return list[0]
    const out = new Uint8Array(total)
    let at = 0
    for (const p of list) {
      out.set(p, at)
      at += p.length
    }
    return out
  }
  const wsSink = {
    frame(opcode: number, fin: boolean) {
      frameOp = opcode
      frameFin = fin
      if (opcode >= 8) control = []
      else if (opcode !== 0) {
        op = opcode
        parts = []
        size = 0
      }
    },
    data(chunk: Uint8Array) {
      if (frameOp >= 8) control.push(chunk)
      else {
        parts.push(chunk)
        size += chunk.length
      }
    },
    frameEnd() {
      if (state === 'closed') return
      if (frameOp === OP_PING) return enqueue(OP_PONG, join(control, control.reduce((n, c) => n + c.length, 0)))
      if (frameOp === OP_PONG) return
      if (frameOp === OP_CLOSE) {
        const body = join(control, control.reduce((n, c) => n + c.length, 0))
        const code = body.length >= 2 ? (body[0] << 8) | body[1] : 1005
        const reason = body.length > 2 ? new TextDecoder().decode(body.subarray(2)) : ''
        if (!sentClose) {
          sentClose = true
          enqueue(OP_CLOSE, body.subarray(0, Math.min(body.length, 2)))
        }
        return finish(code, reason, true)
      }
      if (!frameFin) return
      const whole = join(parts, size)
      parts = []
      size = 0
      if (state !== 'open' && state !== 'closing') return
      handlers.message(op === OP_TEXT ? new TextDecoder().decode(whole) : whole)
    },
    eof() {
      finish(1006, '', false)
    },
    error() {
      finish(1002, 'protocol error', false, 'invalid WebSocket frame from the server')
    },
  }

  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
  const httpSink = {
    head(head: HttpHead) {
      const upgrade = rawHeader(head.raw, 'upgrade')
      if (head.status !== 101 || !(head.flags & F_UPGRADE) || upgrade?.toLowerCase() !== 'websocket') {
        return finish(1006, '', false, `unexpected response to the WebSocket handshake: ${head.status}`)
      }
      if (rawHeader(head.raw, 'sec-websocket-accept') !== codec.wsAcceptKey(key)) {
        return finish(1006, '', false, 'invalid Sec-WebSocket-Accept')
      }
      http.resume(fd, true)
      http.free()
      state = 'open'
      handlers.open(rawHeader(head.raw, 'sec-websocket-protocol') ?? '', rawHeader(head.raw, 'sec-websocket-extensions') ?? '')
    },
    body() {},
    end() {},
    eof() {
      finish(1006, '', false, 'connection closed during the handshake')
    },
    error() {
      finish(1006, '', false, 'invalid response to the WebSocket handshake')
    },
  }

  const onReady = (mask: number) => {
    if (state === 'closed') return
    if (mask & POLLOUT) flush()
    if (mask & (POLLIN | POLLHUP)) {
      if (state === 'connecting') http.recv(fd, httpSink, () => state === 'connecting')
      if (state === 'open' || state === 'closing') ws.recv(fd, wsSink)
    }
  }

  const rc: number = kernel.x.bat_connect(port)
  if (rc < 0) {
    queueMicrotask(() => finish(1006, '', false, `connect ECONNREFUSED 127.0.0.1:${port}`))
  } else {
    fd = rc
    kernel.setNonblock(fd, true)
    handshake = `GET ${path} HTTP/1.1\r\nhost: localhost:${port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: ${key}\r\nsec-websocket-version: 13\r\n`
    if (options.protocols?.length) handshake += `sec-websocket-protocol: ${options.protocols.join(', ')}\r\n`
    for (const [name, value] of options.headers ?? []) handshake += `${name}: ${value}\r\n`
    handshake += '\r\n'
    arm()
    flush()
  }

  return {
    send(data) {
      if (state !== 'open') return
      if (typeof data === 'string') enqueue(OP_TEXT, encoder.encode(data))
      else enqueue(OP_BINARY, data)
    },
    close(code, reason) {
      if (state === 'closed' || state === 'closing') return
      if (state === 'connecting') return finish(1006, '', false)
      state = 'closing'
      const text = encoder.encode(reason ?? '')
      const body = code === undefined ? new Uint8Array(0) : new Uint8Array(2 + text.length)
      if (code !== undefined) {
        body[0] = code >> 8
        body[1] = code & 255
        body.set(text, 2)
      }
      sentClose = true
      enqueue(OP_CLOSE, body)
      // A server that never answers the close does not keep the socket forever.
      closeTimer = setTimeout(() => finish(code ?? 1005, reason ?? '', false), 3000)
    },
    get bufferedAmount() {
      return buffered
    },
    destroy() {
      finish(1006, '', false)
    },
  }
}
