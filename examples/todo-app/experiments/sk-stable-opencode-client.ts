import {diagnoseWorkspace, type Workspace, type Endpoint} from '@kev-browser-agent-kit/workspace';
import {WorkspaceController, type Service} from '@kev-browser-agent-kit/workspace/react';
import {loadPrepared,preparedApps,installOpenCodeConfig,createOpenCodeCandidateLaunch,openCodeCandidateLaunch as descriptor} from '@kev-browser-agent-kit/opencode-chat/browser';

const evidence:any={status:'awaiting-start',retentionAccepted:false,remoteZeroRef:false,liveRuns:0,starts:0,deliveries:0,requests:[],switches:[],events:[],backgroundWork:'actual648 models.fetch:true global refresh and retained location subscribers; not drained'};
const owner=new WorkspaceController({captureProcessOutput:true,onDiagnostic:event=>evidence.events.push(event)});
const roots={A:'/workspace/projects/A',B:'/workspace/projects/B'} as const;
type Root=keyof typeof roots;
const status=document.querySelector('#status')!,snapshot=document.querySelector('#snapshot')!;
const buttons=Object.fromEntries(['start','B','A','finish'].map(id=>[id,document.getElementById(id) as HTMLButtonElement]));
const assert=(ok:unknown,message:string)=>{if(!ok)throw Error(message);};
const sha=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)),b=>b.toString(16).padStart(2,'0')).join('');
const base64=(bytes:Uint8Array)=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
let workspace:Workspace,service:Service,endpoint:Endpoint,execution:Service['execution'],endpointURL:string,authorization:string;
let epoch=0,selected:Root|undefined,candidate:Root|undefined,busy=false,requestBusy=false,poison:unknown,closed=false,exited=false,healthPID:number|undefined;
let stage:any,baseline:any,configHash:string|undefined;
const render=()=>{status.textContent=evidence.status;snapshot.textContent=JSON.stringify({selected,epoch,switches:evidence.switches,error:evidence.error},null,2);};
const preserve=async(path:string,value:unknown)=>{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(20000)});assert(r.ok,'Host evidence preservation failed');return r.json();};
const healthy=()=>assert(!poison&&!closed&&!exited,'Owner closed, poisoned or exited');

