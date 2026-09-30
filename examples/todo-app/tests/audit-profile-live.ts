import {mkdir, writeFile, unlink} from 'node:fs/promises'
import {join,resolve} from 'node:path'

// Offline verification/build followed by a sole new, bounded origin server.
// No runtime rebuild, preparation refresh, stale-origin adoption or switch driver.
const root=resolve('.')
const frozen=join(root,'.diagnostics/phase4-clean-completion')
const preparation=join(root,'.diagnostics/ownership-fixed-pair-prep-20260930')
const evidence=resolve(process.env.AUDIT_EVIDENCE_DIRECTORY ?? '')
if(!process.env.AUDIT_EVIDENCE_DIRECTORY) throw Error('Require distinct new AUDIT_EVIDENCE_DIRECTORY')
await mkdir(evidence)
const receipt=await Bun.file(join(preparation,'receipt.json')).json()
// The ownership receipt reuses its original reviewed library artifacts.
const libraries=resolve(receipt.runtimeSource,'..')
if(receipt.pin!=='446df00f86d5d6d5d856a2e5deec0fac49f242fa') throw Error('Wrong pin')
const hash=async(path:string)=>{const bytes=new Uint8Array(await Bun.file(path).arrayBuffer()); return {bytes:bytes.length,sha256:new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}}
for(const [url,expected] of Object.entries(receipt.verified)) {
  const path=url==='/prepared/baseline/manifest.json'?join(frozen,'server-output/baseline/manifest.json'):join(frozen,url.slice(1))
  if(JSON.stringify(await hash(path))!==JSON.stringify(expected)) throw Error('Frozen asset changed: '+url)
}
for(const [file,expected] of Object.entries(receipt.packagedHashes)) {
  if((file.startsWith('workspace/index.') || file.startsWith('workspace/delivery.') || file.startsWith('workspace/diagnostics.')) && JSON.stringify(await hash(join(libraries,file)))!==JSON.stringify(expected)) throw Error('Reviewed workspace artifact changed: '+file)
}
const manifest=await Bun.file(join(frozen,'server-output/baseline/manifest.json')).json()
for(const asset of [...manifest.assets.filter((entry:any)=>entry.kind==='file'),manifest.bundle,manifest.image]) {
  const actual=await hash(join(frozen,'prepared',asset.file))
  if(actual.bytes!==asset.bytes || actual.sha256!==asset.sha256) throw Error('Frozen payload changed: '+asset.file)
}
const plan={pin:receipt.pin,version:receipt.version,baseline:5,candidate:5,order:['stream','direct','direct','stream','stream','direct','direct','stream','stream','direct'],retries:0,resets:0,switches:0,services:0,models:0,profile:true,entries:manifest.assets.length,managedFileChecks:manifest.assets.filter((entry:any)=>entry.kind==='file').length,port:43231}
await writeFile(join(evidence,'plan.json'),JSON.stringify(plan,null,2),{flag:'wx'})
const built=await Bun.build({entrypoints:[join(root,'examples/todo-app/tests/audit-profile-client.ts')],outdir:evidence,target:'browser',plugins:[{name:'reviewed-frozen-workspace',setup(build){
  build.onResolve({filter:/^@kev-browser-agent-kit\/workspace(?:\/delivery)?$/},args=>({path:join(libraries,'workspace',args.path.endsWith('/delivery')?'delivery.js':'index.js')}))
}}]})
if(!built.success) throw new AggregateError(built.logs,'Consumer build failed')
await writeFile(join(evidence,'identity.json'),JSON.stringify({plan,client:await hash(join(evidence,'audit-profile-client.js')),manifest:await hash(join(frozen,'server-output/baseline/manifest.json')),workspaceIndex:await hash(join(libraries,'workspace/index.js')),workspaceDelivery:await hash(join(libraries,'workspace/delivery.js'))},null,2),{flag:'wx'})
const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-store','Service-Worker-Allowed':'/'}
const lock=join(root,'.diagnostics/matched-pair-initiator.lock')
await writeFile(lock,JSON.stringify({pid:process.pid,task:'bounded-audit-profile',evidence}),{flag:'wx'})
let consumed=false
let server: ReturnType<typeof Bun.serve>
try {server=Bun.serve({hostname:'127.0.0.1',port:plan.port,async fetch(request){
  const path=new URL(request.url).pathname
  if(path==='/') {
    if(consumed) return new Response('Run consumed; no reload or retry',{status:409,headers})
    consumed=true
    return new Response('<!doctype html><title>Bounded full-tree audit profiling</title><pre>Preparing</pre><script type="module" src="/audit-profile-client.js"></script>',{headers:{...headers,'Content-Type':'text/html'}})
  }
  let file:string|undefined
  if(path==='/audit-profile-client.js'||path==='/plan.json') file=join(evidence,path.slice(1))
  else if(path==='/prepared/baseline/manifest.json') file=join(frozen,'server-output/baseline/manifest.json')
  else if(path.startsWith('/prepared/baseline/')) file=join(frozen,'prepared',path.slice('/prepared/baseline/'.length))
  else if(path.startsWith('/runtime/')) file=join(frozen,path.slice(1))
  if(!file||path.split('/').includes('..')||!await Bun.file(file).exists()) return new Response('Not found',{status:404,headers})
  const asset=Bun.file(file); return new Response(asset,{headers:{...headers,'Content-Type':asset.type}})
}})} catch(error) {await unlink(lock); throw error}
console.log(JSON.stringify({pid:process.pid,origin:server.url.href,evidence,plan}))
process.on('SIGTERM',async()=>{server.stop(true);await unlink(lock);process.exit(0)})
