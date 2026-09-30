import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {acquirePairLock,createDriverCommands} from './matched-pair-driver';
import {acceptanceRequestCode,inventoryCode,validateOwnedOrigins} from './single-kernel-driver';
if(process.env.SINGLE_KERNEL_AUTHORIZE_REMAINING!=='yes'||process.argv.length!==4)throw Error('Require explicit remaining-only authorization and <new-output> <new-evidence>');
const root=resolve(import.meta.dir,'../../..'),output=resolve(process.argv[2]!),evidence=resolve(process.argv[3]!);
const receipt=await Bun.file(join(output,'receipt.json')).json(),app=await Bun.file(join(output,'owned-origin.json')).json(),contracts=await Bun.file(join(output,'owned-contract-origin.json')).json();
validateOwnedOrigins(app,contracts,output);
if(receipt.revision!=='e35eab4af7a53ff08eb70c09df59c40b78bfdd67'||!receipt.remainingOnly)throw Error('Require frozen remaining-only e35 artifact');
for(const [file,hash] of Object.entries(receipt.hashes))if(createHash('sha256').update(await readFile(join(output,file))).digest('hex')!==hash)throw Error('Artifact hash mismatch: '+file);
for(const [file,hash] of Object.entries(receipt.driverSources))if(createHash('sha256').update(await readFile(join(root,file))).digest('hex')!==hash)throw Error('Driver hash mismatch: '+file);
const lock=join(root,'.diagnostics/single-kernel-e35eab4-remaining.lock'),release=await acquirePairLock(lock);
try{await mkdir(evidence);}catch(error){await release();throw error;}
const sessions={app:'single-kernel-reload-'+crypto.randomUUID().slice(0,8),contracts:'single-kernel-remaining-'+crypto.randomUUID().slice(0,8)};
const cli=Bun.which('browser-control');if(!cli)throw Error('Browser Control CLI unavailable');
let expired=false,actionPending=false;const commands=createDriverCommands(evidence,sessions,()=>expired,undefined,['bun',cli]);
const deadlinePolicy={actionMs:120000,readMs:15000,closeObservationMs:15000,retries:0,appGenerations:0,models:0};
await writeFile(join(evidence,'ownership.json'),JSON.stringify({output,receipt,app,contracts,sessions,lock,policy:deadlinePolicy,olderCohortsUntouched:true},null,2),{flag:'wx'});
async function read(condition:string,code:string){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([commands.command(condition,code),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('Read deadline; ownership retained'));},15000);})]);}finally{clearTimeout(timer!);}}
async function poll(condition:string,code:string,ms:number,accept:(v:any)=>boolean){const until=Date.now()+ms;while(Date.now()<until){const value=await read(condition,code);if(accept(value))return value;await Bun.sleep(150);}throw Error('Observation deadline; no action replay');}
async function request(condition:string,api:string,action:string,args:unknown[]=[]){const token=crypto.randomUUID();actionPending=true;await read(condition,acceptanceRequestCode(api,action,args,token));const value=await poll(condition,`return await page.evaluate(token=>{const r=window.singleKernelRuns?.[token];if(!r)throw Error('Request lost');return {status:r.status,error:r.error};},${JSON.stringify(token)});`,120000,v=>v.status!=='pending');actionPending=false;if(value.status!=='completed')throw Error(value.error);}
async function lifecycle(args:string[]){const p=Bun.spawn(['bun',cli!,'session',...args],{stdout:'pipe',stderr:'pipe'});const joined=await Promise.allSettled([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(joined.some(r=>r.status==='rejected')){expired=true;throw Error('Ambiguous session lifecycle');}const [stdout,stderr,exit]=joined.map(r=>(r as PromiseFulfilledResult<any>).value);await writeFile(join(evidence,'session-'+args.join('-')+'.json'),JSON.stringify({stdout,stderr,exit}),{flag:'wx'});if(exit)throw Error(stderr||stdout);}
async function ready(condition:string,api:string){await poll(condition,`return await page.evaluate(api=>({ready:!!window[api]}),${JSON.stringify(api)});`,15000,v=>v.ready);}
async function fresh(condition:string,origin:string,api:string){await read(condition,`if(page.url()!=='about:blank')throw Error('Fresh page required');await page.goto(${JSON.stringify(origin+'inspect-empty')});return await page.evaluate(async()=>{const root=await navigator.storage.getDirectory();for await(const name of root.keys())throw Error('Origin OPFS not empty: '+name);if((await indexedDB.databases()).length||(await caches.keys()).length||(await navigator.serviceWorker.getRegistrations()).length||localStorage.length)throw Error('Origin not fresh');return {empty:true};});`);await read(condition,`await page.goto(${JSON.stringify(origin)});return {url:page.url()};`);await ready(condition,api);}
async function closed(condition:string){return poll(condition,inventoryCode(false,true),15000,v=>v.closed);}
async function retain(condition:string,api:string,name:string){
  const manifest=await read(condition,`const value=await page.evaluate(api=>window[api]?.evidence??{unavailable:true},${JSON.stringify(api)});const cdp=await page.context().newCDPSession(page);let targets;try{const origin=new URL(page.url()).origin;targets=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.url?.startsWith(origin+'/')||t.url?.startsWith('blob:'+origin+'/'));}finally{await cdp.detach();}const json=JSON.stringify({url:page.url(),targets,evidence:value});state.remainingSnapshot=json;return {length:json.length,hash:modules.crypto.createHash('sha256').update(json).digest('hex')};`);
  if(!Number.isSafeInteger(manifest.length)||manifest.length>32*1024*1024)throw Error('Evidence bound');let json='';for(let offset=0;offset<manifest.length;offset+=8000){const part=await read(condition,`return {offset:${offset},text:state.remainingSnapshot.slice(${offset},${offset+8000})};`);if(part.offset!==offset||part.text.length!==Math.min(8000,manifest.length-offset))throw Error('Evidence chunk incomplete');json+=part.text;}if(createHash('sha256').update(json).digest('hex')!==manifest.hash)throw Error('Evidence hash changed');await writeFile(join(evidence,name+'.json'),json,{flag:'wx'});
}
try{
  for(const session of Object.values(sessions))await lifecycle(['new',session]);
  await fresh('app',app.url,'singleKernelReload');await request('app','singleKernelReload','seed');await closed('app');await retain('app','singleKernelReload','reload-seed');
  await read('app','await page.reload();return {url:page.url()};');await ready('app','singleKernelReload');await request('app','singleKernelReload','verify');await closed('app');await retain('app','singleKernelReload','real-reload-verified');
  await fresh('contracts',contracts.url,'singleKernelCases');const cases=await read('contracts','return await page.evaluate(()=>window.singleKernelCases.evidence.cases);');if(cases.length!==10)throw Error('Expected exactly 10 focused cases');
  let steps=0;
  for(const [index,test] of cases.entries()){
    if(index){await closed('contracts');await read('contracts',`return await page.evaluate(async()=>{const root=await navigator.storage.getDirectory();const removed=[];for await(const name of root.keys()){await root.removeEntry(name,{recursive:true});removed.push(name);}return {removed};});`);}
    for(let step=0;step<test.steps;step++){
      if(index||step){await closed('contracts');await read('contracts','await page.reload();return {url:page.url()};');await ready('contracts','singleKernelCases');}
      await request('contracts','singleKernelCases','run',[index,step]);await closed('contracts');await retain('contracts','singleKernelCases','case-'+index+'-'+step);steps++;
    }
  }
  for(const session of Object.values(sessions))await lifecycle(['delete',session]);
  await writeFile(join(evidence,'result.json'),JSON.stringify({status:'passed',revision:receipt.revision,version:receipt.version,cases,focusedCases:cases.length,focusedSteps:steps,reloadActions:2,models:0,retries:0,oldCohortsUntouched:true,cleanup:'Owned workspaces closed, zero-worker census, sessions deleted; server stop follows'},null,2),{flag:'wx'});await release();console.log(evidence);
}catch(error){const captureErrors:string[]=[];if(!expired&&!commands.pending)for(const [condition,api] of [['app','singleKernelReload'],['contracts','singleKernelCases']])try{await retain(condition!,api!,'failure-'+condition);}catch(e){captureErrors.push(String(e));if(expired||commands.pending)break;}await writeFile(join(evidence,'result.json'),JSON.stringify({status:'failed',error:String(error),expired,actionPending,commandPending:commands.pending,captureErrors,sessions,retained:true},null,2),{flag:'wx'});console.error(evidence);throw error;}
