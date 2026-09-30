import {Workspace,opfsStore,diagnoseWorkspace} from '@kev-browser-agent-kit/workspace';
import {assertSingleKernelDiagnostics,assertZeroWork} from './single-kernel-contract';
const manifest=await fetch('/runtime/distribution.json').then(r=>r.json());
const distribution={name:'vivari',version:manifest.version,assetBaseUrl:'/runtime/'};
const evidence:any={version:manifest.version,revision:manifest.runtimeBuild.source.commit,steps:[],status:'idle'};
let workspace:Workspace|undefined,active=false,failed=false;const attempted=new Set<string>();
const check=(v:unknown,m:string)=>{if(!v)throw Error(m);};
const binary=()=>Uint8Array.from({length:1048583},(_,i)=>i%251);
async function diagnostics(){const d=await diagnoseWorkspace(workspace!);assertSingleKernelDiagnostics(d);assertZeroWork(d);check((d as any).spawnCapture?.ownedSpills===0,'Reload spill records');return d;}
async function open(){workspace=await Workspace.open({id:'default',storage:opfsStore(distribution)});check(workspace.persistence.status==='durable','Reload durability');}
async function close(){const zero=await diagnostics();await workspace!.flush();await workspace!.close();workspace=undefined;return zero;}
async function run(name:string,task:()=>Promise<unknown>){if(active||failed||attempted.has(name))throw Error('Reload action busy/failed/replayed');active=true;attempted.add(name);let timer:ReturnType<typeof setTimeout>;try{const result=await Promise.race([task(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Reload '+name+' 60000ms deadline; work retained')),60000);})]);evidence.steps.push({name,result});evidence.status='ready';return result;}catch(error){failed=true;evidence.status='failed';evidence.error=String(error);throw error;}finally{clearTimeout(timer!);active=false;document.querySelector('pre')!.textContent=JSON.stringify(evidence,null,2);}}
const api={evidence,
  seed:()=>run('seed',async()=>{await open();await workspace!.fs.writeFile('/reload-marker.txt','e35eab4 real document reload');await workspace!.fs.mkdir('/reload-old');await workspace!.fs.writeFile('/reload-old/binary.dat',binary());await workspace!.fs.rename('/reload-old/binary.dat','/reload-old/renamed.dat');await workspace!.fs.writeFile('/reload-old/deleted.txt','must disappear');await workspace!.fs.remove('/reload-old/deleted.txt');return close();}),
  verify:()=>run('verify-reload',async()=>{await open();check(new TextDecoder().decode(await workspace!.fs.readFile('/reload-marker.txt'))==='e35eab4 real document reload','Reload marker');const bytes=await workspace!.fs.readFile('/reload-old/renamed.dat');check(bytes.length===1048583&&bytes.every((b,i)=>b===i%251),'Reload exact binary');let absent=false;try{await workspace!.fs.readFile('/reload-old/deleted.txt');}catch(e){absent=String(e).includes('ENOENT');}check(absent,'Reload deleted file restored');return {bytes:bytes.length,deletedAbsent:absent,zero:await close()};}),
};
(window as any).singleKernelReload=api;
