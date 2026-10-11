// The probe pages' service worker (scope: this directory). A static host sends no COOP/COEP
// headers, so this adds them to everything it serves, which is what makes the pages
// cross-origin isolated (shared memory needs that). It also plays the server of the
// preload-reuse probe: `preload/<variant>/frame/` and its `m.js`, with the headers of the
// variant, counting how often `m.js` is asked for.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' }
const variants = {
  'no-cache': { cacheControl: 'no-cache', link: true },
  'no-store': { cacheControl: 'no-store', link: true },
  'no-link': { cacheControl: 'no-store', link: false },
  'vary-star': { cacheControl: 'no-store', link: true, vary: '*' },
}
// Since this worker started; the page sees a restart by `born` changing.
const born = Date.now() + Math.random()
const state = {}
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  const scope = new URL(self.registration.scope)
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return
  const match = /^preload\/([\w-]+)\/(frame\/|frame\/m\.js|load|stats)$/.exec(url.pathname.slice(scope.pathname.length))
  if (match && variants[match[1]]) {
    const variant = variants[match[1]], s = (state[match[1]] ??= { load: 0, asked: 0 }), dir = `${scope.pathname}preload/${match[1]}/frame/`
    const answer = (type, body) => new Response(body, { headers: { ...isolation, 'Content-Type': type, 'Cache-Control': variant.cacheControl, ...(variant.vary ? { Vary: variant.vary } : {}) } })
    const json = () => new Response(JSON.stringify({ born, ...s }), { headers: { ...isolation, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
    if (match[2] === 'load') { s.load = Number(url.searchParams.get('n')); return event.respondWith(json()) }
    if (match[2] === 'stats') return event.respondWith(json())
    if (match[2] === 'frame/') return event.respondWith(answer('text/html', `<!doctype html><title>frame</title>${variant.link ? `<link rel="modulepreload" href="${dir}m.js">` : ''}<script type="module">window.ran = (await import('${dir}m.js')).load</script>`))
    s.asked++
    return event.respondWith(answer('text/javascript', `export const load = ${s.load}`))
  }
  if (event.request.method !== 'GET') return
  event.respondWith(fetch(event.request.mode === 'navigate' ? event.request : new Request(url.href, { cache: 'no-cache' })).then(response => {
    if (response.status === 0) return response
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(isolation)) headers.set(name, value)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }))
})
