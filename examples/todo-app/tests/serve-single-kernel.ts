import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {assetHash} from '../../../workspace-api/scripts/runtime-assets';
import {fetchRequestHandler} from '@trpc/server/adapters/fetch';
import {appRouter} from '../src/server/trpcRouter';
import type {Todo} from '../src/schema/todo';

const output=resolve(process.argv[2]??'');
const receipt=await Bun.file(join(output,'receipt.json')).json();
for(const [file,hash] of Object.entries(receipt.hashes))if(assetHash(await readFile(join(output,file)))!==hash)throw Error('Frozen acceptance artifact mismatch: '+file);
const port=Number(process.argv[3]??0);
if(port!==0)throw Error('Use an OS-assigned fresh port; existing origins must remain untouched');
const todos=new Map<string,Todo>();
const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-store','Service-Worker-Allowed':'/'};
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/')return new Response('<!doctype html><title>Single-kernel correctness acceptance</title><h1>Single-kernel correctness acceptance</h1><iframe style="width:100%;height:450px"></iframe><pre>Loading isolated consumer</pre><script type="module" src="/client/single-kernel-client.js"></script>',{headers:{...headers,'Content-Type':'text/html'}});
  if(path.startsWith('/unused-model/'))return new Response('Model calls prohibited',{status:403,headers});
  if(path.startsWith('/api/'))return fetchRequestHandler({endpoint:'/api',req:request,router:appRouter,createContext:({req})=>({req,todos})});
  if(path==='/editing-policy')return Response.json({allowed:false},{headers});
  if(!/^\/(?:client|runtime|prepared)\//.test(path))return new Response('Not found',{status:404,headers});
  const file=resolve(output,'.'+decodeURIComponent(path));
  if(!file.startsWith(output+'/')||!Object.hasOwn(receipt.hashes,file.slice(output.length+1)))return new Response('Not found',{status:404,headers});
  const body=Bun.file(file);return new Response(body,{headers:{...headers,'Content-Type':body.type}});
}});
await Bun.write(join(output,'owned-origin.json'),JSON.stringify({url:String(server.url),pid:process.pid,output},null,2));
console.log(JSON.stringify({url:String(server.url),pid:process.pid,output}));
