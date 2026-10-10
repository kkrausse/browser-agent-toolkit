// A static host sends no COOP/COEP headers, so the page gets them from its own service
// worker (sw.ts): register it, and once it controls this page reload once; the document
// then arrives through the worker with the headers and `crossOriginIsolated` is true. The
// same worker serves the preview frame and the files the build shipped compressed, so the
// page waits for it even where a server already isolates.
const key = 'terminal-app-isolating'

export async function isolate(workerUrl: string, scope: string, note: (kind: string, data?: unknown) => void): Promise<void> {
  if (!('serviceWorker' in navigator)) throw Error('This page needs a service worker, and this browser offers none here (a private window, or a page that is not https or localhost).')
  const registration = await navigator.serviceWorker.register(workerUrl, { scope, updateViaCache: 'none' })
  // A new build's worker knows which files that build compressed: let it take over first.
  await registration.update().catch(() => {})
  const next = registration.installing ?? registration.waiting
  if (next) {
    await new Promise<void>(resolve => {
      const check = () => { if (next.state === 'activated' || next.state === 'redundant') resolve() }
      next.addEventListener('statechange', check)
      check()
      setTimeout(resolve, 10_000)
    })
  }
  await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>(resolve => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
      setTimeout(resolve, 3000)
    })
  }
  const tries = Number(sessionStorage.getItem(key) ?? 0)
  if (navigator.serviceWorker.controller && crossOriginIsolated) {
    sessionStorage.removeItem(key)
    note('stage', `isolated by the service worker${tries ? ` after ${tries} reload(s)` : ''}`)
    return
  }
  if (tries >= 2) {
    sessionStorage.removeItem(key)
    throw Error(`This page could not be cross-origin isolated (service worker ${navigator.serviceWorker.controller ? 'controls the page' : 'does not control the page'}, crossOriginIsolated ${crossOriginIsolated}).`)
  }
  sessionStorage.setItem(key, String(tries + 1))
  // Seen in Chrome 154: the browser kept this document, waiting here, and brought it back
  // on a later reload of the isolated page. It then has to go again.
  addEventListener('pageshow', (event: PageTransitionEvent) => { if (event.persisted) location.reload() })
  note('stage', 'reloading once so the service worker serves this page')
  location.reload()
  await new Promise(() => {})
}
