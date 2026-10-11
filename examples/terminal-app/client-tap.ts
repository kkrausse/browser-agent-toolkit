// Loaded into the OpenCode client's process before its entry (`node --import`): reports the
// client's sign-in exchanges to the page, which shows the paste-back bar for them
// (src/signin.ts). The client talks to the server over a socket inside the runtime, so the
// page does not see its requests any other way. One JSON line per exchange is appended to
// `SIGNIN_TAP_FILE`; the page watches that file. Nothing else is recorded.
import { appendFileSync } from 'node:fs'

const file = process.env.SIGNIN_TAP_FILE
const route = /^\/api\/integration\/[^/]+\/connect\/oauth(\/[^/]+)?$/
if (file) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(input, init)
    try {
      const request = typeof input === 'object' && !(input instanceof URL) ? input : undefined
      const url = new URL(request?.url ?? String(input))
      if (route.test(url.pathname)) {
        const body: unknown = await response.clone().json().catch(() => undefined)
        appendFileSync(file, JSON.stringify({ method: (init?.method ?? request?.method ?? 'GET').toUpperCase(), path: url.pathname, status: response.status, body }) + '\n')
      }
    } catch { /* the client's request is what matters */ }
    return response
  }) as typeof fetch
}
