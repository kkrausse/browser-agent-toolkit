import * as v from 'valibot'
import type { Service } from '@kev-browser-agent-kit/workspace/react'
import { timedStage } from './editor-timings'

// Native OpenCode bundles, not ChatController.exportChats() transcript archives.
export const sessionBundleSchema = v.strictObject({
  info: v.looseObject({ id: v.pipe(v.string(), v.minLength(1)), parentID: v.pipe(v.nullish(v.string()), v.transform(value => value ?? undefined)) }),
  messages: v.array(v.record(v.string(), v.unknown())),
})
export type SessionBundle = v.InferOutput<typeof sessionBundleSchema>

export function orderSessions(sessions: SessionBundle[]): SessionBundle[] {
  const byId = new Map(sessions.map(session => [session.info.id, session]))
  if (byId.size !== sessions.length) throw Error('Duplicate saved session ID')
  const ordered: SessionBundle[] = [], visiting = new Set<string>(), visited = new Set<string>()
  function visit(id: string): void {
    if (visited.has(id)) return
    if (visiting.has(id)) throw Error('Cyclic saved session hierarchy')
    const session = byId.get(id)
    if (!session) throw Error('Missing saved parent session: ' + id)
    visiting.add(id)
    if (session.info.parentID) visit(session.info.parentID)
    visiting.delete(id); visited.add(id); ordered.push(session)
  }
  for (const session of sessions) visit(session.info.id)
  return ordered
}

function url(service: Service, path: string): URL {
  const base = new URL(service.connection.url), target = new URL(path.replace(/^\//, ''), base)
  for (const [key, value] of base.searchParams) if (!target.searchParams.has(key)) target.searchParams.append(key, value)
  return target
}
async function request(service: Service, path: string, init?: RequestInit): Promise<unknown> {
  const response = await service.connection.fetch(url(service, path), { ...init, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw Error(`Native session transfer ${path}: HTTP ${response.status}`)
  return response.json()
}
// The server sends null for exhausted pagination cursors. Treat only null or
// absent fields as exhaustion; malformed non-string cursors must still fail.
const pageSchema = v.object({ data: v.array(v.object({ id: v.string() })), cursor: v.nullish(v.object({ next: v.nullish(v.string()) })) })

const sessionCounts = (sessions: SessionBundle[]) => ({ sessions: sessions.length, messages: sessions.reduce((sum, session) => sum + session.messages.length, 0) })

export function captureSessions(service: Service): Promise<SessionBundle[]> {
  // Per-session export durations (ms, in export order) show whether one session dominates.
  const exportMs: number[] = []
  return timedStage('capture.sessions', () => exportSessions(service, exportMs), sessions => ({ ...sessionCounts(sessions), slowestExportMs: Math.max(0, ...exportMs), exportMs: exportMs.slice(0, 12) }))
}
async function exportSessions(service: Service, exportMs: number[]): Promise<SessionBundle[]> {
  const sessions: SessionBundle[] = [], ids = new Set<string>()
  let cursor: string | undefined
  do {
    const page = v.parse(pageSchema, await request(service, '/api/session?directory=%2Fworkspace&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')))
    for (const { id } of page.data) {
      if (ids.has(id)) throw Error('Repeated session in native export pagination')
      ids.add(id)
      const started = performance.now()
      const transfer = v.parse(v.object({ data: sessionBundleSchema }), await request(service, `/api/session/${encodeURIComponent(id)}/export`))
      exportMs.push(Math.round(performance.now() - started))
      sessions.push(transfer.data)
    }
    cursor = page.cursor?.next ?? undefined
    if (ids.size > 10_000) throw Error('Too many sessions to save')
  } while (cursor)
  return orderSessions(sessions)
}

/** Run before attaching a chat client to the replacement server. Its SQLite
 * mount can outlive clearWorkspace, so explicitly remove old native rows. */
export function restoreSessions(service: Service, sessions: SessionBundle[]): Promise<Map<string, string>> {
  return timedStage('restore.sessions', () => importSessions(service, sessions), () => sessionCounts(sessions))
}
async function importSessions(service: Service, sessions: SessionBundle[]): Promise<Map<string, string>> {
  orderSessions(sessions)
  for (let attempt = 0; ; attempt++) {
    const page = v.parse(pageSchema, await request(service, '/api/session?directory=%2Fworkspace&limit=100'))
    if (!page.data.length) break
    if (attempt >= 100) throw Error('Could not empty replacement session store')
    for (const { id } of page.data) {
      const response = await service.connection.fetch(url(service, `/api/session/${encodeURIComponent(id)}`), { method: 'DELETE', signal: AbortSignal.timeout(30_000) })
      if (!response.ok && response.status !== 404) throw Error('Could not delete outgoing native session')
    }
  }
  // Keep the saved IDs: the store was just emptied, and OpenCode accepts an import
  // under a deleted session's ID (checked against 2.0.3), so the selected session
  // and anything else that names a session stay valid across a switch. The session
  // list is ordered by update time, which an import sets to now: import in reverse
  // of the saved list order, parents still first, and the list reads as it was saved.
  const ids = new Map<string, string>()
  for (const session of orderSessions([...sessions].reverse())) {
    const parentID = session.info.parentID ? ids.get(session.info.parentID) : undefined
    const transfer = (id: string) => request(service, '/api/session/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...session, info: { ...session.info, id, ...(parentID ? { parentID } : {}) }, location: { directory: '/workspace' } }),
    })
    let id = session.info.id
    // An ID still taken outside this directory's list cannot be emptied here.
    const result = v.parse(v.object({ data: v.object({ id: v.string() }) }), await transfer(id).catch(error => {
      if (!String(error).includes('HTTP 409')) throw error
      return transfer(id = 'ses_' + crypto.randomUUID().replaceAll('-', ''))
    }))
    if (result.data.id !== id) throw Error('Native session import returned unexpected ID')
    await request(service, `/api/session/${encodeURIComponent(id)}/message?order=desc&limit=50`)
    ids.set(session.info.id, id)
  }
  return ids
}
