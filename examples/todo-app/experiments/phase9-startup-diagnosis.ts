import {createHash} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'

// Offline receipt analysis, never launches/reopens a guest or changes old evidence.
const evidence=resolve(process.argv[2] ?? '.diagnostics/phase9-startup-diagnosis-20260929')
await mkdir(evidence)
const write=async (name:string,value:unknown) => writeFile(join(evidence,name),JSON.stringify(value,null,2),{flag:'wx'})
const hash=(bytes:Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const prior=resolve('.diagnostics/phase9-matched-switch-20260929')
const inventory=[]
for(const path of new Bun.Glob('**/*').scanSync({cwd:prior,onlyFiles:true})) {
  const bytes=new Uint8Array(await Bun.file(join(prior,path)).arrayBuffer())
  inventory.push({path,bytes:bytes.length,sha256:hash(bytes)})
}
await write('prior-evidence-inventory.json',inventory.sort((a,b)=>a.path.localeCompare(b.path)))
const baseline=await Bun.file(join(prior,'receipts/reset-1790731428301.json')).json()
const reuse=await Bun.file(join(prior,'receipts/reset-1790731479826.json')).json()
const unique=new Map<string,any>()
for(const path of new Bun.Glob('services/reset-*.json').scanSync({cwd:'.diagnostics/phase7-service-qualification-20260929'})) {
  const receipt=await Bun.file('.diagnostics/phase7-service-qualification-20260929/'+path).json()
  for(const event of receipt.evidence.events) if(event.event==='service.listen.ready') unique.set(event.id,event)
}
await write('receipt-analysis.json',{
  phase7ListenerEvents:[...unique.values()].sort((a,b)=>a.time.localeCompare(b.time)),
  phase9:[baseline,reuse].map(receipt=>({url:receipt.url,status:receipt.status,stage:receipt.stage,
    samples:receipt.evidence.samples,
    startupEvents:receipt.evidence.events.filter((e:any)=>e.event.startsWith('service.')||e.event.startsWith('guest.')||e.event.startsWith('opencode.')||e.event==='activity'),
    initialAudit:receipt.evidence.resetEvidence,
  })),
  sameLaunchDescriptors:JSON.stringify(baseline.evidence.events.filter((e:any)=>e.event==='service.launch').map((e:any)=>e.data))===JSON.stringify(reuse.evidence.events.filter((e:any)=>e.event==='service.launch').map((e:any)=>e.data)),
  baselineCleanupObservation:(await Bun.file(join(prior,'baseline-cleanup.json')).json()).before,
  newStartupAttempts:0,measuredSwitches:0,
})
const frozen=resolve('.diagnostics/phase4-clean-completion')
const served=(await Bun.file(join(prior,'identities.json')).json())[0].served
const artifacts=[]
for (const [path,identity] of Object.entries(served) as [string,{bytes:number;sha256:string}][]) {
  const file=path.startsWith('/runtime/') ? join(frozen,path.slice(1))
    : path==='/prepared/baseline/manifest.json' ? join(frozen,'server-output/baseline/manifest.json')
    : path==='/client/performance-client.js' ? join(prior,'performance-client.js') : undefined
  if(!file) throw Error('Unknown frozen artifact '+path)
  const bytes=new Uint8Array(await Bun.file(file).arrayBuffer())
  if(bytes.length!==identity.bytes||hash(bytes)!==identity.sha256) throw Error('Frozen artifact mismatch '+path)
  artifacts.push({path,...identity})
}
await write('frozen-served-artifacts.json',artifacts)
const manifest=await Bun.file(join(frozen,'server-output/baseline/manifest.json')).json()
const distribution=await Bun.file(join(frozen,'runtime/distribution.json')).json()
if(distribution.runtimeBuild.source.commit!=='446df00f86d5d6d5d856a2e5deec0fac49f242fa'||manifest.runtimeVersion!==distribution.version||manifest.dependencies.policy.runtimeVersion!==distribution.version) throw Error('Frozen runtime identity mismatch')
let files=0
for(const entry of manifest.assets) if(entry.kind==='file') {
  const bytes=new Uint8Array(await Bun.file(join(frozen,'prepared',entry.file)).arrayBuffer())
  if(bytes.length!==entry.bytes||hash(bytes)!==entry.sha256) throw Error('Payload mismatch '+entry.destination)
  files++
}
const payloads=[]
for(const kind of ['image','bundle']) {
  const entry=manifest[kind],bytes=new Uint8Array(await Bun.file(join(frozen,'prepared',entry.file)).arrayBuffer())
  if(bytes.length!==entry.bytes||hash(bytes)!==entry.sha256) throw Error('Original payload mismatch '+kind)
  payloads.push({kind,bytes:bytes.length,sha256:hash(bytes)})
}
await write('frozen-identity.json',{runtimeSource:distribution.runtimeBuild.source.commit,distribution:distribution.version,managedEntries:manifest.assets.length,files,payloads})
// Typecheck changed sources without replacing existing generated libraries/runtime.
const root=resolve('.')
const paths={'@kev-browser-agent-kit/workspace/react':[join(root,'workspace-api/src/react.tsx')]}
const bunTypes=join(root,'examples/todo-app/node_modules/@types/bun')
await write('opencode-source.tsconfig.json',{extends:join(root,'opencode-chat/tsconfig.json'),compilerOptions:{noEmit:true,baseUrl:root,types:[bunTypes],paths},include:[join(root,'opencode-chat/src')]})
await write('example-source.tsconfig.json',{extends:join(root,'examples/todo-app/tsconfig.json'),compilerOptions:{baseUrl:root,types:[bunTypes,join(root,'examples/todo-app/node_modules/vite/client')],paths:{'@/*':[join(root,'examples/todo-app/src/*')],...paths,'@kev-browser-agent-kit/opencode-chat/browser':[join(root,'opencode-chat/src/browser.ts')]}},include:[join(root,'examples/todo-app/**/*.ts'),join(root,'examples/todo-app/**/*.tsx'),join(root,'examples/todo-app/.react-router/types/**/*')],exclude:[join(root,'examples/todo-app/node_modules'),join(root,'examples/todo-app/build')]})
console.log(JSON.stringify({evidence,priorFiles:inventory.length,verifiedManagedFiles:files,payloads,newStartupAttempts:0,measuredSwitches:0}))
