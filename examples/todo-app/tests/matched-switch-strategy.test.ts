import {expect, test} from 'bun:test'
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs'
import * as fs from 'node:fs'
import {join, dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {runInNewContext} from 'node:vm'
import {sourceReplacementScript} from '../../../workspace-api/src/environment-experiment'
import {allowedCacheWrites, assertOwnership, createMatchedCohort, expectedWriters, measuredPlan, selectStrategy} from './matched-switch-strategy'
import type {Adapter, Condition, EnvironmentIdentity, OwnershipEvidence} from './matched-switch-strategy'

const digest = 'a'.repeat(64)
const environment: EnvironmentIdentity = {runtime: digest, distribution: digest, managedTree: digest,
  image: digest, bundle: digest, dependencyPolicy: digest, packageAndLock: digest, serviceConfig: digest}
function evidence(port = 43226): OwnershipEvidence {
  return {owner: 'offline-test-only', origin: `http://127.0.0.1:${port}/`, freshOrigin: true,
    exclusiveInitiator: true, externalActors: 0, modelCalls: 0, initialInstalledTreeVerified: true,
    writerMutationAuditVerified: true, writers: [...expectedWriters], cacheWrites: [...allowedCacheWrites]}
}
function adapters() {
  const calls: Record<Condition, string[]> = {'full-reset': [], 'source-only': []}
  const make = (condition: Condition, port: number): Adapter => {
    const record = async (name: string) => {calls[condition].push(name)}
    return {ownership: evidence(port), environment: {...environment},
      verifyGeneration: async generation => record(`verify-${generation}`),
      inspectStopped: async () => {await record('inspect-stopped'); return {viteExited: true, openCodeExited: true,
        stdoutDrained: true, stderrDrained: true, processes: 0, listeners: 0,
        pendingHttp: 0, fetchInflight: 0, fetchQueued: 0, fetchActive: 0}},
      shutdownAndDrain: () => record('shutdown'), clear: () => record('clear'), close: () => record('close'),
      open: () => record('open'), installSource: () => record('install-source'), startRuntime: () => record('start-runtime'),
      deliverDependencies: () => record('deliver'), replaceSource: () => record('replace-source'),
      observeRetainedCache: () => record('observe-cache'), installConfig: () => record('config'),
      launchVite: () => record('launch-vite'), launchOpenCode: () => record('launch-opencode'),
      hydratedInteractivePreview: () => record('hydrate'), openCodeServerReady: () => record('server-ready'),
      flush: () => record('flush')}
  }
  return {calls, values: {'full-reset': make('full-reset', 43226), 'source-only': make('source-only', 43227)}}
}
test('fixed plan is five transitions per condition, alternating pair order, no startup measurement', () => {
  expect(measuredPlan.length).toBe(10)
  for (const condition of ['full-reset', 'source-only']) {
    expect(measuredPlan.filter(item => item.condition === condition).map(item => item.generation)).toEqual([2, 3, 4, 5, 6])
  }
  expect(measuredPlan.slice(0, 4).map(item => item.condition)).toEqual(['full-reset', 'source-only', 'source-only', 'full-reset'])
})
test('every dependency/runtime/config identity mismatch mandates reset, malformed identity is rejected', () => {
  expect(selectStrategy('source-only', environment, {...environment})).toBe('source-only')
  expect(selectStrategy('full-reset', environment, environment)).toBe('full-reset')
  for (const key of Object.keys(environment) as (keyof EnvironmentIdentity)[]) {
    expect(selectStrategy('source-only', environment, {...environment, [key]: 'b'.repeat(64)})).toBe('full-reset')
  }
  expect(() => selectStrategy('source-only', environment, {...environment, image: ''})).toThrow('Incomplete')
})
test('marker-equivalent verification alone never unlocks reuse', () => {
  for (const patch of [{freshOrigin: false}, {exclusiveInitiator: false}, {externalActors: 1}, {modelCalls: 1},
    {initialInstalledTreeVerified: false}, {writerMutationAuditVerified: false}, {owner: ''},
    {writers: [...expectedWriters, 'untracked-reader']}, {cacheWrites: ['/workspace/node_modules/arbitrary']},
    {origin: 'https://example.com/'}, {origin: 'http://127.0.0.1:43226/?old=1'}]) {
    expect(() => assertOwnership({...evidence(), ...patch})).toThrow()
  }
})
test('isolated matching origins and full initial identity are mandatory', () => {
  const {values} = adapters()
  values['source-only'].ownership.origin = values['full-reset'].ownership.origin
  expect(() => createMatchedCohort(values)).toThrow('distinct fresh origins')
  values['source-only'].ownership.origin = evidence(43227).origin
  values['source-only'].environment.packageAndLock = 'b'.repeat(64)
  expect(() => createMatchedCohort(values)).toThrow('identical environments')
})
test('both variants stop/drain/restart both services; source-only does not clear/deliver/delete caches', async () => {
  const {values, calls} = adapters()
  let time = 0
  const cohort = createMatchedCohort(values, () => ++time)
  for (const item of measuredPlan) {
    const result = await cohort.next({generation: item.generation, environment})
    expect(result.status).toBe('passed')
    expect(result.chat).toBe('usable-mounted-chat-unqualified')
    expect(result.diagnosticMilliseconds).toBeGreaterThan(0)
    expect(result.elapsedMilliseconds).toBeGreaterThan(result.lifecycleMilliseconds!)
    expect(result.stages.map(stage => stage.name)).not.toContain('inspect-stopped')
    expect(result.diagnosticStages.map(stage => stage.name)).toContain('stopped-readers')
    if (item.condition === 'source-only') expect(result.diagnosticStages.map(stage => stage.name)).toContain('cache-retention')
  }
  for (const condition of ['full-reset', 'source-only'] as const) {
    expect(calls[condition].filter(name => name === 'shutdown').length).toBe(5)
    expect(calls[condition].filter(name => name === 'launch-vite').length).toBe(5)
    expect(calls[condition].filter(name => name === 'launch-opencode').length).toBe(5)
    expect(calls[condition].indexOf('inspect-stopped')).toBeGreaterThan(calls[condition].indexOf('shutdown'))
  }
  expect(calls['full-reset'].slice(0, 9)).toEqual(['verify-1', 'shutdown', 'inspect-stopped', 'clear', 'close', 'open', 'install-source', 'start-runtime', 'deliver'])
  expect(calls['source-only'].slice(0, 6)).toEqual(['verify-1', 'shutdown', 'inspect-stopped', 'start-runtime', 'replace-source', 'observe-cache'])
  for (const name of ['clear', 'close', 'open', 'deliver', 'install-source']) expect(calls['source-only']).not.toContain(name)
  await expect(cohort.next({generation: 7, environment})).rejects.toThrow('exhausted')
  expect(cohort.receipts.length).toBe(10)
})
test('dependency and config fallback execute full reset, not retained cache handling', async () => {
  for (const key of ['packageAndLock', 'serviceConfig'] as const) {
    const {values, calls} = adapters()
    const cohort = createMatchedCohort(values)
    await cohort.next({generation: 2, environment})
    await expect(cohort.next({generation: 2, environment: {...environment, [key]: 'b'.repeat(64)}})).rejects.toThrow('fallback completed')
    const result = cohort.receipts[1]!
    expect(result.condition).toBe('source-only')
    expect(result.strategy).toBe('full-reset')
    expect(result.status).toBe('failed')
    expect(calls['source-only']).toContain('clear')
    expect(calls['source-only']).toContain('deliver')
    expect(calls['source-only']).not.toContain('replace-source')
    expect(calls['source-only']).not.toContain('observe-cache')
    await expect(cohort.next({generation: 3, environment})).rejects.toThrow('stopped')
  }
})
test('first shutdown/drain failure preserves one failed attempt and blocks deletion and retry', async () => {
  const {values, calls} = adapters()
  values['full-reset'].inspectStopped = async () => ({viteExited: true, openCodeExited: true,
    stdoutDrained: true, stderrDrained: false, processes: 0, listeners: 0, pendingHttp: 0,
    fetchInflight: 0, fetchQueued: 0, fetchActive: 0})
  const cohort = createMatchedCohort(values)
  await expect(cohort.next({generation: 2, environment})).rejects.toThrow('not stopped')
  expect(cohort.receipts).toHaveLength(1)
  expect(cohort.receipts[0]!.status).toBe('failed')
  expect(cohort.receipts[0]!.lifecycleMilliseconds).toBeNull()
  expect(calls['full-reset']).not.toContain('clear')
  await expect(cohort.next({generation: 2, environment})).rejects.toThrow('stopped')
})
test('replacement failure leaves failure intact and never launches new services or retries', async () => {
  const {values, calls} = adapters()
  values['source-only'].replaceSource = async () => {throw new Error('replacement failed')}
  const cohort = createMatchedCohort(values)
  await cohort.next({generation: 2, environment})
  await expect(cohort.next({generation: 2, environment})).rejects.toThrow('replacement failed')
  expect(cohort.receipts).toHaveLength(2)
  expect(calls['source-only']).not.toContain('launch-vite')
  await expect(cohort.next({generation: 3, environment})).rejects.toThrow('stopped')
})
test('failed parallel service launch joins other in-flight readiness before returning; no flush or incoming verification', async () => {
  const {values, calls} = adapters()
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => {entered = resolve})
  values['full-reset'].launchVite = async () => {throw new Error('launch failure')}
  values['full-reset'].openCodeServerReady = () => new Promise<void>(resolve => {release = resolve; entered()})
  const cohort = createMatchedCohort(values)
  let settled = false
  const first = cohort.next({generation: 2, environment}).catch(error => {settled = true; throw error})
  await blocked
  expect(settled).toBe(false)
  await expect(cohort.next({generation: 2, environment})).rejects.toThrow('already running')
  release()
  await expect(first).rejects.toThrow('launch failure')
  expect(calls['full-reset']).not.toContain('flush')
  expect(calls['full-reset']).not.toContain('verify-2')
  await expect(cohort.next({generation: 2, environment})).rejects.toThrow('stopped')
})
test('returned evidence cannot alter fixed budget or operation ordering', async () => {
  const {values} = adapters()
  const cohort = createMatchedCohort(values)
  await expect(cohort.next({generation: 3, environment})).rejects.toThrow('Unexpected')
  expect(cohort.receipts).toHaveLength(0)
  await cohort.next({generation: 2, environment})
  const copy = cohort.receipts
  copy[0]!.stages.length = 0
  copy.length = 0
  expect(cohort.receipts).toHaveLength(1)
  expect(cohort.receipts[0]!.stages.length).toBeGreaterThan(0)
  expect((await cohort.next({generation: 2, environment})).condition).toBe('source-only')
})
test('ownership mutation and overlapping initiation fail closed', async () => {
  const {values, calls} = adapters()
  const cohort = createMatchedCohort(values)
  values['full-reset'].ownership.owner = 'different-owner'
  await expect(cohort.next({generation: 2, environment})).rejects.toThrow('Ownership changed')
  expect(calls['full-reset']).toHaveLength(0)
  const fresh = adapters()
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => {entered = resolve})
  fresh.values['full-reset'].shutdownAndDrain = () => new Promise<void>(resolve => {release = resolve; entered()})
  const serial = createMatchedCohort(fresh.values)
  const first = serial.next({generation: 2, environment})
  await blocked
  await expect(serial.next({generation: 2, environment})).rejects.toThrow('already running')
  release()
  await first
})

