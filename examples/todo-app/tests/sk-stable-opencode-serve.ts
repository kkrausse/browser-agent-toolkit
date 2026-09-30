import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
if(process.env.SK_STABLE_OPENCODE_AUTHORIZE_HOST!=='yes')throw Error('Separate parent live authorization required');
const output=resolve(process.argv[2]??'');
const stage=await Bun.file(join(output,'stage.json')).json();
const hash=async(path:string)=>new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
for(const [file,expected] of Object.entries(stage.stageHashes))if(await hash(join(output,file))!==expected)throw Error('Stage changed '+file);
for(const [file,expected] of Object.entries(stage.frozenHashes))if(await hash(join(stage.frozen,file))!==expected)throw Error('Frozen changed '+file);
if(await Bun.file(join(output,'owned-origin.json')).exists())throw Error('Origin already owned');
const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-store'};
let hostOwner:any,count=0,codecPending=0,captured=false,joined=false;
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const path=new URL(request.url).pathname;
 if(request.method==='GET'&&path==='/')return new Response('<!doctype html><title>Two immutable roots / one actual OpenCode</title><h1>Bounded shared-config routing toy</h1><p>No chat, inference, tools, SSE, eviction or root replacement. Server-owned ModelsDev refresh remains active.</p><button id="start">Start A0</button><button id="B" disabled>Activate B</button><button id="A" disabled>Return to A</button><button id="finish" disabled>Finish and join</button><p id="status"></p><pre id="snapshot"></pre><script type="module" src="/client/sk-stable-opencode-client.js"></script>',{headers:{...headers,'content-type':'text/html'}});
 if(request.method==='GET'&&path==='/inspect-empty')return new Response('<title>Fresh origin inspection</title>',{headers});
 if(request.method==='GET'&&path==='/stage')return Response.json({...stage,stageHashes:undefined,frozenHashes:undefined,hostOwner,clientSha256:stage.stageHashes['client/sk-stable-opencode-client.js']},{headers});
 if(path.startsWith('/prohibited-model/'))return new Response('Inference forbidden',{status:403,headers});
 if(request.method==='POST'&&['/response','/codec','/evidence','/failure'].includes(path)){
  const text=await request.text();if(text.length>8*1024*1024)return new Response('Too large',{status:413,headers});
  const record=JSON.parse(text),index=count++;
  if(path==='/response'||path==='/codec'){
   const bytes=Buffer.from(record.bodyBase64,'base64');if(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')!==record.sha256)throw Error('Response hash mismatch');
   await writeFile(join(output,path.slice(1)+'-'+index+'.json'),text,{flag:'wx'});
   if(path==='/codec'){
    codecPending++;
    try{const child=Bun.spawn(['node',join(output,'sk-stable-opencode-codec.mjs')],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});child.stdin.write(text);child.stdin.end();
     const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);await writeFile(join(output,'codec-result-'+index+'.json'),JSON.stringify({stdout,stderr,exit}),{flag:'wx'});
     if(exit)return new Response(stderr||stdout,{status:422,headers});return Response.json(JSON.parse(stdout),{headers});
    }finally{codecPending--;}
   }
   return Response.json({preserved:true},{headers});
  }
  if(path==='/failure'){await writeFile(join(output,'failure-'+index+'.json'),text,{flag:'wx'});return Response.json({preserved:true,ownerRetained:true},{headers});}
  if(captured||codecPending||record.status!=='bounded-toy-only'||record.retentionAccepted!==false||record.remoteZeroRef!==false||record.switches?.map((s:any)=>s.selected).join(',')!=='A,B,A'||record.starts!==1||record.deliveries!==1||record.exit?.exitCode!==0||record.exit?.signal!==null||record.exit?.forced!==false||record.zero?.procs?.length!==0||record.zero?.listeners?.length!==0||record.zero?.pendingHttp!==0)return new Response('Bounded final join receipt missing',{status:409,headers});
  captured=true;joined=true;await writeFile(join(output,'live-evidence.json'),text,{flag:'wx'});return Response.json({preserved:true},{headers});
 }
 if(request.method==='POST'&&path==='/host-join'){
  if(!joined||codecPending)return new Response('Guest final join required; uncertain owner retained',{status:409,headers});
  const response=Response.json({hostStopping:true,pid:process.pid},{headers});setTimeout(()=>void server.stop(false),50);return response;
 }
 let file:string|undefined;
 if(path==='/client/sk-stable-opencode-client.js')file=join(output,path.slice(1));
 else if(/^\/(runtime|prepared)\//.test(path)&&Object.hasOwn(stage.frozenHashes,path.slice(1)))file=join(stage.frozen,path.slice(1));
 if(!file)return new Response('Not found',{status:404,headers});const body=Bun.file(file);return new Response(body,{headers:{...headers,'content-type':body.type}});
}});
hostOwner={url:String(server.url),pid:process.pid,output,sourceRevision:stage.sourceRevision,ownerID:crypto.randomUUID(),retentionAccepted:false};
await writeFile(join(output,'owned-origin.json'),JSON.stringify(hostOwner),{flag:'wx'});console.log(JSON.stringify(hostOwner));
