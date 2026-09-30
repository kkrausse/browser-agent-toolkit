import {Runtime, diagnoseWorkspace, type Distribution, type Endpoint, type Workspace} from '@kev-browser-agent-kit/workspace';
import {WorkspaceController, type Service} from '@kev-browser-agent-kit/workspace/react';

// Only platform stream read/cancel work is owned by this fixture. No inference.
const guest = `const http=require('node:http');
const server=http.createServer((req,res)=>{
 if(req.url==='/health'){res.end('owner-qa-health');return;}
 if(req.url!=='/owner-upload'){res.writeHead(404);res.end();return;}
 req.on('data',bytes=>console.log('OWNER_UPLOAD_READ:'+bytes.toString()));
 req.on('error',error=>console.log('OWNER_REQUEST_ERROR:'+error.message));
 req.on('aborted',()=>console.log('OWNER_REQUEST_ABORTED'));
});
server.listen(5187,()=>console.log('OWNER_LISTENING:5187'));
process.stdin.resume();process.stdin.on('end',()=>{
 console.log('OWNER_STDIN_EOF');server.closeAllConnections();
 server.close(()=>console.log('OWNER_SERVER_CLOSED'));
});`;
const mode=new URL(location.href).searchParams.get('case')??'release';
const ownerMode=new URL(location.href).searchParams.get('owner')??'controller';
if(!['release','reject','reentrant'].includes(mode)||!['controller','runtime'].includes(ownerMode))throw Error('Unknown case');
const owner=new WorkspaceController({captureProcessOutput:true});
let workspace:Workspace,distribution:Distribution,service:Service,endpoint:Endpoint;
let release!:()=>void;
const gate=new Promise<void>(yes=>{release=yes;});
let cancelStarted!:()=>void,readStarted!:()=>void;
const cancelReceipt=new Promise<void>(yes=>{cancelStarted=yes;});
const readReceipt=new Promise<void>(yes=>{readStarted=yes;});
let stopping:Promise<void>|undefined;
let upload:ReadableStream<Uint8Array>;
const state={scope:'real-workspace-public-built-library-fixture',mode,ownerMode,phase:'idle',pulls:0,cancels:0,cancel:'pending',closed:'pending',settled:'pending',fetch:'pending',stop:'not-requested',replacementAttempts:[] as string[],events:[] as unknown[],sourceHash:'',sourcePaths:[] as string[],sourceUnchanged:false,guestUploadRead:false,uploadReaderLocked:false,guestExit:undefined as unknown,readersJoined:false,workspaceClosed:false,error:'',browserErrors:[] as string[]};
const render=()=>{document.querySelector('pre')!.textContent=JSON.stringify(state,null,2);};
const assert=(ok:unknown,message:string)=>{if(!ok)throw Error(message);};
const sha=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),b=>b.toString(16).padStart(2,'0')).join('');
const observe=(promise:Promise<unknown>,key:'closed'|'settled'|'fetch'|'stop')=>{void promise.then(value=>{state[key]='fulfilled';state.events.push({key,value});render();},error=>{state[key]='rejected';state.events.push({key,error:String(error)});render();});};
window.addEventListener('error',e=>{state.browserErrors.push(e.message);render();});
window.addEventListener('unhandledrejection',e=>{state.browserErrors.push(String(e.reason));render();});
Object.defineProperty(window,'endpointOwnerQA',{get:()=>JSON.parse(JSON.stringify(state))});
const enable=(id:string)=>{(document.getElementById(id) as HTMLButtonElement).disabled=false;};
async function start(){
 assert(state.phase==='idle','One-shot case');
 const root=await navigator.storage.getDirectory();
 for await(const key of (root as unknown as {keys():AsyncIterable<string>}).keys())throw Error('Nonempty fresh origin: '+key);
 assert((await indexedDB.databases()).length===0&&(await caches.keys()).length===0&&(await navigator.serviceWorker.getRegistrations()).length===0&&localStorage.length===0,'Fresh origin/profile required');
 state.events.push(await (await fetch('/stage')).json());
 const dist=await (await fetch('/runtime/distribution.json')).json();
 assert(dist.topology?.policy==='single-kernel','Single kernel required');
 distribution={name:'vivari',version:dist.version,assetBaseUrl:'/runtime/'};
 workspace=await owner.open(distribution);await owner.startRuntime({});
 await workspace.fs.writeFile('/owner-qa.cjs',guest);
 state.sourceHash=await sha(await workspace.fs.readFile('/owner-qa.cjs'));
 state.sourcePaths=(await workspace.fs.readdir('/')).sort();
 service=await owner.launch('owner-qa',{entry:'/workspace/owner-qa.cjs',cwd:'/workspace'},5187,async(ep,signal)=>{
  const response=await ep.fetch('/health',{signal});assert(await response.text()==='owner-qa-health','Exact guest route');
  return {url:ep.url,fetch:(input,init)=>ep.fetch(String(input),init)};
 },{shutdown:'stdin-eof',timeoutMs:10000});
 endpoint=service.endpoint;observe(endpoint.closed,'closed');observe(endpoint.settled,'settled');
 state.events.push({endpointURL:endpoint.url,entry:'/workspace/owner-qa.cjs',route:'/owner-upload'});
 upload=new ReadableStream<Uint8Array>({
  pull(controller){state.pulls++;readStarted();if(state.pulls===1)controller.enqueue(new TextEncoder().encode('OWNER_SOURCE_MARKER'));if(mode==='reentrant')endpoint.dispose();render();},
  async cancel(reason){state.cancels++;state.events.push({sourceCancelReason:String(reason)});cancelStarted();render();await gate;if(mode==='reject'){state.cancel='rejected';render();throw Error('OWNER_SOURCE_CANCEL_REJECTED');}state.cancel='fulfilled';render();},
 },{highWaterMark:0});
 observe(endpoint.fetch('/owner-upload',{method:'POST',body:upload,duplex:'half'} as RequestInit),'fetch');
 await readReceipt;
 if(mode!=='reentrant'){
  await new Promise<void>((yes,no)=>{
   let unsubscribe=()=>{};
   const check=()=>{if(owner.getSnapshot().logs.some(line=>line.includes('OWNER_UPLOAD_READ:OWNER_SOURCE_MARKER'))){state.guestUploadRead=true;unsubscribe();yes();}};
   unsubscribe=owner.subscribe(check);check();
   void service.execution.exited.then(exit=>{if(!state.guestUploadRead){unsubscribe();no(Error('Guest exited before actual upload read: '+JSON.stringify(exit)));}});
  });
 }
 state.uploadReaderLocked=upload.locked;state.phase='reading';enable('close');render();
}
async function closeAdmission(){
 assert(state.phase==='reading','Read receipt required');endpoint.dispose();endpoint.dispose();
 await endpoint.closed;await cancelReceipt;
 // Guest graceful exit is independent of the held host cancellation receipt.
 service.execution.closeStdin();
 const [exit]=await Promise.all([service.execution.exited,service.drained]);
 assert(exit.exitCode===0&&!exit.forced&&exit.signal===null,'Natural guest shutdown required; no forced proof');
 state.guestExit=exit;state.readersJoined=true;
 state.uploadReaderLocked=upload.locked;
 assert(state.cancels===1&&state.settled==='pending'&&state.fetch==='rejected'&&state.uploadReaderLocked,'Prompt rejection / held source separation');
 state.events.push({guestLogs:owner.getSnapshot().logs,diagnostics:await diagnoseWorkspace(workspace)});
 state.phase='held';enable('stop');render();
}
async function stop(){
 assert(state.phase==='held','Held checkpoint required');
 stopping=ownerMode==='controller'?owner.stopRuntime():owner.runtime!.stop();observe(stopping,'stop');
 assert(state.settled==='pending','Endpoint source still owned');state.phase='stopping';enable('replace');enable('release');render();
}
async function replacement(){
 assert(state.phase==='stopping'||state.phase==='negative','Only retained owner may be probed');
 try{const unexpected=await Runtime.start({workspace,distribution});state.replacementAttempts.push('UNEXPECTED_ACCEPTANCE');await unexpected.stop();throw Error('Replacement escaped public attachment guard');}
 catch(error){assert(String(error).includes('already has an active runtime'),'Exact public attachment rejection: '+String(error));state.replacementAttempts.push(String(error));}
 assert(state.stop!=='fulfilled','Stop must not succeed while held/rejected');render();
}
async function finish(){
 assert(state.phase==='stopping'&&state.replacementAttempts.length>0,'Probe held public guard first');release();
 if(mode==='reject'){
  try{await stopping;throw Error('Rejected cancel accepted');}catch(error){assert(String(error).includes(ownerMode==='controller'?'quiescence unproven':'workspace remains attached'),'Expected stop failure: '+String(error));}
  assert(state.settled==='rejected'&&state.cancels===1,'Rejected public endpoint receipt');
  state.phase='negative';await replacement();
  state.uploadReaderLocked=upload.locked;assert(!state.uploadReaderLocked,'Rejected cleanup must still release reader lock');
  state.sourceUnchanged=state.sourceHash===await sha(await workspace.fs.readFile('/owner-qa.cjs'))&&JSON.stringify(state.sourcePaths)===JSON.stringify((await workspace.fs.readdir('/')).sort());
  assert(state.sourceUnchanged,'Source changed');state.phase='ownership-negative';
 }else{
  await stopping;await endpoint.settled;
  state.uploadReaderLocked=upload.locked;assert(!state.uploadReaderLocked,'Upload reader release absent');
  state.sourceUnchanged=state.sourceHash===await sha(await workspace.fs.readFile('/owner-qa.cjs'))&&JSON.stringify(state.sourcePaths)===JSON.stringify((await workspace.fs.readdir('/')).sort());assert(state.sourceUnchanged,'Source changed');
  const next=await Runtime.start({workspace,distribution});await next.stop();state.replacementAttempts.push('accepted-only-after-successful-join');
  await owner.close();state.workspaceClosed=true;state.phase='complete';
 }
 render();
 const saved=await fetch('/evidence',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(state)});assert(saved.ok,'Evidence save failed');
}
for(const [id,action] of [['start',start],['close',closeAdmission],['stop',stop],['replace',replacement],['release',finish]] as const){
 document.getElementById(id)!.addEventListener('click',()=>{(document.getElementById(id) as HTMLButtonElement).disabled=true;void action().catch(error=>{state.error=String(error);state.phase='failed-owner-retained';render();throw error;});});
}
render();
