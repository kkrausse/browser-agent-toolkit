// A raw kernel-level HTTP/WebSocket responder in a bare worker: no Node
// runtime, only the kernel binding and the codec. It is what the page-side
// endpoint client and the preview bridge are tested against.
//   /hello            small text
//   /echo             echoes the request body (content-length)
//   /big?mb=N         N MiB with content-length
//   /chunked?mb=N     N MiB chunked
//   /sse?n=N&ms=M     N events, one every M ms, chunked
//   /redirect         302 to hello
//   /cookie           sets a cookie; /whoami returns the Cookie header
//   /index.html       a page for the preview frame
//   /ws               WebSocket echo
import { attachKernel } from '../../kernel/attach'
import { createKernel, type Kernel } from '../../kernel/kernel'
import { createReactor } from '../../host/reactor'
import { createOutbox, POLLERR, POLLHUP, POLLIN, POLLOUT } from '../client'
import { EAGAIN, F_KEEPALIVE, F_UPGRADE, getCodec, rawHeader, type HttpHead } from '../codec'

const encoder = new TextEncoder()

self.onmessage = async (e: MessageEvent) => {
  const { module, memory, port, prefix = '' } = e.data
  const inst = await attachKernel({ module, memory, canBlock: true })
  const kernel: Kernel = createKernel(inst)
  kernel.x.bat_host_proc_new()
  const io = createReactor(kernel)
  const codec = getCodec(kernel)
  const lfd = kernel.listen(port)
  kernel.setNonblock(lfd, true)
  let served = 0

  function serve(fd: number) {
    kernel.setNonblock(fd, true)
    const parser = codec.httpParser('request')
    let wantOut = false
    let closed = false
    let ws: ReturnType<typeof codec.wsParser> | undefined
    const arm = () => !closed && io.on(fd, POLLIN | POLLHUP | POLLERR | (wantOut ? POLLOUT : 0), onReady)
    const out = createOutbox(codec, fd, (on) => {
      wantOut = on
      arm()
    })
    const close = () => {
      if (closed) return
      closed = true
      io.off(fd)
      parser.free()
      ws?.free()
      kernel.close(fd)
    }
    let head: HttpHead | undefined
    let body: Uint8Array[] = []
    const respond = (status: number, headers: Record<string, string>, payload?: Uint8Array | string) => {
      const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload
      let text = `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Status'}\r\n`
      for (const [k, v] of Object.entries(headers)) text += `${k}: ${v}\r\n`
      if (bytes) text += `Content-Length: ${bytes.length}\r\n`
      out.write(text + '\r\n')
      if (bytes) out.write(bytes)
    }
    const handle = (h: HttpHead, data: Uint8Array[]) => {
      served++
      const url = new URL(h.target, 'http://x')
      const path = prefix && url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length - 1) : url.pathname
      const keep = (h.flags & F_KEEPALIVE) !== 0
      const done = () => {
        if (!keep) void out.drained().then(close)
      }
      if (path === '/hello') {
        respond(200, { 'Content-Type': 'text/plain' }, `hello ${served}`)
        done()
      } else if (path === '/echo') {
        const total = data.reduce((n, c) => n + c.length, 0)
        const all = new Uint8Array(total)
        let at = 0
        for (const c of data) {
          all.set(c, at)
          at += c.length
        }
        respond(200, { 'Content-Type': rawHeader(h.raw, 'content-type') ?? 'application/octet-stream', 'X-Method': h.method }, all)
        done()
      } else if (path === '/big' || path === '/chunked') {
        const mb = Number(url.searchParams.get('mb') ?? 1)
        const chunk = new Uint8Array(64 * 1024)
        for (let i = 0; i < chunk.length; i++) chunk[i] = i & 255
        const count = mb * 16
        const chunked = path === '/chunked'
        out.write(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n${chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${count * chunk.length}`}\r\n\r\n`)
        void (async () => {
          for (let i = 0; i < count && !closed; i++) {
            out.write(chunk, chunked)
            await out.drained()
          }
          if (chunked) out.write('0\r\n\r\n')
          done()
        })()
      } else if (path === '/sse') {
        const n = Number(url.searchParams.get('n') ?? 5)
        const ms = Number(url.searchParams.get('ms') ?? 100)
        out.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\n\r\n')
        let i = 0
        const timer = setInterval(() => {
          if (closed) return clearInterval(timer)
          out.write(encoder.encode(`data: {"i":${i},"t":${Date.now()}}\n\n`), true)
          if (++i >= n) {
            clearInterval(timer)
            out.write('0\r\n\r\n')
            done()
          }
        }, ms)
      } else if (path === '/redirect') {
        respond(302, { Location: `${prefix || '/'}hello` }, '')
        done()
      } else if (path === '/cookie') {
        respond(200, { 'Set-Cookie': 'sid=abc123; Path=/', 'Content-Type': 'text/plain' }, 'set')
        done()
      } else if (path === '/whoami') {
        respond(200, { 'Content-Type': 'text/plain' }, rawHeader(h.raw, 'cookie') ?? '(none)')
        done()
      } else if (path === '/' || path === '/index.html') {
        respond(200, { 'Content-Type': 'text/html; charset=utf-8' }, `<!doctype html><html><head><title>frame</title></head><body><h1 id="h">preview frame</h1><script>window.__frameLoaded = true</script></body></html>`)
        done()
      } else {
        respond(404, { 'Content-Type': 'text/plain' }, `no route ${path}`)
        done()
      }
    }
    // WebSocket echo (server role: unmasked frames out).
    let wsParts: Uint8Array[] = []
    let wsOp = 0
    let frameOp = 0
    let fin = false
    const wsQueue: { op: number; payload: Uint8Array; at: number; first: boolean }[] = []
    const wsFlush = () => {
      while (wsQueue.length) {
        const item = wsQueue[0]
        const n = codec.wsSend(fd, item.op, item.payload, item.at, item.first, false)
        if (n === -EAGAIN) {
          wantOut = true
          return arm()
        }
        if (n < 0) return close()
        item.at += n
        item.first = false
        if (item.at < item.payload.length) {
          wantOut = true
          return arm()
        }
        wsQueue.shift()
      }
      if (wantOut) {
        wantOut = false
        arm()
      }
    }
    const wsSink = {
      frame(op: number, f: boolean) {
        frameOp = op
        fin = f
        if (op !== 0) {
          wsOp = op
          wsParts = []
        }
      },
      data(chunk: Uint8Array) {
        wsParts.push(chunk)
      },
      frameEnd() {
        if (!fin) return
        const total = wsParts.reduce((n, c) => n + c.length, 0)
        const all = new Uint8Array(total)
        let at = 0
        for (const c of wsParts) {
          all.set(c, at)
          at += c.length
        }
        wsParts = []
        if (frameOp === 8) {
          wsQueue.push({ op: 8, payload: all.subarray(0, 2), at: 0, first: true })
          wsFlush()
          return close()
        }
        if (frameOp === 9) wsQueue.push({ op: 10, payload: all, at: 0, first: true })
        else if (frameOp !== 10) wsQueue.push({ op: wsOp, payload: all, at: 0, first: true })
        wsFlush()
      },
      eof: close,
      error: close,
    }
    const sink = {
      head(h: HttpHead) {
        head = h
        body = []
        if (h.flags & F_UPGRADE) {
          const key = rawHeader(h.raw, 'sec-websocket-key') ?? ''
          parser.resume(fd, true)
          out.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${codec.wsAcceptKey(key)}\r\n\r\n`)
          ws = codec.wsParser()
        }
      },
      body(chunk: Uint8Array) {
        body.push(chunk)
      },
      end() {
        if (head) handle(head, body)
        head = undefined
      },
      eof: close,
      error: close,
    }
    function onReady(mask: number) {
      if (closed) return
      if (mask & POLLOUT) {
        if (ws) wsFlush()
        else out.flush()
      }
      if (mask & (POLLIN | POLLHUP)) {
        if (!ws) parser.recv(fd, sink, () => !ws)
        if (ws && !closed) ws.recv(fd, wsSink)
      }
      if (mask & POLLERR) close()
    }
    arm()
  }

  io.on(lfd, POLLIN, () => {
    for (;;) {
      const fd = kernel.accept(lfd)
      if (fd === undefined) break
      serve(fd)
    }
  })
  postMessage({ type: 'listening', port })
}
