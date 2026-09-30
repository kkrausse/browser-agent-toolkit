import {join,resolve} from 'node:path';
const output=resolve(process.argv[2]!);
const receipt=await Bun.file(join(output,'receipt.json')).json();
const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-store','Service-Worker-Allowed':'/'};
const server=Bun.serve({hostname:'127.0.0.1',port:43224,async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/')return new Response('<!doctype html><title>Exclusive OpenCode finite-reader reuse pilot</title><h1>Exclusive OpenCode finite-reader reuse pilot</h1><pre>Loading</pre><script type="module" src="/client/reuse-pilot-client.js"></script>',{headers:{...headers,'Content-Type':'text/html'}});
  if(path==='/evidence'&&request.method==='POST'){const text=await request.text(); if(await Bun.file(join(output,'live-evidence.json')).exists())return new Response('Already captured',{status:409}); await Bun.write(join(output,'live-evidence.json'),text);return new Response('retained');}
  let file:string|undefined;
  if(path==='/client/reuse-pilot-client.js')file=join(output,path.slice(1));
  else if(path.startsWith('/runtime/'))file=join(receipt.frozen,path.slice(1));
  else if(path.startsWith('/prepared/baseline/'))file=path.endsWith('/manifest.json')?join(receipt.frozen,'server-output/baseline/manifest.json'):join(receipt.frozen,'prepared',path.slice('/prepared/baseline/'.length));
  if(!file||path.includes('..')||!await Bun.file(file).exists())return new Response('Not found',{status:404,headers});
  const body=Bun.file(file);return new Response(body,{headers:{...headers,'Content-Type':body.type}});
}});
console.log(JSON.stringify({url:String(server.url),pid:process.pid,output}));
