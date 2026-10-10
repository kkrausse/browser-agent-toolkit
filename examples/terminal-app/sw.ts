// The page's service worker: what a server would otherwise have to do for this directory.
//
//   1. Cross-origin isolation. Every response for the page gets COOP/COEP (the document
//      and the worker scripts need them; `SharedArrayBuffer` needs the document isolated).
//   2. Compressed files. The build ships the big files only as `<name>.gz` and lists them
//      here; a request for `<name>` is answered by fetching `<name>.gz` and inflating it
//      as it arrives (`DecompressionStream`), which is what `Content-Encoding` does in a
//      server's hands. The reader's backpressure still reaches the network.
//   3. The preview. The runtime's own worker script is run in this one (`importScripts`):
//      with this worker's scope being the page's directory, it serves guest listeners at
//      `<directory>/preview/<port>/` and leaves everything else to the listener below.
//
// A classic script at the top of the directory, so its scope needs no `Service-Worker-Allowed`.
interface FetchEventLike extends Event { request: Request; respondWith(response: Promise<Response>): void }
interface WorkerScope { registration: { scope: string }; importScripts(...urls: string[]): void; addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void }
declare const GZIPPED: string[]

const worker = self as unknown as WorkerScope
const scope = new URL(worker.registration.scope)
const preview = `${scope.pathname}preview/`
worker.importScripts(new URL('editor/runtime/sw.js', scope).href)

const gzipped = new Set(GZIPPED)
const isolation: [string, string][] = [
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
]
const types: Record<string, string> = { js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', json: 'application/json', map: 'application/json', scm: 'text/plain; charset=utf-8' }
/** Named by its content: the browser's cache may answer. Everything else is revalidated, so a new build is seen. */
const hashed = /-[0-9a-f]{16}\./

async function serve(request: Request, url: URL): Promise<Response> {
  let path = url.pathname.slice(scope.pathname.length)
  try { path = decodeURIComponent(path) } catch { /* as written */ }
  if (gzipped.has(path)) {
    const response = await fetch(`${url.origin}${url.pathname}.gz`, { cache: hashed.test(path) ? 'default' : 'no-cache', signal: request.signal })
    if (!response.ok || !response.body) return new Response(`${path}.gz: HTTP ${response.status}`, { status: response.status || 502, headers: isolation })
    const headers = new Headers(isolation)
    headers.set('Content-Type', types[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream')
    const modified = response.headers.get('last-modified')
    if (modified) headers.set('Last-Modified', modified)
    return new Response(request.method === 'HEAD' ? null : response.body.pipeThrough(new DecompressionStream('gzip')), { headers })
  }
  // A navigation request cannot be remade with other options.
  const response = await (request.mode === 'navigate' ? fetch(request) : fetch(url.href, { method: request.method, headers: request.headers, cache: hashed.test(path) ? 'default' : 'no-cache', signal: request.signal }))
  if (response.status === 0) return response
  const headers = new Headers(response.headers)
  for (const [name, value] of isolation) headers.set(name, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

worker.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url)
  if (request.method !== 'GET' && request.method !== 'HEAD') return
  // The page's own files only: not another origin (the model), not the preview, and not
  // what a preview frame asks of its server (the runtime's listener above routes those).
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname) || url.pathname.startsWith(preview)) return
  if (request.referrer.startsWith(scope.origin + preview)) return
  event.respondWith(serve(request, url))
})
