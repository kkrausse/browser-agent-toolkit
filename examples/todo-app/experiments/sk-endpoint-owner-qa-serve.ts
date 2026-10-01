import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
if(process.env.SK_ENDPOINT_OWNER_QA_AUTHORIZE_HOST!=='yes')throw Error('Separate parent live authorization required');
const stagePath=resolve(process.argv[2]??'');
const stage=await Bun.file(join(stagePath,'stage.json')).json();
for(const [file,expected] of Object.entries(stage.hashes))if(new Bun.CryptoHasher('sha256').update(await Bun.file(join(stagePath,file)).arrayBuffer()).digest('hex')!==expected)throw Error('Stage changed '+file);
// Evidence and one-use origin ownership live outside immutable stage bytes.
const evidence=resolve(process.argv[3]??'');
if(!process.argv[3]||evidence===stagePath)throw Error('New explicit evidence directory required');
await import('node:fs/promises').then(fs=>fs.mkdir(evidence));
const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-store','Service-Worker-Allowed':'/'};
let count=0;
let origin='';
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const path=new URL(request.url).pathname;
 if(request.method==='GET'&&path==='/')return new Response('<!doctype html><title>Endpoint source ownership QA</title><h1>Held / rejected stream cancellation</h1><p>Real isolated workspace, public built runtime/controller. No inference. One fresh origin/profile per case. Rejected ownership is not normal close acceptance.</p><button id="start">Start owned fixture</button><button id="close" disabled>Close admission / hold cancel</button><button id="stop" disabled>Request runtime stop</button><button id="replace" disabled>Attempt replacement (public guard)</button><button id="release" disabled>Release / reject cancellation</button><pre></pre><script type="module" src="/client/sk-endpoint-owner-qa-client.js"></script>',{headers:{...headers,'content-type':'text/html'}});
 if(path==='/stage')return Response.json({...stage,hashes:undefined,origin,hostPID:process.pid,clientSha256:stage.hashes['client/sk-endpoint-owner-qa-client.js']},{headers});
 if(path==='/evidence'&&request.method==='POST'){
  const text=await request.text();if(text.length>4*1024*1024)return new Response('Too large',{status:413,headers});
  await writeFile(join(evidence,'browser-'+(count++)+'.json'),text,{flag:'wx'});return Response.json({saved:true},{headers});
 }
 const relative=path.slice(1);
 if(request.method==='GET'&&Object.hasOwn(stage.hashes,relative)&&(relative.startsWith('runtime/')||relative==='client/sk-endpoint-owner-qa-client.js')){
  const file=Bun.file(join(stagePath,relative));return new Response(file,{headers:{...headers,'content-type':file.type}});
 }
 return new Response('Not found',{status:404,headers});
}});
origin=String(server.url);
await writeFile(join(evidence,'host-owner.json'),JSON.stringify({url:String(server.url),pid:process.pid,stagePath,evidence}),{flag:'wx'});
console.log(JSON.stringify({url:String(server.url),pid:process.pid,evidence}));
