// Where a guest's outgoing HTTP goes. Used by the global `fetch` and by the
// client halves of `node:http` / `node:https`.
//
//   http://localhost:<port>, 127.0.0.1, [::1]   → kernel socket to the guest listener
//   http(s)://host.internal[:port]              → the page's own server (same origin as this
//                                                 worker, so cookies travel and nothing is
//                                                 mixed content); the URL already carries the
//                                                 page's scheme and port (RuntimeHost.hostOrigin)
//   https://<host named in BAT_FETCH_TUNNEL>    → the runtime's own TLS and HTTP/1.1 client,
//                                                 over a TCP relay (tunnel.ts)
//   anything else                               → the browser's fetch
//
// A loopback port named in the process's `BAT_HOST_LOOPBACK_PORTS` (comma-separated) is the
// machine's, not the guest's: it goes to the browser's fetch like any other host. Without
// that a server on the developer's own machine (a local model endpoint) could not be told
// apart from a guest listener.
//
// `BAT_FETCH_MAP` in the process's environment is a JSON object of exact URLs (origin and
// path, no query) to the URL fetched in their place: `{ "https://issuer.example/keys.json":
// "https://page.example/app/keys.json" }`. For a public document a program insists on reading
// from a host that sends no CORS headers, which the page serves a copy of. The guest sees the
// answer under the URL it asked for.
//
// `BAT_FETCH_TUNNEL` (host names, or `https://host/path` prefixes for only the URLs under a
// path; separated by spaces or commas) with `BAT_FETCH_TUNNEL_URL` (`wss://relay.example/tcp`)
// in the process's environment: an https request to one of those is not given to the browser. The runtime opens a WebSocket to the relay, which opens
// a TCP connection to the host and carries bytes; TLS (certificate chain and name verified
// against public roots; nothing can turn that off) and HTTP/1.1 are spoken here, in the tab.
// For an API that answers without `Access-Control-Allow-Origin`, whose response the browser's
// fetch would refuse to show. The request is the program's own, as Node would send it: no
// `Origin`, no cookies, no preflight, the program's headers as written. See tunnel.ts.
//
// With `BAT_FETCH_DIAG=1` in the process's environment, a request handed to the browser's
// fetch that rejects or is answered with a status of 400 or more leaves one line on the
// process's stderr: `[bat fetch] <METHOD> <origin + path> -> <status | error>`. Never the
// query string, headers or bodies. A cross-origin failure (CORS, mixed content, a host that
// is down) is otherwise only the guest's "fetch failed", and the browser tells script no more
// than "Failed to fetch": the line at least says which request it was. A tunnelled request
// leaves a line whatever its outcome, which says so: `-> HTTP 200 (tunnel via relay.example,
// TLSv1_3 …)`, or `-> tunnel via relay.example: <what failed: the relay, TLS, HTTP>`.
import type { Runtime } from '../process/runtime'
import { createHttpClient, headerPairs, toResponse, wireBody, type HttpClient, type WireResponse } from './client'
import { getNet, isLoopback } from './net'
import { instantiateTls, tunnelRequest, type TlsEngine } from './tunnel'

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
  const browserFetch = rt.host.fetch
  const said = (input: RequestInfo | URL, init: RequestInit | undefined, result: string) => {
    const process = (rt as any).process
    if (process?.env?.BAT_FETCH_DIAG !== '1') return
    let where = '(unparsed URL)'
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      where = url.origin + url.pathname
    } catch { /* as it is */ }
    const method = (init?.method ?? (typeof input === 'object' && !(input instanceof URL) ? input.method : 'GET')).toUpperCase()
    try { process.stderr?.write(`[bat fetch] ${method} ${where} -> ${result}\n`) } catch { /* no stderr */ }
  }
  let mapText: string | undefined, map: Record<string, string> = {}
  /** The URL fetched in place of `input`, when `BAT_FETCH_MAP` names it. */
  const mapped = (input: RequestInfo | URL): string | undefined => {
    const text = (rt as any).process?.env?.BAT_FETCH_MAP
    if (!text) return undefined
    if (text !== mapText) {
      mapText = text
      try { map = JSON.parse(text) } catch { map = {} }
    }
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const to = map[url.origin + url.pathname]
      return typeof to === 'string' ? to : undefined
    } catch { return undefined }
  }
  /** The browser's fetch, with the URL map applied and reporting what failed (see the top of the file). */
  const native = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let response: Response
    try {
      const to = mapped(input)
      // The copy is the page's own file: the request's headers and mode were meant for the other host.
      if (to !== undefined) response = await browserFetch(to, { signal: init?.signal ?? (typeof input === 'object' && !(input instanceof URL) ? input.signal : undefined) })
      else response = await browserFetch(input, init)
    } catch (error) {
      // An abort is the caller's own doing.
      const name = (error as any)?.name
      if (name !== 'AbortError' && name !== 'TimeoutError') said(input, init, `${name ?? 'Error'}: ${String((error as any)?.message ?? error).slice(0, 200)}`)
      throw error
    }
    if (response.status >= 400) said(input, init, `HTTP ${response.status}`)
    return response
  }
  const client = createHttpClient({ kernel: rt.kernel, io })

  // ---- the tunnel (see the top of the file, and tunnel.ts) ----
  const env = (name: string): string => String((rt as any).process?.env?.[name] ?? '')
  /** The relay's address when `url` is to be tunnelled. */
  const tunnelFor = (url: URL): string | undefined => {
    const relay = env('BAT_FETCH_TUNNEL_URL')
    if (!relay || url.protocol !== 'https:') return undefined
    const at = url.origin + url.pathname
    // An entry is a host name, or `https://host/path` for the URLs under that path only.
    const named = env('BAT_FETCH_TUNNEL').split(/[\s,]+/).some((entry) => (entry.includes('/') ? at.startsWith(entry) : entry.toLowerCase() === url.hostname))
    return named ? relay : undefined
  }
  let engine: Promise<TlsEngine> | undefined
  /** bat_tls.wasm, fetched and instantiated at the first tunnelled request of this process. */
  const tlsEngine = (): Promise<TlsEngine> =>
    (engine ??= (async () => {
      const url = rt.config.wasm.tls
      if (!url) throw new Error('this runtime was started without its TLS module (bat_tls.wasm)')
      const response = await browserFetch(url)
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
      const loaded = instantiateTls(await WebAssembly.compile(await response.arrayBuffer()))
      if (loaded.testBuild) {
        try { (rt as any).process?.stderr?.write('[bat fetch] bat_tls.wasm is a TEST build: it trusts a test certificate besides the public roots\n') } catch { /* no stderr */ }
      }
      return loaded
    })().catch((error) => {
      engine = undefined
      throw error
    }))
  type Wire = { method: string; headers: [string, string][]; body: Uint8Array | ReadableStream<Uint8Array> | null; signal?: AbortSignal }
  /** One request through the relay; one diagnostics line whatever happens. */
  async function tunnelled(relay: string, url: URL, req: Wire): Promise<WireResponse & { url: string }> {
    const via = `tunnel via ${(() => { try { return new URL(relay).host } catch { return 'an unreadable relay address' } })()}`
    try {
      const res = await tunnelRequest({ relayUrl: relay, WebSocket: rt.host.WebSocket, engine: tlsEngine }, { url, ...req })
      said(url, { method: req.method }, `HTTP ${res.status} (${via}, ${res.tls})`)
      return { status: res.status, statusText: res.statusText, headers: res.headers, body: res.body, url: url.href }
    } catch (error) {
      const name = (error as any)?.name
      if (name !== 'AbortError' && name !== 'TimeoutError') said(url, { method: req.method }, `${via}: ${String((error as any)?.message ?? error).slice(0, 300)}`)
      throw error
    }
  }
  /** `fetch` for a tunnelled URL: the program's request as written, redirects followed here. */
  async function tunnelFetch(relay: string, url: URL, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const given = typeof input === 'object' && !(input instanceof URL) ? input : undefined
    let method = (init?.method ?? given?.method ?? 'GET').toUpperCase()
    const signal = init?.signal ?? given?.signal ?? undefined
    const redirect = init?.redirect ?? given?.redirect ?? 'follow'
    let headers = headerPairs(init?.headers ?? given?.headers)
    const has = (name: string) => headers.some(([n]) => n.toLowerCase() === name)
    let body: Uint8Array | ReadableStream<Uint8Array> | null = null
    if (init?.body != null) {
      const wire = await wireBody(init.body)
      body = wire.body
      if (wire.type && !has('content-type')) headers.push(['content-type', wire.type])
    } else if (given?.body) body = new Uint8Array(await given.arrayBuffer())
    // What Node's fetch adds when the program did not say.
    if (!has('accept')) headers.push(['accept', '*/*'])
    if (!has('user-agent')) headers.push(['user-agent', 'node'])
    // Bodies are passed on as they arrive; nothing here inflates more than gzip and deflate.
    if (!has('accept-encoding')) headers.push(['accept-encoding', 'identity'])
    let res: WireResponse & { url: string }
    let redirected = false
    for (let hops = 0; ; hops++) {
      try {
        res = await tunnelled(relay, url, { method, headers, body, signal })
      } catch (e) {
        if ((e as any)?.name === 'AbortError' || (e as any)?.name === 'TimeoutError') throw e
        throw new TypeError(`fetch failed: ${String((e as any)?.message ?? e)}`, { cause: e })
      }
      const location = redirect !== 'manual' && REDIRECTS.has(res.status) ? res.headers.find(([n]) => n.toLowerCase() === 'location')?.[1] : undefined
      if (location === undefined) break
      await res.body?.cancel().catch(() => {})
      if (redirect === 'error') throw new TypeError('fetch failed: unexpected redirect')
      if (hops >= 20) throw new TypeError('fetch failed: redirect count exceeded')
      if (body instanceof ReadableStream) throw new TypeError('fetch failed: a redirect of a request with a streamed body')
      const next = new URL(location, url)
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET'
        body = null
        headers = headers.filter(([n]) => !/^content-/i.test(n))
      }
      // Credentials are for the host they were given for.
      if (next.origin !== url.origin) headers = headers.filter(([n]) => !/^(authorization|cookie|proxy-authorization)$/i.test(n))
      const onward = tunnelFor(next)
      if (!onward) return guestFetch(next, { method, headers: headers.filter(([n]) => !/^(accept-encoding|user-agent)$/i.test(n)), body: body as BodyInit | null, signal, redirect })
      relay = onward
      url = next
      redirected = true
    }
    let stream = track(res.body)
    const encoding = res.headers.find(([n]) => n.toLowerCase() === 'content-encoding')?.[1]?.trim().toLowerCase()
    if (stream && (encoding === 'gzip' || encoding === 'deflate')) {
      stream = stream.pipeThrough(new DecompressionStream(encoding) as unknown as TransformStream<Uint8Array, Uint8Array>)
      res.headers = res.headers.filter(([n]) => !/^content-(encoding|length)$/i.test(n))
    }
    const response = toResponse({ ...res, body: stream })
    Object.defineProperty(response, 'url', { value: res.url, configurable: true })
    if (redirected) Object.defineProperty(response, 'redirected', { value: true, configurable: true })
    return response
  }

  const pageOrigin = new URL(rt.host.location.origin)

  const stripBrackets = (h: string) => (h.startsWith('[') ? h.slice(1, -1) : h)
  // Read per request: the process's environment is bound after this is created.
  const hostPort = (url: URL) => ((rt as any).process?.env?.BAT_HOST_LOOPBACK_PORTS ?? '').split(',').includes(url.port || '80')
  const isLocal = (url: URL) => url.protocol === 'http:' && isLoopback(stripBrackets(url.hostname)) && !hostPort(url)
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
      const relay = tunnelFor(url)
      if (relay) {
        const res = await tunnelled(relay, url, req)
        return { ...res, body: track(res.body) }
      }
      // The browser owns these headers; sending them is an error or a no-op (or, for
      // `user-agent` in WebKit, a preflight: see withoutUserAgent).
      const headers = req.headers.filter(([n]) => !/^(host|connection|content-length|transfer-encoding|keep-alive|upgrade|expect|user-agent)$/i.test(n))
      const out = await native(isHostAlias(url) ? toPage(url) : url, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : (req.body as BodyInit | null), signal: req.signal, redirect: 'manual' })
      return { status: out.status, statusText: out.statusText, headers: headerPairs(out.headers), body: track(out.body), url: url.href }
    } finally {
      loop.unref()
    }
  }

  /**
   * For a request the browser sends: without the guest's `user-agent`. Chromium does not
   * send a script's User-Agent, so nothing there ever depended on it; WebKit does send it,
   * and since it is not a CORS-safelisted header the request then needs a preflight that
   * servers of plain documents refuse (models.opencode.ai/api.json: 405, "Load failed").
   */
  function withoutUserAgent(input: RequestInfo | URL, init?: RequestInit): [RequestInfo | URL, RequestInit | undefined] {
    if (init?.headers) {
      const headers = new Headers(init.headers)
      if (!headers.has('user-agent')) return [input, init]
      headers.delete('user-agent')
      return [input, { ...init, headers }]
    }
    if (typeof input === 'object' && !(input instanceof URL) && input.headers.has('user-agent')) {
      const headers = new Headers(input.headers)
      headers.delete('user-agent')
      return [new Request(input, { headers }), init]
    }
    return [input, init]
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
      const relay = url && tunnelFor(url)
      if (relay) return await tunnelFetch(relay, url!, input, init)
      ;[input, init] = withoutUserAgent(input, init)
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
