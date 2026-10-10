/// <reference lib="webworker" />
// The preview service worker. Scope `/preview/`: it controls only preview
// frames, never the page that hosts the editor.
//
// A request for `/preview/<port>/…` is streamed to the guest listener on that
// port and its response streamed back. The worker cannot share the kernel's
// memory, so it talks to the bridge worker (netd) over one MessagePort the
// page hands to both; request and response bodies cross as transferred
// streams, so nothing is buffered whole and the page's main thread is not on
// the path.
import type { FromNetd, ShimToServiceWorker, ToNetd, ToServiceWorker } from '../host/bridge-protocol'
import { previewShim } from './preview-shim'

declare const self: ServiceWorkerGlobalScope

const ISOLATION: [string, string][] = [
  // The preview is embedded by a cross-origin-isolated page.
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
]
const SHIM = `<script>(${previewShim.toString()})()</script>`
const route = /^\/preview\/(\d+)(\/.*)?$/

let bridge: MessagePort | undefined
let bridgeWaiters: ((port: MessagePort | undefined) => void)[] = []
const hostPaths = new Map<number, string[]>()
const jars = new Map<number, Map<string, string>>()
const pending = new Map<number, { resolve(m: Extract<FromNetd, { t: 'response' }>): void; reject(e: Error & { code?: string }): void }>()
let nextId = 1

function setBridge(port: MessagePort) {
  bridge?.close()
  bridge = port
  port.onmessage = (e: MessageEvent<FromNetd>) => {
    const m = e.data
    const p = pending.get(m.id)
    if (!p) return void (m.t === 'response' && m.body instanceof ReadableStream && m.body.cancel().catch(() => {}))
    pending.delete(m.id)
    if (m.t === 'response') p.resolve(m)
    else p.reject(Object.assign(new Error(m.message), { code: m.code }))
  }
  ;(port as any).onclose = () => {
    if (bridge === port) dropBridge()
  }
  for (const wake of bridgeWaiters.splice(0)) wake(port)
}
function dropBridge() {
  bridge = undefined
  for (const p of pending.values()) p.reject(Object.assign(new Error('The editor runtime closed'), { code: 'ECLOSED' }))
  pending.clear()
}
/** After an idle restart this worker has no port: ask the editor page for a new one. */
async function getBridge(): Promise<MessagePort | undefined> {
  if (bridge) return bridge
  const waiter = new Promise<MessagePort | undefined>((resolve) => {
    bridgeWaiters.push(resolve)
    setTimeout(() => resolve(undefined), 4000)
  })
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ t: 'bat-need-port' })
  return waiter
}

self.addEventListener('install', () => void self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('message', (event) => {
  const m = event.data as ToServiceWorker | ShimToServiceWorker
  if (!m || typeof m.t !== 'string') return
  if (m.t === 'bat-port') {
    hostPaths.clear()
    for (const [port, list] of Object.entries(m.hostPaths)) hostPaths.set(Number(port), list)
    setBridge(m.port)
  } else if (m.t === 'bat-host-paths') {
    hostPaths.clear()
    for (const [port, list] of Object.entries(m.hostPaths)) hostPaths.set(Number(port), list)
  } else if (m.t === 'bat-closed') {
    dropBridge()
  } else if (m.t === 'bat-ws') {
    event.waitUntil(openWebSocket(m))
  }
})

async function openWebSocket(m: ShimToServiceWorker) {
  const url = new URL(m.url)
  const match = route.exec(url.pathname)
  const port = await getBridge()
  if (!match || !port) {
    m.channel.postMessage({ t: 'close', code: 1006, reason: '', wasClean: false })
    return
  }
  const guestPort = Number(match[1])
  const headers: [string, string][] = [
    ['origin', self.location.origin],
    ['user-agent', navigator.userAgent],
  ]
  const cookie = cookieHeader(guestPort)
  if (cookie) headers.push(['cookie', cookie])
  const message: ToNetd = { t: 'ws', port: guestPort, path: url.pathname + url.search, protocols: m.protocols, headers, channel: m.channel }
  port.postMessage(message, [m.channel])
}

function cookieHeader(port: number): string {
  const jar = jars.get(port)
  return jar ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : ''
}
/** `Set-Cookie` cannot be put on a synthesized response; keep the guest's cookies here and send them back to it. */
function storeCookie(port: number, line: string) {
  const [pair, ...attrs] = line.split(';')
  const eq = pair.indexOf('=')
  if (eq <= 0) return
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()
  let jar = jars.get(port)
  if (!jar) jars.set(port, (jar = new Map()))
  let expired = false
  for (const attr of attrs) {
    const [k, v = ''] = attr.trim().split('=')
    if (/^max-age$/i.test(k) && Number(v) <= 0) expired = true
    if (/^expires$/i.test(k) && Date.parse(v) <= Date.now()) expired = true
  }
  if (expired) jar.delete(name)
  else jar.set(name, value)
}

/** Insert the shim before the document's first script can run, without waiting for the whole body. */
function injectShim(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder('latin1')
  const shim = new TextEncoder().encode(SHIM)
  let held: Uint8Array[] = []
  let heldBytes = 0
  let done = false
  const flush = (controller: TransformStreamDefaultController<Uint8Array>, final: boolean) => {
    const all = new Uint8Array(heldBytes)
    let at = 0
    for (const c of held) {
      all.set(c, at)
      at += c.length
    }
    // Latin-1 keeps byte offsets: one character per byte.
    const text = decoder.decode(all)
    const head = /<head(?:\s[^>]*)?>/i.exec(text)
    let cut = -1
    if (head) cut = head.index + head[0].length
    else if (final || heldBytes >= 16384) {
      const html = /<html(?:\s[^>]*)?>/i.exec(text)
      const doctype = /<!doctype[^>]*>/i.exec(text)
      cut = html ? html.index + html[0].length : doctype ? doctype.index + doctype[0].length : 0
    }
    if (cut < 0) return
    done = true
    held = []
    controller.enqueue(all.subarray(0, cut))
    controller.enqueue(shim)
    if (cut < all.length) controller.enqueue(all.subarray(cut))
  }
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (done) return controller.enqueue(chunk)
        held.push(chunk)
        heldBytes += chunk.length
        flush(controller, false)
      },
      flush(controller) {
        if (!done) flush(controller, true)
      },
    }),
  )
}

