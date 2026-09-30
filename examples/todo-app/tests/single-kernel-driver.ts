import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {acquirePairLock,createDriverCommands} from './matched-pair-driver';

export const acceptancePolicy=Object.freeze({stageMs:120000,readMs:15000,interactiveMs:60000,generations:5,retries:0});
export function acceptanceLock(evidence:string){return resolve(evidence)+'.lock';}
export function acceptanceRequestCode(api:string,action:string,args:unknown[],token:string){
  return `return await page.evaluate(({api,action,args,token})=>{
    const owner=window[api];if(!owner)throw Error('Acceptance API absent');
    const runs=window.singleKernelRuns??={};
    if(runs[token]||Object.values(runs).some(r=>r.status==='pending'))throw Error('Duplicate or competing initiator');
    const run=runs[token]={status:'pending'};
    Promise.resolve().then(()=>owner[action](...args)).then(value=>{run.status='completed';run.value=value},error=>{run.status='failed';run.error=String(error)});
    return {token,status:run.status};
  },${JSON.stringify({api,action,args,token})});`;
}
export async function runFoundation(request:(action:string)=>Promise<unknown>){
  for(const action of ['open','childSync','captureBoundaries','initialize','minimalAsyncSpawn','minimalSpawnSync','minimalExecSync','fetchedBody','watches','streaming','recreate'])await request(action);
}
export function validateOwnedOrigins(app:any,contracts:any,output:string){
  for(const origin of [app,contracts]){
    const url=new URL(origin.url);
    if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||url.pathname!=='/'||!url.port||['43222','43223'].includes(url.port)||origin.output!==output||!Number.isSafeInteger(origin.pid))throw Error('Invalid owned acceptance origin');
  }
  if(app.url===contracts.url||app.contracts!==false||contracts.contracts!==true)throw Error('Distinct app and contracts origins required');
}
export function inventoryCode(expectKernel:boolean,observeClose=false){
  return `const origin=new URL(page.url()).origin;
    const cdp=await page.context().newCDPSession(page);
    try{const {targetInfos}=await cdp.send('Target.getTargets');
      const scoped=new Set(targetInfos.filter(t=>t.url?.startsWith(origin+'/')||t.url?.startsWith('blob:'+origin+'/')).map(t=>t.targetId));
      for(let changed=true;changed;){changed=false;for(const t of targetInfos)if(t.openerId&&scoped.has(t.openerId)&&!scoped.has(t.targetId)){scoped.add(t.targetId);changed=true;}}
      const targets=targetInfos.filter(t=>scoped.has(t.targetId)&&['worker','shared_worker','service_worker'].includes(t.type));
      const workers=targets.filter(t=>t.type!=='service_worker');
      const kernels=workers.filter(t=>/\\/kernel-worker(?:-[\\w-]+)?\\.js(?:\\?|$)/.test(t.url));
      const processes=workers.filter(t=>/\\/process-worker-[\\w-]+\\.js(?:\\?|$)/.test(t.url));
       if(workers.length!==kernels.length+processes.length||(${!observeClose}&&(kernels.length!==${expectKernel?1:0}||(${!expectKernel}&&processes.length))))throw Error('Chrome worker topology mismatch: '+JSON.stringify(targets));
      for(const kernel of kernels){const url=new URL(kernel.url);if(!url.searchParams.has('opfs-disable')||url.search.slice(1).includes('?'))throw Error('Malformed/missing kernel SQLite proxy opt-out flag');}
      const d=${expectKernel?"await page.evaluate(()=>window.singleKernelAcceptance.diagnostics())":"null"};
      if(d&&(d.workers.process!==processes.length||d.workers.kernel!==kernels.length))throw Error('Actual Chrome census differs from runtime registry');
       return {origin,targets,runtimeWorkers:d?.workers??null,closed:kernels.length===0&&processes.length===0};
    }finally{await cdp.detach();}`;
}

