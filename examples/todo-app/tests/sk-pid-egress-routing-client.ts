import {Workspace,Runtime,opfsStore,diagnoseWorkspace,type Execution} from '@kev-browser-agent-kit/workspace';
const state={scope:'supported-host-alias-native-routing',phase:'idle',token:'',guestPID:0,workspaceId:'',sourceHash:'',sourceUnchanged:false,events:[] as unknown[],logs:[] as string[],errors:[] as string[],stop:'not-requested',runtimeStop:'not-requested',readersJoined:false,workspaceClosed:false,evidencePersisted:false};
let workspace:Workspace,runtime:Runtime,execution:Execution,drained:Promise<void>;
const render=()=>{document.querySelector('pre')!.textContent=JSON.stringify(state,null,2);};
const assert=(ok:unknown,message:string)=>{if(!ok)throw Error(message);};
const hash=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),b=>b.toString(16).padStart(2,'0')).join('');
const backend=async(joined=false)=>{const response=await fetch('/backend-state'+(joined?'?joined=1':''));assert(response.ok,'Backend observer receipt');return await response.json();};
const save=async()=>{const response=await fetch('/evidence',{method:'POST',body:JSON.stringify(state)});assert(response.ok,'Evidence persistence');state.evidencePersisted=true;render();};
const enable=(id:string)=>{(document.getElementById(id) as HTMLButtonElement).disabled=false;};
async function until(predicate:()=>Promise<boolean>|boolean,label:string){
 const deadline=Date.now()+15000;
 while(!await predicate()){
  assert(!state.logs.join('').includes('GUEST_REQUEST_ERROR:'),'Actual guest request error: '+state.logs.join(''));
  assert(Date.now()<deadline,'Observer deadline: '+label+'; not a cleanup receipt');
  await new Promise(resolve=>setTimeout(resolve,50));
 }
}
Object.defineProperty(window,'pidEgressRoutingQA',{get:()=>JSON.parse(JSON.stringify(state))});
window.addEventListener('error',e=>{state.errors.push(e.message);render();});
window.addEventListener('unhandledrejection',e=>{state.errors.push(String(e.reason));render();});
async function start(){
 assert(state.phase==='idle','One-shot cohort');state.phase='preflight-starting';render();
 const root=await navigator.storage.getDirectory();for await(const key of (root as unknown as {keys():AsyncIterable<string>}).keys())throw Error('Nonempty origin: '+key);
 assert((await indexedDB.databases()).length===0&&(await caches.keys()).length===0&&(await navigator.serviceWorker.getRegistrations()).length===0&&localStorage.length===0,'Fresh origin');
 const stage=await (await fetch('/stage')).json();state.events.push(stage);state.token=stage.token;
 assert(stage.runtimeRevision==='33fa1359a003ca9c50cb3bc49699b99bc1a063f1'&&stage.toolkitRevision==='d0eec346dbc749db1c0cd82dd8aad0b27c1da363','Exact source');
 assert(stage.origin===location.origin+'/','Exact owned origin/port');
 assert(await hash(new Uint8Array(await (await fetch('/client/sk-pid-egress-routing-client.js')).arrayBuffer()))===stage.clientSha256,'Consumer identity');
 const host=new URL(stage.origin);assert(host.hostname==='127.0.0.1'&&host.protocol==='http:'&&host.port,'Explicit local host policy');
 const aliasBase=new URL('http://host.vivari.internal:'+host.port+'/').origin;
 state.events.push({aliasBase,rewriteTarget:host.origin,policy:'same port; alias hostname rewritten by unchanged kernel-fetch'});
 const distribution={name:'vivari',version:stage.version,assetBaseUrl:'/runtime/'};
 workspace=await Workspace.open({id:'default',storage:opfsStore(distribution)});state.workspaceId=workspace.id;runtime=await Runtime.start({workspace,distribution});
 const guest=`const http=require('node:http');const base=${JSON.stringify(aliasBase)},token=${JSON.stringify(stage.token)};const pid=process.pid;console.log('ROUTING_GUEST_PID:'+pid);const url=base+'/route?token='+token+'&pid='+pid;const preflight=http.request(url,{method:'POST'},res=>{let payload='';res.setEncoding('utf8');res.on('data',x=>payload+=x);res.on('end',()=>{console.log('ROUTE_STATUS:'+res.statusCode);console.log('ROUTE_PAYLOAD:'+payload);console.log('ROUTE_READY');});});preflight.on('error',e=>console.log('GUEST_REQUEST_ERROR:preflight:'+e.message));preflight.end('ROUTE_REQUEST:'+token);process.stdin.resume();let started=false;process.stdin.on('data',()=>{if(started)return;started=true;const plan=Array.from({length:9},(_,i)=>['headers','header-'+i]).concat([['body','body'],['headers','queued']]);for(const [mode,id] of plan){console.log('HELD_ISSUE:'+id);const req=http.get(base+'/backend/'+mode+'?token='+token+'&pid='+pid+'&id='+id,res=>{console.log('UNEXPECTED_RESPONSE:'+id);res.on('data',()=>{});res.on('end',()=>console.log('UNEXPECTED_END:'+id));});req.on('error',e=>console.log('GUEST_REQUEST_ERROR:'+id+':'+e.message));}});`;
 await workspace.fs.writeFile('/routing-egress.cjs',guest);state.sourceHash=await hash(await workspace.fs.readFile('/routing-egress.cjs'));
 execution=await runtime.node({entry:'/workspace/routing-egress.cjs',cwd:'/workspace'});
 const read=async(stream:AsyncIterable<Uint8Array>,channel:string)=>{for await(const bytes of stream){state.logs.push(channel+':'+new TextDecoder().decode(bytes));render();}};
 drained=Promise.all([read(execution.stdout,'stdout'),read(execution.stderr,'stderr')]).then(()=>{state.readersJoined=true;render();});
 void execution.exited.then(exit=>{state.events.push({publicExit:exit});render();});
 await until(()=>state.logs.join('').includes('ROUTE_READY'),'single routing response');
 state.guestPID=Number(state.logs.join('').match(/ROUTING_GUEST_PID:(\d+)/)?.[1]);assert(state.guestPID>0,'Actual PID');
 const expected='ROUTE_OK:'+stage.token+':'+state.guestPID;
 assert(state.logs.join('').includes('ROUTE_STATUS:200\n')&&state.logs.join('').includes('ROUTE_PAYLOAD:'+expected+'\n'),'Exact tokenized guest response');
 const receipt=await backend();state.events.push({routingReceipt:receipt,preflightDiagnostic:await diagnoseWorkspace(workspace)});
 assert(receipt.routes.length===1&&receipt.routes[0].pid===String(state.guestPID)&&receipt.routes[0].token===stage.token&&receipt.routes[0].body==='ROUTE_REQUEST:'+stage.token&&receipt.routes[0].payload===expected,'One actual owned host route, exact token/PID/body/response');
 assert(receipt.requests.length===0,'No held cohort before successful routing');state.phase='routing-proved';enable('hold');render();await save();
}
async function hold(){
 assert(state.phase==='routing-proved','Routing preflight first');state.phase='holding';render();execution.writeStdin(new TextEncoder().encode('BEGIN_HELD\n'));
 await until(async()=>{const receipt=await backend();return receipt.requests.length===10&&state.logs.join('').includes('HELD_ISSUE:queued');},'ten actual held requests');
 const receipt=await backend(),diagnostic=await diagnoseWorkspace(workspace);state.events.push({backendHeld:receipt,heldDiagnostic:diagnostic});
 assert(receipt.requests.every((r:{pid:string;token:string;cancelled:boolean;id:string})=>r.pid===String(state.guestPID)&&r.token===state.token&&!r.cancelled&&r.id!=='queued'),'Exact held owner and queued non-dispatch');
 assert(receipt.events.some((e:{type:string})=>e.type==='body-enqueued'),'Actual native body stream admitted');
 assert(diagnostic.procs.some(p=>p.pid===state.guestPID)&&diagnostic.fetch.active===10&&diagnostic.fetch.queued===1,'Public worker pool proves ten active/one queued');
 assert(!state.logs.join('').includes('UNEXPECTED_'),'Held backend still pending');state.phase='held';enable('stop');render();await save();
}
async function stop(){
 assert(state.phase==='held','Held public checkpoint first');state.phase='stopping';state.stop='pending';render();await execution.stop();state.stop='fulfilled';const exit=await execution.exited;
 assert(!exit.cleanupError,'No cleanup failure');await drained;state.runtimeStop='pending';render();await runtime.stop();state.runtimeStop='fulfilled';
 const receipt=await backend(true),diagnostic=await diagnoseWorkspace(workspace);state.events.push({backendAfterStop:receipt,exit,afterStopDiagnostic:diagnostic});
 assert(receipt.requests.length===10&&receipt.requests.every((r:{cancelled:boolean;id:string})=>r.cancelled&&r.id!=='queued'),'All actual native requests cancelled; dead queued request never dispatched');
 assert(receipt.events.some((e:{type:string})=>e.type==='body-cancelled'),'Native response-body cancellation');
 assert(diagnostic.procs.length===0&&diagnostic.fetch.active===0&&diagnostic.fetch.queued===0&&diagnostic.fetch.inflight===0&&diagnostic.fetch.pinnedBodies===0&&diagnostic.fetch.cachedEntries===0,'Public stopped census/fetch/pin/cache counters zero');
 state.sourceUnchanged=state.sourceHash===await hash(await workspace.fs.readFile('/routing-egress.cjs'));assert(state.sourceUnchanged,'Exact guest source unchanged');
 state.phase='joined';enable('close');render();await save();
}
async function close(){assert(state.phase==='joined','Joins required');await workspace.close();state.workspaceClosed=true;state.phase='complete';render();await save();}
for(const [id,action] of [['start',start],['hold',hold],['stop',stop],['close',close]] as const)document.getElementById(id)!.addEventListener('click',()=>{(document.getElementById(id) as HTMLButtonElement).disabled=true;void action().catch(async error=>{state.phase='failed-owner-retained';state.errors.push(String(error));render();await save();});});
render();
