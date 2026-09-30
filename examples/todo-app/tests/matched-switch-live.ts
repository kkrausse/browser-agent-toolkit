import {join, resolve} from 'node:path'
import {mkdir, writeFile} from 'node:fs/promises'
import {fetchRequestHandler} from '@trpc/server/adapters/fetch'
import {appRouter} from '../src/server/trpcRouter'
import type {Todo} from '../src/schema/todo'

// Phase9 only: unchanged frozen runtime/payload, separately built example client.
// Run from repository root. Never overwrites a previous evidence directory.
const root=resolve('.diagnostics/phase4-clean-completion')
const evidence=resolve('.diagnostics/phase9-matched-switch-20260929')
await mkdir(evidence)
const built=await Bun.build({entrypoints:[resolve('examples/todo-app/tests/performance-client.ts')],target:'browser',minify:false,plugins:[{name:'canonical-workspace',setup(build){
  build.onResolve({filter:/^@kev-browser-agent-kit\/workspace(?:\/(?:react|delivery|diagnostics))?$/},args=>({path:resolve('workspace-api/dist/lib',(args.path.split('/')[2]??'index')+'.js')}))
  build.onResolve({filter:/^@kev-browser-agent-kit\/opencode-chat\/browser$/},()=>({path:resolve('opencode-chat/dist/browser.js')}))
}}]})
if(!built.success) throw new AggregateError(built.logs,'Phase9 client build failed')
const client=built.outputs[0]!
await writeFile(join(evidence,'performance-client.js'),new Uint8Array(await client.arrayBuffer()),{flag:'wx'})
const html='<!doctype html><html><head><title>Phase9 matched restarted services</title></head><body><h1>Matched restarted-service experiment</h1><button disabled>Serial verifier owns switches</button><iframe style="width:100%;height:400px"></iframe><pre></pre><script type="module" src="/client/performance-client.js"></script></body></html>'
const servers=[43226,43227].map(port=>{
 const todos=new Map<string,Todo>()
 return Bun.serve({hostname:'127.0.0.1',port,async fetch(request){
  const pathname=new URL(request.url).pathname
  const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-store','Service-Worker-Allowed':'/'}
  if(pathname==='/')return new Response(html,{headers:{...headers,'Content-Type':'text/html'}})
  if(pathname==='/inspect-empty')return new Response('<!doctype html><title>Script-free origin inspection</title>',{headers:{...headers,'Content-Type':'text/html'}})
  if(pathname.startsWith('/api/'))return fetchRequestHandler({endpoint:'/api',req:request,router:appRouter,createContext:({req})=>({req,todos})})
  if(pathname==='/editing-policy')return Response.json({allowed:false})
  let filePath:string|undefined
  if(pathname==='/prepared/baseline/manifest.json')filePath=join(root,'server-output/baseline/manifest.json')
  else if(pathname.startsWith('/prepared/baseline/'))filePath=join(root,'prepared',pathname.slice('/prepared/baseline/'.length))
  else if(pathname.startsWith('/runtime/'))filePath=join(root,'runtime',pathname.slice('/runtime/'.length))
  else if(pathname==='/client/performance-client.js')filePath=join(evidence,'performance-client.js')
  if(!filePath||pathname.split('/').includes('..')||!await Bun.file(filePath).exists())return new Response('Not found',{status:404,headers})
  const file=Bun.file(filePath);return new Response(file,{headers:{...headers,'Content-Type':file.type}})
 }})
})
console.log(JSON.stringify({pid:process.pid,origins:servers.map(server=>server.url.href),evidence}))
