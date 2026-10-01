import {Workspace, Runtime, opfsStore, diagnoseWorkspace} from '@kev-browser-agent-kit/workspace'
import {managedDeliveryTool} from '@kev-browser-agent-kit/workspace/delivery'
import {installedTreeAuditTool} from '../tests/installed-tree-audit'

// One fresh-origin install, ten audits, no services/source switches/retries.
const evidence: any = {samples:[], events:[], status:'preparing'}
;(window as any).auditProfile = evidence
const output=document.querySelector('pre')!
const render=()=>{output.textContent=JSON.stringify(evidence,null,2)}
let ownedRuntime: Awaited<ReturnType<typeof Runtime.start>> | undefined
let ownedWorkspace: Workspace | undefined
try {
  const manifest=await (await fetch('/prepared/baseline/manifest.json')).json()
  const plan=await (await fetch('/plan.json')).json()
  const distribution={name:'vivari',version:manifest.runtimeVersion,assetBaseUrl:'/runtime/'}
  ownedWorkspace=await Workspace.open({id:'default',storage:opfsStore(distribution)})
  const initial=await ownedWorkspace.fs.readdir('/')
  if(initial.length) throw Error('Fresh-origin workspace not empty')
  const phases: Record<string,number>={}
  const tools={
    install:managedDeliveryTool({format:'managed-tree-v1', roots:['/workspace/node_modules','/workspace/.browser-editor-backends','/opencode-v2','/app'],entries:manifest.assets,bundle:manifest.bundle,image:manifest.image},{baseUrl:'/prepared/baseline/',signal:AbortSignal.timeout(180000)}),
    stream:installedTreeAuditTool(manifest.assets,{hashMode:'stream',profile:true,onTiming:(name,ms)=>{phases[name]=ms}}),
    direct:installedTreeAuditTool(manifest.assets,{hashMode:'direct',profile:true,onTiming:(name,ms)=>{phases[name]=ms}}),
  }
  const runtime=await Runtime.start({workspace:ownedWorkspace,distribution,tools})
  ownedRuntime=runtime
  await runtime.tools.install()
  await ownedWorkspace.flush()
  evidence.before=await diagnoseWorkspace(ownedWorkspace)
  evidence.status='auditing'; render()
  let canonical: string | undefined
  for(const [index,mode] of plan.order.entries()) {
    // Record consumption before launch. An error ends the fixed run, never re-arms.
    evidence.events.push({index,mode,event:'audit.consumed'}); render()
    const start=performance.now()
    const result=await runtime.tools[mode as 'stream'|'direct']()
    const milliseconds=performance.now()-start
    const {profile,...audit}=result as any
    evidence.samples.push({index,mode,milliseconds,phases:{...phases},audit,profile})
    if(!audit.valid || audit.checked!==manifest.assets.length) throw Error('Full-tree audit failed')
    const serialized=JSON.stringify(audit)
    if(canonical && serialized!==canonical) throw Error('Differential live inventory mismatch')
    canonical=serialized; render()
  }
  evidence.after=await diagnoseWorkspace(ownedWorkspace)
  evidence.status='complete'
} catch(error) {evidence.status='failed'; evidence.error=String(error)}
finally {
  try {await ownedRuntime?.stop(); await ownedWorkspace?.close(); evidence.cleanup='joined'}
  catch(error) {evidence.cleanup=String(error); evidence.status='failed'}
  render()
}
