import {expect,test} from 'bun:test'
import {runInNewContext} from 'node:vm'
import {resolve} from 'node:path'

// Execute the actual bundled consumer with host-only adapter doubles. No browser,
// guest, service, source install on disk, or PDF action is started by these controls.
const adapter = `
const h=globalThis.h;
export class WorkspaceController {
  signal=new AbortController().signal; snapshot={services:{},error:''}; listeners=new Set();
  constructor(){h.controller=this}
  getSnapshot=()=>this.snapshot;
  subscribe=(fn)=>{this.listeners.add(fn);return()=>this.listeners.delete(fn)};
  async open(){h.calls.push('open');return this.workspace??={flush:async()=>{},fs:{readFile:async path=>typeof h.files[path]==='string'?new TextEncoder().encode(h.files[path]):Uint8Array.from(atob(h.files[path].data),character=>character.charCodeAt(0)),readdir:async()=>Object.keys(h.files).map(path=>path.slice(1))}}}
  async close(){h.calls.push('close');await this.stopRuntime();this.workspace=undefined}
  async startRuntime(tools){h.calls.push('runtime');return this.runtime={tools}}
  async stopRuntime(){h.calls.push('runtime.stop');await this.stopServices();this.runtime=undefined}
  async stopServices(){h.calls.push('services.stop');this.snapshot.services={}}
  async launch(name){h.calls.push('launch.'+name);const service={endpoint:{url:'http://fake',fetch:async()=>h.delayBody?{ok:true,arrayBuffer:async()=>{await new Promise(resolve=>setTimeout(resolve,20));h.calls.push('body.settled');return new ArrayBuffer(0)}}:new Response('ok'),attachPreview:()=>{h.calls.push('attach');return {dispose(){}}}},execution:{exited:new Promise(()=>{})},drained:new Promise(()=>{}),failed:new Promise(()=>{})};this.snapshot.services[name]=service;return service}
  registerAttachment(){} clientReady(){}
}
export const clearWorkspace=async()=>{h.calls.push('clear');h.files={}};
export const diagnoseWorkspace=async()=>({procs:[],listeners:[],pendingHttp:0,fetch:{inflight:0,queued:0,active:0}});
export const diagnoseWorkspaceEntry=async()=>({});
export const installSource=async(_,source)=>{h.calls.push('install');h.files={...source}};
export const experimentalSourceReplacementTool=source=>async()=>{h.calls.push('replace');if(h.replaceError){h.files['/partial']='retained failure';throw Error('partial replacement')}h.files={...source};return {}};
export const loadPrepared=async()=>h.manifest;
export const preparedApps=()=>async()=>{h.calls.push('deliver')};
export const installOpenCodeConfig=async()=>{};
export const startOpenCode=async controller=>{await controller.launch('chat');if(h.chatTerminalDuringPreview)setTimeout(()=>{controller.snapshot.error='chat died during aggregate qualification';for(const listener of controller.listeners)listener()},5);if(h.chatError){await new Promise(resolve=>setTimeout(resolve,5));throw Error('chat qualification failed')}};
export const createDiagnosticScope=()=>({});
export const installedTreeAuditTool=()=>async()=>{h.calls.push('audit');const result=h.audits.shift();if(result instanceof Error)throw result;return result??{valid:true,checked:1,cacheDigest:'cache-a'}};
`
const build=await Bun.build({entrypoints:[resolve(import.meta.dir,'performance-client.ts')],target:'browser',plugins:[{name:'host-only-controls',setup(build){
  build.onResolve({filter:/^@kev-browser-agent-kit\//},args=>({path:args.path,namespace:'controls'}))
  build.onResolve({filter:/installed-tree-audit$/},args=>({path:args.path,namespace:'controls'}))
  build.onLoad({filter:/.*/,namespace:'controls'},()=>({contents:adapter,loader:'js'}))
}}]})
if(!build.success)throw new AggregateError(build.logs)
const client=await build.outputs[0]!.text()
async function cohort(audits: unknown[]=[], replaceError=false, faults: {delayBody?:boolean;chatError?:boolean;chatTerminalDuringPreview?:boolean}={}) {
  const h:any={calls:[],files:{},audits,replaceError,...faults,manifest:{runtimeVersion:'pin',dependencies:{policy:{runtimeVersion:'pin'}},assets:[],preview:{entry:'vite'},project:{'/src/home.tsx':"import { useState } from 'react'; export default function Home() {return <h1>Todos</h1>}",'/vite.config.ts':'defineConfig({})','/package.json':'{}','/bun.lock':'lock','/react-router.config.ts':'router','/tsconfig.json':'{}'}}}
  const pre={textContent:''}
  const iframe={contentDocument:{querySelector:()=>({})}}
  const window:any={}
  const context={h,window,document:{querySelector:(name:string)=>name==='pre'?pre:iframe},location:{origin:'http://host-only.invalid',search:'?matched=phase9&variant=dependencies'},URLSearchParams,AbortController,AbortSignal,TextEncoder,TextDecoder,Response,performance,setTimeout,clearTimeout,console:{info(){},error(){}},atob}
  await runInNewContext('(async()=>{'+client+'})()',context)
  const api=window.editorPerformanceExperiment
  // Make owned mock executions observable on driver stop (real joins tested in
  // workspace-api service-readiness.test.ts, not inferred from this double).
  h.releaseServices=()=>{for(const service of Object.values(h.controller.snapshot.services) as any[]){service.execution.exited=Promise.resolve({exitCode:0});service.drained=Promise.resolve()}}
  return {h,api}
}
test('actual consumer routes before-retain invalidity and audit exceptions through reset and stops without incoming launches',async()=>{
  for(const failure of [{valid:false,checked:0,reason:'invalid'},new Error('audit exception')]) {
    const {h,api}=await cohort([{valid:true,checked:1,cacheDigest:'cache-a'},failure])
    expect(api.ready).toBe(true)
    const launches=h.calls.filter((call:string)=>call.startsWith('launch.')).length
    h.releaseServices()
    await expect(api.switchWorkspace()).rejects.toThrow('full reset fallback completed')
    expect(h.calls).toContain('clear')
    expect(h.calls).not.toContain('replace')
    expect(h.calls.at(-1)).toBe('services.stop')
    expect(h.calls.filter((call:string)=>call.startsWith('launch.')).length).toBe(launches)
    expect(api.ready).toBe(false)
  }
})
test('actual consumer cache mismatch, invalid post-audit and post-audit exception all reset and stop',async()=>{
  for(const failure of [{valid:true,checked:1,cacheDigest:'cache-b'},{valid:false,checked:0,cacheDigest:'cache-a'},new Error('after audit exception')]) {
    const {h,api}=await cohort([{valid:true,checked:1,cacheDigest:'cache-a'},{valid:true,checked:1,cacheDigest:'cache-a'},failure])
    h.releaseServices()
    await expect(api.switchWorkspace()).rejects.toThrow('full reset fallback completed')
    expect(h.calls).toContain('replace')
    expect(h.calls.filter((call:string)=>call.startsWith('launch.'))).toEqual(['launch.vite','launch.chat'])
    expect(h.controller.runtime).toBeUndefined()
  }
})
test('actual partial source replacement preserves failed tree and blocks incoming launch/rearm',async()=>{
  const {h,api}=await cohort([],true);h.releaseServices()
  const clears=h.calls.filter((call:string)=>call==='clear').length
  await expect(api.switchWorkspace()).rejects.toThrow('partial replacement')
  expect(h.files['/partial']).toBe('retained failure')
  expect(h.calls.filter((call:string)=>call==='clear').length).toBe(clears)
  expect(h.calls.filter((call:string)=>call.startsWith('launch.'))).toEqual(['launch.vite','launch.chat'])
  await expect(api.rearm()).rejects.toThrow('Rearm requires')
})
test('actual driver service-only stop and same-generation rearm preserve workspace and generation',async()=>{
  const {h,api}=await cohort();h.releaseServices()
  const workspace=h.controller.workspace
  await api.stopServices()
  expect(api.ready).toBe(false)
  expect(h.controller.workspace).toBe(workspace)
  expect(h.calls).not.toContain('close')
  await api.rearm()
  expect(api.ready).toBe(true)
  expect((await api.verifySource()).generation).toBe(1)
  expect(api.resetEvidence.at(-1)).toMatchObject({phase:'services.same-generation.rearmed',generation:1,measured:false})
})
test('actual consumer terminal controller error invalidates already-published aggregate readiness',async()=>{
  const {h,api}=await cohort()
  h.controller.snapshot.error='chat died after individual readiness'
  for(const listener of h.controller.listeners)listener()
  expect(api.ready).toBe(false)
  expect(api.error).toContain('chat died')
})
test('actual consumer sibling failure joins late HTTP completion and forbids attachment/readiness',async()=>{
  const {h,api}=await cohort([],false,{delayBody:true,chatError:true})
  expect(api.error).toContain('chat qualification failed')
  expect(api.ready).toBe(false)
  expect(h.calls).toContain('body.settled')
  expect(h.calls).not.toContain('attach')
})
test('actual consumer monitors already-ready OpenCode throughout sibling aggregate qualification',async()=>{
  const {h,api}=await cohort([],false,{delayBody:true,chatTerminalDuringPreview:true})
  expect(api.error).toContain('chat died during aggregate qualification')
  expect(api.ready).toBe(false)
  expect(h.calls).toContain('body.settled')
  expect(h.calls).not.toContain('attach')
})
