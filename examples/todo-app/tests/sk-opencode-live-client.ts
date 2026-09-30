import {diagnoseWorkspace} from '@kev-browser-agent-kit/workspace';
import {WorkspaceController} from '@kev-browser-agent-kit/workspace/react';
import {loadPrepared,preparedApps,installOpenCodeConfig,createOpenCodeCandidateLaunch,openCodeCandidateLaunch as descriptor} from '@kev-browser-agent-kit/opencode-chat/browser';
import {createChatController} from 'sk-opencode-qualified-controller';
import {captureQualificationRequest,createQualificationFence,qualifyRootResult} from './sk-opencode-live-fence';
import {guardedFailureCleanup} from './sk-opencode-live-failure-cleanup';

// Deliberate actual-controller UI: read-only snapshot, no ChatView send/tool actions.
// All writes are initial preparation of this NEW owned origin, before server launch.
const evidence:any={status:'awaiting-start',retentionAccepted:false,remoteZeroRef:false,requestAttempts:[],requests:[],events:[],attempts:0,backgroundWork:'delivered-models.fetch:true-global-refresh-not-drained'};
const owner=new WorkspaceController({captureProcessOutput:true,onDiagnostic:event=>evidence.events.push(event)});
const sha=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)),b=>b.toString(16).padStart(2,'0')).join('');
const base64=(bytes:Uint8Array)=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);};
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
let admitted=false,closed=false,poison:unknown;
const fence=createQualificationFence();
const pending=new Set<Promise<unknown>>();
const status=document.querySelector('#status')!,sessionText=document.querySelector('#session')!,snapshotText=document.querySelector('#snapshot')!;
const start=document.querySelector<HTMLButtonElement>('#start')!,admit=document.querySelector<HTMLButtonElement>('#admit')!;
let acceptUI:()=>void,rejectUI:(error:unknown)=>void;
const uiAdmission=new Promise<void>((resolve,reject)=>{acceptUI=resolve;rejectUI=reject;});
void uiAdmission.catch(()=>{});
admit.onclick=()=>{if(evidence.status!=='mounted-awaiting-ui-admission'||admitted)return;admitted=true;admit.disabled=true;acceptUI();};
const display=()=>{status.textContent=evidence.status;};
async function run(){
 if(evidence.attempts++)throw Error('One-shot owner already used');
 start.disabled=true;
  const watchdog=setTimeout(()=>{poison??=Error('Qualification deadline; unresolved ownership retained');rejectUI(poison);evidence.status='failed';evidence.error=String(poison);display();},180000);
 let workspace:any,service:any,chat:ReturnType<typeof createChatController>|undefined,unsubscribe:(()=>void)|undefined;
 let projectID:string|undefined,ownedRootID:string|undefined;
 const preserve=async(path:string,value:unknown)=>{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(20000)});assert(response.ok,'Evidence preservation failed: '+path);};
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
   workspace=await owner.open({name:'vivari',version:stage.runtimeVersion,assetBaseUrl:'/runtime/'});
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
   fence.admitFreshOrigin(); // Only after storage, committed-client and frozen A0 identity admission.
  let endpoint:any,healthPID:number|undefined;
  const requestURL=(path:string)=>{const u=new URL(path.replace(/^\//,''),endpoint.url);for(const [k,v] of new URL(endpoint.url).searchParams)u.searchParams.set(k,v);u.searchParams.set('location[directory]','/workspace');return u.href;};
   const transport=(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
    const request=new Request(input,init);
    const task=(async()=>{
     const captured=await captureQualificationRequest(request,record=>evidence.requestAttempts.push(record),record=>preserve('/request-evidence',record));
     const requestBytes=captured.bytes;
     let route:ReturnType<typeof fence.admit>;
     try{assert(!closed&&!poison,'Qualification admissions closed');route=fence.admit(request,new URL(endpoint.url),requestBytes);captured.record.admission='admitted';}
     catch(error){captured.record.admission='rejected';Object.assign(captured.record,{error:String(error)});throw error;}
     const {path,sse,create,inventory}=route;
     if(create){
      const proof=await fetch('/codec',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...captured.record,path,mode:'root-request-schema'}),signal:AbortSignal.timeout(20000)});
      const text=await proof.text();assert(proof.ok,'Actual delivered root request schema rejected: '+text.slice(0,500));
      const receipt=JSON.parse(text);assert(receipt.qualified===true&&receipt.kind==='root-request-schema'&&receipt.path===path&&receipt.method===request.method&&receipt.bytes===requestBytes.length,'Root schema receipt mismatch');
      Object.assign(captured.record,{pinnedRequestSchema:receipt});
     }
     const headers=new Headers(request.headers);headers.set('authorization',authorization);
     assert(!closed&&!poison,'Qualification admissions closed before guest transport');
     const response=await endpoint.fetch(request.url,{method:request.method,headers,signal:request.signal,...(requestBytes.length?{body:requestBytes}:{})});
     if(sse&&response.ok){evidence.sse={path,status:response.status,headers:[...response.headers],locallyJoined:false};return response;}
     const bytes=new Uint8Array(await response.arrayBuffer());
    const record={method:request.method,path,url:request.url,status:response.status,headers:[...response.headers],bodyBase64:base64(bytes),sha256:await sha(bytes)};
     evidence.requests.push(record); // Preserve failure bytes before codec validation.
     await preserve('/response-evidence',record);
     assert(response.ok,'Guest HTTP '+response.status);request.signal.throwIfAborted();
    const proof=await fetch('/codec',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(record),signal:AbortSignal.timeout(20000)});
    const proofText=await proof.text();assert(proof.ok,'Pinned codec qualification failed: '+proofText.slice(0,500));
    const parity=JSON.parse(proofText);assert(parity.qualified===true&&parity.method===request.method&&parity.path===path&&parity.status===response.status&&parity.bytes===bytes.length,'Pinned codec receipt mismatch');
     Object.assign(record,{pinnedCodec:parity});
     if(path.endsWith('/message')||path.endsWith('/permission')||path.endsWith('/form')){const data=JSON.parse(new TextDecoder().decode(bytes)).data;assert(Array.isArray(data)&&data.length===0,'Native root hydration must be empty');}
     if(path==='/api/session/active'){const data=JSON.parse(new TextDecoder().decode(bytes)).data;assert(data&&typeof data==='object'&&Object.keys(data).length===0,'Global execution not empty');}
     if(inventory)fence.admitEmptyInventory(JSON.parse(new TextDecoder().decode(bytes)).data);
     if(create){assert(projectID,'Owned project missing');ownedRootID=qualifyRootResult(JSON.parse(new TextDecoder().decode(bytes)).data,projectID!,evidence.previousSessionIDs);fence.ownRoot(ownedRootID);evidence.ownedRootID=ownedRootID;}
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
   service=await owner.launch('qualification-chat',launch,descriptor.port,async exposed=>{
   endpoint=exposed;
   // launch waits for listener; no readiness retries or unrelated RPC are admitted.
   const health=await json('/api/health');assert(health.healthy&&health.version==='2.0.3'&&Number.isSafeInteger(health.pid),'Pinned native health');healthPID=health.pid;evidence.health=health;
   await transport(requestURL('/api/plugin/await-activation'),{method:'POST',signal:AbortSignal.timeout(20000)});
   return {url:requestURL(''),fetch:transport};
  },{shutdown:'stdin-eof',timeoutMs:15000},{listenMs:60000,connectMs:45000,overallMs:90000});
  evidence.endpoint=endpoint.url;evidence.before=await identity();
  const processIdentity=(d:typeof evidence.before)=>d.procs.map((p:any)=>({pid:p.pid,ppid:p.ppid,command:p.command,cwd:p.cwd}));
  evidence.identity.process=processIdentity(evidence.before);
  const inventory=await json('/api/session');assert(inventory.data.length===0,'Fresh origin contains persisted native sessions');evidence.previousSessionIDs=inventory.data.map((s:any)=>s.id);
   const project=await json('/api/project/current'),config=await json('/api/config'),plugins=await json('/api/plugin'),models=await json('/api/model');
   projectID=project.id;
  assert(plugins.data.some((p:any)=>p.id==='editor.javascript'&&p.state.status==='active')&&plugins.data.some((p:any)=>p.id==='editor.model-headers'&&p.state.status==='active'),'Real plugins not activated');
  const selected=config.find((c:any)=>c.path===descriptor.configPath)?.info;
  assert(selected?.providers?.opencode?.settings?.apiKey==='editor-host-proxy'&&models.data.some((m:any)=>m.providerID===descriptor.model.providerID&&m.id===descriptor.model.id&&m.enabled),'Model marker/catalog admission failed');
  const configuredModel=selected.model;
  assert(configuredModel==='opencode/'+descriptor.model.id||configuredModel?.providerID===descriptor.model.providerID&&configuredModel.model===descriptor.model.id,'Explicit configured default model marker mismatch');
  evidence.catalog={project,config,plugins,models};
   chat=createChatController({endpoint:{url:requestURL(''),fetch:transport},directory:'/workspace',startNewSession:true,handshakeTimeoutMs:20000});
   const render=()=>{const snapshot=chat!.getSnapshot();evidence.snapshot=snapshot;sessionText.textContent=snapshot.sessionID??'None';snapshotText.textContent=JSON.stringify(snapshot,null,2);};
   unsubscribe=chat.subscribe(render);render();
  await chat.ready;render();const snapshot=chat.getSnapshot();
   assert(!snapshot.error&&!snapshot.loading&&snapshot.sessionID&&snapshot.messages.length===0&&snapshot.execution==='idle'&&snapshot.permissions.length===0&&snapshot.questions.length===0&&snapshot.unsupportedForms.length===0,'Actual controller fresh idle hydration failed');
  assert(snapshot.defaultModel?.providerID===descriptor.model.providerID&&snapshot.defaultModel.id===descriptor.model.id,'Real controller default model marker mismatch');
  const session=(await json('/api/session/'+snapshot.sessionID)).data;evidence.session=session;
   assert(session.id===snapshot.sessionID&&session.id===ownedRootID,'Controller must select exact owned root');qualifyRootResult(session,project.id,evidence.previousSessionIDs);
  assert((await json('/api/session/active')).data&&Object.keys((await json('/api/session/active')).data).length===0,'Active execution not empty');
  evidence.status='mounted-awaiting-ui-admission';admit.disabled=false;display();
  await uiAdmission;assert(!poison,'Deadline/transport failed during manual UI admission');
  assert(sessionText.textContent===session.id&&document.querySelectorAll('input,textarea').length===0,'Rendered real controller UI admission failed');
  evidence.ui={deliberateControllerUI:true,renderedSessionID:sessionText.textContent,emptyIdle:true,admitted:true};
  evidence.after=await identity();const finalHealth=await json('/api/health');assert(finalHealth.pid===healthPID,'Owned guest PID changed');
  assert(JSON.stringify(processIdentity(evidence.after))===JSON.stringify(evidence.identity.process),'Owned runtime process identity changed');
  closed=true;await Promise.all([...pending]);unsubscribe();await chat.dispose();evidence.sse.locallyJoined=true;
  assert(!poison,'Finite request failure');
  await owner.stopServices();await service.drained;evidence.executionExit=await service.execution.exited;
  assert(evidence.executionExit.exitCode===0&&evidence.executionExit.signal===null&&evidence.executionExit.forced===false,'Guest did not cleanly exit with joined outputs');
  evidence.zero=await diagnoseWorkspace(workspace);assert(evidence.zero.procs.length===0&&evidence.zero.listeners.length===0&&evidence.zero.pendingHttp===0,'Guest cleanup not zero work');
   await owner.close();assert(!poison,'Qualification deadline/failure during cleanup');evidence.status='mounted-qualification-only';
  }catch(error){
   closed=true;poison??=error;evidence.status='failed';evidence.error=String(error);display();
   try{
    // Preserve the failed cohort BEFORE any disposal, EOF or ownership release.
    await preserve('/failed-evidence',evidence);
    assert(workspace&&service,'Known returned guest/service ownership required; ambiguous launch retained');
    evidence.failureCleanup=await guardedFailureCleanup({
     dispose:async()=>{unsubscribe?.();if(chat)await chat.dispose();if(evidence.sse)evidence.sse.locallyJoined=true;},
     finiteJoin:async()=>{await Promise.allSettled([...pending]);},
     guestEOFJoin:async()=>{
      service.execution.closeStdin();let timer:ReturnType<typeof setTimeout>|undefined;
      try{const [exit]=await Promise.race([Promise.all([service.execution.exited,service.drained]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Failure EOF join uncertain; no forced stop')),15000);})]);evidence.executionExit=exit;assert(exit.exitCode===0&&exit.signal===null&&exit.forced===false,'Failure guest not clean/non-forced');}
      finally{clearTimeout(timer);}
     },
     zeroWork:async()=>{evidence.zero=await diagnoseWorkspace(workspace);assert(evidence.zero.procs.length===0&&evidence.zero.listeners.length===0&&evidence.zero.pendingHttp===0,'Failure cleanup zero work unproven');return evidence.zero;},
     workspaceClose:async()=>{await owner.close();},
    });
   }catch(cleanupError){evidence.failureCleanup={kind:'guarded-failure-cleanup',qualificationPassed:false,completed:false,error:String(cleanupError)};}
  }
 clearTimeout(watchdog);display();
 const exported=await fetch('/evidence',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(evidence)});
 evidence.exported=exported.ok;return evidence;
}
start.onclick=()=>{(window as any).skOpenCodeQualification.done=run();};
(window as any).skOpenCodeQualification={evidence,done:undefined};
