// The terminal client is OpenCode 2.0.26; the server the toolkit runs in the tab is 2.0.3.
// Their HTTP APIs share 115 of about 144 routes (compared from both servers' /openapi.json);
// most of the rest were renamed in between, and two exist only in the newer server. Every
// request of the client passes through the page anyway, so the renamed routes it uses are
// translated here, and `/api/info` is answered here. Routes with no older equivalent
// (credentials, pairing, `/api/location/reload`, `PATCH /api/experimental/config`) pass
// through and get the server's own 404, which the client reports where it matters.
//
// This is a bridge, not a guarantee: bodies of the shared routes were not compared field by
// field. It goes away when the toolkit's pinned server and the client are the same version.

export type GuestFetch = (path: string, init: { method: string; headers: [string, string][]; body: Uint8Array | null; signal: AbortSignal }) => Promise<Response>

const serverVersion = '2.0.3'
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const text = (body: Uint8Array | null) => body ? new TextDecoder().decode(body) : ''
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const withJson = (headers: [string, string][]): [string, string][] => [...headers.filter(([name]) => name.toLowerCase() !== 'content-type'), ['content-type', 'application/json']]

/** `/api/experimental/<x>` in 2.0.26 that was `/api/<x>` in 2.0.3. */
const graduated = [
  /^\/api\/experimental\/(mcp\/[^/]+(?:\/(?:connect|disconnect))?)$/,
  /^\/api\/experimental\/(session\/stats)$/,
  /^\/api\/experimental\/(session\/import)$/,
  /^\/api\/experimental\/(session\/[^/]+\/(?:export|skill|wait|instructions\/entries(?:\/[^/]+)?))$/,
  /^\/api\/experimental\/(generate)$/,
]

export function olderServer(fetch: GuestFetch): GuestFetch {
  return async (target, init) => {
    const query = target.indexOf('?')
    const path = query < 0 ? target : target.slice(0, query), search = query < 0 ? '' : target.slice(query)
    const { method } = init
    const to = (newPath: string, change: Partial<typeof init> = {}) => fetch(newPath + search, { ...init, ...change })

    if (method === 'GET' && path === '/api/info') {
      const older = await fetch('/api/server', init)
      const urls = older.ok ? (await older.json() as { urls?: string[] }).urls ?? [] : []
      return json({ version: serverVersion, pid: 0, urls, paths: { tmp: '/workspace/.server/tmp' }, capabilities: { persistentPty: false } })
    }
    if (method === 'GET' && path === '/api/form') return to('/api/form/request')
    if (method === 'GET' && path === '/api/vcs/branch') return to('/api/vcs/branches')
    const session = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(path)
    if (session) {
      const [, id, rest = ''] = session, base = `/api/session/${id}`
      if (method === 'DELETE' && /^\/form\/[^/]+$/.test(rest)) return fetch(`${base}${rest}/cancel`, { ...init, method: 'POST' })
      if (method === 'DELETE' && rest === '/revert') return fetch(`${base}/revert/clear`, { ...init, method: 'POST' })
      const inbox = /^\/inbox\/[^/]+$/.test(rest)
      if (method === 'PATCH' && inbox) {
        const delivery = (JSON.parse(text(init.body) || '{}') as { delivery?: string }).delivery === 'queue' ? 'queue' : 'steer'
        return fetch(`${base}${rest}/${delivery}`, { ...init, method: 'POST', body: null })
      }
      if (method === 'PATCH' && rest === '') {
        // 2.0.26 updates metadata and permissions in one call; 2.0.3 can rename and replace rules.
        const update = JSON.parse(text(init.body) || '{}') as { metadata?: { title?: unknown } | null; permissions?: unknown }
        let last: Response | undefined
        if (typeof update.metadata?.title === 'string') last = await fetch(`${base}/rename`, { ...init, method: 'POST', headers: withJson(init.headers), body: encode({ title: update.metadata.title }) })
        if (update.permissions != null && (!last || last.ok)) last = await fetch(`${base}/permission/rules`, { ...init, method: 'PUT', headers: withJson(init.headers), body: encode(update.permissions) })
        return last ?? new Response(null, { status: 204 })
      }
    }
    for (const pattern of graduated) {
      const match = pattern.exec(path)
      if (match) return to(`/api/${match[1]}`)
    }
    return fetch(target, init)
  }
}
