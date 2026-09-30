import {diagnoseWorkspace, diagnoseWorkspaceEntry} from '@kev-browser-agent-kit/workspace';
import {WorkspaceController} from '@kev-browser-agent-kit/workspace/react';
import {installSource} from '@kev-browser-agent-kit/workspace/delivery';
import {loadPrepared, preparedApps, installOpenCodeConfig, startOpenCode,openCodeCandidateLaunch} from '@kev-browser-agent-kit/opencode-chat/browser';
import {previewHTTPThenAttach} from './matched-qualification';
import {assertZeroWork, assertSingleKernelDiagnostics, fsProbe, streamProbe, childSyncProbe,binaryCaptureBoundariesProbe,fetchedBodyProbe,connectionApiURL} from './single-kernel-contract';
import {minimalChildProbe,minimalSpawnProbe,spawnProbeFixture,type SpawnProbeMode} from './single-kernel-spawn-probes';

const policy={stageMs:120000,requestMs:20000,generations:5,retries:0};
const evidence: any={policy,status:'idle',stages:[],events:[],models:0};
evidence.browserEvents=[];
window.addEventListener('unhandledrejection',event=>{evidence.browserEvents.push({type:'unhandledrejection',reason:String(event.reason).slice(0,4096)});});
window.addEventListener('error',event=>{evidence.browserEvents.push({type:'error',message:event.message.slice(0,4096),source:event.filename,line:event.lineno,column:event.colno});});
let owner=new WorkspaceController({onDiagnostic:event=>evidence.events.push(event),captureProcessOutput:true});
let active=false, failed=false;
const attempted=new Set<string>();
const assert=(condition:unknown,message:string)=>{if(!condition)throw Error(message);};
const decoder=new TextDecoder();
const distribution=await fetch('/runtime/distribution.json').then(r=>r.json());
const delivery={name:'vivari',version:distribution.version,assetBaseUrl:'/runtime/'};
function render(){document.querySelector('pre')!.textContent=JSON.stringify(evidence,null,2);}
async function stage(name:string,task:()=>Promise<unknown>,ms=policy.stageMs){
  if(active||failed||attempted.has(name))throw Error('Acceptance owner busy, terminally failed, or stage already attempted');
  attempted.add(name);
  active=true; evidence.status=name;render();
  let timer: ReturnType<typeof setTimeout>;
  try {
    const result=await Promise.race([task(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(name+' '+ms+'ms deadline; owned work retained, no retry')),ms);})]);
    evidence.stages.push({name,result});evidence.status='ready';render();return result;
  }catch(error){failed=true;evidence.status='failed';evidence.error=String(error);render();throw error;}
  finally{active=false;clearTimeout(timer!);}
}
async function diagnostics(){const d=await diagnoseWorkspace(owner.workspace!);assertSingleKernelDiagnostics(d);return d;}
async function zero(){const d=await diagnostics();assertZeroWork(d);return d;}
async function capture(stream:AsyncIterable<Uint8Array>,label='unlabelled'){
  const chunks:Uint8Array[]=[];let size=0;const channelDecoder=new TextDecoder();
  const channels=evidence.guestChannels??={};const channel=channels[label]??={bytes:0,text:'',truncated:false};
  for await(const chunk of stream){size+=chunk.length;assert(size<1048576,'Probe output exceeded bound');chunks.push(chunk);
    channel.bytes+=chunk.length;const text=channel.text+channelDecoder.decode(chunk,{stream:true});channel.truncated||=text.length>65536;channel.text=text.slice(-65536);
  }
  channel.text=(channel.text+channelDecoder.decode()).slice(-65536);return chunks.map(b=>decoder.decode(b)).join('');
}
async function open(){
  assert(distribution.topology?.policy==='single-kernel','Not a single-kernel distribution');
  const workspace=await owner.open(delivery);assert(workspace.persistence.status==='durable','Persistence not durable');
   await owner.startRuntime({});
   return {version:distribution.version,revision:distribution.runtimeBuild.source.commit,diagnostics:await diagnostics()};
}
async function initialize(){
  const workspace=owner.workspace!;
  await workspace.fs.writeFile('/fs-probe.mjs',fsProbe);
  const execution=await owner.runtime!.node({entry:'/workspace/fs-probe.mjs',cwd:'/workspace'});
  // Attach both drains before awaiting exit; no stdout-only await deadlock.
  const out=capture(execution.stdout,'filesystem.stdout'),err=capture(execution.stderr,'filesystem.stderr');execution.closeStdin();
  const [stdout,stderr,exit]=await Promise.all([out,err,execution.exited]);
  assert(exit.exitCode===0&&!exit.forced,'Sync FS probe failed: '+stderr);
  const sync=JSON.parse(stdout.trim());assert(sync.syncFS===true,'Sync FS completion absent');
  const large=await workspace.fs.readFile('/large-binary.dat');assert(large.length===1048583,'Large host read truncated');
  for(let i=0;i<large.length;i++)assert(large[i]===i%251,'Large host read byte corruption');
  assert(JSON.stringify((await workspace.fs.readdir('/kernel-contract')).sort())===JSON.stringify(sync.names),'Host newline readdir');
  const link=await diagnoseWorkspaceEntry(workspace,'/kernel-contract/link');assert(link.target==='renamed\nentry.txt','Host link metadata');
  await workspace.fs.rename('/kernel-contract/renamed\nentry.txt','/kernel-contract/host-renamed\nentry.txt');
  assert((await workspace.fs.stat('/kernel-contract/host-renamed\nentry.txt')).size===5,'Host rename/stat');
  await workspace.fs.writeFile('/persist-marker.txt','single-kernel durable marker');await workspace.flush();
  return {sync,link,diagnostics:await diagnostics()};
}
async function streaming(){
  await owner.workspace!.fs.writeFile('/stream-probe.mjs',streamProbe);
  const service=await owner.launch('stream',{entry:'/workspace/stream-probe.mjs',cwd:'/workspace'},5189,async endpoint=>{
    const response=await endpoint.fetch('/health',{signal:AbortSignal.timeout(policy.requestMs)});assert(response.ok&&await response.text()==='healthy','Stream health');
    return {url:endpoint.url,fetch:(input,init)=>endpoint.fetch(String(input),init)};
  },{shutdown:'stdin-eof',timeoutMs:10000});
  const response=await service.endpoint.fetch('/stream',{signal:AbortSignal.timeout(60000)});
  assert(response.ok&&response.body,'Stream response absent');
  await new Promise(resolve=>setTimeout(resolve,750));
  const stalled=JSON.parse(decoder.decode(await owner.workspace!.fs.readFile('/stream-progress.json')));
  assert(stalled.produced>0&&stalled.produced<256,'Producer did not stall with unread body');
  const reader=response.body!.getReader();let bytes=0;
  while(true){const next=await reader.read();if(next.done)break;for(let i=0;i<next.value.length;i++)assert(next.value[i]===Math.floor((bytes+i)/65536)%251,'Stream byte corruption');bytes+=next.value.length;}
  assert(bytes===256*65536,'Stream truncated');
  const completed=JSON.parse(decoder.decode(await owner.workspace!.fs.readFile('/stream-progress.json')));
  assert(completed.produced===256&&completed.drains>0,'Producer completion/drain missing');
  const cancel=await service.endpoint.fetch('/stream',{signal:AbortSignal.timeout(policy.requestMs)});
  assert(cancel.body,'Cancellation response absent');await cancel.body!.cancel('single-kernel acceptance cancel');
  await owner.workspace!.fs.writeFile('/host-during-http.txt','host remains responsive');
  const health=await service.endpoint.fetch('/health',{signal:AbortSignal.timeout(policy.requestMs)});
  assert(await health.text()==='healthy','Handler sync FS after HTTP cancellation');
  await owner.stopServices();await service.drained;const exit=await service.execution.exited;
  assert(exit.exitCode===0&&!exit.forced,'Stream shutdown not graceful');
  assert(decoder.decode(await owner.workspace!.fs.readFile('/shutdown-sync.txt'))==='shutdown','Shutdown sync FS missing');
  let staleRejected=false;try{const stale=await service.endpoint.fetch('/health',{signal:AbortSignal.timeout(policy.requestMs)});await stale.arrayBuffer();}catch{staleRejected=true;}
  assert(staleRejected,'Disposed endpoint accepted stale request');
  return {stalled,completed,bytes,exit,canceled:true,staleRejected,zero:await zero()};
}
async function childSync(){
  await owner.workspace!.fs.writeFile('/parent-sync.cjs',childSyncProbe);
  const execution=await owner.runtime!.node({entry:'/workspace/parent-sync.cjs',cwd:'/workspace'});
  const out=capture(execution.stdout,'child-sync.stdout'),err=capture(execution.stderr,'child-sync.stderr');execution.closeStdin();
  const [stdout,stderr,exit]=await Promise.all([out,err,execution.exited]);
  assert(exit.exitCode===0&&!exit.forced,'execSync child failed: '+stderr);
  const result=JSON.parse(stdout.trim());assert(result.execSync&&result.bytes===1048583,'execSync completion');
  const binary=await owner.workspace!.fs.readFile('/child-sync/link');assert(binary.length===1048583,'Child host readback length');
  for(let i=0;i<binary.length;i++)assert(binary[i]===i%251,'Child host byte corruption');
  return {...result,diagnostics:await zero()};
}
async function captureBoundaries(){
  await owner.workspace!.fs.writeFile('/capture-boundaries.cjs',binaryCaptureBoundariesProbe);
  const execution=await owner.runtime!.node({entry:'/workspace/capture-boundaries.cjs',cwd:'/workspace'});
  const out=capture(execution.stdout,'capture-boundaries.stdout'),err=capture(execution.stderr,'capture-boundaries.stderr');execution.closeStdin();
  const [stdout,stderr,exit]=await Promise.all([out,err,execution.exited]);
  assert(exit.exitCode===0&&exit.signal===null&&!exit.forced,'Binary capture boundaries failed: '+stderr);
  const result=JSON.parse(stdout.trim());assert(result.binaryCapture&&result.bothStreams===1048583&&result.execErrors===2,'Binary capture completion');
  return {...result,exit,diagnostics:await zero()};
}
async function minimalSpawn(mode:SpawnProbeMode){
  const workspace=owner.workspace!;
  await workspace.fs.writeFile('/spawn-existing.txt',spawnProbeFixture);
  await workspace.fs.writeFile('/minimal-spawn-child.cjs',minimalChildProbe);
  try{await workspace.fs.stat('/spawn-child-complete.txt');await workspace.fs.remove('/spawn-child-complete.txt');}catch(error){if(!String(error).includes('ENOENT'))throw error;}
  await workspace.fs.writeFile('/minimal-spawn-parent.cjs',minimalSpawnProbe(mode));
  const execution=await owner.runtime!.node({entry:'/workspace/minimal-spawn-parent.cjs',cwd:'/workspace'});
  const out=capture(execution.stdout,'minimal-'+mode+'.stdout'),err=capture(execution.stderr,'minimal-'+mode+'.stderr');execution.closeStdin();
  const [stdout,stderr,exit]=await Promise.all([out,err,execution.exited]);
  assert(exit.exitCode===0&&exit.signal===null&&!exit.forced,'Minimal '+mode+' failed: '+stderr);
  assert(stdout==='PARENT_BEFORE_'+mode+'\nPARENT_AFTER_'+mode+'\n','Minimal '+mode+' completion markers');
  assert(decoder.decode(await workspace.fs.readFile('/spawn-child-complete.txt'))==='read-completed','Minimal child completion file');
  return {mode,stdout,stderr,exit,diagnostics:await zero()};
}
async function fetchedBody(){
  await owner.workspace!.fs.writeFile('/fetched-body.mjs',fetchedBodyProbe(location.origin));
  const execution=await owner.runtime!.node({entry:'/workspace/fetched-body.mjs',cwd:'/workspace'});
  let readyResolve!:(value:any)=>void;const ready=new Promise<any>(resolve=>{readyResolve=resolve;});
  let stdout='';const out=(async()=>{for await(const bytes of execution.stdout){stdout+=decoder.decode(bytes);assert(stdout.length<65536,'Fetched probe output bound');const line=stdout.split('\n').find(line=>line.includes('evicted-pinned'));if(line)readyResolve(JSON.parse(line));}return stdout;})();
  const err=capture(execution.stderr,'fetched-body.stderr');
  const earlyExit=execution.exited.then(exit=>{throw Error('Fetched body guest exited before handoff: '+JSON.stringify(exit));});void earlyExit.catch(()=>{});
  const handoff=await Promise.race([ready,earlyExit]);const pinned=await diagnostics();
  assert(pinned.fetch.pinnedBodies===1&&pinned.fetch.cachedBytes===16*1024*1024,'Evicted held-body pin/cache checkpoint');
  execution.writeStdin(new TextEncoder().encode('read held body'));execution.closeStdin();
  const [text,stderr,exit]=await Promise.all([out,err,execution.exited]);assert(exit.exitCode===0&&!exit.forced,'Fetched body guest failed: '+stderr);
  const complete=JSON.parse(text.trim().split('\n').at(-1)!);assert(complete.phase==='reclaimed'&&complete.absent&&complete.bytes===1048583,'Fetched fallback/reclaim completion');
  const final=await zero();assert(final.fetch.pinnedBodies===0,'Fetched pin retained after close/exit');
  return {handoff,pinned,complete,diagnostics:final};
}
async function watches(){
  const events:{paths:string[]}[]=[];
  const unwatch=owner.workspace!.fs.watch(event=>events.push(event));
  try{
    await Promise.all(Array.from({length:8},(_,i)=>owner.workspace!.fs.writeFile('/concurrent-'+i+'.txt','final-'+i)));
    await owner.workspace!.flush();
    await owner.workspace!.fs.rename('/concurrent-0.txt','/concurrent-renamed.txt');
    await owner.workspace!.fs.remove('/concurrent-1.txt');await owner.workspace!.flush();
    const deadline=Date.now()+10000;
    while(!events.some(event=>event.paths.includes('/concurrent-renamed.txt'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
    assert(events.some(event=>event.paths.includes('/concurrent-renamed.txt')),'Host filesystem watch rename delivery missing');
    assert(decoder.decode(await owner.workspace!.fs.readFile('/concurrent-renamed.txt'))==='final-0','Concurrent write/rename final bytes');
    return {events,diagnostics:await zero()};
  }finally{unwatch();}
}
async function recreate(){
  await owner.stopRuntime();await zero();await owner.close();
  owner=new WorkspaceController({onDiagnostic:event=>evidence.events.push(event),captureProcessOutput:true});
  const workspace=await owner.open(delivery);
  assert(decoder.decode(await workspace.fs.readFile('/persist-marker.txt'))==='single-kernel durable marker','Recreate persistence');
  assert((await workspace.fs.stat('/kernel-contract/host-renamed\nentry.txt')).size===5,'Recreate filesystem');
  assert(decoder.decode(await workspace.fs.readFile('/concurrent-renamed.txt'))==='final-0','Concurrent flush persistence');
  for(let i=2;i<8;i++)assert(decoder.decode(await workspace.fs.readFile('/concurrent-'+i+'.txt'))==='final-'+i,'Concurrent persisted bytes');
  let deleted=false;try{await workspace.fs.readFile('/concurrent-1.txt');}catch{deleted=true;}assert(deleted,'Deleted concurrent file restored');
  return {persistence:workspace.persistence,diagnostics:await zero()};
}
let generation=0;
let sourceHome='';
let manifest: Awaited<ReturnType<typeof loadPrepared>>;
async function apps(){
  assert(generation<policy.generations,'Fixed generation budget exhausted');
  const services=Object.values(owner.getSnapshot().services);
  await owner.stopRuntime();await Promise.all(services.map(async service=>{await service.drained;await service.execution.exited;}));await zero();
  manifest??=await loadPrepared('/prepared/',owner.signal);assert(manifest.runtimeVersion===delivery.version,'Prepared runtime identity');
  const next=generation+1,marker=next%2?'A':'B';
  const home=manifest.project['/src/home.tsx'];assert(typeof home==='string','Todo fixture absent');
  const source={...manifest.project,
    '/src/home.tsx':(home as string).replace('import { useState }','import { useEffect, useState }').replace('export default function Home() {',`export default function Home() { useEffect(()=>{document.querySelector('main')?.setAttribute('data-hydrated','${next}');},[]);`).replace('<h1>Todos</h1>',`<h1 data-generation="${next}" data-workspace={workspace}>Todos ${marker}</h1><button id="pdf-workload" type="button" onClick={async e=>{const b=e.currentTarget;b.dataset.bytes=String(await runPdfWorkload());}}>Generate fixture PDF</button>`).replace("import { useEffect, useState }", "import {workspace} from './switch-import';\nimport {runPdfWorkload} from './pdf-workload';\nimport { useEffect, useState }"),
    '/src/switch-import.ts':`export {workspace} from '../switch-${marker.toLowerCase()}-only';`,
    ['/switch-'+marker.toLowerCase()+'-only.ts']:`export const workspace='${marker}';`,
    '/src/pdf-workload.ts':`import {PDFDocument} from 'pdf-lib';export async function runPdfWorkload(){const pdf=await PDFDocument.create();pdf.addPage().drawText('Fresh ${marker}/${next}');return(await pdf.save()).length;}`};
  if(generation)await owner.workspace!.fs.remove('/switch-'+(marker==='A'?'b':'a')+'-only.ts');
  await installSource(owner.workspace!,source,{existing:'replace'});
  sourceHome=source['/src/home.tsx'];
  const runtime=await owner.startRuntime({apps:preparedApps(manifest,'/prepared/',owner.signal,text=>evidence.events.push({delivery:text}))});await runtime.tools.apps();
  await installOpenCodeConfig(owner.workspace!,{modelBaseURL:location.origin+'/unused-model/'});
  // Readiness and cleanup ownership come from the qualified controller. Serial
  // launch avoids speculative competing starts during this correctness suite.
  const preview=await owner.launch('vite',manifest.preview,5173,async endpoint=>({url:endpoint.url,fetch:(input,init)=>endpoint.fetch(String(input),init)}));
  await previewHTTPThenAttach(owner.signal,()=>preview.endpoint.fetch('/',{signal:AbortSignal.timeout(policy.requestMs)}),()=>{
    const attachment=preview.endpoint.attachPreview(document.querySelector('iframe')!,{hostPaths:['/api','/editing-policy']});owner.registerAttachment('vite',()=>attachment.dispose());
  });
  const chat=await startOpenCode(owner,{prepared:manifest,waitForClient:false});
  await owner.workspace!.flush();generation=next;
  return {generation,marker,previewURL:preview.endpoint.url,chatURL:chat.endpoint.url,diagnostics:await diagnostics(),interactive:'pending external Playwright hydration/todo/PDF verification'};
}
async function hmr(){
  assert(generation===1&&sourceHome,'HMR requires the first live preview');
  const updated=sourceHome.replace('<h1 data-generation=', '<h1 data-hmr="single-kernel-fresh-hmr" data-generation=');
  assert(updated!==sourceHome,'HMR fixture replacement absent');
  await owner.workspace!.fs.writeFile('/src/home.tsx',updated);await owner.workspace!.flush();
  return {generation,expected:'single-kernel-fresh-hmr',diagnostics:await diagnostics(),interactive:'pending same-document HMR verification'};
}
async function sse(){
  const service=owner.getSnapshot().services.chat;assert(service,'OpenCode service absent');
  const abort=new AbortController();
  const response=await service.connection.fetch(connectionApiURL(service.connection.url,'/api/event'),{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(policy.requestMs)])});
  assert(response.ok&&response.headers.get('content-type')?.includes('text/event-stream')&&response.body,'OpenCode event stream headers');
  const reader=response.body!.getReader();let text='';
  while(!text.includes('server.connected')){const next=await reader.read();assert(!next.done,'Event stream ended before handshake');text+=decoder.decode(next.value);assert(text.length<65536,'Handshake exceeded bound');}
  abort.abort('single-kernel SSE abort');
  try{await reader.read();}catch{}finally{try{await reader.cancel();}catch{}reader.releaseLock();}
  const deadline=Date.now()+policy.requestMs;let state=await diagnostics();
  while(state.pendingHttp!==0&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,25));state=await diagnostics();}
  assert(state.pendingHttp===0,'OpenCode event cancellation left pending HTTP');
  const health=await service.connection.fetch(connectionApiURL(service.connection.url,openCodeCandidateLaunch.healthPath),{signal:AbortSignal.timeout(policy.requestMs)});
  assert(health.ok&&(await health.json()).healthy,'OpenCode health after SSE abort');
  return {handshake:true,aborted:true,diagnostics:state};
}
const api={evidence,diagnostics,get generation(){return generation;},open:()=>stage('open',open),captureBoundaries:()=>stage('binary-capture-boundaries',captureBoundaries,60000),initialize:()=>stage('filesystem',initialize),fetchedBody:()=>stage('fetched-body-evicted-pin',fetchedBody),childSync:()=>stage('child-sync',childSync,20000),watches:()=>stage('concurrent-watch-flush',watches),streaming:()=>stage('http-backpressure',streaming),recreate:()=>stage('persistence-recreate',recreate),apps:()=>stage('apps-'+(generation+1),apps),hmr:()=>stage('hmr',hmr),sse:()=>stage('opencode-sse-abort',sse),
  minimalAsyncSpawn:()=>stage('minimal-async-spawn',()=>minimalSpawn('async')),
  minimalSpawnSync:()=>stage('minimal-spawnSync',()=>minimalSpawn('spawnSync')),
  minimalExecSync:()=>stage('minimal-execSync',()=>minimalSpawn('execSync')),
  // Never automatic: the parent must authorize retirement after preserving the
  // natural failure. This is cleanup, not a replay or an acceptance pass.
  async retireFailure(authorization:string){
    if(authorization!=='after-evidence-and-parent-repair-authorization'||!failed||active||evidence.retirement)throw Error('Failure retirement not authorized/available');
    active=true;evidence.retirement={status:'pending'};
    try{await owner.stopRuntime();const stopped=await zero();await owner.close();evidence.retirement={status:'completed',stopped};render();return evidence.retirement;}
    catch(error){evidence.retirement={status:'failed',error:String(error)};render();throw error;}
    finally{active=false;}
  },
  reloadCheck:()=>stage('persistence-reload',async()=>{await owner.open(delivery);assert(decoder.decode(await owner.workspace!.fs.readFile('/persist-marker.txt'))==='single-kernel durable marker','Reload persistence');return zero();}),
  close:()=>stage('shutdown',async()=>{await owner.stopRuntime();const stopped=await zero();await owner.close();return stopped;})};
(window as any).singleKernelAcceptance=api;render();
