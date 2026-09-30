import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {acquirePairLock,createDriverCommands} from './matched-pair-driver';

// The mounted-controller first pair was blocked, not the older phase9 plan.
// Reverse ONLY condition order; the served client/fixtures remain byte-identical.
export const counterbalancedLifecyclePlan=Object.freeze([
 {condition:'reuse',port:43232,markers:['A0','B1','A2','B3','A4','B5']},
 {condition:'restart',port:43233,markers:['A0','B1','A2','B3','A4','B5']},
] as const);
export async function runCounterbalancedLifecyclePair(run:(step:typeof counterbalancedLifecyclePlan[number])=>Promise<void>){
 for(const step of counterbalancedLifecyclePlan)await run(step);
}
export function retainLifecycleHost<T extends {unref:()=>void}>(host:T){host.unref();return host;}

if(import.meta.main){
 if(process.env.MATCHED_AUTHORIZE_COUNTERBALANCE!=='yes')throw Error('Explicit single-pair authorization required');
 const first=resolve('.diagnostics/opencode-matched-lifecycle-2026-09-30T05-24-21-330Z');
 const output=resolve(process.argv[2]!);
 const release=await acquirePairLock(resolve('.diagnostics/matched-pair-initiator.lock'));
 let healthy=false;
 try{
  await mkdir(output);
  const receipt=await Bun.file(join(first,'receipt.json')).json();
  const bytes=await Bun.file(join(first,'client/matched-lifecycle-client.js')).arrayBuffer();
  if(bytes.byteLength!==1926835||new Bun.CryptoHasher('sha256').update(bytes).digest('hex')!=='84615fa7f71952080e1afb5f47c0ee2fd3bea45341c9f57bd3cada89c402a461')throw Error('Frozen client mismatch');
  await mkdir(join(output,'client'));
  await Bun.write(join(output,'client/matched-lifecycle-client.js'),bytes);
  await writeFile(join(output,'receipt.json'),JSON.stringify({...receipt,output,policy:{...receipt.policy,order:['reuse','restart']},firstPair:first,frozenClientPolicyOrder:'restart,reuse is inert per-page metadata; external actual order reuse,restart'},null,2),{flag:'wx'});
  const capture=async(args:string[],name:string)=>{
   const p=Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});
   const results=await Promise.allSettled([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
   const failed=results.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
   const [stdout,stderr,exit]=results.map(r=>(r as PromiseFulfilledResult<any>).value);
   await writeFile(join(output,name+'.json'),JSON.stringify({stdout,stderr,exit}),{flag:'wx'});
   if(exit)throw Error(stderr||stdout);return stdout;
  };
  const listeners=await capture(['lsof','-nP','-iTCP','-sTCP:LISTEN'],'inventory-before');
  for(const {port} of counterbalancedLifecyclePlan)if(listeners.includes(':'+port+' '))throw Error('Port occupied');
  const before=JSON.parse(await capture(['bunx','browser-control','status','--json'],'browser-before'));
  if(!before.relay?.running||before.relay.stale||!before.extension?.connected)throw Error('Browser unavailable or stale');
  const source=await capture(['git','-C',receipt.runtimeSource,'rev-parse','HEAD'],'source-pin');
  if(source.trim()!==receipt.pin)throw Error('Source pin mismatch');
  if((await capture(['git','-C',receipt.runtimeSource,'status','--porcelain'],'source-clean')).trim())throw Error('Source not clean');
  let checks=0;
  const hash=async(file:string,expected:any)=>{const bytes=await Bun.file(file).arrayBuffer();if(bytes.byteLength!==expected.bytes||new Bun.CryptoHasher('sha256').update(bytes).digest('hex')!==expected.sha256)throw Error('Frozen bytes mismatch '+file);};
  for(const [url,expected] of Object.entries(receipt.verified))await hash(url==='/prepared/baseline/manifest.json'?join(receipt.frozen,'server-output/baseline/manifest.json'):join(receipt.frozen,url.slice(1)),expected);
  const identity=await Bun.file(join(receipt.frozen,'served-identity.json')).json(),manifest=await Bun.file(join(receipt.frozen,'server-output/baseline/manifest.json')).json();
  for(const asset of [...manifest.assets.filter((a:any)=>a.kind==='file'),identity.payload.image,identity.payload.bundle]){await hash(join(receipt.frozen,'prepared',asset.file),asset);checks++;}
  if(checks!==10528)throw Error('Payload count mismatch');
  await writeFile(join(output,'plan.json'),JSON.stringify({plan:counterbalancedLifecyclePlan,policy:receipt.policy,actualOrder:['reuse','restart'],client:receipt.client,managedFileChecks:checks,lock:resolve('.diagnostics/matched-pair-initiator.lock'),rebuild:false},null,2),{flag:'wx'});
  const sessions:Record<string,string>={};let expired=false;
  const commands=createDriverCommands(output,sessions,()=>expired);
  const hosts:any[]=[];
  // Host ownership is intentionally retained like the first pair. Guest services
  // are joined/stopped by the unchanged client before accepting a condition.
  await runCounterbalancedLifecyclePair(async({condition,port})=>{
   const host=retainLifecycleHost(Bun.spawn(['bun',resolve('examples/todo-app/tests/serve-reuse-pilot.ts'),output,String(port)],{stdout:Bun.file(join(output,'host-'+condition+'.out')),stderr:Bun.file(join(output,'host-'+condition+'.err'))}));hosts.push({condition,port,pid:host.pid});
   await writeFile(join(output,'hosts-'+condition+'.json'),JSON.stringify(hosts),{flag:'wx'});
   const hostDeadline=Date.now()+10000;
   while(!await Bun.file(join(output,'host-'+condition+'.out')).size){if(Date.now()>hostDeadline)throw Error('Host listen deadline');await Bun.sleep(100);}
   const opened=JSON.parse(await capture(['bunx','browser-control','execute','--json','return {url:page.url()}'],'session-'+condition));
   if(!opened.ok||!opened.session)throw Error('Fresh session absent');
   sessions[condition]=typeof opened.session==='string'?opened.session:opened.session.id;
   if(!sessions[condition])throw Error('Fresh session ID absent');
   await commands.command(condition,`await page.goto('http://127.0.0.1:${port}/inspect-empty');return await page.evaluate(async()=>{if((await indexedDB.databases()).length||(await caches.keys()).length||(await navigator.serviceWorker.getRegistrations()).length||localStorage.length)throw Error('Origin not fresh');return {empty:true,url:location.href}})`);
   await commands.command(condition,`await page.goto('http://127.0.0.1:${port}/?condition=${condition}');return {url:page.url()}`);
   const deadline=Date.now()+receipt.policy.observationMs;
   let terminal:any;
   while(Date.now()<deadline){
    const value=await commands.command(condition,`return await page.evaluate(()=>{const e=window.matchedPilot?.evidence;return {url:location.href,status:e?.status,error:e?.error,attempts:e?.attempts}})`);
    if(value.status==='failed')throw Error('Condition failed: '+value.error);
    if(value.status==='passed'){terminal=value;break;}
    await Bun.sleep(5000);
   }
   if(!terminal){expired=true;throw Error('Condition observation deadline; ownership retained');}
   const exported=await commands.command(condition,await Bun.file('examples/todo-app/tests/export-matched-lifecycle.js').text());
   if(exported.status!=='passed'||!exported.receipt.validated)throw Error('Incomplete export');
   await capture(['bun',resolve('examples/todo-app/tests/verify-matched-lifecycle.ts'),output],'verify-'+condition);
   const data=await Bun.file(join(output,'live-'+condition+'.json')).json();
   if(data.attempts.cold!==1||data.attempts.transition!==5||data.zero.procs.length||data.zero.listeners.length||data.zero.pendingHttp||data.exit.exitCode!==0||data.exit.forced||data.exit.signal!==null)throw Error('Condition zero-work/exit acceptance');
   await writeFile(join(output,'accepted-'+condition+'.json'),JSON.stringify({session:sessions[condition],terminal,exported}),{flag:'wx'});
  });
  await capture(['lsof','-nP','-iTCP','-sTCP:LISTEN'],'inventory-after');
  await capture(['bunx','browser-control','status','--json'],'browser-after');
  await writeFile(join(output,'completion.json'),JSON.stringify({status:'passed',sessions,hosts,transitions:10,retries:0,replacements:0,extensions:0,lockReleased:true}),{flag:'wx'});
  healthy=true;
 }catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),pairStopped:true,ownership:'retained; no retries or replacement'}),{flag:'wx'});throw error;}
 finally{if(healthy)await release();}
}
