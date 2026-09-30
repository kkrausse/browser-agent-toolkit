import {join, resolve} from 'node:path'
import {mkdir, writeFile} from 'node:fs/promises'
import {fetchRequestHandler} from '@trpc/server/adapters/fetch'
import {appRouter} from '../src/server/trpcRouter'
import type {Todo} from '../src/schema/todo'
import {prospectivePolicy} from './matched-readiness'

// Future reviewed pair only. Offline preparation is a mandatory separate step.
// Run from repository root. Never overwrites a previous evidence directory.
const root=resolve('.diagnostics/phase4-clean-completion')
if (!process.env.MATCHED_CLIENT_PREPARATION || !process.env.MATCHED_EVIDENCE_DIRECTORY) throw Error('Require reviewed MATCHED_CLIENT_PREPARATION and a new MATCHED_EVIDENCE_DIRECTORY; do not use stale dist')
const preparation=resolve(process.env.MATCHED_CLIENT_PREPARATION)
const receipt=await Bun.file(join(preparation,'receipt.json')).json()
if(receipt.pin!=='446df00f86d5d6d5d856a2e5deec0fac49f242fa'||receipt.version!=='4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a')throw Error('Unqualified preparation identity')
for(const [key,value] of Object.entries(prospectivePolicy))if(receipt.prospectivePolicy[key]!==value)throw Error('Prepared budget mismatch: '+key)
for(const key of ['listenMs','connectMs','hydrationMs','overallMs'] as const)if(new URLSearchParams(receipt.policyQuery).get('readiness.'+key)!==String(prospectivePolicy[key]))throw Error('Prepared URL budget mismatch: '+key)
for(const [url,expected] of Object.entries(receipt.verified) as [string,{bytes:number;sha256:string}][]) {
  const path=url==='/prepared/baseline/manifest.json'?join(root,'server-output/baseline/manifest.json'):join(root,url.slice(1))
  const asset=new Uint8Array(await Bun.file(path).arrayBuffer())
  if(asset.length!==expected.bytes||new Bun.CryptoHasher('sha256').update(asset).digest('hex')!==expected.sha256)throw Error('Frozen artifact changed: '+url)
}
const bytes=new Uint8Array(await Bun.file(join(preparation,'client/performance-client.js')).arrayBuffer())
if(bytes.length!==receipt.client.bytes||new Bun.CryptoHasher('sha256').update(bytes).digest('hex')!==receipt.client.sha256)throw Error('Prepared consumer hash mismatch')
const evidence=resolve(process.env.MATCHED_EVIDENCE_DIRECTORY)
await mkdir(evidence)
await writeFile(join(evidence,'performance-client.js'),bytes,{flag:'wx'})
await writeFile(join(evidence,'preparation-receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'})
const html='<!doctype html><html><head><title>Phase9 matched restarted services</title></head><body><h1>Matched restarted-service experiment</h1><button disabled>Serial verifier owns switches</button><iframe style="width:100%;height:400px"></iframe><pre></pre><script type="module" src="/client/performance-client.js"></script></body></html>'
const servers=[43228,43229].map((port,index)=>{
 const todos=new Map<string,Todo>()
 return Bun.serve({hostname:'127.0.0.1',port,async fetch(request){
  const pathname=new URL(request.url).pathname
  const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-store','Service-Worker-Allowed':'/'}
   if(pathname==='/') {
     const parameters=new URL(request.url).searchParams
     const expected=new URLSearchParams(receipt.policyQuery)
     if(parameters.get('matched')!=='phase9'||parameters.get('variant')!==(index===0?'baseline':'dependencies')||[...expected].some(([key,value])=>parameters.get(key)!==value))return new Response('Frozen identical reviewed policy and condition URL required',{status:400,headers})
     return new Response(html,{headers:{...headers,'Content-Type':'text/html'}})
   }
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
