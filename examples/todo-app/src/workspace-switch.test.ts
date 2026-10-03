import { describe, expect, test } from 'bun:test'
import { dependencyMismatch, switchWorkspace, type SwitchPath } from './workspace-switch'
import { workspaceSwitchPresentation } from './workspace-switch-presentation'
import { idleChat, validateWorkspace, safeSourcePath, captureSource, retainedRoots, type SavedWorkspace, type Catalog } from './local-workspaces'
import { orderSessions } from './workspace-sessions'
import type { Workspace } from '@kev-browser-agent-kit/workspace'
import type { ChatSnapshot } from '@kev-browser-agent-kit/opencode-chat'

const image = (name: string): SavedWorkspace => ({ format: 1, id: crypto.randomUUID(), name, savedAt: 1, source: { '/package.json': new TextEncoder().encode('{}'), '/src/home.tsx': new TextEncoder().encode(name) }, sessions: [] })
function fixture() {
  const outgoing = image('A'), incoming = image('B'), events: string[] = []
  let persisted: Catalog = { activeId: outgoing.id, workspaces: [outgoing] }
  const options = {
    incoming, catalog: persisted, hold: () => { events.push('hold'); return { release: () => { events.push('release') } } },
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
    expect(f.events).toEqual(['hold', 'capture', 'persist-pending', 'dispose-chat', 'stop', 'replace', 'start', 'commit', 'release'])
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
    await expect(switchWorkspace({ ...f.options, hold: () => { throw Error('busy') } })).rejects.toThrow('busy')
    expect(f.events).toEqual([])
  })
  test('failed outgoing save never stops or clears', async () => {
    const f = fixture()
    await expect(switchWorkspace({ ...f.options, persist: async () => { throw Error('quota') } })).rejects.toThrow('quota')
    expect(f.events).toEqual(['hold', 'capture', 'release'])
  })
  test('chat admission is acquired once, still held at the journal write and at disposal, and released by a failed capture', async () => {
    const f = fixture()
    let held = 0
    const hold = () => { held++; return { release: () => { held-- } } }
    const seen: number[] = []
    await switchWorkspace({ ...f.options, hold,
      persist: async next => { if (next.pending) seen.push(held); await f.options.persist(next) },
      disposeChat: async () => { seen.push(held) } })
    expect(seen).toEqual([1, 1])
    await expect(switchWorkspace({ ...f.options, hold, capture: async () => { throw Error('capture failed') } })).rejects.toThrow('capture failed')
    expect(held).toBe(0)
    expect(f.events).not.toContain('dispose-chat')
  })
  test('retry of an interrupted switch takes no hold: the outgoing chat is already gone', async () => {
    const f = fixture()
    await switchWorkspace({ ...f.options, retry: true, hold: () => { throw Error('no chat') } })
    expect(f.events).toEqual(['persist-pending', 'dispose-chat', 'stop', 'replace', 'start', 'commit'])
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
  test('successful startup retains neutral progress until final catalog commit', async () => {
    const f = fixture()
    const result = await switchWorkspace({ ...f.options, persist: async next => {
      if (!next.pending) {
        expect(f.events).toContain('start')
        expect(f.persisted().activeId).toBe(f.outgoing.id)
        expect(workspaceSwitchPresentation(f.persisted().pending, true)?.phase).toBe('switching')
      }
      await f.options.persist(next)
    } })
    expect(workspaceSwitchPresentation(result.pending, false)).toBeUndefined()
  })
  test('failed final catalog commit becomes recovery despite successful startup', async () => {
    const f = fixture()
    await expect(switchWorkspace({ ...f.options, persist: async next => {
      if (!next.pending) throw Error('commit failed')
      await f.options.persist(next)
    } })).rejects.toThrow('commit failed')
    expect(f.events).toContain('start')
    expect(f.persisted().activeId).toBe(f.outgoing.id)
    expect(workspaceSwitchPresentation(f.persisted().pending, false)?.phase).toBe('recovery')
  })
  const retainedFixture = (blocker: () => Promise<string | undefined> = async () => undefined) => {
    const f = fixture(), paths: SwitchPath[] = []
    const retained = {
      blocker: async () => { f.events.push('eligibility'); return blocker() },
      stopPreview: async () => { f.events.push('stop-preview') }, replaceSource: async () => { f.events.push('replace-source') }, resume: async () => { f.events.push('resume') },
    }
    return { ...f, paths, retained, options: { ...f.options, retained, onPath: (taken: SwitchPath) => { paths.push(taken) } } }
  }
  test('an eligible switch keeps the server: decided before disposal, and nothing is stopped or cleared', async () => {
    const f = retainedFixture()
    const result = await switchWorkspace(f.options)
    expect(f.events).toEqual(['hold', 'capture', 'persist-pending', 'eligibility', 'dispose-chat', 'stop-preview', 'replace-source', 'resume', 'commit', 'release'])
    expect(f.paths).toEqual([{ path: 'retained' }])
    expect(result.activeId).toBe(f.incoming.id)
  })
  test('a blocker, a failing eligibility check or a retry takes the unchanged full path with its reason', async () => {
    const full = ['dispose-chat', 'stop', 'replace', 'start', 'commit']
    const blocked = retainedFixture(async () => '1 session(s) still running')
    await switchWorkspace(blocked.options)
    expect(blocked.events).toEqual(['hold', 'capture', 'persist-pending', 'eligibility', ...full, 'release'])
    expect(blocked.paths).toEqual([{ path: 'full', reason: '1 session(s) still running' }])
    const unknown = retainedFixture(async () => { throw Error('health timed out') })
    await switchWorkspace(unknown.options)
    expect(unknown.events.slice(4)).toEqual([...full, 'release'])
    expect(unknown.paths[0]?.reason).toContain('health timed out')
    const retry = retainedFixture()
    await switchWorkspace({ ...retry.options, retry: true })
    expect(retry.events).toEqual(['persist-pending', ...full])
    expect(retry.paths).toEqual([{ path: 'full', reason: 'retry of an interrupted switch' }])
  })
  test('a retained path that fails part way recovers through the full path and never commits before it', async () => {
    for (const step of ['stopPreview', 'replaceSource', 'resume'] as const) {
      const f = retainedFixture()
      const result = await switchWorkspace({ ...f.options, retained: { ...f.retained, [step]: async () => { throw Error(step + ' failed') } } })
      expect(f.events.slice(f.events.indexOf('dispose-chat', 5))).toEqual(['dispose-chat', 'stop', 'replace', 'start', 'commit', 'release'])
      expect(f.paths).toEqual([{ path: 'retained' }, { path: 'full', reason: `retained path failed: ${step} failed` }])
      expect(result.pending).toBeUndefined()
    }
    // The full path failing too leaves the journal for Retry interrupted switch.
    const f = retainedFixture()
    await expect(switchWorkspace({ ...f.options, retained: { ...f.retained, resume: async () => { throw Error('preview failed') } }, start: async () => { throw Error('start failed') } })).rejects.toThrow('start failed')
    expect(f.persisted().activeId).toBe(f.outgoing.id)
    expect(f.persisted().pending?.id).toBe(f.incoming.id)
    expect(f.events).not.toContain('commit')
  })
  test('installed dependencies are reused only for matching dependency sections and lockfiles', () => {
    const encode = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
    const base = { '/package.json': encode({ name: 'a', dependencies: { react: '19', vite: '7' }, devDependencies: { typescript: '5' } }), '/bun.lock': encode('lock-1'), '/src/home.tsx': encode('A') }
    // Source, the package name and key order are not dependency inputs.
    expect(dependencyMismatch(base, { ...base, '/src/home.tsx': encode('B'), '/package.json': encode({ devDependencies: { typescript: '5' }, dependencies: { vite: '7', react: '19' }, name: 'b' }) })).toBeUndefined()
    expect(dependencyMismatch(base, { ...base, '/package.json': encode({ dependencies: { react: '19', vite: '7', zod: '4' }, devDependencies: { typescript: '5' } }) })).toBe('package.json dependencies differ')
    expect(dependencyMismatch(base, { ...base, '/package.json': encode({ dependencies: { react: '19', vite: '7' } }) })).toBe('package.json devDependencies differ')
    expect(dependencyMismatch(base, { ...base, '/bun.lock': encode('lock-2') })).toBe('/bun.lock differs')
    const { '/bun.lock': _lock, ...unlocked } = base
    expect(dependencyMismatch(base, unlocked)).toBe('/bun.lock is in only one workspace')
    expect(dependencyMismatch(unlocked, unlocked)).toBeUndefined()
    expect(dependencyMismatch(base, { ...base, '/package.json': encode('not json') })).toBe('package.json cannot be compared')
    expect(dependencyMismatch(base, { ...base, '/package.json': encode('[]') })).toBe('package.json cannot be compared')
    // Stamped by the editor build that created the workspace, not by an install in it.
    expect(dependencyMismatch({ ...base, '/.browser-editor/runtime-package.json': encode('build-1') }, { ...base, '/.browser-editor/runtime-package.json': encode('build-2') })).toBeUndefined()
    // A retained root is never restored into: it must not be a source path.
    for (const root of retainedRoots) expect(safeSourcePath('/' + root + '/file')).toBe(false)
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
    for (const patch of [{ execution: 'running' }, { execution: 'unknown' }, { loading: true }, { loadingOlder: true }, { sending: true }, { connection: 'disconnected' }, { interruptRequested: true }, { permissions: [{}] }, { questions: [{}] }, { unsupportedForms: [{}] }, { held: 'Saving workspace' }, { sessionOperationPending: true }]) expect(idleChat({ ...idle, ...patch } as ChatSnapshot)).toBe(false)
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
