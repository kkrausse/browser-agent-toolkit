import {join,resolve} from 'node:path';
const output=resolve(process.argv[2]!);
const receipt=await Bun.file(join(output,'receipt.json')).json();
const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-store','Service-Worker-Allowed':'/'};
const chunks=new Map<string,string[]>();
const server=Bun.serve({hostname:'127.0.0.1',port:Number(process.argv[3]??43224),async fetch(request){
  const path=new URL(request.url).pathname;
   if(path==='/')return new Response('<!doctype html><title>Exclusive OpenCode lifecycle pilot</title><h1>Exclusive OpenCode lifecycle pilot</h1><pre>Loading</pre><script type="module" src="/client/'+(receipt.entry??'reuse-pilot-client')+'.js"></script>',{headers:{...headers,'Content-Type':'text/html'}});
   const capture=path.match(/^\/evidence\/(restart|reuse)\/(\d+|complete)$/);
   if(capture&&request.method==='POST'){
     const name=capture[1]!,part=capture[2]!,file=join(output,'live-'+name+'.json');
     if(await Bun.file(file).exists())return new Response('Already captured',{status:409});
     if(part!=='complete'){const body=await request.text(),list=chunks.get(name)??[];if(Number(part)!==list.length||body.length>65536)return new Response('Chunk order/size',{status:400});list.push(body);chunks.set(name,list);await Bun.write(join(output,name+'-chunk-'+part+'.txt'),body);return Response.json({index:Number(part),bytes:Buffer.byteLength(body)});}
     const manifest=await request.json() as {chunks:number;bytes:number;sha256:string};const list=chunks.get(name)??[],text=list.join(''),hash=new Bun.CryptoHasher('sha256').update(text).digest('hex');
     if(list.length!==manifest.chunks||Buffer.byteLength(text)!==manifest.bytes||hash!==manifest.sha256)return new Response('Incomplete export',{status:400});
     const data=JSON.parse(text);if(data.condition!==name||!['passed','failed'].includes(data.status))return new Response('Nonterminal evidence',{status:400});await Bun.write(file,text);await Bun.write(join(output,'export-'+name+'.json'),JSON.stringify({...manifest,validated:true}));chunks.delete(name);return Response.json({...manifest,validated:true,status:data.status});
   }
  if(path==='/evidence'&&request.method==='POST'){const text=await request.text(); if(await Bun.file(join(output,'live-evidence.json')).exists())return new Response('Already captured',{status:409}); await Bun.write(join(output,'live-evidence.json'),text);return new Response('retained');}
  let file:string|undefined;
   if(path==='/client/'+(receipt.entry??'reuse-pilot-client')+'.js')file=join(output,path.slice(1));
  else if(path.startsWith('/runtime/'))file=join(receipt.frozen,path.slice(1));
  else if(path.startsWith('/prepared/baseline/'))file=path.endsWith('/manifest.json')?join(receipt.frozen,'server-output/baseline/manifest.json'):join(receipt.frozen,'prepared',path.slice('/prepared/baseline/'.length));
  if(!file||path.includes('..')||!await Bun.file(file).exists())return new Response('Not found',{status:404,headers});
  const body=Bun.file(file);return new Response(body,{headers:{...headers,'Content-Type':body.type}});
}});
console.log(JSON.stringify({url:String(server.url),pid:process.pid,output}));