if(import.meta.main){
  if(process.env.SINGLE_KERNEL_AUTHORIZE_RUN!=='yes')throw Error('Requires parent checkpoint authorization: SINGLE_KERNEL_AUTHORIZE_RUN=yes');
  if(!process.argv[2]||!process.argv[3])throw Error('Usage: bun single-kernel-driver.ts <prepared-output> <new-evidence-directory>');
  const root=resolve(import.meta.dir,'../../..'),output=resolve(process.argv[2]),evidence=resolve(process.argv[3]);
  const app=await Bun.file(join(output,'owned-origin.json')).json(),contracts=await Bun.file(join(output,'owned-contract-origin.json')).json();
  validateOwnedOrigins(app,contracts,output);
  const receipt=await Bun.file(join(output,'receipt.json')).json();
  if(!receipt.prepared||receipt.topology?.policy!=='single-kernel')throw Error('Full acceptance requires matching prepared apps and single-kernel receipt');
  if(receipt.revision!=='e35eab4af7a53ff08eb70c09df59c40b78bfdd67')throw Error('Require authorized final cleanup checkpoint');
  for(const [file,expected] of Object.entries(receipt.hashes))if(createHash('sha256').update(await readFile(join(output,file))).digest('hex')!==expected)throw Error('Acceptance artifact changed: '+file);
  if(!receipt.driverSources)throw Error('Driver source receipt missing');
  for(const [file,expected] of Object.entries(receipt.driverSources))if(createHash('sha256').update(await readFile(join(root,file))).digest('hex')!==expected)throw Error('Driver changed since preparation: '+file);
  const cli=process.env.BROWSER_CONTROL_CLI??Bun.which('browser-control');if(!cli)throw Error('Bun-backed Browser Control CLI unavailable');
  const lock=acceptanceLock(evidence);
  const release=await acquirePairLock(lock);
  try{await mkdir(evidence);}catch(error){await release();throw error;} // No action has started; never strand a preflight lock.
  const sessions={app:'single-kernel-app-'+crypto.randomUUID().slice(0,8),contracts:'single-kernel-cases-'+crypto.randomUUID().slice(0,8)};
  await writeFile(join(evidence,'ownership.json'),JSON.stringify({output,app,contracts,sessions,policy:acceptancePolicy,receipt,lock,firstProbeDeadlineMs:20000,captureBoundariesDeadlineMs:60000,oldCohortsUntouched:true},null,2),{flag:'wx'});
  let expired=false,actionPending=false;
  const commands=createDriverCommands(evidence,sessions,()=>expired,undefined,['bun',cli]);
  const command=commands.command;
  async function session(args:string[]){
    const p=Bun.spawn(['bun',cli!,'session',...args],{stdout:'pipe',stderr:'pipe'});
    const joined=await Promise.allSettled([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    if(joined.some(result=>result.status==='rejected')){expired=true;throw Error('Ambiguous Browser Control session lifecycle; ownership retained');}
    const [stdout,stderr,exit]=joined.map(result=>(result as PromiseFulfilledResult<any>).value);
    await writeFile(join(evidence,'session-'+args.join('-')+'.json'),JSON.stringify({stdout,stderr,exit}),{flag:'wx'});
    if(exit)throw Error(stderr||stdout);
  }
  async function bounded<T>(task:Promise<T>,ms:number){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('Observation expired; no replay or replacement cleanup'))},ms);})]);}finally{clearTimeout(timer!);}}
  async function read(condition:string,code:string){return bounded(command(condition,code),acceptancePolicy.readMs);}
  async function poll(condition:string,code:string,ms:number,accept:(value:any)=>boolean){
    const deadline=Date.now()+ms;
    while(Date.now()<deadline){const value=await read(condition,code);if(accept(value))return value;await Bun.sleep(150);}
    expired=true;throw Error('Bounded acceptance observation expired; action not retried');
  }
  async function request(condition:string,api:string,action:string,args:unknown[]=[]){
    const token=crypto.randomUUID();actionPending=true;
    await read(condition,acceptanceRequestCode(api,action,args,token));
    const result=await poll(condition,`return await page.evaluate(token=>{const r=window.singleKernelRuns?.[token];if(!r)throw Error('Owned action lost');return {status:r.status,error:r.error}},${JSON.stringify(token)})`,(action==='childSync'?20000:action==='captureBoundaries'?60000:acceptancePolicy.stageMs)+10000,value=>value.status!=='pending');
    actionPending=false;if(result.status!=='completed')throw Error(result.error??'Acceptance action failed');
  }
  async function fresh(condition:string,origin:string,api:string){
    await read(condition,`if(state.singleKernelLogObserver)throw Error('Page log observer already installed');
      const record=state.singleKernelLogObserver={url:${JSON.stringify(origin)},entries:[],dropped:0};
      const retain=value=>{if(record.entries.length>=256){record.dropped++;return;}record.entries.push(value);};
      const safe=text=>String(text).replace(/\\b(?:Basic|Bearer)\\s+[A-Za-z0-9._~+\\/=-]+/gi,'[authorization redacted]').slice(0,4096);
      page.on('console',message=>{if(['warning','error'].includes(message.type()))retain({type:message.type(),text:safe(message.text()),location:message.location()});});
      page.on('pageerror',error=>retain({type:'pageerror',text:safe(error.message)}));
      return {observerInstalled:true};`);
    await read(condition,`if(page.url()!=='about:blank')throw Error('Refuse nonempty session page');await page.goto(${JSON.stringify(origin+'inspect-empty')});return await page.evaluate(async()=>{
      const root=await navigator.storage.getDirectory();for await(const key of root.keys())throw Error('Origin has existing OPFS '+key);
      if((await indexedDB.databases()).length||(await caches.keys()).length||(await navigator.serviceWorker.getRegistrations()).length||localStorage.length)throw Error('Origin not fresh');return {empty:true};});`);
    await read(condition,`await page.goto(${JSON.stringify(origin)});return {url:page.url()};`);
    await poll(condition,`return await page.evaluate(api=>({ready:!!window[api]}),${JSON.stringify(api)})`,acceptancePolicy.interactiveMs,value=>value.ready);
  }
  async function hydrate(generation:number,hmr=false){
    await poll('app',`return await page.evaluate(({generation,hmr})=>{
      const api=window.singleKernelAcceptance;if(api.evidence.error)throw Error(api.evidence.error);
      const d=document.querySelector('iframe')?.contentDocument,h=d?.querySelector('h1[data-generation="'+generation+'"]');
      const ready=!!d?.querySelector('main[data-hydrated="'+generation+'"]')&&h?.dataset.workspace===(generation%2?'A':'B')&&!!d.querySelector('input#title:not(:disabled)');
      if(hmr&&d!==window.singleKernelPreviewDocument)throw Error('HMR replaced the preview document');
      if(ready&&!hmr)window.singleKernelPreviewDocument=d;
      return {ready:ready&&(!hmr||h.dataset.hmr==='single-kernel-fresh-hmr'),generation};
    },${JSON.stringify({generation,hmr})})`,acceptancePolicy.interactiveMs,value=>value.ready);
  }
  async function interactive(generation:number){
    const title='Single kernel todo '+generation+' '+crypto.randomUUID().slice(0,8);
    actionPending=true;
    await read('app',`const frame=page.frameLocator('iframe');await frame.getByLabel('New todo').fill(${JSON.stringify(title)},{timeout:10000});await frame.getByRole('button',{name:'Add',exact:true}).click({timeout:10000});return {submitted:true};`);
    await poll('app',`return await page.evaluate(title=>({found:[...document.querySelector('iframe').contentDocument.querySelectorAll('li span')].some(e=>e.textContent===title)}),${JSON.stringify(title)})`,acceptancePolicy.interactiveMs,value=>value.found);
    actionPending=false;
    const token=crypto.randomUUID();actionPending=true;
    await read('app',`return await page.evaluate(({generation,token})=>{
      const d=document.querySelector('iframe').contentDocument,b=d.querySelector('#pdf-workload');
      if(!d.querySelector('h1[data-generation="'+generation+'"]')||!b)throw Error('PDF generation absent');
      if(window.singleKernelPdf?.pending)throw Error('PDF still pending');
      delete b.dataset.bytes;b.dataset.verificationRun=token;window.singleKernelPdf={document:d,button:b,token,pending:true};return {armed:true};
    },${JSON.stringify({generation,token})});`);
    await read('app',`await page.frameLocator('iframe').getByRole('button',{name:'Generate fixture PDF',exact:true}).click({timeout:10000});return {clicked:true};`);
    await poll('app',`return await page.evaluate(token=>{
      const r=window.singleKernelPdf,d=document.querySelector('iframe').contentDocument;
      if(!r||r.token!==token||d!==r.document||d.querySelector('#pdf-workload')!==r.button||r.button.dataset.verificationRun!==token)throw Error('PDF token/document changed');
      const bytes=Number(r.button.dataset.bytes);if(Number.isFinite(bytes)&&bytes>0)r.pending=false;return {completed:!r.pending,bytes};
    },${JSON.stringify(token)})`,acceptancePolicy.interactiveMs,value=>value.completed&&value.bytes>0);
    actionPending=false;
  }
  async function retain(condition:string,api:string,name:string){
    const manifest=await read(condition,`return await page.evaluate(async api=>{const json=JSON.stringify(window[api].evidence);window.singleKernelEvidenceSnapshot=json;const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json))),b=>b.toString(16).padStart(2,'0')).join('');return {length:json.length,hash}},${JSON.stringify(api)});`);
    if(!Number.isSafeInteger(manifest.length)||manifest.length>32*1024*1024||!/[a-f0-9]{64}/.test(manifest.hash))throw Error('Invalid frozen evidence manifest');
    let text='';for(let offset=0;offset<manifest.length;offset+=8000){const part=await read(condition,`return await page.evaluate(({offset,size})=>({offset,text:window.singleKernelEvidenceSnapshot.slice(offset,offset+size)}),${JSON.stringify({offset,size:8000})});`);if(part.offset!==offset||part.text.length!==Math.min(8000,manifest.length-offset))throw Error('Evidence chunk missing');text+=part.text;}
    if(createHash('sha256').update(text).digest('hex')!==manifest.hash)throw Error('Evidence digest mismatch');await writeFile(join(evidence,name+'.json'),text,{flag:'wx'});
  }
  async function retainBrowserLogs(condition:string,name:string){
    const manifest=await read(condition,`const observer=state.singleKernelLogObserver;const json=JSON.stringify(observer?{url:observer.url,entries:observer.entries,dropped:observer.dropped}:{unavailable:'Observer not installed'});state.singleKernelLogSnapshot=json;return {length:json.length,hash:modules.crypto.createHash('sha256').update(json).digest('hex')};`);
    if(!Number.isSafeInteger(manifest.length)||manifest.length>2*1024*1024)throw Error('Browser log snapshot exceeded bound');
    let text='';for(let offset=0;offset<manifest.length;offset+=8000){const part=await read(condition,`if(typeof state.singleKernelLogSnapshot!=='string')throw Error('Browser log snapshot lost');return {offset:${offset},text:state.singleKernelLogSnapshot.slice(${offset},${offset+8000})};`);if(part.offset!==offset||part.text.length!==Math.min(8000,manifest.length-offset))throw Error('Browser log evidence chunk missing');text+=part.text;}
    if(createHash('sha256').update(text).digest('hex')!==manifest.hash)throw Error('Browser log snapshot digest changed');
    await writeFile(join(evidence,name+'.json'),text,{flag:'wx'});
  }
  async function retainDiagnostics(){
    await read('app',`return await page.evaluate(async()=>{window.singleKernelAcceptance.evidence.failureDiagnostics=await Promise.race([window.singleKernelAcceptance.diagnostics().catch(error=>({unavailable:String(error)})),new Promise(resolve=>setTimeout(()=>resolve({unavailable:'5000ms read deadline'}),5000))]);return {captured:true};});`);
  }
  // Worker.terminate is synchronous, but Chrome Target removal propagates later.
  // Observe only after joined stop/close. Never replay a lifecycle action here.
  async function closedTargets(condition:string){await poll(condition,inventoryCode(false,true),15000,value=>value.closed);}
  try{
    for(const id of Object.values(sessions))await session(['new',id]);
    await fresh('app',app.url,'singleKernelAcceptance');
    await runFoundation(action=>request('app','singleKernelAcceptance',action));
    await read('app',inventoryCode(true));
    for(let generation=1;generation<=acceptancePolicy.generations;generation++){
      await request('app','singleKernelAcceptance','apps');await hydrate(generation);await interactive(generation);await read('app',inventoryCode(true));
      if(generation===1){await request('app','singleKernelAcceptance','hmr');await hydrate(generation,true);await request('app','singleKernelAcceptance','sse');}
    }
    await request('app','singleKernelAcceptance','close');await closedTargets('app');await retain('app','singleKernelAcceptance','app-evidence');
    await read('app','await page.reload();return {url:page.url()};');
    await poll('app',`return await page.evaluate(()=>({ready:!!window.singleKernelAcceptance}))`,acceptancePolicy.interactiveMs,value=>value.ready);
    await request('app','singleKernelAcceptance','reloadCheck');await read('app',inventoryCode(true));
    await request('app','singleKernelAcceptance','close');await closedTargets('app');await retain('app','singleKernelAcceptance','reload-evidence');
    await retainBrowserLogs('app','app-browser-logs');
    await fresh('contracts',contracts.url,'singleKernelCases');
    const cases=await read('contracts','return await page.evaluate(()=>window.singleKernelCases.evidence.cases);');
    for(const [index,test] of cases.entries()){
      if(index){
        await closedTargets('contracts');
        await read('contracts',`return await page.evaluate(async()=>{const root=await navigator.storage.getDirectory();const removed=[];for await(const name of root.keys()){await root.removeEntry(name,{recursive:true});removed.push(name);}return {ownedStorageRemoved:removed};});`);
      }
      for(let step=0;step<test.steps;step++){
        if(index||step){await read('contracts','await page.reload();return {url:page.url()};');await poll('contracts',`return await page.evaluate(()=>({ready:!!window.singleKernelCases}))`,acceptancePolicy.interactiveMs,value=>value.ready);}
        await request('contracts','singleKernelCases','run',[index,step]);await closedTargets('contracts');await retain('contracts','singleKernelCases','case-'+index+'-'+step);
      }
    }
    await retainBrowserLogs('contracts','contract-browser-logs');
    for(const id of Object.values(sessions))await session(['delete',id]);
    await writeFile(join(evidence,'result.json'),JSON.stringify({status:'passed',cases:cases.length,generations:acceptancePolicy.generations,retries:0,models:0,servers:'Parent-owned fresh test servers retained; exact PIDs in ownership.json'},null,2),{flag:'wx'});
    await release();console.log(evidence);
  }catch(error){
    // Never navigate/retry/stop after ambiguous initiation or an expired read.
    // Exact pages, origin servers, and global lock remain for inspection/repair.
    const captureErrors:string[]=[];
    if(!expired&&!commands.pending){
      try{await retainDiagnostics();}catch(captureError){captureErrors.push(String(captureError));}
      for(const [condition,api] of [['app','singleKernelAcceptance'],['contracts','singleKernelCases']]){
        try{const available=await read(condition,`return await page.evaluate(api=>({available:!!window[api]}),${JSON.stringify(api)});`);if(available.available)await retain(condition!,api!,'failure-'+condition);await retainBrowserLogs(condition!,'failure-'+condition+'-browser-logs');}catch(captureError){captureErrors.push(String(captureError));if(expired||commands.pending)break;}
      }
    }
    await writeFile(join(evidence,'result.json'),JSON.stringify({status:'failed',error:String(error),expired,actionPending,commandPending:commands.pending,sessions,retained:true,captureErrors},null,2),{flag:'wx'});
    console.error('Acceptance failed; owned resources retained: '+evidence);throw error;
  }
}
