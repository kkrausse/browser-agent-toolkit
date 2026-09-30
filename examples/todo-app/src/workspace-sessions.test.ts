import { expect, test } from 'bun:test'
import type { Service } from '@kev-browser-agent-kit/workspace/react'
import { captureSessions, restoreSessions } from './workspace-sessions'

function service(fetch: (url: URL, init?: RequestInit) => Promise<Response>): Service {
  return { connection: { url: 'http://example.test/?token=route&location%5Bdirectory%5D=%2Fworkspace', fetch: (input, init) => fetch(new URL(String(input)), init) } } as Service
}
test('native export paginates and validates resumable bundles without inference requests', async () => {
  const paths: string[] = []
  const endpoint = service(async url => {
    expect(url.searchParams.get('token')).toBe('route')
    paths.push(url.pathname)
    if (url.pathname === '/api/session') return Response.json(url.searchParams.has('cursor') ? { data: [{ id: 'child' }], cursor: {} } : { data: [{ id: 'parent' }], cursor: { next: 'page2' } })
    const id = url.pathname.includes('parent') ? 'parent' : 'child'
    return Response.json({ data: { info: { id, ...(id === 'child' ? { parentID: 'parent' } : {}) }, messages: [{ id: 'msg-' + id, role: 'user', parts: [{ type: 'text', text: id }] }] } })
  })
  const exported = await captureSessions(endpoint)
  expect(exported.map(item => item.info.id)).toEqual(['parent', 'child'])
  expect(exported[1]?.messages[0]?.parts).toEqual([{ type: 'text', text: 'child' }])
  expect(paths).toEqual(['/api/session', '/api/session/parent/export', '/api/session', '/api/session/child/export'])
})
test('native import clears persisted old rows, remaps child/parent IDs and verifies history hydration', async () => {
  const calls: string[] = [], imported: Record<string, unknown>[] = []
  let oldExists = true
  const endpoint = service(async (url, init) => {
    calls.push((init?.method ?? 'GET') + ' ' + url.pathname)
    if (url.pathname === '/api/session') return Response.json({ data: oldExists ? [{ id: 'outgoing' }] : [], cursor: {} })
    if (init?.method === 'DELETE') { oldExists = false; return Response.json({}) }
    if (url.pathname === '/api/session/import') {
      const bundle = JSON.parse(String(init?.body)); imported.push(bundle)
      return Response.json({ data: { id: bundle.info.id } })
    }
    return Response.json({ data: [] })
  })
  const ids = await restoreSessions(endpoint, [{ info: { id: 'child', parentID: 'parent' }, messages: [] }, { info: { id: 'parent' }, messages: [] }])
  expect(ids.size).toBe(2)
  expect((imported[1]?.info as { parentID: string }).parentID).toBe(ids.get('parent')!)
  expect((imported[1]?.info as { id: string }).id).toBe(ids.get('child')!)
  expect(imported[0]?.location).toEqual({ directory: '/workspace' })
  expect(calls[0]).toBe('GET /api/session')
  expect(calls[1]).toBe('DELETE /api/session/outgoing')
  expect(calls.filter(call => call.includes('/message'))).toHaveLength(2)
})
test('malformed native transfer fails instead of silently dropping chat sessions', async () => {
  await expect(captureSessions(service(async url => Response.json(url.pathname === '/api/session' ? { data: [{ id: 'bad' }] } : { data: { info: { id: 'bad' } } })))).rejects.toThrow()
})
test('native export accepts terminal null cursors and nullable root fields without dropping bundle data', async () => {
  const paths: string[] = []
  const bundle = { info: { id: 'root', parentID: null, title: null, metadata: null }, messages: [{ id: 'message', model: null, parts: [] }] }
  const exported = await captureSessions(service(async url => {
    paths.push(url.pathname)
    return Response.json(url.pathname === '/api/session'
      ? { data: [{ id: 'root' }], cursor: { previous: null, next: null } }
      : { data: bundle })
  }))
  expect(paths).toEqual(['/api/session', '/api/session/root/export'])
  expect(exported).toEqual([{ ...bundle, info: { ...bundle.info, parentID: undefined } }])
})
test('native empty session lists accept absent and null cursor containers', async () => {
  for (const page of [{ data: [] }, { data: [], cursor: null }, { data: [], cursor: { next: null } }]) {
    expect(await captureSessions(service(async () => Response.json(page)))).toEqual([])
  }
})
test('native import clears old rows when list pagination ends with null', async () => {
  let oldExists = true
  const calls: string[] = []
  const ids = await restoreSessions(service(async (url, init) => {
    calls.push((init?.method ?? 'GET') + ' ' + url.pathname)
    if (init?.method === 'DELETE') { oldExists = false; return Response.json({}) }
    return Response.json({ data: oldExists ? [{ id: 'old' }] : [], cursor: { next: null } })
  }), [])
  expect(ids.size).toBe(0)
  expect(calls).toEqual(['GET /api/session', 'DELETE /api/session/old', 'GET /api/session'])
})
test('non-string native cursors and parent IDs still fail validation', async () => {
  await expect(captureSessions(service(async () => Response.json({ data: [], cursor: { next: 42 } })))).rejects.toThrow()
  await expect(captureSessions(service(async url => Response.json(url.pathname === '/api/session'
    ? { data: [{ id: 'bad' }], cursor: { next: null } }
    : { data: { info: { id: 'bad', parentID: 42 }, messages: [] } })))).rejects.toThrow()
})
