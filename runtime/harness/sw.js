// Harness-only service worker for the code-cache experiment (page query `sw=1`).
// Requests for /sw-cache/<tag>/<file> are answered from Cache Storage; a miss fetches
// /prepared/<file> and stores it. Chrome keeps V8 code caches for Cache Storage
// responses separately from the HTTP cache's, which is what the experiment compares.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  const m = /^\/sw-cache\/([^/]+)\/(.+)$/.exec(url.pathname)
  if (!m) return
  e.respondWith(
    (async () => {
      const cache = await caches.open(`bat-harness-${m[1]}`)
      const hit = await cache.match(url.pathname)
      if (hit) return hit
      const res = await fetch(`/prepared/${m[2]}`)
      if (res.ok) await cache.put(url.pathname, res.clone())
      return res
    })(),
  )
})
