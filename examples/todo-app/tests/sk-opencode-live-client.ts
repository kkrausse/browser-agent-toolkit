import {diagnoseWorkspace} from '@kev-browser-agent-kit/workspace';
import {WorkspaceController} from '@kev-browser-agent-kit/workspace/react';
import {loadPrepared,preparedApps,installOpenCodeConfig,createOpenCodeCandidateLaunch,openCodeCandidateLaunch as descriptor} from '@kev-browser-agent-kit/opencode-chat/browser';
import {createChatController} from 'sk-opencode-qualified-controller';

// Deliberate actual-controller UI: read-only snapshot, no ChatView send/tool actions.
// All writes are initial preparation of this NEW owned origin, before server launch.
const evidence:any={status:'awaiting-start',retentionAccepted:false,remoteZeroRef:false,requests:[],events:[],attempts:0};
const owner=new WorkspaceController({captureProcessOutput:true,onDiagnostic:event=>evidence.events.push(event)});
const sha=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)),b=>b.toString(16).padStart(2,'0')).join('');
const base64=(bytes:Uint8Array)=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);};
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
let admitted=false,closed=false,poison:unknown,creates=0;
const pending=new Set<Promise<unknown>>();
const status=document.querySelector('#status')!,sessionText=document.querySelector('#session')!,snapshotText=document.querySelector('#snapshot')!;
const start=document.querySelector<HTMLButtonElement>('#start')!,admit=document.querySelector<HTMLButtonElement>('#admit')!;
let acceptUI:()=>void;
const uiAdmission=new Promise<void>(resolve=>{acceptUI=resolve;});
admit.onclick=()=>{if(evidence.status!=='mounted-awaiting-ui-admission'||admitted)return;admitted=true;admit.disabled=true;acceptUI();};
const display=()=>{status.textContent=evidence.status;};
async function run(){
 if(evidence.attempts++)throw Error('One-shot owner already used');
 start.disabled=true;
 const watchdog=setTimeout(()=>{poison??=Error('Qualification deadline; unresolved ownership retained');evidence.status='failed';evidence.error=String(poison);display();},180000);
 try{
  const freshRoot=await navigator.storage.getDirectory();
  for await(const key of (freshRoot as any).keys())throw Error('Origin already contains OPFS '+key);
  assert((await indexedDB.databases()).length===0&&(await caches.keys()).length===0&&(await navigator.serviceWorker.getRegistrations()).length===0&&localStorage.length===0,'Fresh native origin storage required');
  evidence.freshOrigin={url:location.origin,opfsEmpty:true,indexedDBEmpty:true,cachesEmpty:true,serviceWorkersEmpty:true,localStorageEmpty:true};
  const stage=await (await fetch('/stage')).json();evidence.stage=stage;
  assert(stage.sourceRevision&&stage.runtimeVersion&&stage.serverSha256,'Served stage identity missing');
  const servedClient=new Uint8Array(await (await fetch('/client/sk-opencode-live-client.js')).arrayBuffer());
  assert(await sha(servedClient)===stage.clientSha256,'Served committed-source client hash mismatch');
  evidence.servedClientSha256=await sha(servedClient);
  const manifest=await loadPrepared('/prepared/',owner.signal);
  assert(manifest.runtimeVersion===stage.runtimeVersion,'Runtime/payload mismatch');
  const workspace=await owner.open({name:'vivari',version:stage.runtimeVersion,assetBaseUrl:'/runtime/'});
  const runtime=await owner.startRuntime({apps:preparedApps(manifest,'/prepared/',owner.signal,delivery=>evidence.events.push({delivery}))});
  await runtime.tools.apps();
  await installOpenCodeConfig(workspace,{modelBaseURL:location.origin+'/prohibited-model/'});
  const marker='sk-mounted-A0-'+crypto.randomUUID();
  await workspace.fs.writeFile('/sk-qualification-source.txt',marker);await workspace.flush();
  const files=['/sk-qualification-source.txt',descriptor.workspaceConfigPath,'/.server/config/opencode/plugins/editor-model-headers.js','/.server/config/opencode/plugins/editor-javascript.js'];
  const fileIdentity=async()=>Object.fromEntries(await Promise.all(files.map(async path=>[path,await sha(await workspace.fs.readFile(path))])));
  const initialFiles=await fileIdentity();
  const password=crypto.randomUUID()+crypto.randomUUID(),authorization='Basic '+btoa('opencode:'+password);
  const launch=createOpenCodeCandidateLaunch({password,ripgrepBinDirectory:manifest.opencode.support.binDirectory});
  const {OPENCODE_PASSWORD:_,...publicEnvironment}=launch.env!;
  evidence.identity={files:initialFiles,sourceMarker:marker,sourceRevision:stage.sourceRevision,runtimeRevision:stage.runtimeRevision,runtimeVersion:manifest.runtimeVersion,serverSha256:stage.serverSha256,dependencies:manifest.dependencies,opencode:manifest.opencode,cwd:launch.cwd,environment:publicEnvironment,ownerID:crypto.randomUUID(),directory:'/workspace',workspaceID:'<absent>',launches:1};
  let endpoint:any,healthPID:number|undefined;
  const requestURL=(path:string)=>{const u=new URL(path.replace(/^\//,''),endpoint.url);for(const [k,v] of new URL(endpoint.url).searchParams)u.searchParams.set(k,v);u.searchParams.set('location[directory]','/workspace');return u.href;};
  const transport=(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
   if(closed||poison)return Promise.reject(Error('Qualification admissions closed'));
   const request=new Request(input,init),url=new URL(request.url),base=new URL(endpoint.url),prefix=base.pathname.endsWith('/')?base.pathname:base.pathname+'/';
   const path='/'+url.pathname.slice(prefix.length),sse=path==='/api/event'&&request.method==='GET';
   const allowed=request.method==='GET'&&(['/api/health','/api/config','/api/project/current','/api/plugin','/api/model','/api/model/default','/api/session','/api/session/active'].includes(path)||/^\/api\/session\/[A-Za-z0-9_-]+(?:\/(message|permission|form))?$/.test(path)||sse)||request.method==='POST'&&['/api/session','/api/plugin/await-activation'].includes(path);
   if(!allowed||url.origin!==base.origin||!url.pathname.startsWith(prefix)||url.searchParams.get('location[directory]')!=='/workspace'||url.searchParams.has('location[workspace]')||request.headers.has('x-opencode-workspace')){poison=Error('Forbidden route/location');return Promise.reject(poison);}
   for(const [key,value] of base.searchParams)if(url.searchParams.get(key)!==value){poison=Error('Listener ownership mismatch');return Promise.reject(poison);}
   if(request.method==='POST'&&path==='/api/session'&&++creates!==1){poison=Error('Only one native fresh root permitted');return Promise.reject(poison);}
   const task=(async()=>{
    const requestBytes=request.body?new Uint8Array(await request.arrayBuffer()):undefined;
    if(path==='/api/session'&&request.method==='POST'){const body=JSON.parse(new TextDecoder().decode(requestBytes));assert(Object.keys(body).every(k=>k==='location')&&!body.id&&!body.parentID,'Unexpected root create settings');}
    const headers=new Headers(request.headers);headers.set('authorization',authorization);
    const response=await endpoint.fetch(request.url,{method:request.method,headers,signal:request.signal,...(requestBytes?{body:requestBytes}:{})});
    assert(response.ok,'Guest HTTP '+response.status);
    if(sse){evidence.sse={path,status:response.status,headers:[...response.headers],locallyJoined:false};return response;}
    const bytes=new Uint8Array(await response.arrayBuffer());request.signal.throwIfAborted();
    const record={method:request.method,path,url:request.url,status:response.status,headers:[...response.headers],bodyBase64:base64(bytes),sha256:await sha(bytes)};
    evidence.requests.push(record); // Preserve failure bytes before codec validation.
    const proof=await fetch('/codec',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(record),signal:AbortSignal.timeout(20000)});
    assert(proof.ok,'Pinned codec qualification failed: '+await proof.text().then(t=>t.slice(0,500)));
    // Body above has been consumed; codec output is captured separately by host.
    return new Response(response.status===204?null:bytes,{status:response.status,headers:response.headers});
   })().catch(error=>{poison??=error;throw error;});
   pending.add(task);return task.finally(()=>pending.delete(task));
  };
  const json=async(path:string)=>(await transport(requestURL(path),{signal:AbortSignal.timeout(20000)})).json();
  const identity=async()=>{
   assert(JSON.stringify(await fileIdentity())===JSON.stringify(initialFiles),'Immutable source/config/plugin fingerprint changed');
   assert(new TextDecoder().decode(await workspace.fs.readFile('/sk-qualification-source.txt'))===marker,'Source generation marker changed');
   const d=await diagnoseWorkspace(workspace);
   assert(d.procs.length===1&&d.listeners.length===1&&d.listeners[0]===4096,'Expected only owned guest OpenCode server');
   return d;
  };
  evidence.status='launching';display();
  const service=await owner.launch('qualification-chat',launch,descriptor.port,async exposed=>{
   endpoint=exposed;
   // launch waits for listener; no readiness retries or unrelated RPC are admitted.
   const health=await json('/api/health');assert(health.healthy&&health.version==='2.0.3'&&Number.isSafeInteger(health.pid),'Pinned native health');healthPID=health.pid;evidence.health=health;
   await transport(requestURL('/api/plugin/await-activation'),{method:'POST',signal:AbortSignal.timeout(20000)});
   return {url:requestURL(''),fetch:transport};
  },{shutdown:'stdin-eof',timeoutMs:15000},{listenMs:60000,connectMs:45000,overallMs:90000});
  evidence.endpoint=endpoint.url;evidence.before=await identity();
  const inventory=await json('/api/session');assert(inventory.data.length===0,'Fresh origin contains persisted native sessions');evidence.previousSessionIDs=inventory.data.map((s:any)=>s.id);
  const project=await json('/api/project/current'),config=await json('/api/config'),plugins=await json('/api/plugin'),models=await json('/api/model');
  assert(plugins.data.some((p:any)=>p.id==='editor.javascript'&&p.state.status==='active')&&plugins.data.some((p:any)=>p.id==='editor.model-headers'&&p.state.status==='active'),'Real plugins not activated');
  const selected=config.find((c:any)=>c.path===descriptor.configPath)?.info;
  assert(selected?.providers?.opencode?.settings?.apiKey==='editor-host-proxy'&&models.data.some((m:any)=>m.providerID===descriptor.model.providerID&&m.id===descriptor.model.id&&m.enabled),'Model marker/catalog admission failed');
  evidence.catalog={project,config,plugins,models};
  const chat=createChatController({endpoint:{url:requestURL(''),fetch:transport},directory:'/workspace',startNewSession:true,handshakeTimeoutMs:20000});
  const render=()=>{const snapshot=chat.getSnapshot();evidence.snapshot=snapshot;sessionText.textContent=snapshot.sessionID??'None';snapshotText.textContent=JSON.stringify(snapshot,null,2);};
  const unsubscribe=chat.subscribe(render);render();
  await chat.ready;render();const snapshot=chat.getSnapshot();
  assert(!snapshot.error&&!snapshot.loading&&snapshot.sessionID&&snapshot.messages.length===0&&snapshot.execution==='idle'&&snapshot.permissions.length===0&&snapshot.questions.length===0,'Actual controller fresh idle hydration failed');
  const session=(await json('/api/session/'+snapshot.sessionID)).data;evidence.session=session;
  assert(session.id===snapshot.sessionID&&session.projectID===project.id&&session.location.directory==='/workspace'&&session.location.workspaceID===undefined&&session.parentID===undefined&&session.fork===undefined&&session.model===undefined&&session.permissions===undefined&&session.metadata===undefined,'Native root inheritance mismatch');
  assert((await json('/api/session/active')).data&&Object.keys((await json('/api/session/active')).data).length===0,'Active execution not empty');
  evidence.status='mounted-awaiting-ui-admission';admit.disabled=false;display();
  await uiAdmission;assert(!poison,'Deadline/transport failed during manual UI admission');
  assert(sessionText.textContent===session.id&&document.querySelectorAll('input,textarea').length===0,'Rendered real controller UI admission failed');
  evidence.ui={deliberateControllerUI:true,renderedSessionID:sessionText.textContent,emptyIdle:true,admitted:true};
  evidence.after=await identity();const finalHealth=await json('/api/health');assert(finalHealth.pid===healthPID,'Owned guest PID changed');
  closed=true;await Promise.all([...pending]);unsubscribe();await chat.dispose();evidence.sse.locallyJoined=true;
  assert(!poison,'Finite request failure');
  await owner.stopServices();await service.drained;evidence.executionExit=await service.execution.exited;
  evidence.zero=await diagnoseWorkspace(workspace);assert(evidence.zero.procs.length===0&&evidence.zero.listeners.length===0&&evidence.zero.pendingHttp===0,'Guest cleanup not zero work');
  await owner.close();evidence.status='mounted-qualification-only';
 }catch(error){closed=true;poison??=error;evidence.status='failed';evidence.error=String(error);/* retain uncertain ownership; no retry/reset/replacement/forced cleanup */}
 clearTimeout(watchdog);display();
 const exported=await fetch('/evidence',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(evidence)});
 evidence.exported=exported.ok;return evidence;
}
start.onclick=()=>{(window as any).skOpenCodeQualification.done=run();};
(window as any).skOpenCodeQualification={evidence,done:undefined};
