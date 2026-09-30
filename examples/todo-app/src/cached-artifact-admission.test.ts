import { expect, test } from 'bun:test'
import { cachedArtifactSourceAdmission, retainedEnvironmentInputs } from './cached-artifact-admission'
import { captureSource, safeSourcePath, validateWorkspace } from './local-workspaces'
import type { Workspace } from '@kev-browser-agent-kit/workspace'

const bytes = (text: string) => new TextEncoder().encode(text)
const prepared = { '/package.json': bytes('{}'), '/bun.lock': bytes('pinned'), '/vite.config.ts': bytes('fixed') }
const options = () => ({ requested: true, retry: false, prepared, outgoing: { ...prepared, '/src/a.ts': bytes('A') }, incoming: { ...prepared, '/src/b.ts': bytes('B') } })

test('source-only changes are preparatory-eligible but default and recovery are not', () => {
  expect(cachedArtifactSourceAdmission(options()).eligible).toBe(true)
  expect(cachedArtifactSourceAdmission({ ...options(), requested: false }).eligible).toBe(false)
  expect(cachedArtifactSourceAdmission({ ...options(), retry: true }).eligible).toBe(false)
  expect(cachedArtifactSourceAdmission({ ...options(), prepared: {} }).eligible).toBe(false)
})

test('every dependency/config input must match prepared bytes, including presence', () => {
  for (const path of retainedEnvironmentInputs) {
    for (const side of ['outgoing', 'incoming'] as const) {
      const o = options()
      expect(cachedArtifactSourceAdmission({ ...o, [side]: { ...o[side], [path]: bytes('changed') } }).eligible).toBe(false)
      if (path in prepared) {
        const source: Record<string, Uint8Array> = { ...o[side] }; delete source[path]
        expect(cachedArtifactSourceAdmission({ ...o, [side]: source }).eligible).toBe(false)
      }
    }
  }
  const changed = { ...prepared, '/package.json': bytes('{"dependencies":{"unprepared":"1"}}') }
  expect(cachedArtifactSourceAdmission({ ...options(), outgoing: changed, incoming: changed }).eligible).toBe(false)
  expect(cachedArtifactSourceAdmission({ ...options(), incoming: { ...prepared, '/vite.config.cts': bytes('unknown') } }).eligible).toBe(false)
})

test('managed archives, receipts and scripts never enter logical source snapshots', async () => {
  const roots = ['package.json', 'node_modules', '.browser-editor-cache', '.browser-editor-backends']
  const reads: string[] = []
  const workspace = { fs: {
    readdir: async () => roots,
    stat: async () => ({ isDirectory: false, isFile: true, size: 2 }),
    readFile: async (path: string) => { reads.push(path); return bytes('{}') },
  } } as unknown as Workspace
  const source = await captureSource(workspace, async path => ({ path, metadata: { kind: 'file' } }))
  expect(Object.keys(source)).toEqual(['/package.json'])
  expect(reads).toEqual(['/package.json'])
  for (const root of roots.slice(1)) {
    expect(safeSourcePath('/' + root + '/receipt')).toBe(false)
    expect(() => validateWorkspace({ format: 1, id: crypto.randomUUID(), name: 'tampered', savedAt: 1, sessions: [], source: { ...source, ['/' + root + '/receipt']: bytes('forged') } })).toThrow('Unsafe')
  }
})
