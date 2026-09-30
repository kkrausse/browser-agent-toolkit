import {diagnoseWorkspace} from '@kev-browser-agent-kit/workspace';
import {WorkspaceController} from '@kev-browser-agent-kit/workspace/react';
import {installOpenCodeConfig, loadPrepared, preparedApps, createOpenCodeCandidateLaunch, openCodeCandidateLaunch as descriptor} from '@kev-browser-agent-kit/opencode-chat/browser';
import {createChatController} from '../../../opencode-chat/src/controller';
import type {ChatController} from '../../../opencode-chat/src/types';
import {createPilotFence, resetPilot, pilotReuseAllowed, pilotRequestURL} from './reuse-pilot-fence';
import {assertPilotRoot} from './reuse-pilot-contract';

// One-shot fresh-origin owner. No public/UI actions or execution endpoints.
const policy = {coldMs:90000, requestMs:20000, resetMs:60000, drainMs:20000, cleanupMs:15000};
const evidence: any = {label:'fresh-contract-preflight-controlled-reuse',policy, attempts:{cold:0,reset:0}, events:[], requests:[], samples:[], status:'preparing'};
const owner = new WorkspaceController({onDiagnostic:event=>evidence.events.push(event),captureProcessOutput:true});
let chat: ChatController | undefined;
let firstFence: ReturnType<typeof createPilotFence> | undefined;
let secondFence: ReturnType<typeof createPilotFence> | undefined;
let stopped = false;
const assert = (condition: unknown, message: string) => {if(!condition) throw Error(message);};
async function timed<T>(name: string, task: () => Promise<T>) { const started=performance.now(); try {return await task();} finally {evidence.samples.push({name,ms:performance.now()-started});} }
async function bounded<T>(task: () => Promise<T>, ms: number) {let timer: ReturnType<typeof setTimeout>; try {return await Promise.race([task(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{stopped=true; reject(Error('Pilot deadline '+ms));},ms);})]);} finally {clearTimeout(timer!);} }
function render() {document.querySelector('pre')!.textContent=JSON.stringify(evidence,null,2);}
async function run() {
  const watchdog=setTimeout(()=>{stopped=true;evidence.status='failed';evidence.error='180000ms observation deadline; unresolved work retained';render();},180000);
  try {
    const manifest=await loadPrepared('/prepared/baseline/',owner.signal);
    const workspace=await owner.open({name:'vivari',version:manifest.runtimeVersion,assetBaseUrl:'/runtime/'});
    const runtime=await owner.startRuntime({apps:preparedApps(manifest,'/prepared/baseline/',owner.signal,text=>evidence.events.push({delivery:text}))});
    await timed('environment.deliver',()=>runtime.tools.apps());
    await installOpenCodeConfig(workspace,{modelBaseURL:location.origin+'/unused-model/'});
    const original=JSON.parse(new TextDecoder().decode(await workspace.fs.readFile(descriptor.workspaceConfigPath)));
    const pluginPaths=['/.server/config/opencode/plugins/editor-model-headers.js','/.server/config/opencode/plugins/editor-javascript.js'];
    const pluginBytes=await Promise.all(pluginPaths.map(p=>workspace.fs.readFile(p).then(b=>Array.from(b))));
    const identity={location:'/workspace',modelConfig:JSON.stringify(original),pluginBytes:JSON.stringify(pluginBytes),dependencies:JSON.stringify(manifest.dependencies),environment:'same launch',cwd:'/app',runtime:manifest.runtimeVersion};
    assert(pilotReuseAllowed(identity,{...identity}),'Identity comparator'); evidence.admission={identity,exclusive:true,noExecution:true};
    const write=async (marker: string) => {assert(!stopped,'Stopped before source write'); await workspace.fs.writeFile('/pilot-source.txt',marker); assert(!stopped,'Stopped before config write'); await workspace.fs.writeFile(descriptor.workspaceConfigPath,JSON.stringify({...original,username:'reuse-pilot-'+marker})); await workspace.flush();};
    await write('A');
    const password=crypto.randomUUID()+crypto.randomUUID(); const authorization='Basic '+btoa('opencode:'+password);
    const query=new URLSearchParams({'location[directory]':'/workspace'}).toString();
    let endpoint: any;
    const transport=async (input: string,init: RequestInit={}) => {assert(!stopped,'Pilot stopped'); const headers=new Headers(init.headers); headers.set('authorization',authorization); return endpoint.fetch(input,{...init,headers});};
    const makeFence=(admin=false) => {const fence=createPilotFence(transport,admin,endpoint.url,true); evidence.requests.push(fence.records); return fence;};
    const json=async (fence: ReturnType<typeof createPilotFence>,path: string,method='GET') => (await fence.fetch(pilotRequestURL(endpoint.url,path),{method,signal:AbortSignal.timeout(policy.requestMs)})).json();
    const qualify=async (fence: ReturnType<typeof createPilotFence>,marker: string) => {
      const health=await json(fence,descriptor.healthPath); assert(health.healthy && health.version==='2.0.3','Pinned health');
      await fence.fetch(pilotRequestURL(endpoint.url,descriptor.activation.path),{method:'POST',signal:AbortSignal.timeout(policy.requestMs)});
      const plugins=await json(fence,descriptor.pluginPath); for(const id of ['editor.model-headers','editor.javascript']) assert(plugins.data.some((p:any)=>p.id===id&&p.state?.status==='active'),'Plugin '+id);
      const configs=await json(fence,descriptor.configAPIPath); const config=configs.find((c:any)=>c.type==='document'&&c.path===descriptor.configPath);
      assert(config?.info?.username==='reuse-pilot-'+marker,'Fresh config '+marker);
      const project=await json(fence,'/api/project/current?'+query);
      const models=await json(fence,descriptor.modelPath); assert(models.data.some((m:any)=>m.id===descriptor.model.id&&m.enabled),'Model catalog only');
      evidence[marker]={health,config:config.info,project,plugins}; return health;
    };
    const attach=async (fence: ReturnType<typeof createPilotFence>,marker:string) => {
      chat=createChatController({endpoint:{url:endpoint.url,fetch:fence.fetch},directory:'/workspace',startNewSession:true,handshakeTimeoutMs:policy.requestMs});
      await chat.ready; const snapshot=chat.getSnapshot(); assert(!snapshot.error&&!snapshot.loading&&snapshot.sessionID&&snapshot.messages.length===0,'Fresh hydrated empty '+marker);
      const sessionEnvelope=await json(fence,'/api/session/'+snapshot.sessionID);
      evidence[marker].sessionEnvelope=sessionEnvelope; evidence[marker].snapshot=snapshot;
      evidence[marker].session=assertPilotRoot(sessionEnvelope,snapshot.sessionID!);
      assert(evidence[marker].session.projectID===evidence[marker].project.id&&snapshot.execution==='idle'&&snapshot.permissions.length===0&&snapshot.questions.length===0,'Fresh idle project session '+marker);
    };
    evidence.attempts.cold++; evidence.status='cold'; render();
    const service=await timed('cold.launch-through-hydration',()=>bounded(async()=>{
      const service=await owner.launch('chat',createOpenCodeCandidateLaunch({password,ripgrepBinDirectory:manifest.opencode.support.binDirectory}),descriptor.port,async exposed=>{
        endpoint=exposed; firstFence=makeFence(); await timed('cold.readiness',()=>qualify(firstFence!,'A'));
        return {url:exposed.url,fetch:firstFence.fetch};
      },{shutdown:'stdin-eof',timeoutMs:10000},{listenMs:60000,connectMs:45000,overallMs:90000});
      await timed('cold.client-hydration',()=>attach(firstFence!,'A')); return service;
    },policy.coldMs));
    evidence.before=await diagnoseWorkspace(workspace);
    assert(evidence.before.procs.length===1&&evidence.before.listeners.length===1&&evidence.before.listeners[0]===4096,'Exclusive server ownership');
    evidence.endpoint=endpoint.url; // Password is never retained.
    evidence.attempts.reset++; evidence.status='reset'; render();
    const admin=makeFence(true);
    await timed('reset.total',()=>bounded(()=>resetPilot({fence:firstFence!,deadlineMs:policy.drainMs,
      dispose:()=>timed('reset.dispose',async()=>{await chat!.dispose(); evidence.outgoingDisposed=true;}),
      evict:()=>timed('reset.DELETE',async()=>{evidence.resetAdmission={exclusive:true,finiteNormal:firstFence!.records.filter(r=>r.state==='normal').length,unresolved:firstFence!.records.filter(r=>r.state==='pending'||r.state==='failed').length,localDisposed:evidence.outgoingDisposed,zeroRefs:'inferred from owned finite normal handler completion; not a remote receipt'}; assert(evidence.resetAdmission.unresolved===0&&evidence.outgoingDisposed,'Reset admission'); await admin.fetch(pilotRequestURL(endpoint.url,'/api/debug/location?'+query),{method:'DELETE',signal:AbortSignal.timeout(policy.requestMs)}); evidence.evicted=true;}),
      replace:()=>timed('reset.source-config-write',()=>write('B')),
      acquire:()=>timed('reset.reinit-hydration',async()=>{secondFence=makeFence(); await qualify(secondFence,'B'); await attach(secondFence,'B');}),
    }),policy.resetMs));
    assert(evidence.A.health.pid===evidence.B.health.pid,'PID stable');
    assert(evidence.A.session.id!==evidence.B.session.id,'Distinct session');
    assert(JSON.stringify(evidence.A.project)===JSON.stringify(evidence.B.project),'Same-directory project resolution');
    assert(JSON.stringify(pluginBytes)===JSON.stringify(await Promise.all(pluginPaths.map(p=>workspace.fs.readFile(p).then(b=>Array.from(b))))),'Plugins unchanged');
    assert(new TextDecoder().decode(await workspace.fs.readFile('/pilot-source.txt'))==='B','Source B');
    evidence.after=await diagnoseWorkspace(workspace); assert(evidence.after.procs.length===1,'No execution children');
    await timed('cleanup',()=>bounded(async()=>{secondFence!.freeze(); await secondFence!.drain(policy.drainMs); await chat!.dispose(); await owner.stopServices(); await service.drained; evidence.exit=await service.execution.exited; evidence.zero=await diagnoseWorkspace(workspace); assert(evidence.zero.procs.length===0&&evidence.zero.listeners.length===0&&evidence.zero.pendingHttp===0,'Final zero work'); await owner.close();},policy.cleanupMs));
    assert(!stopped,'Stopped before success'); evidence.status='passed';
  } catch(error) {stopped=true;evidence.status='failed'; evidence.error=String(error); evidence.stack=error instanceof Error?error.stack:undefined; /* First failure: retain owned page/server. No DELETE, retry or replacement cleanup. */}
  clearTimeout(watchdog); render(); return evidence;
}
(window as any).reusePilot={evidence,done:run()};
