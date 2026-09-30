import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';

if(process.env.SK_OPENCODE_AUTHORIZE_HOST!=='yes')throw Error('Parent browser-slot authorization required: SK_OPENCODE_AUTHORIZE_HOST=yes');
const output=resolve(process.argv[2]??'');
const stage=await Bun.file(join(output,'stage.json')).json();
const hash=async(file:string)=>new Bun.CryptoHasher('sha256').update(await Bun.file(file).arrayBuffer()).digest('hex');
for(const [file,expected] of Object.entries(stage.stageHashes))if(await hash(join(output,file))!==expected)throw Error('Staged artifact changed '+file);
if(await hash(join(stage.frozen,'receipt.json'))!==stage.frozenReceiptSha256)throw Error('Frozen receipt changed');
for(const [file,expected] of Object.entries(stage.frozenHashes))if(await hash(join(stage.frozen,file))!==expected)throw Error('Frozen artifact changed '+file);
if(await Bun.file(join(output,'owned-origin.json')).exists())throw Error('Stage origin already owned; no host replacement');
const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-store','Service-Worker-Allowed':'/'};
let codecCount=0,codecPending=0,captured=false,hostJoinAllowed=false;
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const url=new URL(request.url),path=url.pathname;
 if(path==='/inspect-empty')return new Response('<!doctype html><title>Fresh origin inspection</title>',{headers});
 if(path==='/stage')return Response.json({...stage,clientSha256:stage.stageHashes['client/sk-opencode-live-client.js'],frozenHashes:undefined,stageHashes:undefined},{headers});
 if(path==='/')return new Response('<!doctype html><title>SK pinned mounted qualification — no retention</title><h1>Real OpenCode controller qualification</h1><p>No prompt, model, tool, reset or retention operation is exposed.</p><button id="start">Start one owned qualification</button><p id="status">awaiting-start</p><p>Native selected session: <strong id="session">None</strong></p><pre id="snapshot">Not mounted</pre><button id="admit" disabled>Confirm rendered empty idle root and join cleanup</button><script type="module" src="/client/sk-opencode-live-client.js"></script>',{headers:{...headers,'content-type':'text/html'}});
 if(path.startsWith('/prohibited-model/'))return new Response('Inference prohibited',{status:403,headers});
 if(path==='/codec'&&request.method==='POST'){
  codecPending++;const index=codecCount++;
  try{
   const raw=await request.text();if(raw.length>8*1024*1024)throw Error('Codec input too large');
   const record=JSON.parse(raw),bytes=Buffer.from(record.bodyBase64,'base64');
   if(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')!==record.sha256)throw Error('Raw response digest mismatch');
   const child=Bun.spawn(['node',join(output,'sk-opencode-live-codec.mjs')],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
   child.stdin.write(raw);child.stdin.end();
   const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   await writeFile(join(output,'codec-'+index+'.json'),JSON.stringify({record,stdout,stderr,exit}),{flag:'wx'});
   if(exit)throw Error(stderr||stdout);return Response.json(JSON.parse(stdout),{headers});
  }catch(error){return new Response(String(error),{status:422,headers});}finally{codecPending--;}
 }
 if(path==='/evidence'&&request.method==='POST'){
  if(captured||codecPending)return new Response('Already captured or codec work pending',{status:409,headers});
  const text=await request.text(),evidence=JSON.parse(text);
  if(!['failed','mounted-qualification-only'].includes(evidence.status)||evidence.retentionAccepted!==false||evidence.remoteZeroRef!==false)return new Response('Invalid terminal scope',{status:400,headers});
  captured=true;await writeFile(join(output,'live-evidence.json'),text,{flag:'wx'});
  hostJoinAllowed=evidence.status==='mounted-qualification-only'&&evidence.zero?.procs?.length===0&&evidence.zero?.listeners?.length===0&&evidence.zero?.pendingHttp===0&&evidence.executionExit?.exitCode===0&&evidence.executionExit?.forced===false&&evidence.executionExit?.signal===null;
  return Response.json({captured:true,sha256:new Bun.CryptoHasher('sha256').update(text).digest('hex')},{headers});
 }
 if(path==='/host-join'&&request.method==='POST'){
  if(!captured||!hostJoinAllowed||codecPending)return new Response('Successful guest join/zero-work receipt required; failed ownership retained',{status:409,headers});
  const response=Response.json({ownedHostStopping:true,pid:process.pid},{headers});setTimeout(()=>void server.stop(false),50);return response;
 }
 const decoded=decodeURIComponent(path);if(decoded.includes('..'))return new Response('Not found',{status:404,headers});
 let file:string|undefined;
 if(decoded==='/client/sk-opencode-live-client.js')file=join(output,decoded.slice(1));
 else if(/^\/(runtime|prepared)\//.test(decoded)&&Object.hasOwn(stage.frozenHashes,decoded.slice(1)))file=join(stage.frozen,decoded.slice(1));
 if(!file)return new Response('Not found',{status:404,headers});
 const body=Bun.file(file);return new Response(body,{headers:{...headers,'content-type':body.type}});
}});
await writeFile(join(output,'owned-origin.json'),JSON.stringify({url:String(server.url),pid:process.pid,output,sourceRevision:stage.sourceRevision,retentionAccepted:false}),{flag:'wx'});
console.log(JSON.stringify({url:String(server.url),pid:process.pid,output}));
