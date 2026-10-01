// One parent-authorized read-only debugger probe of the retained failed kernel.
// No work is started, no SAB/process fields are written, and resume runs finally.
const session = 'single-kernel-app-3abef79d';
const origin = 'http://127.0.0.1:62428/';
const pageTarget = 'AEFC36AB5EFB6EEB30E8FC0BA5B2D586';
const kernelTarget = '216A12FEAB92F224B74E6D32B324E4C8';
const output = '/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-kernel-probe-33e74eb.json';
if (page.url() !== origin) throw Error('Wrong retained kernel origin');
const version = await (await fetch('http://127.0.0.1:19989/json/version')).json();
const endpoint = new URL(version.webSocketDebuggerUrl);endpoint.searchParams.set('browserControlSessionId',session);
const socket = new WebSocket(endpoint);
const pending = new Map(), events = [];let sequence=0,targetSession;
const evidence={origin,session,pageTarget,kernelTarget,observedBindings:'kernel/filesystemRef/decodeRequest/decodeBytes exist verbatim in the receipted emitted worker',frames:[],availability:[],result:null,error:null,resumed:false,resumeError:null};
const bounded = promise => Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('5000ms read-only debugger observation deadline')),5000))]);
socket.addEventListener('message',event=>{
  const message=JSON.parse(String(event.data));
  if(message.id){const request=pending.get(message.id);pending.delete(message.id);if(message.error)request?.reject(Error(message.error.message));else request?.resolve(message.result);}
  else events.push(message);
});
const send=(method,params={},sessionId=undefined)=>bounded(new Promise((resolve,reject)=>{
  const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
}));
try{
  await bounded(new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});}));
  const root=await send('Target.attachToTarget',{targetId:pageTarget,flatten:true});
  await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},root.sessionId);
  const info=await send('Target.getTargetInfo',{targetId:kernelTarget});evidence.target=info.targetInfo;
  if(info.targetInfo.type!=='worker'||info.targetInfo.url!==origin+'runtime/assets/kernel-worker-W_1uBQG1.js?opfs-disable=')throw Error('Wrong observed kernel target');
  targetSession=(await send('Target.attachToTarget',{targetId:kernelTarget,flatten:true})).sessionId;
  await send('Debugger.enable',{},targetSession);
  await send('Debugger.pause',{},targetSession);
  const until=Date.now()+5000;
  while(!events.some(event=>event.sessionId===targetSession&&event.method==='Debugger.paused')&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
  const paused=events.find(event=>event.sessionId===targetSession&&event.method==='Debugger.paused');
  if(!paused)throw Error('No paused kernel frame became available without starting application work');
  evidence.reason=paused.params.reason;
  evidence.frames=paused.params.callFrames.map(({callFrameId,functionName,location,url,scopeChain})=>({callFrameId,functionName,location,url,scopes:scopeChain.map(({type,name,startLocation,endLocation})=>({type,name,startLocation,endLocation}))}));
  let selected;
  for(const frame of paused.params.callFrames){
    const available=await send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'({kernel:typeof kernel!=="undefined"&&kernel!==null,filesystem:typeof filesystemRef!=="undefined"&&filesystemRef!==null,decodeRequest:typeof decodeRequest==="function",decodeBytes:typeof decodeBytes==="function"})',returnByValue:true,silent:true},targetSession);
    evidence.availability.push({functionName:frame.functionName,location:frame.location,evaluation:available});
    if(available.result?.value?.kernel&&available.result.value.filesystem&&available.result.value.decodeRequest&&available.result.value.decodeBytes){selected=frame;break;}
  }
  if(!selected)throw Error('Observed paused frames do not expose the module bindings; no state was guessed');
  evidence.selectedFrame={functionName:selected.functionName,location:selected.location};
  const expression=`(()=>{
    const p=kernel.procs.get(2);const c=filesystemRef.server.clients.get(2);let request;
    try{const {fields}=decodeRequest(p.data.slice(0,Atomics.load(p.ctrl,2)));const s=JSON.parse(decodeBytes(fields[0]));request={command:s.command,args:s.args,cwd:s.cwd,capture:s.capture};}
    catch(e){request={decodeError:String(e)};}
    return {ctrl:Array.from(p.ctrl),request,nextPid:kernel.nextPid,pids:[...kernel.procs.keys()],sameFilesystemSab:c?.ctrl.buffer===p.ctrl.buffer,lazyCommands:[...kernel.lazyLoaders.keys()],lazyInflight:kernel.lazyInflight.size};
  })()`;
  evidence.result=await send('Debugger.evaluateOnCallFrame',{callFrameId:selected.callFrameId,expression,returnByValue:true,silent:true},targetSession);
  const {scriptSource}=await send('Debugger.getScriptSource',{scriptId:selected.location.scriptId},targetSession);
  const lines=scriptSource.split('\n'),line=selected.location.lineNumber;evidence.activeFrameSource=lines.slice(Math.max(0,line-5),line+6).join('\n');
}catch(error){evidence.error=String(error);}
finally{
  if(targetSession){try{await send('Debugger.resume',{},targetSession);evidence.resumed=true;}catch(error){evidence.resumeError=String(error);}}
  socket.close();
  await fs.promises.writeFile(output,JSON.stringify(evidence,null,2),{flag:'wx'});
}
return {output,...evidence};