test('exact existing source-replacement mechanics remove stale renamed imports and preserve binary/config/dependencies/cache', () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'phase8-source-'))
  const translate = (path: string) => {
    if (path !== '/workspace' && !path.startsWith('/workspace/') && path !== '/.server') throw new Error(`Unexpected path ${path}`)
    return join(root, path === '/.server' ? 'server-config' : 'workspace' + path.slice('/workspace'.length))
  }
  const put = (name: string, bytes: string | Uint8Array) => {
    const target = translate('/workspace' + name)
    mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, bytes)
  }
  const vfs = {
    readdirSync: (path: string) => readdirSync(translate(path)),
    lstatSync: (path: string) => fs.lstatSync(translate(path)),
    rmSync: (path: string, options: Parameters<typeof rmSync>[1]) => rmSync(translate(path), options),
    mkdirSync: (path: string, options: Parameters<typeof mkdirSync>[1]) => mkdirSync(translate(path), options),
    writeFileSync: (path: string, bytes: Uint8Array) => writeFileSync(translate(path), bytes),
  }
  try {
    for (const name of ['/node_modules/pkg/index.js', '/node_modules/.vite-temp/temp.js', '/.browser-editor-backends/tool.js', '/.browser-editor-cache/vite/deps.js']) put(name, 'retain exact bytes')
    put('/src/old.ts', 'export const stale = true')
    put('/src/main.ts', "import './old'")
    put('/old-only.ts', 'old generation')
    mkdirSync(translate('/.server')); writeFileSync(join(translate('/.server'), 'stale'), 'stale configuration')
    const source = {'/src/main.ts': "import './renamed'", '/src/renamed.ts': 'export const fresh = true',
      '/vite.config.ts': "export default {cacheDir:'/workspace/.browser-editor-cache/vite'}", '/binary.dat': {encoding: 'base64' as const, data: 'AAEC/w=='}}
    let result = ''
    runInNewContext(sourceReplacementScript(source, false), {
      require: (name: string) => name === 'node:fs' ? vfs : name === 'node:path' ? require('node:path') : (() => {throw new Error(name)})(),
      Buffer, console: {log: (text: string) => {result = text}},
    })
    expect(JSON.parse(result).writes).toBe(4)
    expect(readdirSync(translate('/workspace/src'))).toEqual(['main.ts', 'renamed.ts'])
    expect(fs.existsSync(translate('/workspace/old-only.ts'))).toBe(false)
    expect(fs.existsSync(translate('/.server'))).toBe(false)
    expect(readFileSync(translate('/workspace/src/main.ts'), 'utf8')).toBe(source['/src/main.ts'])
    expect(readFileSync(translate('/workspace/vite.config.ts'), 'utf8')).toBe(source['/vite.config.ts'])
    expect([...readFileSync(translate('/workspace/binary.dat'))]).toEqual([0, 1, 2, 255])
    for (const name of ['/node_modules/pkg/index.js', '/node_modules/.vite-temp/temp.js', '/.browser-editor-backends/tool.js', '/.browser-editor-cache/vite/deps.js']) {
      expect(readFileSync(translate('/workspace' + name), 'utf8')).toBe('retain exact bytes')
    }
  } finally {rmSync(root, {recursive: true, force: true})}
})
test('replacement generator rejects managed roots, traversal, and file-directory collisions', () => {
  for (const path of ['/node_modules/evil', '/.browser-editor-cache/evil', '/.browser-editor-backends/evil', '/../evil', '/src/../evil', '/src\\evil']) {
    expect(() => sourceReplacementScript({[path]: 'bad'}, false)).toThrow()
  }
  expect(() => sourceReplacementScript({'/src': 'file', '/src/child.ts': 'child'}, false)).toThrow('also a directory')
})