function plain(status: number, text: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Preview</title><body style="font:14px system-ui;padding:2rem;color:#555">${text}</body>`, {
    status,
    headers: [...ISOLATION, ['Content-Type', 'text/html; charset=utf-8'], ['Cache-Control', 'no-store']],
  })
}

async function toGuest(event: FetchEvent, guestPort: number, url: URL): Promise<Response> {
  const request = event.request
  const port = await getBridge()
  if (!port) return plain(503, 'The editor is not running in this browser tab.')
  const headers: [string, string][] = []
  request.headers.forEach((value, name) => headers.push([name, value]))
  if (!request.headers.has('user-agent')) headers.push(['user-agent', navigator.userAgent])
  headers.push(['x-forwarded-host', url.host], ['x-forwarded-proto', url.protocol.slice(0, -1)])
  const cookie = cookieHeader(guestPort)
  if (cookie) headers.push(['cookie', cookie])
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null
  const id = nextId++
  const answer = new Promise<Extract<FromNetd, { t: 'response' }>>((resolve, reject) => pending.set(id, { resolve, reject }))
  // The guest server is configured with the prefix as its base: it sees the whole path.
  const message: ToNetd = { t: 'fetch', id, port: guestPort, method: request.method, path: url.pathname + url.search, headers, body: hasBody ? request.body : null }
  port.postMessage(message, hasBody ? [request.body as unknown as Transferable] : [])
  request.signal.addEventListener('abort', () => {
    port.postMessage({ t: 'abort', id } satisfies ToNetd)
    pending.get(id)?.reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))
    pending.delete(id)
  })
  let res: Extract<FromNetd, { t: 'response' }>
  try {
    res = await answer
  } catch (e) {
    const code = (e as any)?.code
    if (code === 'ECONNREFUSED') return plain(503, `Nothing is listening on port ${guestPort} in the editor yet.`)
    return plain(502, `The preview server did not answer (${code ?? 'error'}).`)
  }
  const out = new Headers()
  let html = false
  for (const [name, value] of res.headers) {
    const lower = name.toLowerCase()
    if (lower === 'set-cookie') {
      storeCookie(guestPort, value)
      continue
    }
    if (lower === 'content-type' && /^text\/html\b/i.test(value)) html = true
    if (lower === 'location') {
      // A guest that redirects to its own absolute URL means this origin.
      try {
        const target = new URL(value, url)
        if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(target.hostname) && Number(target.port || 80) === guestPort) {
          out.append(name, url.origin + target.pathname + target.search + target.hash)
          continue
        }
      } catch {
        // pass it through as written
      }
    }
    try {
      out.append(name, value)
    } catch {
      // not representable
    }
  }
  for (const [name, value] of ISOLATION) out.set(name, value)
  const discard = () => (res.body instanceof ReadableStream ? res.body.cancel().catch(() => {}) : undefined)
  if (res.status < 200 || res.status > 599) {
    await discard()
    return plain(502, `The preview server answered with status ${res.status}.`)
  }
  const nullBody = res.status === 204 || res.status === 205 || res.status === 304 || request.method === 'HEAD'
  let body: ReadableStream<Uint8Array> | ArrayBuffer | null = nullBody ? null : res.body
  if (nullBody) void discard()
  if (body && html && res.status !== 206) {
    body = injectShim(body instanceof ReadableStream ? body : new Response(body).body!)
    out.delete('content-length')
  }
  return new Response(body, { status: res.status, statusText: /^[\t\x20-\x7e]*$/.test(res.statusText) ? res.statusText : '', headers: out })
}

/** A `hostPaths` prefix: the same request, to the page's real server. */
function toHost(request: Request, target: string): Promise<Response> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null
  const init: RequestInit & { duplex?: string } = {
    method: request.method,
    headers: request.headers,
    body: hasBody ? request.body : undefined,
    credentials: 'same-origin',
    cache: request.cache === 'only-if-cached' ? 'default' : request.cache,
    redirect: request.mode === 'navigate' ? 'manual' : request.redirect,
    referrer: request.referrer,
    signal: request.signal,
  }
  if (hasBody) init.duplex = 'half'
  return fetch(target, init)
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  const match = route.exec(url.pathname)
  if (!match) return
  const guestPort = Number(match[1])
  const below = match[2] ?? '/'
  // Answered here: the cost of the service-worker path alone (docs/experiments/2026-10-09-net.md).
  if (below === '/__bat/ping') return event.respondWith(new Response('pong', { headers: [...ISOLATION, ['Cache-Control', 'no-store']] }))
  const prefixes = hostPaths.get(guestPort)
  if (prefixes?.some((p) => below === p || below.startsWith(p.endsWith('/') ? p : `${p}/`) || below.startsWith(`${p}?`))) {
    event.respondWith(toHost(event.request, url.origin + below + url.search))
    return
  }
  event.respondWith(toGuest(event, guestPort, url))
})
