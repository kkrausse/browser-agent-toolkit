import {diagnoseWorkspace} from '@kev-browser-agent-kit/workspace';
import {WorkspaceController} from '@kev-browser-agent-kit/workspace/react';
import {installOpenCodeConfig, loadPrepared, preparedApps, createOpenCodeCandidateLaunch, openCodeCandidateLaunch as descriptor} from '@kev-browser-agent-kit/opencode-chat/browser';
import {createChatController} from '../../../opencode-chat/src/controller';
import type {ChatController} from '../../../opencode-chat/src/types';
import {createPilotFence, pilotRequestURL} from './reuse-pilot-fence';
import {assertPilotRoot} from './reuse-pilot-contract';

// Frozen restricted experiment: unchanged controller/runtime; no extra rearms.
const policy=Object.freeze({transitions:5,order:['restart','reuse'],transitionMs:150000,coldMs:150000,requestMs:20000,drainMs:20000,cleanupMs:15000,observationMs:300000,retries:0,replacements:0,extensions:0,rearms:0});
const condition=new URL(location.href).searchParams.get('condition');
if(condition!=='restart'&&condition!=='reuse')throw Error('Explicit condition required');
const evidence:any={label:'matched-mounted-controller-lifecycle',condition,policy,status:'preparing',events:[],requests:[],samples:[],generations:[],transitions:[],attempts:{cold:0,transition:0}};
const owner=new WorkspaceController({onDiagnostic:event=>evidence.events.push(event),captureProcessOutput:true});
let chat:ChatController|undefined,stopped=false;
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const render=()=>{document.querySelector('pre')!.textContent=JSON.stringify({status:evidence.status,condition,attempts:evidence.attempts,samples:evidence.samples,error:evidence.error},null,2);};
async function timed<T>(name:string,generation:number,task:()=>Promise<T>){const started=performance.now();try{return await task();}finally{const finished=performance.now();evidence.samples.push({name,generation,started,finished,ms:finished-started});render();}}
async function bounded<T>(task:()=>Promise<T>,ms:number){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([task(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{stopped=true;reject(Error('Frozen deadline '+ms));},ms);})]);}finally{clearTimeout(timer!);}}
async function run(){
 const watchdog=setTimeout(()=>{stopped=true;evidence.status='failed';evidence.error='300000ms observation deadline; unresolved work retained';render();},policy.observationMs);
 try{
  const manifest=await loadPrepared('/prepared/baseline/',owner.signal);
  const workspace=await owner.open({name:'vivari',version:manifest.runtimeVersion,assetBaseUrl:'/runtime/'});
  const runtime=await owner.startRuntime({apps:preparedApps(manifest,'/prepared/baseline/',owner.signal,text=>evidence.events.push({delivery:text}))});
  await timed('environment.deliver',0,()=>runtime.tools.apps());
  await installOpenCodeConfig(workspace,{modelBaseURL:'http://127.0.0.1:9/unused-model/'});
  const original=JSON.parse(new TextDecoder().decode(await workspace.fs.readFile(descriptor.workspaceConfigPath)));
  const pluginPaths=['/.server/config/opencode/plugins/editor-model-headers.js','/.server/config/opencode/plugins/editor-javascript.js'];
  const plugins=JSON.stringify(await Promise.all(pluginPaths.map(p=>workspace.fs.readFile(p).then(b=>Array.from(b)))));
  evidence.identity={runtime:manifest.runtimeVersion,dependencies:manifest.dependencies,config:original,plugins,location:'/workspace',cwd:'/app',exclusive:true};
  const marker=(n:number)=>(n%2?'B':'A')+n;
  const write=async(n:number)=>{assert(!stopped,'Stopped before source write');await workspace.fs.writeFile('/pilot-source.txt',marker(n));assert(!stopped,'Stopped before config write');await workspace.fs.writeFile(descriptor.workspaceConfigPath,JSON.stringify({...original,username:'matched-pilot-'+marker(n)}));await workspace.flush();};
  await write(0);
  const password=crypto.randomUUID()+crypto.randomUUID(),authorization='Basic '+btoa('opencode:'+password);
  const query=new URLSearchParams({'location[directory]':'/workspace'}).toString();
  let endpoint:any,service:any,fence:ReturnType<typeof createPilotFence>;
  const transport=async(input:string,init:RequestInit={})=>{assert(!stopped,'Pilot stopped');const headers=new Headers(init.headers);headers.set('authorization',authorization);return endpoint.fetch(input,{...init,headers});};
  const makeFence=(generation:number,admin=false)=>{const f=createPilotFence(transport,admin,endpoint.url,true);evidence.requests.push({generation,admin,records:f.records});return f;};
  const json=async(f:ReturnType<typeof createPilotFence>,path:string,method='GET')=>(await f.fetch(pilotRequestURL(endpoint.url,path),{method,signal:AbortSignal.timeout(policy.requestMs)})).json();
  const qualify=async(n:number)=>{
   const row:any={generation:n,marker:marker(n)};evidence.generations.push(row);
   row.health=await timed('qualification.health',n,()=>json(fence,descriptor.healthPath));assert(row.health.healthy&&row.health.version==='2.0.3','Pinned health');
   await timed('qualification.activation',n,()=>fence.fetch(pilotRequestURL(endpoint.url,descriptor.activation.path),{method:'POST',signal:AbortSignal.timeout(policy.requestMs)}));
   row.plugins=await timed('qualification.plugins',n,()=>json(fence,descriptor.pluginPath));for(const id of ['editor.model-headers','editor.javascript'])assert(row.plugins.data.some((p:any)=>p.id===id&&p.state?.status==='active'),'Active '+id);
   const configs=await timed('qualification.config',n,()=>json(fence,descriptor.configAPIPath));row.config=configs.find((c:any)=>c.type==='document'&&c.path===descriptor.configPath)?.info;assert(row.config?.username==='matched-pilot-'+marker(n),'Config marker');
   row.project=await timed('qualification.project',n,()=>json(fence,'/api/project/current?'+query));
   const models=await timed('qualification.catalog',n,()=>json(fence,descriptor.modelPath));assert(models.data.some((m:any)=>m.id===descriptor.model.id&&m.enabled),'Catalog only');
  };
  const ready=async(n:number)=>timed('controller.ready',n,async()=>{chat=createChatController({endpoint:{url:endpoint.url,fetch:fence.fetch},directory:'/workspace',startNewSession:true,handshakeTimeoutMs:policy.requestMs});await chat.ready;});
  const prove=async(n:number)=>timed('proof',n,async()=>{
   const row=evidence.generations[n],snapshot=chat!.getSnapshot();assert(!snapshot.error&&!snapshot.loading&&snapshot.sessionID&&snapshot.messages.length===0,'Fresh hydrated session');
   row.snapshot=snapshot;row.sessionEnvelope=await json(fence,'/api/session/'+snapshot.sessionID);row.session=assertPilotRoot(row.sessionEnvelope,snapshot.sessionID!);
   assert(row.session.projectID===row.project.id&&snapshot.execution==='idle'&&snapshot.permissions.length===0&&snapshot.questions.length===0,'Idle empty root');
   assert(new TextDecoder().decode(await workspace.fs.readFile('/pilot-source.txt'))===marker(n),'Source marker');
   assert(JSON.stringify(await Promise.all(pluginPaths.map(p=>workspace.fs.readFile(p).then(b=>Array.from(b)))))===plugins,'Immutable plugins');
   row.diagnostics=await diagnoseWorkspace(workspace);assert(row.diagnostics.procs.length===1&&row.diagnostics.listeners.length===1&&row.diagnostics.listeners[0]===4096,'Exclusive service');
   if(n){const old=evidence.generations[n-1];assert(old.session.id!==row.session.id,'Distinct sessions');assert(JSON.stringify(old.project)===JSON.stringify(row.project),'Same project');assert(condition==='reuse'?old.health.pid===row.health.pid:old.health.pid!==row.health.pid,'Condition PID identity');
    const listed=fence.records.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/api/session'));
    const ids=listed.flatMap(r=>JSON.parse(atob(r.wire!.bodyBase64)).data.map((s:any)=>s.id));for(const previous of evidence.generations.slice(0,n))assert(ids.includes(previous.session.id),'Persisted old session '+previous.generation);
   }
  });
  const launch=async(n:number)=>timed('service.launch',n,async()=>{service=await owner.launch('chat',createOpenCodeCandidateLaunch({password,ripgrepBinDirectory:manifest.opencode.support.binDirectory}),descriptor.port,async exposed=>{endpoint=exposed;fence=makeFence(n);await qualify(n);return {url:exposed.url,fetch:fence.fetch};},{shutdown:'stdin-eof',timeoutMs:10000},{listenMs:60000,connectMs:90000,overallMs:150000});});
  evidence.attempts.cold++;evidence.status='cold';render();
  await timed('cold.to-ready',0,()=>bounded(async()=>{await launch(0);await ready(0);},policy.coldMs));await prove(0);
  for(let n=1;n<=policy.transitions;n++){
   assert(!stopped,'Stopped before transition');evidence.attempts.transition++;evidence.status='transition-'+n;render();
   await timed('transition.to-ready',n,()=>bounded(async()=>{
    fence!.freeze();await timed('outgoing.join',n,()=>fence!.drain(policy.drainMs));
    await timed('outgoing.dispose',n,()=>chat!.dispose());
    const admission={generation:n,normalFinite:fence!.records.filter(r=>r.state==='normal').length,unresolved:fence!.records.filter(r=>r.state==='pending'||r.state==='failed').length,localDisposed:true,zeroRefs:'inferred from exclusive normally consumed finite handlers; not remote receipt'};evidence.transitions.push(admission);assert(!admission.unresolved,'No unresolved old calls');
    if(condition==='restart')await timed('outgoing.stop-drain',n,async()=>{await owner.stopServices();await service.drained;const exit=await service.execution.exited;assert(exit.exitCode===0&&!exit.forced,'Healthy restart shutdown');const zero=await diagnoseWorkspace(workspace);assert(!zero.procs.length&&!zero.listeners.length&&!zero.pendingHttp,'Restart zero work');evidence.transitions[n-1].exit=exit;});
    else await timed('outgoing.DELETE',n,async()=>{const admin=makeFence(n,true);await admin.fetch(pilotRequestURL(endpoint.url,'/api/debug/location?'+query),{method:'DELETE',signal:AbortSignal.timeout(policy.requestMs)});admin.freeze();await admin.drain(policy.drainMs);});
    await timed('source-config.write',n,()=>write(n));
    if(condition==='restart')await launch(n);else{fence=makeFence(n);await timed('reuse.qualify',n,()=>qualify(n));}
    await ready(n);
   },policy.transitionMs));
   await prove(n);
  }
  await timed('cleanup',6,()=>bounded(async()=>{fence!.freeze();await fence!.drain(policy.drainMs);await chat!.dispose();await owner.stopServices();await service.drained;evidence.exit=await service.execution.exited;evidence.zero=await diagnoseWorkspace(workspace);assert(!evidence.zero.procs.length&&!evidence.zero.listeners.length&&!evidence.zero.pendingHttp,'Final zero work');await owner.close();},policy.cleanupMs));
  assert(!stopped,'Stopped before completion');evidence.status='passed';
 }catch(error){stopped=true;evidence.status='failed';evidence.error=String(error);evidence.stack=error instanceof Error?error.stack:undefined;/* STOP: no retry/eviction/replacement/cleanup after failure. */}
 clearTimeout(watchdog);render();return evidence;
}
(window as any).matchedPilot={evidence,done:run()};
