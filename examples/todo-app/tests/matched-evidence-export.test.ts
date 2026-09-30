import {test,expect} from 'bun:test'
import {runInNewContext} from 'node:vm'
import {webcrypto,createHash} from 'node:crypto'
import {exportEvidence,createDriverCommands} from './matched-pair-driver'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

function fixture() {
  const api={samples:Array.from({length:180},(_,i)=>({name:'stage-'+i,milliseconds:i,detail:{children:Array.from({length:65},(_,j)=>({id:`${i}:${j}`}))}})),events:Array.from({length:130},(_,i)=>({id:'event-'+i,generation:6})),resetEvidence:[{phase:'readiness.budgets',generation:6}]}
  const evaluate=async(code:string)=>runInNewContext(`(async()=>{${code}})()`,{page:{evaluate:(fn:any,arg:any)=>fn(arg)},window:{editorPerformanceExperiment:api},location:{href:'http://127.0.0.1:43228/?variant=baseline'},crypto:webcrypto,TextEncoder})
  return {api,evaluate}
}
test('bounded serialized export preserves all nested entries, order, ids, counts and generation',async()=>{
  const {api,evaluate}=fixture();let chunks=0
  const result=await exportEvidence(async code=>{const v=await evaluate(code);if(v.offset!==null){++chunks;expect(v.text.length).toBeLessThanOrEqual(8000)}return v},'export-id',6)
  expect(chunks).toBeGreaterThan(10)
  expect(result.value.samples).toEqual(api.samples)
  expect(result.value.events).toEqual(api.events)
  expect(result.value.resetEvidence).toEqual(api.resetEvidence)
  expect(result.manifest.samples).toBe(180);expect(result.manifest.events).toBe(130)
  expect(result.manifest.id).toBe('export-id');expect(result.value.generation).toBe(6)
})
for(const fault of ['id','generation','offset','count','length','truncated','reordered','hash','missing','tail'] as const)test('export rejects '+fault+' rather than claiming success',async()=>{
  const {evaluate}=fixture()
  let calls=0
  await expect(exportEvidence(async code=>{
    const v=await evaluate(code);++calls
    if(fault==='tail'&&calls>2&&v.offset===null)v.hash='0'.repeat(64)
    if(calls===2) {
      if(fault==='id')v.id='foreign'
      if(fault==='generation')v.generation=5
      if(fault==='offset')v.offset=8000
      if(fault==='count')--v.events
      if(fault==='length')--v.length
      if(fault==='truncated')v.text=v.text.slice(0,50)
      if(fault==='reordered')v.text=v.text.split('').reverse().join('')
      if(fault==='hash')v.hash='0'.repeat(64)
      if(fault==='missing')return undefined
    }
    return v
  },'export-id',6)).rejects.toThrow()
})
test('matching envelope cannot conceal a serialized count mismatch',async()=>{
  const json=JSON.stringify({url:'url',generation:6,samples:[],events:[],resetEvidence:[]})
  const head={id:'id',generation:6,url:'url',hash:createHash('sha256').update(json).digest('hex'),length:json.length,samples:1,events:0,resetEvidence:0,offset:null,text:''}
  let call=0
  await expect(exportEvidence(async()=>++call===2?{...head,offset:0,text:json}:head,'id',6)).rejects.toThrow('count')
})
for(const envelope of [{ok:true,valueUnavailable:true},{ok:true,text:'truncated after 50'}, {ok:true,value:1,valueUnavailable:true}])test('CLI ok without available complete value fails closed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'matched-export-'))
  const commands=createDriverCommands(root,{baseline:'fixture'},()=>false,()=>({stdout:new Blob([JSON.stringify(envelope)]).stream(),stderr:new Blob([]).stream(),exited:Promise.resolve(0)}))
  await expect(commands.command('baseline','return 1')).rejects.toThrow('value unavailable')
  expect(commands.pending).toBe(false)
})
