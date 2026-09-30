import {expect, test} from 'bun:test'
import {startWorkspaceSwitch, waitForVerificationRead, waitForWorkspaceSwitch} from './reset-verifier.js'

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
