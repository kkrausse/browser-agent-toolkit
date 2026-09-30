import {expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import * as path from 'node:path'
import {createContext, runInContext} from 'node:vm'
import * as ResetVerifier from './reset-verifier.js'
import {armPdfWorkload, waitForPdfWorkload, startWorkspaceSwitch, waitForVerificationRead, waitForWorkspaceSwitch} from './reset-verifier.js'

const contextError = new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation.')
function clock() {
  let time = 0
  return {timeoutMs: 10, intervalMs: 1, now: () => time, sleep: async (ms: number) => {time += ms}}
}
test('fresh verification read tolerates a bounded transient context, not stale readiness', async () => {
  let reads = 0
  const result = await waitForVerificationRead(async () => {
    if (++reads === 1) throw contextError
    return {generation: reads === 2 ? 2 : 3}
  }, value => value.generation === 3, clock())
  expect(result.generation).toBe(3)
  expect(reads).toBe(3)
})
test('runtime, protected UI, closed target and ordinary timeout errors are terminal', async () => {
  for (const message of ['ENOTEMPTY', 'target/cross-extension-page', 'Target page, context or browser has been closed', 'Timeout 30000ms exceeded']) {
    let reads = 0
    await expect(waitForVerificationRead(async () => {reads++; throw new Error(message)}, () => true, clock())).rejects.toThrow(message)
    expect(reads).toBe(1)
  }
})
test('context replacement and unready generation never extend the budget', async () => {
  let reads = 0
  await expect(waitForVerificationRead(async () => {reads++; throw contextError}, () => true, clock())).rejects.toThrow('Execution context')
  expect(reads).toBe(4)
  await expect(waitForVerificationRead(async () => false, Boolean, clock())).rejects.toThrow('deadline exceeded')
})
test('a read completing after the deadline cannot become a pass', async () => {
  const budget = clock()
  await expect(waitForVerificationRead(async () => {await budget.sleep(11); return true}, Boolean, budget)).rejects.toThrow('deadline exceeded')
})
test('generation-specific switch observer requires completed token and fresh hydration', async () => {
  const observations = [
    {status: 'pending', ready: true, hydrated: true},
    {status: 'completed', ready: true, hydrated: false},
    {status: 'completed', ready: true, hydrated: true},
  ]
  let reads = 0
  const page = {url: () => 'http://fixture/', evaluate: async (_fn: unknown, arg: unknown) => {
    expect(arg).toEqual({token: 'one', expectedGeneration: 3})
    return observations[reads++]
  }}
  expect((await waitForWorkspaceSwitch(page, 'one', 3, clock())).hydrated).toBe(true)
  expect(reads).toBe(3)
})
test('switch initiation failure is not retried', async () => {
  let calls = 0
  const page = {evaluate: async () => {calls++; throw contextError}}
  await expect(startWorkspaceSwitch(page, 'one')).rejects.toThrow('Execution context')
  expect(calls).toBe(1)
})
test('failed switch and lost host observation are terminal', async () => {
  for (const message of ['ENOTEMPTY', 'Switch observation lost with host document']) {
    let reads = 0
    const page = {url: () => 'http://fixture/', evaluate: async () => {reads++; throw new Error(message)}}
    await expect(waitForWorkspaceSwitch(page, 'one', 3, clock())).rejects.toThrow(message)
    expect(reads).toBe(1)
  }
})

// Execute the real page callbacks against a minimal DOM, including old bytes.
function pdfFixture() {
  const button = {dataset: {bytes: '875'} as Record<string, string>}
  let generation = 1
  const document = {querySelector: (selector: string) => selector === '#pdf-workload' ? button : selector.includes('data-hydrated') ? (selector.includes(`="${generation}"`) ? {} : null) : {}}
  const host = {querySelector: () => ({contentDocument: document})}
  const window = {editorPerformanceExperiment: {error: ''}, document: host} as any
  let url = 'http://fixture/'
  const page = {url: () => url, evaluate: async (fn: Function, arg: unknown) => {
    const oldWindow = globalThis.window
    const oldDocument = globalThis.document
    Object.assign(globalThis, {window, document: host})
    try {return fn(arg)} finally {Object.assign(globalThis, {window: oldWindow, document: oldDocument})}
  }}
  return {page, button, window, setGeneration: (value: number) => {generation = value}, navigate: () => {url += 'changed'}}
}
test('PDF old bytes are invalidated; pending workload times out and cannot be re-armed', async () => {
  const f = pdfFixture()
  await armPdfWorkload(f.page, 1, 'run')
  expect(f.button.dataset.bytes).toBeUndefined()
  await expect(waitForPdfWorkload(f.page, 1, 'run', clock())).rejects.toThrow('deadline exceeded')
  await expect(armPdfWorkload(f.page, 1, 'replacement')).rejects.toThrow('pending')
})
test('PDF completion requires this run and generation, accepts variable fresh bytes', async () => {
  for (const bytes of [874, 876, 1001]) {
    const f = pdfFixture()
    await armPdfWorkload(f.page, 1, 'run')
    f.button.dataset.bytes = String(bytes)
    const result = await waitForPdfWorkload(f.page, 1, 'run', clock())
    expect(result).toMatchObject({generation: 1, token: 'run', status: 'completed', pdfBytes: bytes})
  }
})
test('fresh PDF bytes on stale hydration do not pass', async () => {
  const f = pdfFixture()
  await armPdfWorkload(f.page, 1, 'run')
  f.setGeneration(2)
  f.button.dataset.bytes = '876'
  await expect(waitForPdfWorkload(f.page, 1, 'run', clock())).rejects.toThrow('deadline exceeded')
})
test('PDF terminal runtime errors, lost runs and replaced markers fail closed', async () => {
  for (const kind of ['runtime', 'lost', 'marker']) {
    const f = pdfFixture()
    await armPdfWorkload(f.page, 1, 'run')
    f.button.dataset.bytes = '876'
    if (kind === 'runtime') f.window.editorPerformanceExperiment.error = 'ENOTEMPTY'
    if (kind === 'lost') delete f.window.resetPdfVerificationRuns.run
    if (kind === 'marker') f.button.dataset.verificationRun = 'old'
    await expect(waitForPdfWorkload(f.page, 1, 'run', clock())).rejects.toThrow()
  }
})
test('PDF host navigation during a read is terminal', async () => {
  const f = pdfFixture()
  await armPdfWorkload(f.page, 1, 'run')
  const budget = clock()
  const sleep = budget.sleep
  budget.sleep = async ms => {await sleep(ms); f.navigate()}
  await expect(waitForPdfWorkload(f.page, 1, 'run', budget)).rejects.toThrow('Host document URL changed')
})

test('actual execute body rejects old bytes with one click and zero completed jobs, accepts new completion', async () => {
  for (const completes of [false, true]) {
    let clicks = 0
    let completedJobs = 0
    let receipt: any
    const button = {dataset: {bytes: '875'} as Record<string, string>}
    const preview = {querySelector: (selector: string) => selector === '#pdf-workload' ? button : {}}
    const document = {querySelector: () => ({contentDocument: preview})}
    const url = 'http://fixture/?fsEvidence=1'
    const api = {ready: true, error: '', verifySource: async () => ({files: 26, generation: 1}), resources: () => ({})}
    const context = createContext({document, window: {document, editorPerformanceExperiment: api}, URL, crypto,
      path, fs: {mkdirSync() {}, writeFileSync(_path: string, value: string) {receipt = JSON.parse(value)}},
      state: {resetEvidenceOrigin: 'http://fixture', resetEvidenceDirectory: '/synthetic', resetEvidenceAction: 'initial'},
      ResetVerifier: {...ResetVerifier, waitForPdfWorkload: (page: any, generation: number, token: string) => ResetVerifier.waitForPdfWorkload(page, generation, token, clock())},
    })
    context.page = {url: () => url,
      evaluate: async (fn: Function, arg: any) => {context.arg = arg; return runInContext(`(${fn.toString()})(arg)`, context)},
      waitForFunction: async (fn: Function) => {if (!runInContext(`(${fn.toString()})()`, context)) throw Error('Not ready')},
      frameLocator: () => ({getByRole: () => ({click: async () => {clicks++; if (completes) {completedJobs++; button.dataset.bytes = '876'}}})}),
    }
    const body = readFileSync(new URL('./reset-evidence-v2.js', import.meta.url), 'utf8')
    const result = await runInContext(`(async () => {${body}\n})()`, context)
    expect(result.status).toBe(completes ? 'PASS' : 'FAILED')
    expect(clicks).toBe(1)
    expect(completedJobs).toBe(completes ? 1 : 0)
    expect(receipt.stage).toBe(completes ? 'completed' : 'pdf.read')
    if (completes) expect(receipt.checks[0].pdfRun.status).toBe('completed')
  }
})
