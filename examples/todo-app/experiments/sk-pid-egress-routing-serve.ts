import {join,resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
if(process.env.SK_PID_EGRESS_ROUTING_AUTHORIZE!=='yes')throw Error('Explicit authorization required');
const stagePath=resolve(process.argv[2]??''),evidence=resolve(process.argv[3]??'');
if(!process.argv[3]||stagePath===evidence)throw Error('Separate new evidence directory');
const stage=await Bun.file(join(stagePath,'stage.json')).json();
for(const [file,digest] of Object.entries(stage.hashes))if(new Bun.CryptoHasher('sha256').update(await Bun.file(join(stagePath,file)).arrayBuffer()).digest('hex')!==digest)throw Error('Changed stage '+file);
await mkdir(evidence);
const events:unknown[]=[],routes:unknown[]=[],requests:{mode:string;pid:string;id:string;token:string;cancelled:boolean}[]=[];
let sequence=0,persisted=Promise.resolve();
const log=async(event:unknown)=>{events.push(event);const bytes=JSON.stringify({routes,requests,events},null,2);persisted=persisted.then(()=>writeFile(join(evidence,'backend.json'),bytes));await persisted;};
const observers=new Set<()=>void>();
const cancellationComplete=()=>requests.length===10&&requests.every(r=>r.cancelled)&&events.some(e=>(e as {type:string}).type==='body-cancelled');
const notify=()=>{if(cancellationComplete())for(const observer of observers)observer();};
const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin','Cache-Control':'no-store','Service-Worker-Allowed':'/'};
const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(request){
 const url=new URL(request.url),path=url.pathname;
 if(path==='/route'){
  const token=url.searchParams.get('token'),pid=url.searchParams.get('pid'),body=await request.text();
  if(token!==stage.token||request.method!=='POST'||body!=='ROUTE_REQUEST:'+stage.token)return new Response('Wrong cohort',{status:403,headers});
  const payload='ROUTE_OK:'+token+':'+pid;routes.push({url:request.url,method:request.method,pid,token,body,payload,time:Date.now()});await log({type:'routing-response',pid,token,payload,time:Date.now()});return new Response(payload,{headers});
 }
 if(path.startsWith('/backend/')){
  const mode=path.slice('/backend/'.length),token=url.searchParams.get('token')??'';if(!['headers','body'].includes(mode)||token!==stage.token)return new Response('Wrong cohort',{status:403,headers});
  const item={mode,pid:url.searchParams.get('pid')??'',id:url.searchParams.get('id')??'',token,cancelled:false};requests.push(item);await log({type:'request',url:request.url,...item,time:Date.now()});
  let resolve!: (r:Response)=>void;const held=new Promise<Response>(yes=>{resolve=yes;});
  request.signal.addEventListener('abort',()=>{item.cancelled=true;void log({type:'request-aborted',mode,pid:item.pid,id:item.id,time:Date.now()}).then(notify);if(mode==='headers')resolve(new Response('aborted',{headers}));},{once:true});
  if(mode==='headers')return held;
  return new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('NATIVE_BODY_MARKER'));void log({type:'body-enqueued',mode,pid:item.pid,id:item.id,time:Date.now()});},cancel(reason){item.cancelled=true;void log({type:'body-cancelled',mode,pid:item.pid,id:item.id,reason:String(reason),time:Date.now()}).then(notify);}}),{headers:{...headers,'content-type':'application/octet-stream'}});
 }
 if(path==='/backend-state'){
  if(url.searchParams.has('joined')&&!cancellationComplete()){
   const received=await new Promise<boolean>(resolve=>{const yes=()=>{clearTimeout(timer);observers.delete(yes);resolve(true);};const timer=setTimeout(()=>{observers.delete(yes);resolve(false);},10000);observers.add(yes);notify();});
   if(!received)return Response.json({error:'Cancellation observer deadline; not cleanup receipt',routes,requests,events},{status:504,headers});
  }
  await persisted;return Response.json({routes,requests,events},{headers});
 }
 if(path==='/stage')return Response.json({...stage,hashes:undefined,origin:String(server.url),hostPID:process.pid,clientSha256:stage.hashes['client/sk-pid-egress-routing-client.js']},{headers});
 if(path==='/evidence'&&request.method==='POST'){await writeFile(join(evidence,`browser-${sequence++}.json`),await request.text(),{flag:'wx'});return Response.json({saved:true},{headers});}
 if(path==='/favicon.ico')return new Response(null,{status:204,headers});
 if(path==='/')return new Response('<!doctype html><title>Host alias PID egress QA</title><h1>Host alias routing / native PID egress</h1><p>One tokenized routing preflight, then native held headers/body with public queue/stop receipts. No exotic backend or rollback claim.</p><button id="start">Prove single guest route</button><button id="hold" disabled>Start held native requests</button><button id="stop" disabled>Stop guest and runtime</button><button id="close" disabled>Close joined workspace</button><pre></pre><script type="module" src="/client/sk-pid-egress-routing-client.js"></script>',{headers:{...headers,'content-type':'text/html'}});
 const relative=path.slice(1);if(Object.hasOwn(stage.hashes,relative)&&(relative.startsWith('runtime/')||relative==='client/sk-pid-egress-routing-client.js')){const file=Bun.file(join(stagePath,relative));return new Response(file,{headers:{...headers,'content-type':file.type}});}
 return new Response('Not found',{status:404,headers});
}});
await writeFile(join(evidence,'host-owner.json'),JSON.stringify({pid:process.pid,url:String(server.url),stagePath,evidence,token:stage.token}),{flag:'wx'});console.log(JSON.stringify({pid:process.pid,url:String(server.url),evidence}));
process.on('SIGTERM',async()=>{await server.stop(true);await log({type:'host-stop',pid:process.pid,time:Date.now()});process.exit(0);});
