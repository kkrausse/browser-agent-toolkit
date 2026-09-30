import {test,expect} from 'bun:test'
import {mkdtemp, rmdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {acquirePairLock,pairPlan,runPair,requestCode} from './matched-pair-driver'
import {runInNewContext} from 'node:vm'

test('global filesystem lock excludes another initiator and never steals retained ownership',async()=>{
  const root=await mkdtemp(join(tmpdir(),'matched-driver-')), path=join(root,'lock')
  const release=await acquirePairLock(path)
  await expect(acquirePairLock(path)).rejects.toThrow()
  await release(); await (await acquirePairLock(path))(); await rmdir(root)
})
test('frozen pair has serial cold stop boundaries, one nonmeasured rearm each, ten interleaved transitions',async()=>{
  expect(pairPlan.slice(0,6).map(s=>s.action)).toEqual(['cold','stopServices','cold','stopServices','rearm','rearm'])
  expect(pairPlan.filter(s=>s.measured)).toHaveLength(10)
  expect(pairPlan.filter(s=>s.action==='rearm').every(s=>!s.measured&&s.generation===1)).toBe(true)
  expect(pairPlan.slice(6).map(s=>s.condition)).toEqual(['baseline','dependencies','dependencies','baseline','baseline','dependencies','dependencies','baseline','baseline','dependencies'])
  let active=0, count=0
  await runPair(async()=>{expect(++active).toBe(1);await Bun.sleep(1);--active;++count})
  expect(count).toBe(16)
})
test('first failure ends entire pair without retries or replacement',async()=>{
  let count=0
  await expect(runPair(async()=>{if(++count===3)throw Error('first failure')})).rejects.toThrow('first failure')
  expect(count).toBe(3)
})
test('second cold startup cannot begin until first stop has joined; stop failure prevents rearms',async()=>{
  let release!:()=>void
  const joined=new Promise<void>(resolve=>{release=resolve})
  const seen:string[]=[]
  const task=runPair(async step=>{
    seen.push(step.condition+':'+step.action)
    if(seen.length===2)await joined
    if(seen.length===4)throw Error('cleanup unproven')
  })
  await Bun.sleep(5)
  expect(seen).toEqual(['baseline:cold','baseline:stopServices'])
  release();await expect(task).rejects.toThrow('cleanup unproven')
  expect(seen).toEqual(['baseline:cold','baseline:stopServices','dependencies:cold','dependencies:stopServices'])
})
test('page request excludes different tokens while owned action pending',async()=>{
  let release!:()=>void, calls=0
  const window:any={editorPerformanceExperiment:{rearm:()=>{++calls;return new Promise<void>(r=>{release=r})}}}
  const page={evaluate:(fn:any,arg:any)=>fn(arg)}
  const run=(token:string)=>runInNewContext(`(async()=>{${requestCode('rearm',token)}})()`,{page,window,Promise,Error})
  await run('first');await Promise.resolve()
  await expect(run('different-token')).rejects.toThrow('Owned request pending')
  expect(calls).toBe(1);release();await Bun.sleep(1)
  await expect(run('first')).rejects.toThrow('Request token reused')
})
