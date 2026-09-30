import {mkdir, rmdir, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {prospectivePolicy} from './matched-readiness'
import {createHash} from 'node:crypto'

export const pairPlan = [
  {condition:'baseline', action:'cold', generation:1, measured:false},
  {condition:'baseline', action:'stopServices', generation:1, measured:false},
  {condition:'dependencies', action:'cold', generation:1, measured:false},
  {condition:'dependencies', action:'stopServices', generation:1, measured:false},
  {condition:'baseline', action:'rearm', generation:1, measured:false},
  {condition:'dependencies', action:'rearm', generation:1, measured:false},
  ...[2,3,4,5,6].flatMap(generation => (generation % 2 === 0 ? ['baseline','dependencies'] : ['dependencies','baseline']).map(condition => ({condition,action:'switch',generation,measured:true}))),
] as const
export type Step = typeof pairPlan[number]
export async function runPair(run: (step: Step) => Promise<void>) {
  // One awaited initiator, never a Promise.all, across BOTH origins.
  for (const step of pairPlan) await run(step)
}
export async function acquirePairLock(path: string) {
  await mkdir(path) // Atomic, process-wide/repository-wide exclusion; never steal.
  return async () => {await rmdir(path)}
}

// Page requests return immediately; subsequent CLI commands are short read-only
// polls. Never replay an initiation after an ambiguous command result.
export function requestCode(action: string, token: string) {
  return `return await page.evaluate(({action,token}) => {
    const api=window.editorPerformanceExperiment;
    if(!api)throw Error('API absent');
    const requests=window.matchedDriverRequests??={};
    if(requests[token])throw Error('Request token reused');
    if(Object.values(requests).some(r=>r.status==='pending'))throw Error('Owned request pending');
    const r=requests[token]={status:'pending'};
    Promise.resolve().then(()=>api[action]()).then(value=>{r.status='completed';r.value=value},error=>{r.status='failed';r.error=String(error)});
    return {token,status:r.status};
  },${JSON.stringify({action,token})})`
}

// Keep export implementation inside the identity-pinned driver. Every read is
// pure and bounded on the wire; never send nested arrays to the CLI renderer.
const evidenceChunkSize=8000
export function evidenceReadCode(id:string,offset:number|null) {
  return `return await page.evaluate(async ({id,offset,size})=>{
    const a=window.editorPerformanceExperiment;
    if(!a||![a.samples,a.events,a.resetEvidence].every(Array.isArray))throw Error('Evidence API unavailable');
    const generation=a.resetEvidence.findLast(r=>r.phase==='readiness.budgets')?.generation;
    if(!Number.isInteger(generation))throw Error('Evidence generation unavailable');
    const json=JSON.stringify({url:location.href,generation,samples:a.samples,events:a.events,resetEvidence:a.resetEvidence});
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json))),b=>b.toString(16).padStart(2,'0')).join('');
    return {id,generation,url:location.href,hash,length:json.length,samples:a.samples.length,events:a.events.length,resetEvidence:a.resetEvidence.length,offset,text:offset===null?'':json.slice(offset,offset+size)};
  },${JSON.stringify({id,offset,size:evidenceChunkSize})})`
}

export async function exportEvidence(command:(code:string)=>Promise<any>,id:string,expectedGeneration:number) {
  const head=await command(evidenceReadCode(id,null))
  const valid=(v:any)=>v&&v.id===id&&v.generation===expectedGeneration&&typeof v.url==='string'&&/^[a-f0-9]{64}$/.test(v.hash)&&['length','samples','events','resetEvidence'].every(k=>Number.isSafeInteger(v[k])&&v[k]>=0)
  if(!valid(head)||head.offset!==null||head.text!==''||head.length===0||head.length>32*1024*1024)throw Error('Invalid evidence manifest')
  let json=''
  for(let offset=0;offset<head.length;offset+=evidenceChunkSize) {
    const part=await command(evidenceReadCode(id,offset))
    if(!valid(part)||['url','hash','length','samples','events','resetEvidence'].some(k=>part[k]!==head[k])||part.offset!==offset||typeof part.text!=='string'||part.text.length!==Math.min(evidenceChunkSize,head.length-offset))throw Error('Incomplete or changed evidence chunk')
    json+=part.text
  }
  const tail=await command(evidenceReadCode(id,null))
  if(JSON.stringify(tail)!==JSON.stringify(head)||createHash('sha256').update(json).digest('hex')!==head.hash)throw Error('Evidence identity or digest changed')
  const value=JSON.parse(json)
  if(value.url!==head.url||value.generation!==expectedGeneration||['samples','events','resetEvidence'].some(k=>!Array.isArray(value[k])||value[k].length!==head[k]))throw Error('Evidence count or generation mismatch')
  return {manifest:head,value}
}

export function createDriverCommands(evidence:string, sessions:Record<string,string>, expired:()=>boolean,
  spawn:(args:string[])=>{stdout:ReadableStream;stderr:ReadableStream;exited:Promise<number>}=(args)=>Bun.spawn(args,{stdout:'pipe',stderr:'pipe'})) {
  let sequence=0, pending=false
  return {
    get pending(){return pending},
    async command(condition:string,code:string) {
      if(expired() || pending)throw Error('Unsettled ownership; no further browser commands')
      pending=true
      let ambiguous=false
      try {
        const id=String(++sequence).padStart(4,'0'), file=join(evidence,id+'.js')
        await writeFile(file,code,{flag:'wx'})
        const child=spawn(['bunx','browser-control','execute','--json','--session',sessions[condition]!,'--file',file])
        // Join every drain and exit before relinquishing ownership. A rejected
        // observation cannot prove browser settlement, even after its siblings join.
        const joined=await Promise.allSettled([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
        const failure=joined.find(result=>result.status==='rejected')
        if(failure?.status==='rejected'){ambiguous=true;throw failure.reason}
        const [stdout,stderr,exit]=joined.map(result=>(result as PromiseFulfilledResult<any>).value)
        await writeFile(join(evidence,id+'.json'),JSON.stringify({stdout,stderr,exit}),{flag:'wx'})
        const result=JSON.parse(stdout)
        if(exit || !result.ok)throw Error(result.error || stderr || 'Browser command failed')
        if(result.valueUnavailable===true||!Object.hasOwn(result,'value'))throw Error('Browser command value unavailable; evidence incomplete')
        return result.value
      } finally {if(!ambiguous)pending=false}
    },
  }
}

if (import.meta.main) {
  if (process.env.MATCHED_AUTHORIZE_PAIR !== 'yes') throw Error('Offline preparation only unless MATCHED_AUTHORIZE_PAIR=yes explicitly authorizes the fresh pair')
  const preparation=resolve(process.env.MATCHED_CLIENT_PREPARATION || ''), evidence=resolve(process.env.MATCHED_DRIVER_EVIDENCE || '')
  if(!process.env.MATCHED_CLIENT_PREPARATION || !process.env.MATCHED_DRIVER_EVIDENCE || !process.env.MATCHED_BASELINE_SESSION || !process.env.MATCHED_REUSE_SESSION)throw Error('Require preparation, new driver evidence and two fresh owned session IDs')
  if(process.env.MATCHED_BASELINE_SESSION===process.env.MATCHED_REUSE_SESSION)throw Error('Distinct sessions required')
  const release=await acquirePairLock(resolve('.diagnostics/matched-pair-initiator.lock'))
  let quiescent=false
  try {
    await mkdir(evidence)
    const receipt=await Bun.file(join(preparation,'receipt.json')).json()
    for(const [key,value] of Object.entries(prospectivePolicy))if(receipt.prospectivePolicy[key]!==value)throw Error('Frozen budget mismatch: '+key)
    if(receipt.pin!=='446df00f86d5d6d5d856a2e5deec0fac49f242fa'||receipt.version!=='4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a')throw Error('Runtime identity mismatch')
    const driverBytes=await Bun.file(import.meta.path).arrayBuffer()
    if(new Bun.CryptoHasher('sha256').update(driverBytes).digest('hex')!==receipt.driver.sha256)throw Error('Driver changed after preparation')
    const verifier=await Bun.file(join(preparation,'reset-verifier.js')).text()
    if(new Bun.CryptoHasher('sha256').update(verifier).digest('hex')!==receipt.verifier.sha256)throw Error('Verifier identity mismatch')
    const build=await Bun.build({entrypoints:[join(preparation,'reset-verifier.js')],target:'browser',format:'cjs'})
    if(!build.success)throw Error('Verifier build failed')
    const helper=`const ResetVerifier=(()=>{const module={exports:{}};const exports=module.exports;${await build.outputs[0]!.text()};return module.exports})()\n`
    await writeFile(join(evidence,'plan.json'),JSON.stringify({pairPlan,prospectivePolicy,receipt,lock:resolve('.diagnostics/matched-pair-initiator.lock')},null,2),{flag:'wx'})
    const sessions:Record<string,string>={baseline:process.env.MATCHED_BASELINE_SESSION,dependencies:process.env.MATCHED_REUSE_SESSION}
    let expired=false, actionPending=false
    const commands=createDriverCommands(evidence,sessions,()=>expired), command=commands.command
    async function bounded<T>(task:Promise<T>,ms:number) {
      let timer:ReturnType<typeof setTimeout> | undefined
      try{return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('Deadline expired; owned work retained, quiescence unproven'))},ms)})])}
      finally{clearTimeout(timer)}
    }
    async function poll(condition:string,code:string,ms:number,accept:(value:any)=>boolean) {
      const deadline=Date.now()+ms
      while(Date.now()<deadline) {
        const value=await bounded(command(condition,code),Math.max(1,deadline-Date.now()))
        if(accept(value))return value
        await Bun.sleep(100)
      }
      expired=true; throw Error('Observation expired; quiescence unproven')
    }
    async function request(condition:string,action:string,ms:number) {
      const token=crypto.randomUUID()
      actionPending=true
      await command(condition,requestCode(action,token))
      const result=await poll(condition,`return await page.evaluate(token=>{const r=window.matchedDriverRequests?.[token];if(!r)throw Error('Request lost');return r},${JSON.stringify(token)})`,ms,v=>v.status!=='pending')
      actionPending=false
      if(result.status==='failed')throw Error(result.error)
      return result
    }
    const readyCode=`return await page.evaluate(()=>{const api=window.editorPerformanceExperiment;if(api?.error)throw Error(api.error);return {ready:api?.ready===true}})`
    async function verifierRead(condition:string, expression:string,ms:number) {
      const token=crypto.randomUUID()
      await command(condition,helper+`if(state.matchedRead?.status==='pending')throw Error('Verifier still owned');const r=state.matchedRead={token:${JSON.stringify(token)},status:'pending'};Promise.resolve().then(()=>${expression}).then(value=>{r.status='completed';r.value=value},error=>{r.status='failed';r.error=String(error)});return {token:r.token,status:r.status}`)
      return poll(condition,`const r=state.matchedRead;if(!r||r.token!==${JSON.stringify(token)})throw Error('Verifier ownership lost');if(r.status==='failed')throw Error(r.error);return r`,ms,v=>v.status==='completed')
    }
    async function verify(condition:string,generation:number) {
      const source=await request(condition,'verifySource',prospectivePolicy.verifierReadMs)
      if(source.value.generation!==generation)throw Error('Source generation mismatch')
      const token=crypto.randomUUID()
      actionPending=true
      await command(condition,helper+`return await ResetVerifier.armPdfWorkload(page,${generation},${JSON.stringify(token)})`)
      await command(condition,`await page.frameLocator('iframe').getByRole('button',{name:'Generate fixture PDF'}).click({timeout:30000});return {clicked:true}`)
      // Unchanged verifier performs generation/document/token-specific reads.
      await verifierRead(condition,`ResetVerifier.waitForPdfWorkload(page,${generation},${JSON.stringify(token)},{timeoutMs:${prospectivePolicy.verifierReadMs}})`,prospectivePolicy.verifierReadMs)
      actionPending=false
    }
    async function stop(condition:string) {
      await request(condition,'stopServices',prospectivePolicy.cleanupMs)
      const d=await request(condition,'diagnostics',prospectivePolicy.cleanupMs)
      const value=d.value
      if(!Array.isArray(value.procs)||value.procs.length||!Array.isArray(value.listeners)||value.listeners.length||value.pendingHttp!==0||value.fetch?.inflight!==0||value.fetch?.queued!==0||value.fetch?.active!==0)throw Error('Zero-work proof missing')
    }
    try {
      await runPair(async step => {await bounded((async()=>{
        const {condition,action,generation}=step
        if(action==='cold') {
          const port=condition==='baseline'?43228:43229
          const url=`http://127.0.0.1:${port}/?variant=${condition}&candidate=baseline&fsEvidence=1&matched=phase9&${receipt.policyQuery}`
          // Inspect empty storage on the fresh script-free origin; no clearing.
          await command(condition,`await page.goto(${JSON.stringify(`http://127.0.0.1:${port}/inspect-empty`)});return await page.evaluate(async()=>{if((await indexedDB.databases()).length||(await caches.keys()).length||(await navigator.serviceWorker.getRegistrations()).length||localStorage.length)throw Error('Origin not fresh');return {empty:true}})`)
          await command(condition,`await page.goto(${JSON.stringify(url)});return {url:page.url()}`)
          await poll(condition,readyCode,prospectivePolicy.observationMs,v=>v.ready)
          await verify(condition,generation)
          // Separate bounded diagnostics; validation/cache stages remain named
          // samples, never subtracted from switch.total or startup.total.
          const diagnostics=await request(condition,'diagnostics',prospectivePolicy.cleanupMs)
          await writeFile(join(evidence,condition+'-cold-diagnostics.json'),JSON.stringify({measured:false,diagnostics}),{flag:'wx'})
        } else if(action==='stopServices') await stop(condition)
        else if(action==='rearm') {await request(condition,'rearm',prospectivePolicy.overallMs);await verify(condition,generation)}
        else {
          const token=crypto.randomUUID()
          actionPending=true
          await command(condition,helper+`return await ResetVerifier.startWorkspaceSwitch(page,${JSON.stringify(token)})`)
          await verifierRead(condition,`ResetVerifier.waitForWorkspaceSwitch(page,${JSON.stringify(token)},${generation},{timeoutMs:${prospectivePolicy.observationMs}})`,prospectivePolicy.observationMs)
          actionPending=false
          await verify(condition,generation)
        }
        const exported=await exportEvidence(code=>command(condition,code),crypto.randomUUID(),generation)
        await writeFile(join(evidence,`step-${pairPlan.indexOf(step)}-evidence.json`),JSON.stringify(exported),{flag:'wx'})
        await writeFile(join(evidence,`step-${pairPlan.indexOf(step)}.json`),JSON.stringify({step,status:'PASS'}),{flag:'wx'})
      })(),prospectivePolicy.watchdogMs)})
      await stop('baseline'); await stop('dependencies'); quiescent=true
    } catch(error) {
      await writeFile(join(evidence,'failure.json'),JSON.stringify({error:String(error),pairStopped:true,noRetries:true,quiescence:'unproven; lock retained'}),{flag:'wx'})
      // Stop requests only: no reset, close, rearm, replacement or new workload.
      // Do not overlap unresolved initiations with cleanup: pending page requests
      // reject a new request. A failed/expired cleanup retains lock and pages.
      if(!expired && !commands.pending && !actionPending)for(const condition of ['baseline','dependencies']) {try{await bounded(stop(condition),prospectivePolicy.cleanupMs)}catch{break}}
      throw error
    }
  } finally {if(quiescent)await release()}
}
