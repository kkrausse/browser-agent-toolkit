// Shared by the probe pages: a readout on the page with a copy button (a phone has no
// console), kept in localStorage as it grows so that a tab the system killed shows what it
// had printed; and the page's isolation, from the service worker beside it (sw.js).
const name = location.pathname.split('/').pop().replace(/\.html$/, '') || 'probe'
const key = `bat-probe-${name}`
const pre = document.querySelector('#out')
const lines = []
let previous = ''
try { previous = localStorage.getItem(key) ?? '' } catch { /* no storage */ }
export const text = value => value instanceof Error ? `${value.name}: ${value.message}` : typeof value === 'string' ? value : JSON.stringify(value)
export function out(line = '') {
  lines.push(String(line))
  pre.textContent = lines.join('\n')
  try { localStorage.setItem(key, lines.join('\n').slice(-20000)) } catch { /* no storage */ }
}
export const readout = () => lines.join('\n')
/** A run that was started and never said it ended: said at the next load. */
export function begin(what) { try { localStorage.setItem(key + '-running', `${what}, started ${new Date().toISOString()}`) } catch { /* no storage */ } }
export function end() { try { localStorage.removeItem(key + '-running') } catch { /* no storage */ } }
const copy = document.querySelector('#copy')
copy?.addEventListener('click', () => {
  const all = readout()
  const byHand = () => { const area = document.querySelector('#manual'); area.hidden = false; area.value = all; area.focus(); area.select(); area.setSelectionRange(0, all.length); let ok = false; try { ok = document.execCommand('copy') } catch {} copy.textContent = ok ? 'Copied' : 'Select all, copy' }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(all).then(() => { copy.textContent = 'Copied' }, byHand); else byHand()
})

/** Resolves in an isolated page; reloads once to get there. Rejects where it cannot be had. */
export async function isolated() {
  out(`${name} · ${new Date().toISOString()}`)
  out(`url: ${location.href}`)
  out(`user agent: ${navigator.userAgent}`)
  let unfinished = ''
  try { unfinished = localStorage.getItem(key + '-running') ?? '' } catch { /* no storage */ }
  if (unfinished) { out(`!! THE PREVIOUS RUN NEVER FINISHED (${unfinished}): the tab was closed, reloaded or killed during it. What it had printed:`); out(previous.split('\n').map(l => '   | ' + l).join('\n')); out(''); end() }
  if (!('serviceWorker' in navigator)) throw Error(`no service worker here (secure context: ${isSecureContext}; a private window, or a page that is not https)`)
  const tries = Number(sessionStorage.getItem(key + '-reloads') ?? 0)
  if (!crossOriginIsolated || !navigator.serviceWorker.controller) {
    await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' })
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise(resolve => { navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }); setTimeout(resolve, 3000) })
    if (tries >= 2) throw Error(`could not be cross-origin isolated after ${tries} reloads (controller ${!!navigator.serviceWorker.controller}, crossOriginIsolated ${crossOriginIsolated})`)
    sessionStorage.setItem(key + '-reloads', String(tries + 1))
    out('reloading once so the service worker serves this page…')
    location.reload()
    await new Promise(() => {})
  }
  sessionStorage.removeItem(key + '-reloads')
  out(`crossOriginIsolated: ${crossOriginIsolated} (service worker controls the page${tries ? `, after ${tries} reload(s)` : ''})`)
  out('')
}
