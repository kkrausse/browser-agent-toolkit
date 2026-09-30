import { describe, expect, test } from 'bun:test'
import { switchWorkspace } from './workspace-switch'
import { idleChat, validateWorkspace, safeSourcePath, captureSource, type SavedWorkspace, type Catalog } from './local-workspaces'
import { orderSessions } from './workspace-sessions'
import type { Workspace } from '@kev-browser-agent-kit/workspace'
import type { ChatSnapshot } from '@kev-browser-agent-kit/opencode-chat'

const image = (name: string): SavedWorkspace => ({ format: 1, id: crypto.randomUUID(), name, savedAt: 1, source: { '/package.json': new TextEncoder().encode('{}'), '/src/home.tsx': new TextEncoder().encode(name) }, sessions: [] })
function fixture() {
  const outgoing = image('A'), incoming = image('B'), events: string[] = []
  let persisted: Catalog = { activeId: outgoing.id, workspaces: [outgoing] }
  const options = {
    incoming, catalog: persisted, assertIdle: () => { events.push('idle') },
    capture: async () => { events.push('capture'); return outgoing },
    persist: async (next: Catalog) => { events.push(next.pending ? 'persist-pending' : 'commit'); persisted = next },
    disposeChat: async () => { events.push('dispose-chat') }, stop: async () => { events.push('stop') },
    replace: async () => { events.push('replace') }, start: async () => { events.push('start') },
  }
  return { options, events, incoming, outgoing, persisted: () => persisted }
}
describe('local workspace switching', () => {
  test('validates, saves outgoing and durably journals incoming before disposal/stop/replace/start', async () => {
    const f = fixture()
    const result = await switchWorkspace(f.options)
    expect(f.events).toEqual(['idle', 'capture', 'idle', 'persist-pending', 'dispose-chat', 'stop', 'replace', 'start', 'commit'])
    expect(result.activeId).toBe(f.incoming.id)
    expect(result.pending).toBeUndefined()
    expect(result.workspaces.map(item => item.name)).toEqual(['A', 'B'])
  })
  test('invalid incoming cannot save, stop or replace outgoing', async () => {
    const f = fixture()
    await expect(switchWorkspace({ ...f.options, incoming: { ...f.incoming, source: { '/../secret': new Uint8Array() } } })).rejects.toThrow()
    expect(f.events).toEqual([])
  })
  test('busy chat blocks before saving', async () => {
    const f = fixture()
    await expect(switchWorkspace({ ...f.options, assertIdle: () => { throw Error('busy') } })).rejects.toThrow('busy')
    expect(f.events).toEqual([])
  })
  test('failed outgoing save never stops or clears', async () => {
    const f = fixture()
    await expect(switchWorkspace({ ...f.options, persist: async () => { throw Error('quota') } })).rejects.toThrow('quota')
    expect(f.events).toEqual(['idle', 'capture', 'idle'])
  })
  test('unproven service shutdown leaves both recovery snapshots durable and never clears', async () => {
    const f = fixture()
    await expect(switchWorkspace({ ...f.options, stop: async () => { throw Error('quiescence unproven') } })).rejects.toThrow()
    expect(f.persisted().pending?.id).toBe(f.incoming.id)
    expect(f.persisted().workspaces[0]?.name).toBe('A')
    expect(f.events).not.toContain('replace')
  })
  test('failed replacement keeps journal; retry never captures partial outgoing state', async () => {
    const f = fixture()
    await expect(switchWorkspace({ ...f.options, replace: async () => { throw Error('clear failed') } })).rejects.toThrow()
    expect(f.persisted().activeId).toBe(f.outgoing.id)
    expect(f.persisted().pending?.id).toBe(f.incoming.id)
    f.events.length = 0
    await switchWorkspace({ ...f.options, catalog: f.persisted(), incoming: f.persisted().pending, retry: true })
    expect(f.events).not.toContain('capture')
    expect(f.persisted().activeId).toBe(f.incoming.id)
  })
  test('failed restart never commits incoming identity', async () => {
    const f = fixture()
    await expect(switchWorkspace({ ...f.options, start: async () => { throw Error('start failed') } })).rejects.toThrow()
    expect(f.persisted().activeId).toBe(f.outgoing.id)
    expect(f.persisted().pending?.name).toBe('B')
  })
  test('snapshot rejects unsafe paths and missing selected native sessions', () => {
    expect(safeSourcePath('/src/home.tsx')).toBe(true)
    for (const path of ['/../x', '/src//x', '/node_modules/a.js', '/.server/config/x', '/.env', '/.env.local', '/src/../../x']) expect(safeSourcePath(path)).toBe(false)
    expect(() => validateWorkspace({ ...image('A'), selectedSessionId: 'missing' })).toThrow('missing')
  })
  test('native session hierarchy validates and imports parent first', () => {
    const parent = { info: { id: 'p' }, messages: [] }, child = { info: { id: 'c', parentID: 'p' }, messages: [] }
    expect(orderSessions([child, parent]).map(item => item.info.id)).toEqual(['p', 'c'])
    expect(() => orderSessions([child])).toThrow('Missing')
    expect(() => orderSessions([parent, parent])).toThrow('Duplicate')
    expect(() => orderSessions([{ info: { id: 'a', parentID: 'b' }, messages: [] }, { info: { id: 'b', parentID: 'a' }, messages: [] }])).toThrow('Cyclic')
  })
  test('chat admission rejects executing/loading/unknown/disconnected/request states', () => {
    const idle = { connection: 'connected', execution: 'idle', sending: false, loading: false, loadingOlder: false, interruptRequested: false, permissions: [], questions: [], unsupportedForms: [] } as unknown as ChatSnapshot
    expect(idleChat(idle)).toBe(true)
    expect(idleChat(undefined)).toBe(false)
    for (const patch of [{ execution: 'running' }, { execution: 'unknown' }, { loading: true }, { loadingOlder: true }, { sending: true }, { connection: 'disconnected' }, { interruptRequested: true }, { permissions: [{}] }, { questions: [{}] }]) expect(idleChat({ ...idle, ...patch } as ChatSnapshot)).toBe(false)
  })
  test('source capture includes agent-added files, excludes managed/server/secrets and refuses source symlinks', async () => {
    const fs = { readdir: async (path: string) => path === '/' ? ['src', 'package.json', '.server', 'node_modules'] : ['home.tsx', 'added.ts'], stat: async (path: string) => ({ isDirectory: path === '/src', isFile: path !== '/src', size: 1 }), readFile: async (path: string) => new TextEncoder().encode(path) }
    const workspace = { fs } as unknown as Workspace
    const inspect = async (path: string) => ({ path, metadata: { kind: path === '/src' ? 'dir' : 'file' } })
    expect(Object.keys(await captureSource(workspace, inspect))).toEqual(['/src/home.tsx', '/src/added.ts', '/package.json'])
    await expect(captureSource(workspace, async path => ({ path, metadata: { kind: 'symlink' } }))).rejects.toThrow('symlinks')
    const secretWorkspace = { fs: { ...fs, readdir: async () => ['.env'] } } as unknown as Workspace
    await expect(captureSource(secretWorkspace, inspect)).rejects.toThrow('Secret environment file')
  })
})
