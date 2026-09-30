import {expect,test} from 'bun:test'
import {auditFence,previewHTTPThenAttach} from './matched-qualification'
import {boundedReadiness,joinedReadiness,joinPendingReadiness,prospectivePolicy} from './matched-readiness'

test('invalid audit, exception, absent digest and digest mismatch mandate reset after replacement',async()=>{
  for (const inspect of [async()=>({valid:false,checked:1,cacheDigest:'a'}),async()=>{throw Error('audit threw')},async()=>({valid:true,checked:1}),async()=>({valid:true,checked:1,cacheDigest:'b'})]) {
    const calls:string[]=[]
    await expect(auditFence('after-replacement',inspect,'a',async()=>{calls.push('reset');throw Error('reset completed; stopped')},()=>calls.push('record'))).rejects.toThrow('reset completed')
    expect(calls).toEqual(['record','reset'])
  }
})
test('before-retain exceptions are invalid; initial failures never count as qualification',async()=>{
  const fallback=async():Promise<never>=>{throw Error('unexpected reset')}
  expect((await auditFence('before-retain',async()=>{throw Error('bad audit')},undefined,fallback,()=>{})).valid).toBe(false)
  await expect(auditFence('initial',async()=>({valid:false,checked:0,reason:'bad tree'}),undefined,fallback,()=>{})).rejects.toThrow('bad tree')
})
test('late HTTP body completion after cancellation cannot attach preview',async()=>{
  const cancel=new AbortController()
  let resolve!:()=>void
  const body=new Promise<void>(yes=>{resolve=yes})
  let attached=false
  const task=previewHTTPThenAttach(cancel.signal,async()=>({ok:true,arrayBuffer:async()=>{await body;return new ArrayBuffer(0)}} as Response),()=>{attached=true})
  cancel.abort(Error('sibling failed'));resolve()
  await expect(task).rejects.toThrow('sibling failed')
  expect(attached).toBe(false)
})
test('first sibling failure cancels and joins delayed sibling before returning',async()=>{
  let settled=false
  await expect(joinedReadiness(new AbortController().signal,[async()=>{throw Error('first failure')},async signal=>{
    await Bun.sleep(15);expect(signal.aborted).toBe(true);settled=true
  }])).rejects.toThrow('first failure')
  expect(settled).toBe(true)
})
test('bounded observation reports unresolved ownership, and teardown join waits for late settlement',async()=>{
  let release!:()=>void
  const owned=new Promise<void>(resolve=>{release=resolve})
  await expect(boundedReadiness(5,new AbortController().signal,async()=>owned,5)).rejects.toThrow('quiescence unproven')
  let joined=false
  const cleanup=joinPendingReadiness().then(()=>{joined=true})
  await Bun.sleep(5);expect(joined).toBe(false)
  release();await cleanup;expect(joined).toBe(true)
})
test('prospective enclosing budgets include two 38s audits and whole-services without stage reset',()=>{
  expect(2*38000+prospectivePolicy.overallMs).toBeLessThan(prospectivePolicy.observationMs)
  expect(prospectivePolicy.observationMs+2*prospectivePolicy.verifierReadMs+prospectivePolicy.cleanupMs).toBeLessThan(prospectivePolicy.watchdogMs)
  expect(prospectivePolicy).toMatchObject({listenMs:60000,connectMs:45000,hydrationMs:60000,overallMs:90000,observationMs:180000,watchdogMs:300000})
})
