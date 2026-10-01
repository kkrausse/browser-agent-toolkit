import {Workspace,Runtime,opfsStore,diagnoseWorkspace,type Execution} from '@kev-browser-agent-kit/workspace';

const state={scope:'native-fetch-public-stop-only',phase:'idle',workspaceId:'',sourceHash:'',sourceUnchanged:false,events:[] as unknown[],logs:[] as string[],errors:[] as string[],stop:'not-requested',runtimeStop:'not-requested',readersJoined:false,workspaceClosed:false,evidencePersisted:false};
let workspace:Workspace,runtime:Runtime,execution:Execution,drained:Promise<void>,guest:string;
const render=()=>{document.querySelector('pre')!.textContent=JSON.stringify(state,null,2);};
const assert=(ok:unknown,message:string)=>{if(!ok)throw Error(message);};
const hash=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),b=>b.toString(16).padStart(2,'0')).join('');
const backend=async(joined=false)=>{const response=await fetch('/backend-state'+(joined?'?joined=1':''));assert(response.ok,'Backend observer receipt');return await response.json();};
const persist=async()=>{const response=await fetch('/evidence',{method:'POST',body:JSON.stringify(state)});assert(response.ok,'Evidence persistence');state.evidencePersisted=true;render();};
Object.defineProperty(window,'pidEgressNativeQA',{get:()=>JSON.parse(JSON.stringify(state))});
window.addEventListener('error',e=>{state.errors.push(e.message);render();});
window.addEventListener('unhandledrejection',e=>{state.errors.push(String(e.reason));render();});
async function start(){
 assert(state.phase==='idle','One shot');state.phase='starting';render();
 const root=await navigator.storage.getDirectory();for await(const key of (root as unknown as {keys():AsyncIterable<string>}).keys())throw Error('Nonempty origin: '+key);
 assert((await indexedDB.databases()).length===0&&(await caches.keys()).length===0&&(await navigator.serviceWorker.getRegistrations()).length===0&&localStorage.length===0,'Fresh origin');
 const stage=await (await fetch('/stage')).json();state.events.push(stage);
 assert(stage.runtimeRevision==='33fa1359a003ca9c50cb3bc49699b99bc1a063f1'&&stage.toolkitRevision==='d0eec346dbc749db1c0cd82dd8aad0b27c1da363','Exact source');
 assert(await hash(new Uint8Array(await (await fetch('/client/sk-pid-egress-native-client.js')).arrayBuffer()))===stage.clientSha256,'Consumer identity');
 const distribution={name:'vivari',version:stage.version,assetBaseUrl:'/runtime/'};
 workspace=await Workspace.open({id:'default',storage:opfsStore(distribution)});state.workspaceId=workspace.id;
 runtime=await Runtime.start({workspace,distribution});
 guest=`const http=require('node:http');console.log('NATIVE_GUEST_PID:'+process.pid);const plan=Array.from({length:9},(_,i)=>['headers','header-'+i]).concat([['body','body'],['headers','queued']]);for(const [mode,id] of plan){const url=${JSON.stringify(location.origin)}+'/backend/'+mode+'?pid='+process.pid+'&id='+id;console.log('NATIVE_ISSUE:'+id);const req=http.get(url,res=>{console.log('UNEXPECTED_RESPONSE:'+id);res.on('data',()=>{});res.on('end',()=>console.log('UNEXPECTED_END:'+id));});req.on('error',e=>console.log('GUEST_REQUEST_ERROR:'+id+':'+e.message));}process.stdin.resume();`;
 await workspace.fs.writeFile('/native-egress.cjs',guest);state.sourceHash=await hash(await workspace.fs.readFile('/native-egress.cjs'));
 execution=await runtime.node({entry:'/workspace/native-egress.cjs',cwd:'/workspace'});
 const read=async(stream:AsyncIterable<Uint8Array>,channel:string)=>{for await(const bytes of stream){state.logs.push(channel+':'+new TextDecoder().decode(bytes));render();}};
 drained=Promise.all([read(execution.stdout,'stdout'),read(execution.stderr,'stderr')]).then(()=>{state.readersJoined=true;render();});
 void execution.exited.then(exit=>{state.events.push({publicExit:exit});render();});
 state.phase='launched';(document.getElementById('confirm') as HTMLButtonElement).disabled=false;render();
}
async function confirm(){
 assert(state.phase==='launched','Launch first');const receipt=await backend();state.events.push({backendHeld:receipt});
 const pid=state.logs.join('').match(/NATIVE_GUEST_PID:(\d+)/)?.[1];assert(pid,'Actual guest PID marker');
 assert(receipt.requests.length===10&&receipt.requests.every((r:{pid:string;cancelled:boolean;id:string})=>r.pid===pid&&!r.cancelled&&r.id!=='queued'),'Ten actual held native requests for exact guest PID; queued request not dispatched');
 assert(receipt.events.some((e:{type:string})=>e.type==='body-enqueued'),'Actual response body started');
 const diagnostic=await diagnoseWorkspace(workspace);state.events.push({heldDiagnostic:diagnostic});
 assert(diagnostic.procs.some(p=>p.pid===Number(pid))&&diagnostic.fetch.active===10&&diagnostic.fetch.queued===1,'Public worker census proves ten active and one queued');
 assert(!state.logs.join('').includes('UNEXPECTED_'),'Backend must remain held');
 state.phase='held';(document.getElementById('stop') as HTMLButtonElement).disabled=false;render();await persist();
}
async function stop(){
 assert(state.phase==='held','Held receipt first');state.phase='stopping';state.stop='pending';render();
 await execution.stop();state.stop='fulfilled';const exit=await execution.exited;
 assert(!exit.cleanupError,'No cleanup failure');await drained;
 state.runtimeStop='pending';render();await runtime.stop();state.runtimeStop='fulfilled';
 const receipt=await backend(true),diagnostic=await diagnoseWorkspace(workspace);state.events.push({backendAfterStop:receipt,exit,afterStopDiagnostic:diagnostic});
 assert(receipt.requests.length===10&&receipt.requests.every((r:{id:string})=>r.id!=='queued'),'Dead queued request never dispatched');
 assert(receipt.requests.every((r:{cancelled:boolean})=>r.cancelled),'Actual native header/body request cancellation required');
 assert(receipt.events.some((e:{type:string})=>e.type==='body-cancelled'),'Native body cancellation observed');
 assert(diagnostic.procs.length===0&&diagnostic.fetch.active===0&&diagnostic.fetch.queued===0&&diagnostic.fetch.inflight===0&&diagnostic.fetch.pinnedBodies===0&&diagnostic.fetch.cachedEntries===0,'Public post-stop census and fetch/pin/publication counters quiescent');
 state.sourceUnchanged=state.sourceHash===await hash(await workspace.fs.readFile('/native-egress.cjs'));assert(state.sourceUnchanged,'Source marker unchanged');
 state.phase='joined';(document.getElementById('close') as HTMLButtonElement).disabled=false;render();await persist();
}
async function close(){
 assert(state.phase==='joined','Public joins first');await workspace.close();state.workspaceClosed=true;state.phase='complete';render();await persist();
}
for(const [id,action] of [['start',start],['confirm',confirm],['stop',stop],['close',close]] as const)document.getElementById(id)!.addEventListener('click',()=>{(document.getElementById(id) as HTMLButtonElement).disabled=true;void action().catch(async error=>{state.phase='failed-owner-retained';state.errors.push(String(error));render();await persist();});});
render();
