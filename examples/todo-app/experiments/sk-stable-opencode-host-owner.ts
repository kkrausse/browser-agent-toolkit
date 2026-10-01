import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
if(process.env.SK_STABLE_OPENCODE_AUTHORIZE_HOST!=='yes')throw Error('Separate parent live authorization required');
const output=resolve(process.argv[2]??''),stage=await Bun.file(join(output,'stage.json')).json();
const entry='source/examples/todo-app/tests/sk-stable-opencode-serve.ts';
if(new Bun.CryptoHasher('sha256').update(await Bun.file(join(output,entry)).arrayBuffer()).digest('hex')!==stage.stageHashes[entry])throw Error('Frozen host source changed');
await writeFile(join(output,'host-initiator.json'),JSON.stringify({pid:process.pid,output}),{flag:'wx'});
const child=Bun.spawn(['bun',join(output,entry),output],{stdout:'pipe',stderr:'pipe'});
const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();let exited=false;void child.exited.then(()=>{exited=true;});
while(!await Bun.file(join(output,'owned-origin.json')).exists()&&!exited)await Bun.sleep(100);
let origin:any;if(await Bun.file(join(output,'owned-origin.json')).exists()){origin=await Bun.file(join(output,'owned-origin.json')).json();console.log(JSON.stringify({...origin,initiatorPID:process.pid,finish:'After Finish and join succeeds, POST /host-join; await this initiator completion. Failure retains ownership; no automatic force cleanup.'}));}
const [out,err,exit]=await Promise.all([stdout,stderr,child.exited]);
await writeFile(join(output,'host-process-join.json'),JSON.stringify({pid:child.pid,exit,stdout:out,stderr:err,stdoutJoined:true,stderrJoined:true,retentionAccepted:false}),{flag:'wx'});
if(exit||!origin)throw Error('Host failed '+err);
const absent=await new Promise<boolean>((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port:Number(new URL(origin.url).port)});socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',(error:NodeJS.ErrnoException)=>error.code==='ECONNREFUSED'?resolve(true):reject(error));socket.setTimeout(3000,()=>{socket.destroy();reject(Error('Listener absence uncertain'));});});
if(!absent)throw Error('Host listener retained');
await writeFile(join(output,'host-listener-absence.json'),JSON.stringify({url:origin.url,listenerAbsent:true,childJoined:true,retentionAccepted:false}),{flag:'wx'});console.log(JSON.stringify({hostJoined:true,output}));
