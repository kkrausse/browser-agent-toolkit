#!/usr/bin/env bun
// Where a page on someone's phone sends its diagnostics panel (src/diag.ts, `?diag=<url>` or a
// build made with DIAG_URL): every POST is kept as a file, so nothing has to be copied or
// pasted on the device.
//
//   bun diag-collector.ts          PORT (default 4319), on 127.0.0.1 only
//   DIAG_DIR=…                     where uploads go (default <repo>/.diagnostics/uploads, gitignored)
//
// It is plain http on loopback. A page served over https needs it over https: on a tailnet,
//   tailscale serve --bg --https=4319 http://127.0.0.1:4319
// and the page's address gets `?diag=https://<machine>.<tailnet>.ts.net:4319/diag`.
//
//   POST /diag?id=<load>&why=<reason>   a readout as text → <time>-<id>-<why>.txt
//   POST /diag (a JSON array)           the page's event queue → events-<id>.jsonl, appended
//   GET  /                              the newest uploads, as text
//
// Any origin may post (the body is only ever written to a file); a beacon's credentialed
// request is allowed too, and the answers carry CORP so a COEP page may read them.
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const port = Number(process.env.PORT ?? 4319)
const dir = resolve(process.env.DIAG_DIR ?? join(import.meta.dirname, '../../.diagnostics/uploads'))
mkdirSync(dir, { recursive: true })
const safe = (value: string | null, fallback: string) => (value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || fallback
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  maxRequestBodySize: 8 * 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url), origin = request.headers.get('origin')
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': origin ?? '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
      ...(origin ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method === 'POST') {
      const body = await request.text()
      const id = safe(url.searchParams.get('id'), 'noid')
      let file: string
      let events: { id?: string }[] | undefined
      if (body.startsWith('[')) try { events = JSON.parse(body) } catch { /* kept as text */ }
      if (Array.isArray(events)) {
        file = join(dir, `events-${safe(events[0]?.id ?? null, id)}.jsonl`)
        appendFileSync(file, events.map(event => JSON.stringify({ at: new Date().toISOString(), origin, ...event })).join('\n') + '\n')
      } else {
        file = join(dir, `${stamp()}-${id}-${safe(url.searchParams.get('why'), 'send')}.txt`)
        writeFileSync(file, `uploaded ${new Date().toISOString()} from ${origin ?? 'no origin'}\n${body}\n`)
        console.log(`${file}  (${body.length} chars)`)
      }
      return new Response(`kept ${body.length} chars\n`, { headers })
    }
    if (request.method === 'GET' && url.pathname === '/') {
      const files = readdirSync(dir).sort().reverse().slice(0, 40)
      return new Response(`diag collector: ${dir}\n${files.join('\n')}\n`, { headers })
    }
    return new Response('diag collector: POST a readout\n', { status: 404, headers })
  },
})
console.log(`diag collector on http://127.0.0.1:${server.port}, uploads in ${dir}`)
