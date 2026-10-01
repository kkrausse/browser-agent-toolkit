import {Workspace,Runtime,opfsStore,diagnoseWorkspace} from '@kev-browser-agent-kit/workspace';
import {assertZeroWork,assertSingleKernelDiagnostics,childSyncProbe} from '../tests/single-kernel-contract';
import {minimalChildProbe,minimalSpawnProbe,spawnProbeFixture,type SpawnProbeMode} from '../tests/single-kernel-spawn-probes';
const manifest=await fetch('/runtime/distribution.json').then(response=>response.json());
if(manifest.topology?.policy!=='single-kernel')throw Error('Diagnostic requires a verified single-kernel distribution');
const distribution={name:'vivari',version:manifest.version,assetBaseUrl:'/runtime/'};
const evidence:any={version:manifest.version,revision:manifest.runtimeBuild.source.commit,deadlineMs:20000,status:'idle',events:[],probes:[],output:{},models:0};
let workspace:Workspace,runtime:Runtime,active=false,failed=false;
const attempted=new Set<string>();
const assert=(condition:unknown,message:string)=>{if(!condition)throw Error(message);};
function render(){document.querySelector('pre')!.textContent=JSON.stringify(evidence,null,2);}
async function diagnostics(){const value=await diagnoseWorkspace(workspace);assertSingleKernelDiagnostics(value);return value;}
async function stage(name:string,task:()=>Promise<unknown>,ms=20000){
  if(active||failed||attempted.has(name))throw Error('Diagnostic busy, failed, or already attempted');
  active=true;attempted.add(name);evidence.status=name;render();let timer:ReturnType<typeof setTimeout>;
  try{const result=await Promise.race([task(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(name+' '+ms+'ms deadline; unresolved owned work retained')),ms);})]);evidence.probes.push({name,result});evidence.status='ready';render();return result;}
  catch(error){failed=true;evidence.status='failed';evidence.error=String(error);render();throw error;}
  finally{active=false;clearTimeout(timer!);}
}
async function capture(stream:AsyncIterable<Uint8Array>,label:string){
  const channel=evidence.output[label]={bytes:0,text:''};const decoder=new TextDecoder();
  for await(const bytes of stream){channel.bytes+=bytes.length;assert(channel.bytes<=65536,'Diagnostic output exceeds tiny-probe bound');channel.text+=decoder.decode(bytes,{stream:true});}
  channel.text+=decoder.decode();return channel.text;
}
async function execute(name:string,source:string,expected?:string){
  await workspace.fs.writeFile('/diagnostic-parent.cjs',source);
  const execution=await runtime.node({entry:'/workspace/diagnostic-parent.cjs',cwd:'/workspace'});
  const stdout=capture(execution.stdout,name+'.stdout'),stderr=capture(execution.stderr,name+'.stderr');execution.closeStdin();
  const [out,err,exit]=await Promise.all([stdout,stderr,execution.exited]);
  assert(exit.exitCode===0&&exit.signal===null&&!exit.forced,name+' exit failure '+JSON.stringify(exit)+' '+err);
  if(expected!==undefined)assert(out===expected,name+' completion markers differ');
  const diag=await diagnostics();assertZeroWork(diag);return {out,err,exit,diagnostics:diag};
}
const api={evidence,diagnostics,
  open:()=>stage('open',async()=>{
    workspace=await Workspace.open({id:'default',storage:opfsStore(distribution),onDiagnostic:event=>evidence.events.push(event)});
    assert(workspace.persistence.status==='durable','Diagnostic persistence not durable');runtime=await Runtime.start({workspace,distribution});
    await workspace.fs.writeFile('/spawn-existing.txt',spawnProbeFixture);await workspace.fs.writeFile('/minimal-spawn-child.cjs',minimalChildProbe);
    return diagnostics();
  },60000),
  probe:(mode:SpawnProbeMode)=>stage('minimal-'+mode,async()=>{
    assert(['async','spawnSync','execSync'].includes(mode),'Unknown public spawn mode');
    if(mode!=='async')await workspace.fs.remove('/spawn-child-complete.txt');
    return execute(mode,minimalSpawnProbe(mode),'PARENT_BEFORE_'+mode+'\nPARENT_AFTER_'+mode+'\n');
  }),
  original:()=>stage('original-execSync-maxBuffer2097152',()=>execute('original',childSyncProbe)),
  close:()=>stage('healthy-close',async()=>{await runtime.stop();const zero=await diagnostics();assertZeroWork(zero);await workspace.close();return zero;}),
};
(window as any).singleKernelSpawnDiagnostic=api;render();
