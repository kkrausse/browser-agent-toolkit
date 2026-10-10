// Finishing an OAuth sign-in whose redirect is a loopback address ("Sign in with ChatGPT").
//
// The OpenCode server listens for the redirect on `127.0.0.1:<port>` and waits. In the tab
// that listener is a socket of the runtime's kernel: the browser tab the user signs in with
// cannot reach it and ends on a dead `http://127.0.0.1:<port>/auth/callback?code=…` address.
// OpenAI accepts only loopback redirects for this flow (a web address of this page is refused
// at the first request), so nothing can bring the browser back here by itself. This page can
// reach the listener, though (`runtime.endpoint(port).fetch`): the user pastes the address the
// browser ended on and the page makes that request.
//
// The page learns of an attempt from the client's own requests, which all pass through it:
// the answer to `POST /api/integration/<id>/connect/oauth` carries the sign-in URL, and the
// client then polls `GET …/connect/oauth/<attempt>` until it is no longer pending.
import type { RuntimeHost } from '@kkrausse/browser-agent-toolkit/browser'

export type ServerFetch = (path: string, init: { method: string; headers: [string, string][]; body: Uint8Array | null; signal: AbortSignal }) => Promise<Response>

interface Pending { attempt: string; url: string; port: number; path: string }

const loopback = /^(127(\.\d+){3}|localhost|\[::1\])$/
const start = /^\/api\/integration\/[^/]+\/connect\/oauth$/
const status = /^\/api\/integration\/[^/]+\/connect\/oauth\/([^/]+)$/

/** Wraps the client's path to the server; shows `#signin` while a loopback sign-in is pending. */
export function watchSignIn(fetch: ServerFetch, runtime: () => RuntimeHost | undefined, log: (line: string) => void): ServerFetch {
  const bar = document.querySelector<HTMLFormElement>('#signin')!
  const link = bar.querySelector<HTMLAnchorElement>('a')!, input = bar.querySelector<HTMLInputElement>('input')!, note = bar.querySelector<HTMLElement>('output')!
  let pending: Pending | undefined
  let clear: ReturnType<typeof setTimeout> | undefined
  /** `failure`: what is left in the bar for a while after an attempt that did not succeed. */
  const show = (next: Pending | undefined, failure?: string) => {
    pending = next
    clearTimeout(clear)
    bar.hidden = !next && !failure
    bar.classList.toggle('over', !next)
    if (!next) {
      note.textContent = failure ? `Sign-in ${failure}` : ''
      if (failure) clear = setTimeout(() => show(undefined), 30_000)
      return
    }
    link.href = next.url
    input.value = ''
    input.placeholder = `http://127.0.0.1:${next.port}${next.path}?code=…`
    note.textContent = ''
    // Allowed while the key press that started the sign-in still counts as a gesture; the link is there either way.
    try { window.open(next.url, '_blank') } catch { /* blocked */ }
  }

  bar.addEventListener('submit', event => {
    event.preventDefault()
    const now = pending, host = runtime()
    if (!now || !host) return
    let pasted: URL
    try { pasted = new URL(input.value.trim()) } catch { note.textContent = 'That is not an address.'; return }
    if (!loopback.test(pasted.hostname) || Number(pasted.port) !== now.port || !(pasted.searchParams.has('code') || pasted.searchParams.has('error'))) {
      note.textContent = `Expected the address the sign-in tab ended on: http://127.0.0.1:${now.port}${now.path}?code=…`
      return
    }
    note.textContent = 'Delivering…'
    // The listener answers when the server has exchanged the code, with a page that says how it went.
    void host.endpoint(now.port).fetch(pasted.pathname + pasted.search, { headers: { host: pasted.host }, signal: AbortSignal.timeout(60_000) }).then(async response => {
      const said = new DOMParser().parseFromString(await response.text(), 'text/html').body.textContent?.replace(/\s+/g, ' ').trim().slice(0, 200) ?? ''
      log(`[page] sign-in callback delivered to the server's listener on port ${now.port}: HTTP ${response.status}${response.ok ? '' : ` (${said})`}`)
      if (pending === now) note.textContent = response.ok ? 'Signed in.' : `The server refused it (HTTP ${response.status}): ${said}`
    }, error => {
      log(`[page] sign-in callback could not be delivered to port ${now.port}: ${error instanceof Error ? error.message : String(error)}`)
      if (pending === now) note.textContent = `Could not reach the server's listener: ${error instanceof Error ? error.message : String(error)}`
    })
  })

  return async (path, init) => {
    const response = await fetch(path, init)
    const route = path.split('?')[0]!
    try {
      if (init.method === 'POST' && start.test(route) && response.ok) {
        const data = (await response.clone().json() as { data?: { attemptID?: string; url?: string } }).data
        const redirect = data?.url && URL.canParse(data.url) ? new URL(data.url).searchParams.get('redirect_uri') : null
        const to = redirect && URL.canParse(redirect) ? new URL(redirect) : undefined
        if (data?.attemptID && to && to.protocol === 'http:' && loopback.test(to.hostname)) {
          log(`[page] sign-in started; its redirect is the server's listener on port ${to.port}`)
          show({ attempt: data.attemptID, url: data.url!, port: Number(to.port) || 80, path: to.pathname })
        }
      } else if (pending && status.exec(route)?.[1] === pending.attempt) {
        // Cancelled by the client, or the client's poll says it is over.
        const state = init.method === 'DELETE' ? 'cancelled' : init.method === 'GET' && response.ok ? (await response.clone().json() as { data?: { status?: string; message?: string } }).data : undefined
        const over = typeof state === 'string' ? state : state?.status && state.status !== 'pending' ? `${state.status}${state.message ? `: ${state.message}` : ''}` : undefined
        if (over) { log(`[page] sign-in ${over}`); show(undefined, over.startsWith('failed') || over === 'expired' ? over : undefined) }
      }
    } catch { /* not what was expected: the client deals with it */ }
    return response
  }
}
