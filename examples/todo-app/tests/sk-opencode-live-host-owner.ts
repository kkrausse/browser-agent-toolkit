import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';

// Parent may background this initiator, but must join its completion notification.
// No browser action, relay operation or guest execution is performed by this file.
if(process.env.SK_OPENCODE_AUTHORIZE_HOST!=='yes')throw Error('Parent browser-slot authorization required');
const output=resolve(process.argv[2]??'');
const stage=await Bun.file(join(output,'stage.json')).json();
const entry='source/examples/todo-app/tests/sk-opencode-live-serve.ts';
if(new Bun.CryptoHasher('sha256').update(await Bun.file(join(output,entry)).arrayBuffer()).digest('hex')!==stage.stageHashes[entry])throw Error('Owned host source changed');
if(await Bun.file(join(output,'owned-origin.json')).exists())throw Error('Never replace an owned origin');
await writeFile(join(output,'host-initiator.json'),JSON.stringify({pid:process.pid,output,stageSourceRevision:stage.sourceRevision}),{flag:'wx'});
const child=Bun.spawn(['bun',join(output,entry),output],{env:{...process.env,SK_OPENCODE_AUTHORIZE_HOST:'yes'},stdout:'pipe',stderr:'pipe'});
const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();
let exited=false;void child.exited.then(()=>{exited=true;});
while(!await Bun.file(join(output,'owned-origin.json')).exists()&&!exited)await Bun.sleep(100);
let origin:any;
if(await Bun.file(join(output,'owned-origin.json')).exists()){origin=await Bun.file(join(output,'owned-origin.json')).json();console.log(JSON.stringify({...origin,initiatorPID:process.pid,finish:'POST /host-join after success, or /failure-host-join ONLY after preserved failure and guarded cleanup; await initiator completion'}));}
// No timeout/force kill masquerading as a join. Parent owns escalation if retained.
const [out,err,exit]=await Promise.all([stdout,stderr,child.exited]);
const failureCleanup=await Bun.file(join(output,'failure-host-join-request.json')).exists();
const scope=failureCleanup?{kind:'guarded-failure-cleanup',qualificationPassed:false}:{kind:'mounted-foundation-host-cleanup'};
await writeFile(join(output,'host-process-join.json'),JSON.stringify({...scope,pid:child.pid,exit,stdout:out,stderr:err,stdoutJoined:true,stderrJoined:true}),{flag:'wx'});
if(exit||!origin)throw Error('Owned host failed: '+err);
const url=new URL(origin.url);
const absent=await new Promise<boolean>((resolve,reject)=>{
 const socket=createConnection({host:'127.0.0.1',port:Number(url.port)});
 socket.once('connect',()=>{socket.destroy();resolve(false);});
 socket.once('error',(error:NodeJS.ErrnoException)=>error.code==='ECONNREFUSED'?resolve(true):reject(error));
 socket.setTimeout(3000,()=>{socket.destroy();reject(Error('Listener absence uncertain'));});
});
if(!absent)throw Error('Owned host listener still present');
await writeFile(join(output,'host-listener-absence.json'),JSON.stringify({...scope,url:origin.url,listenerAbsent:true,childJoined:true,initiatorCompleting:true}),{flag:'wx'});
console.log(JSON.stringify({...scope,hostJoined:true,listenerAbsent:true,output}));
if(failureCleanup)throw Error('Qualification FAILED; guarded host cleanup joined, not a pass');
