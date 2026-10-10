// `RuntimeHost.endpoint(port)`: the page talks to a guest listener over a
// kernel socket directly. No worker hop, no message channel: the page's own
// kernel instance writes the request into the socket ring and parses the
// response out of it, driven by the page reactor.
import { createHttpClient, headerPairs, toResponse, wireBody, type HttpClient, type NetContext } from '../net/client'
import { getCodec } from '../net/codec'

export interface Endpoint {
  readonly url: string
  fetch(path: string, init?: RequestInit): Promise<Response>
  ready(signal?: AbortSignal): Promise<void>
}

/** `previewUrl`: where the service worker serves guest listeners, ending in `/` (`https://app.example/preview/`). */
export function createEndpoints(ctx: NetContext, previewUrl: string, closed: AbortSignal) {
  const client: HttpClient = createHttpClient(ctx)
  const codec = getCodec(ctx.kernel)
  closed.addEventListener('abort', () => client.close(), { once: true })

  async function fetchPort(port: number, path: string, init: RequestInit = {}): Promise<Response> {
    if (closed.aborted) throw new Error('The runtime is closed')
    const headers = headerPairs(init.headers)
    const { body, type } = await wireBody(init.body)
    if (type && !headers.some(([name]) => name.toLowerCase() === 'content-type')) headers.push(['content-type', type])
    try {
      const res = await client.request(port, {
        method: init.method ?? 'GET',
        path: path.startsWith('/') ? path : `/${path}`,
        headers,
        body,
        signal: init.signal ? AbortSignal.any([init.signal, closed]) : closed,
      })
      return toResponse(res)
    } catch (e) {
      if ((e as any)?.name === 'AbortError' || (e as any)?.name === 'TimeoutError' || !(e as any)?.code) throw e
      // What fetch() does for a connection failure, with the reason attached.
      throw new TypeError(`Failed to fetch guest port ${port}: ${(e as Error).message}`, { cause: e })
    }
  }

  function endpoint(port: number): Endpoint {
    return {
      url: `${previewUrl}${port}/`,
      fetch: (path, init) => fetchPort(port, path, init),
      async ready(signal) {
        await codec.waitForListener(port, signal ? AbortSignal.any([signal, closed]) : closed)
      },
    }
  }
  return { endpoint, client }
}
