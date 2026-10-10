// Where a guest's outgoing HTTP goes. Used by the global `fetch` and by the
// client halves of `node:http` / `node:https`.
//
//   http://localhost:<port>, 127.0.0.1, [::1]   → kernel socket to the guest listener
//   http(s)://host.internal[:port]              → the page's own server (same origin as this
//                                                 worker, so cookies travel and nothing is
//                                                 mixed content); the URL already carries the
//                                                 page's scheme and port (RuntimeHost.hostOrigin)
//   anything else                               → the browser's fetch
import type { Runtime } from '../process/runtime'
import { createHttpClient, headerPairs, toResponse, type HttpClient, type WireResponse } from './client'
import { getNet, isLoopback } from './net'

export const HOST_ALIAS = 'host.internal'

export interface GuestFetch {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  /** For `http.request`: the same routing, without building Request objects for loopback. */
  route(url: URL, req: { method: string; headers: [string, string][]; body: Uint8Array | null; signal?: AbortSignal }): Promise<WireResponse & { url: string }>
  client: HttpClient
}

const kFetch = Symbol.for('bat.net.fetch')
const REDIRECTS = new Set([301, 302, 303, 307, 308])

export function getGuestFetch(rt: Runtime): GuestFetch {
  const r = rt as any
  return (r[kFetch] ??= createGuestFetch(rt))
}

function createGuestFetch(rt: Runtime): GuestFetch {
  const { io } = getNet(rt)
  const loop = rt.loop
  const native = rt.host.fetch
  const client = createHttpClient({ kernel: rt.kernel, io })
  const pageOrigin = new URL(rt.host.location.origin)

  const stripBrackets = (h: string) => (h.startsWith('[') ? h.slice(1, -1) : h)
  const isLocal = (url: URL) => url.protocol === 'http:' && isLoopback(stripBrackets(url.hostname))
  const isHostAlias = (url: URL) => url.hostname === HOST_ALIAS
  /** `host.internal` is this worker's own origin under another name. */
  const toPage = (url: URL) => {
    const out = new URL(url.href)
    out.protocol = pageOrigin.protocol
    out.hostname = pageOrigin.hostname
    out.port = pageOrigin.port
    return out
  }

  /**
   * The process must not exit while a response is awaited or while someone is
   * reading its body. An unread body does not keep the process alive.
   */
  function track(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
    if (!body) return null
    const reader = body.getReader()
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        loop.ref()
        try {
          const { done, value } = await reader.read()
          if (done) controller.close()
          else controller.enqueue(value)
        } catch (e) {
          controller.error(e)
        } finally {
          loop.unref()
        }
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    })
  }

  async function local(url: URL, req: { method: string; headers: [string, string][]; body: Uint8Array | null; signal?: AbortSignal }, follow: boolean): Promise<WireResponse & { url: string }> {
    let method = req.method
    let body = req.body
    let headers = req.headers
    for (let hops = 0; ; hops++) {
      const port = url.port ? Number(url.port) : 80
      if (!headers.some(([n]) => n.toLowerCase() === 'host')) headers = [['host', url.host], ...headers]
      const res = await client.request(port, { method, path: url.pathname + url.search, headers, body, signal: req.signal })
      const location = follow && REDIRECTS.has(res.status) ? res.headers.find(([n]) => n.toLowerCase() === 'location')?.[1] : undefined
      if (location === undefined) return { ...res, url: url.href }
      await res.body?.cancel().catch(() => {})
      if (hops >= 20) throw new TypeError('fetch failed: redirect count exceeded')
      const next = new URL(location, url)
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET'
        body = null
        headers = headers.filter(([n]) => !/^content-/i.test(n))
      }
      headers = headers.filter(([n]) => n.toLowerCase() !== 'host')
      if (!isLocal(next)) {
        const out = await native(isHostAlias(next) ? toPage(next) : next, { method, headers, body: body as BodyInit | null, signal: req.signal })
        return { status: out.status, statusText: out.statusText, headers: headerPairs(out.headers), body: out.body, url: out.url }
      }
      url = next
    }
  }

  async function route(url: URL, req: { method: string; headers: [string, string][]; body: Uint8Array | null; signal?: AbortSignal }) {
    loop.ref()
    try {
      if (isLocal(url)) {
        const res = await local(url, req, false)
        return { ...res, body: track(res.body) }
      }
      // The browser owns these headers; sending them is an error or a no-op.
      const headers = req.headers.filter(([n]) => !/^(host|connection|content-length|transfer-encoding|keep-alive|upgrade|expect)$/i.test(n))
      const out = await native(isHostAlias(url) ? toPage(url) : url, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : (req.body as BodyInit | null), signal: req.signal, redirect: 'manual' })
      return { status: out.status, statusText: out.statusText, headers: headerPairs(out.headers), body: track(out.body), url: url.href }
    } finally {
      loop.unref()
    }
  }

  async function guestFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url: URL | undefined
    try {
      url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    } catch {
      // Let the platform report the bad URL its own way.
    }
    loop.ref()
    try {
      if (url && isLocal(url)) {
        const request = new Request(input as RequestInfo, init)
        const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null
        let res: WireResponse & { url: string }
        try {
          res = await local(url, { method: request.method, headers: headerPairs(request.headers), body, signal: request.signal }, request.redirect !== 'manual')
        } catch (e) {
          if ((e as any)?.name === 'AbortError' || (e as any)?.name === 'TimeoutError') throw e
          throw new TypeError('fetch failed', { cause: e })
        }
        const response = toResponse({ ...res, body: track(res.body) })
        Object.defineProperty(response, 'url', { value: res.url, configurable: true })
        return response
      }
      let response: Response
      if (url && isHostAlias(url)) {
        // Re-target the request; a Request object is rebuilt because its URL is read-only.
        if (typeof input === 'object' && !(input instanceof URL)) response = await native(new Request(toPage(url), input as Request), init)
        else response = await native(toPage(url), init)
      } else response = await native(input, init)
      if (!response.body || response.status < 200) return response
      const tracked = new Response(track(response.body), { status: response.status, statusText: response.statusText, headers: response.headers })
      for (const key of ['url', 'redirected', 'type'] as const) Object.defineProperty(tracked, key, { value: response[key], configurable: true })
      return tracked
    } finally {
      loop.unref()
    }
  }

  return { fetch: guestFetch, route, client }
}

/** Replace the worker's `fetch` with the routed one (idempotent). */
export function installFetch(rt: Runtime): void {
  const g = rt.host.global
  if (g.fetch?.__bat) return
  const gf = getGuestFetch(rt)
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => gf.fetch(input, init)
  Object.defineProperty(fetch, '__bat', { value: true })
  Object.defineProperty(g, 'fetch', { value: fetch, writable: true, configurable: true, enumerable: true })
}