// Private transport accepts only closed route literals and epoch/root capabilities.
// No Request/RequestInit/body argument exists: every guest request has zero upload
// bytes. In particular a caller-owned ReadableStream cannot cross this boundary.
async function finite(root:Root,token:number,path:'/api/health'|'/api/config'|'/api/project/current'|'/api/plugin/await-activation'|'/api/debug/location'){
 healthy();assert(token===epoch&&root===(candidate??selected),'Stale caller epoch/root');assert(!requestBusy,'Concurrent finite request forbidden');
 requestBusy=true;
 try{
  const url=new URL(path.slice(1),endpointURL);
  for(const [key,value] of new URL(endpointURL).searchParams)url.searchParams.set(key,value);
  url.searchParams.set('location[directory]',roots[root]);
  const method=path==='/api/plugin/await-activation'?'POST':'GET';
  const signal=AbortSignal.timeout(20000);
  const response=await endpoint.fetch(url.href,{method,headers:{authorization},signal});
  const bytes=new Uint8Array(await response.arrayBuffer());
  signal.throwIfAborted();
  const record:any={root,directory:roots[root],epoch:token,method,path,url:url.href,status:response.status,headers:[...response.headers],bodyBase64:base64(bytes),sha256:await sha(bytes),requestBodyBytes:0};
  evidence.requests.push(record);await preserve('/response',record);
  healthy();assert(token===epoch&&root===(candidate??selected),'Stale response rejected before publication');assert(response.ok,'Guest HTTP failure');
  const parity=await preserve('/codec',record);assert(parity.qualified&&parity.bytes===bytes.length&&parity.path===path&&parity.method===method,'Actual codec parity mismatch');record.codec=parity;
  healthy();assert(token===epoch,'Late codec result rejected');
  return {data:response.status===204?undefined:JSON.parse(new TextDecoder().decode(bytes)),hash:record.sha256};
 }catch(error){poison??=error;throw error;}finally{requestBusy=false;}
}
async function rootBytes(){
 const result:any={sharedFiles:{}};
 for(const path of [descriptor.workspaceConfigPath,'/.server/config/opencode/plugins/editor-model-headers.js','/.server/config/opencode/plugins/editor-javascript.js'])result.sharedFiles[path]=await sha(await workspace.fs.readFile(path));
 for(const key of ['A','B'] as const){
  const path=roots[key].slice('/workspace'.length);
  const names=(await workspace.fs.readdir(path)).sort();
  assert(JSON.stringify(names)===JSON.stringify(['marker.txt','opencode.json']),'Root path set changed');
  assert((await workspace.fs.stat(path)).isDirectory,'Owned root not directory');
  result[key]={directory:roots[key],names,files:{}};
  for(const name of names){assert((await workspace.fs.stat(path+'/'+name)).isFile,'Root source is not ordinary file');result[key].files[name]=await sha(await workspace.fs.readFile(path+'/'+name));}
 }
 return result;
}
async function continuity(root:Root,token:number){
 healthy();assert(service.execution===execution&&service.endpoint===endpoint&&endpoint.url===endpointURL,'Execution/endpoint identity changed');
 const currentStage=await (await fetch('/stage',{signal:AbortSignal.timeout(20000)})).json();
 assert(JSON.stringify(currentStage.hostOwner)===JSON.stringify(stage.hostOwner)&&currentStage.sourceRevision===stage.sourceRevision&&currentStage.clientSha256===stage.clientSha256,'Exclusive host-owner/stage identity changed');
 assert(JSON.stringify(await rootBytes())===JSON.stringify(baseline),'Immutable A/B root bytes changed');
 const health=(await finite(root,token,'/api/health')).data;
 assert(health.healthy&&health.version==='2.0.3'&&Number.isSafeInteger(health.pid),'Actual health shape');
 healthPID??=health.pid;assert(health.pid===healthPID,'Guest PID changed');
 const diagnostics=await diagnoseWorkspace(workspace);
 assert(diagnostics.procs.length===1&&diagnostics.listeners.length===1&&diagnostics.listeners[0]===4096&&diagnostics.pendingHttp===0,'Exclusive idle guest owner required');
 const processRows=diagnostics.procs.map(p=>({pid:p.pid,ppid:p.ppid,command:p.command,cwd:p.cwd}));
 evidence.processRows??=processRows;assert(JSON.stringify(processRows)===JSON.stringify(evidence.processRows),'Guest process row changed');
 const u=new URL(endpointURL);assert(u.searchParams.has('__vv_listener'),'Pinned listener generation missing');
 return {health,processRows,endpointURL,listener:u.searchParams.get('__vv_listener'),sameExecutionObject:true,sameEndpointObject:true,executionExited:false,ownerID:evidence.ownerID,hostOwner:stage.hostOwner,roots:await rootBytes(),starts:evidence.starts,deliveries:evidence.deliveries};
}
async function activate(root:Root){
 healthy();assert(!requestBusy,'Outgoing finite request not joined');
 candidate=root;const token=++epoch;
 await finite(root,token,'/api/plugin/await-activation');
 const project=(await finite(root,token,'/api/project/current')).data;
 assert(typeof project.id==='string'&&typeof project.directory==='string'&&typeof project.canonical==='string','Pinned project shape');
 const config=await finite(root,token,'/api/config');configHash??=config.hash;assert(config.hash===configHash,'Shared frozen config bytes changed');
 const locations=(await finite(root,token,'/api/debug/location')).data;
 const allowed=new Set<string>(evidence.switches.length?Object.values(roots):[roots.A]);
 assert(Array.isArray(locations)&&locations.every(ref=>allowed.has(ref.directory)&&ref.workspaceID===undefined),'Unexpected loaded server location');
 for(const directory of allowed)assert(locations.filter((ref:{directory:string})=>ref.directory===directory).length===1,'Actual server directory key missing/duplicated');
 const receipt=await continuity(root,token);
 healthy();assert(!requestBusy&&token===epoch,'Finite completion not joined');
 selected=root;candidate=undefined; // Publication occurs only after every normal finite response/codec completes.
 evidence.switches.push({selected,epoch,project,locations,sharedConfigSha256:config.hash,continuity:receipt});
 evidence.status=evidence.switches.length===3?'bounded-A-B-A-observed-awaiting-final-join':'selected-'+root;render();
}
async function start(){
 assert(evidence.starts===0,'One-shot fresh owner');
 const fs=await navigator.storage.getDirectory();for await(const key of (fs as any).keys())throw Error('Nonempty OPFS '+key);
 assert((await indexedDB.databases()).length===0&&(await caches.keys()).length===0&&(await navigator.serviceWorker.getRegistrations()).length===0&&localStorage.length===0,'Fresh native origin required');
 stage=await (await fetch('/stage')).json();evidence.stage=stage;assert(stage.hostOwner?.url===location.origin+'/'&&stage.hostOwner.pid>0,'Exact host owner receipt');
 assert(await sha(new Uint8Array(await (await fetch('/client/sk-stable-opencode-client.js')).arrayBuffer()))===stage.clientSha256,'Served client mismatch');
 const manifest=await loadPrepared('/prepared/',owner.signal);
 workspace=await owner.open({name:'vivari',version:stage.runtimeVersion,assetBaseUrl:'/runtime/'});
 const runtime=await owner.startRuntime({apps:preparedApps(manifest,'/prepared/',owner.signal,delivery=>evidence.events.push({delivery}))});
 await runtime.tools.apps();evidence.deliveries++;
 await installOpenCodeConfig(workspace,{modelBaseURL:location.origin+'/prohibited-model/'});
 let projectsExists=false;try{await workspace.fs.stat('/projects');projectsExists=true;}catch(error){assert(String(error).includes('ENOENT'),'Unexpected root existence check failure');}
 assert(!projectsExists,'Fixed project roots must be newly owned, never reused');
 await workspace.fs.mkdir('/projects');
 for(const key of ['A','B'] as const){const path='/projects/'+key;await workspace.fs.mkdir(path);await workspace.fs.writeFile(path+'/marker.txt','stable-root-'+key+'-'+crypto.randomUUID());await workspace.fs.writeFile(path+'/opencode.json',JSON.stringify({name:'immutable-root-'+key,snapshot:false}));}
 await workspace.flush();baseline=await rootBytes();evidence.initialRoots=baseline;
 evidence.ownerID=crypto.randomUUID();authorization='Basic '+btoa('opencode:'+crypto.randomUUID()+crypto.randomUUID());
 // Decode only the password locally; no credentials enter receipts.
 const password=atob(authorization.slice(6)).slice('opencode:'.length);
 evidence.starts++;service=await owner.launch('stable-opencode',createOpenCodeCandidateLaunch({password,ripgrepBinDirectory:manifest.opencode.support.binDirectory}),descriptor.port,async exposed=>{
  endpoint=exposed;endpointURL=exposed.url;return {url:exposed.url,fetch:()=>Promise.reject(Error('Generic connection transport prohibited'))};
 },{shutdown:'stdin-eof',timeoutMs:15000},{listenMs:60000,connectMs:45000,overallMs:90000});
 execution=service.execution;void execution.exited.then(()=>{exited=true;if(!closed)poison??=Error('Server exited during retention');});void service.failed.catch(error=>{if(!closed)poison??=error;});
 evidence.liveRuns=1;await activate('A');
}
async function finish(){
 assert(evidence.switches.length===3&&selected==='A','A0-B-A sequence required');
 await continuity('A',epoch);closed=true;assert(!requestBusy,'Finite owner not joined');
 await owner.stopServices();await service.drained;const exit=await execution.exited;
 assert(exit.exitCode===0&&exit.signal===null&&exit.forced===false,'Clean final guest exit required');
 const zero=await diagnoseWorkspace(workspace);assert(zero.procs.length===0&&zero.listeners.length===0&&zero.pendingHttp===0,'Final guest zero-work required');
 await owner.close();evidence.exit=exit;evidence.zero=zero;evidence.status='bounded-toy-only';await preserve('/evidence',evidence);render();
}
function action(task:()=>Promise<void>,next?:string){
 if(busy||poison||closed)return;busy=true;Object.values(buttons).forEach(b=>b.disabled=true);
 const done=task().then(()=>{if(next)buttons[next]!.disabled=false;}).catch(async error=>{poison??=error;evidence.status='failed-owner-retained';evidence.error=String(error);try{await preserve('/failure',evidence);}catch{};render();}).finally(()=>{busy=false;});
 (window as any).skStableOpenCode.done=done;
}
buttons.start!.onclick=()=>action(start,'B');buttons.B!.onclick=()=>action(()=>activate('B'),'A');buttons.A!.onclick=()=>action(()=>activate('A'),'finish');buttons.finish!.onclick=()=>action(finish);
(window as any).skStableOpenCode={evidence,done:undefined};render();
