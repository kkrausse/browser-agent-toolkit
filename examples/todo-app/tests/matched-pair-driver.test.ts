import {test,expect} from 'bun:test'
import {mkdtemp, rmdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {acquirePairLock,pairPlan,runPair,requestCode,createDriverCommands} from './matched-pair-driver'
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
for(const rejected of ['stdout','exit'] as const)test(`cold command ${rejected} rejection joins delayed siblings and retains ambiguous lock`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'matched-command-')), lock=join(root,'lock')
  const release=await acquirePairLock(lock)
  let out!:ReadableStreamDefaultController, err!:ReadableStreamDefaultController, finish!:(value:number)=>void, fail!:(error:Error)=>void
  const stdout=new ReadableStream({start(c){out=c}}), stderr=new ReadableStream({start(c){err=c}})
  const exited=new Promise<number>((resolve,reject)=>{finish=resolve;fail=reject})
  let calls=0, settled=false, cleanup=0, steps=0
  const commands=createDriverCommands(root,{baseline:'owned-baseline'},()=>false,()=>{++calls;return {stdout,stderr,exited}})
  // Same cold-command/actionPending=false ownership boundary as the live driver.
  const task=runPair(async()=>{++steps;await commands.command('baseline','await page.goto("http://cold/");return {ready:true}')})
    .catch(async error=>{if(!commands.pending){++cleanup;await commands.command('baseline',requestCode('stopServices','cleanup'))}throw error})
    .finally(()=>{settled=true})
  const observed=task.catch(error=>error)
  while(!calls)await Bun.sleep(1)
  if(rejected==='stdout')out.error(Error('observation failed'));else fail(Error('observation failed'))
  await Bun.sleep(5)
  expect(settled).toBe(false);expect(commands.pending).toBe(true)
  for(const code of [requestCode('stopServices','stop'),requestCode('rearm','rearm'),'return await page.reload()'])await expect(commands.command('baseline',code)).rejects.toThrow('Unsettled ownership')
  await expect(acquirePairLock(lock)).rejects.toThrow()
  err.close();await Bun.sleep(5);expect(settled).toBe(false)
  if(rejected==='stdout')finish(1);else out.close()
  expect(String(await observed)).toContain('observation failed')
  expect(commands.pending).toBe(true);expect(cleanup).toBe(0);expect(calls).toBe(1);expect(steps).toBe(1)
  await expect(commands.command('baseline',requestCode('rearm','late'))).rejects.toThrow('Unsettled ownership')
  await expect(acquirePairLock(lock)).rejects.toThrow()
  // Only the test fixture owner releases its retained lock, never the driver.
  await release()
})
