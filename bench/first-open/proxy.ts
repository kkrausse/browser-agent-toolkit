#!/usr/bin/env bun
// A bandwidth-limited front for the example server, for first-open measurements on
// something like a real link. Chrome's own throttling (CDP Network.emulateNetworkConditions)
// applies per target and the image is fetched by a worker, so the limit is put on the wire
// instead: one token bucket shared by every response body, like one downlink.
//
//   bun bench/first-open/proxy.ts --port 4131 --upstream 4130 --mbit 50 [--rtt 20]
//
// Response bodies are passed through as the upstream sent them (no re-compression, no
// decompression), so what is limited is the bytes a browser would really download.
// `GET /__proxy/stats` returns bytes sent per path since `POST /__proxy/reset`.
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const port = Number(arg('port', '4131'))
const upstream = `http://127.0.0.1:${arg('upstream', '4130')}`
const mbit = Number(arg('mbit', '50'))
const rtt = Number(arg('rtt', '0'))
const rate = (mbit * 1e6) / 8 // bytes per second
const PIECE = 16 * 1024

// Token bucket with a short burst; waiters are served in arrival order.
let tokens = rate * 0.05
let last = performance.now()
let queue: Promise<void> = Promise.resolve()
function take(bytes: number): Promise<void> {
  const turn = queue.then(async () => {
    for (;;) {
      const now = performance.now()
      tokens = Math.min(rate * 0.05, tokens + ((now - last) / 1000) * rate)
      last = now
      if (tokens >= bytes) {
        tokens -= bytes
        return
      }
      await Bun.sleep(Math.max(1, ((bytes - tokens) / rate) * 1000))
    }
  })
  queue = turn
  return turn
}

let stats: Record<string, number> = {}
function limited(body: ReadableStream<Uint8Array>, path: string): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let pending: Uint8Array | undefined
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!pending?.length) {
        const { done, value } = await reader.read()
        if (done) return controller.close()
        pending = value
      }
      const piece = pending.subarray(0, PIECE)
      pending = pending.subarray(piece.length)
      await take(piece.length)
      stats[path] = (stats[path] ?? 0) + piece.length
      controller.enqueue(piece)
    },
    cancel: (reason) => reader.cancel(reason),
  })
}

Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 240,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/__proxy/stats') return Response.json({ mbit, rtt, bytes: stats })
    if (url.pathname === '/__proxy/reset') {
      stats = {}
      return new Response('ok')
    }
    if (rtt) await Bun.sleep(rtt)
    const headers = new Headers(request.headers)
    // The app compares the Origin's host name with the request's: keep the browser's Host.
    headers.set('host', request.headers.get('host') ?? url.host)
    const response = await fetch(upstream + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
      decompress: false,
      signal: request.signal,
    } as RequestInit)
    const out = new Headers(response.headers)
    return new Response(response.body ? limited(response.body, url.pathname) : null, { status: response.status, statusText: response.statusText, headers: out })
  },
})
console.log(`proxy :${port} → ${upstream} at ${mbit} Mbit/s${rtt ? `, +${rtt} ms per request` : ''}`)
