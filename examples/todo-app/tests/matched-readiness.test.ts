import {expect,test} from 'bun:test'
import {boundedReadiness,matchedReadinessBudgets} from './matched-readiness'

test('matched defaults preserve phase9 policy and both variants receive identical budgets', () => {
  const baseline = matchedReadinessBudgets(new URLSearchParams('variant=baseline&readiness.listenMs=60000'))
  const reuse = matchedReadinessBudgets(new URLSearchParams('variant=dependencies&readiness.listenMs=60000'))
  expect(baseline).toEqual(reuse)
  expect(Object.isFrozen(baseline)).toBe(true)
  expect(matchedReadinessBudgets(new URLSearchParams()).listenMs).toBe(30000)
  for (const value of ['', '0', '-1', 'NaN', '2.5', '240001']) expect(() => matchedReadinessBudgets(new URLSearchParams('readiness.listenMs='+value))).toThrow()
})

test('overall matched services deadline includes unresolved readiness and propagates cancellation', async () => {
  let signal!: AbortSignal
  await expect(boundedReadiness(10,new AbortController().signal,async s => {signal=s;return new Promise<never>(() => {})})).rejects.toThrow('Matched readiness budget exhausted')
  expect(signal.aborted).toBe(true)
})

test('preexisting cancellation never starts readiness', async () => {
  const controller = new AbortController(); controller.abort(Error('cohort stopped'))
  let called=false
  await expect(boundedReadiness(100,controller.signal,async()=>{called=true})).rejects.toThrow('cohort stopped')
  expect(called).toBe(false)
})
