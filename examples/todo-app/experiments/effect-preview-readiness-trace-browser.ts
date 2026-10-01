// Runs in the Browser Control CLI's Playwright realm, not in the application.
export function installNativeObserverCode(origin: string, session: string) {
  return `if(state.previewNativeObserver)throw Error('Native observer already installed');
const origin=${JSON.stringify(origin)};
// CLI-owned, session-scoped native CDP reader. Flattened messages preserve the
// actual worker session IDs; no Target.sendMessageToTarget alias substitution.
const version=await fetch('http://127.0.0.1:19989/json/version',{headers:{'browser-control-session-id':${JSON.stringify(session)}}}).then(r=>r.json());
const socket=new WebSocket(version.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
const callbacks=new Map();const handlers=new Map();let commandId=0;
const cdp={send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++commandId;callbacks.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}}));});},on(event,fn){handlers.set(event,fn);},off(event){handlers.delete(event);}};
socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const cb=callbacks.get(m.id);if(cb){callbacks.delete(m.id);m.error?cb.reject(new Error(m.error.message)):cb.resolve(m.result);}return;}handlers.get(m.method)?.(m.params,m.sessionId);});
const record=state.previewNativeObserver={origin,events:[],dropped:0,bytes:0,errors:[],sessions:[],limit:{events:4096,bytes:2097152}};
const retain=(event,data)=>{const entry={wall:Date.now(),event,data};const text=JSON.stringify(entry);if(record.events.length>=record.limit.events||record.bytes+text.length>record.limit.bytes){record.dropped++;return;}record.bytes+=text.length;record.events.push(entry);};
const observers=[];const listen=(event,fn)=>{cdp.on(event,fn);observers.push([event,fn]);};
const fail=error=>{if(record.errors.length<32)record.errors.push(String(error));};
const safe=text=>String(text).replace(/\\b(?:Basic|Bearer)\\s+[A-Za-z0-9._~+\\/=-]+/gi,'[authorization redacted]');
const network=(source,method,p)=>{
 if(method==='Network.requestWillBeSent')retain('native.request',{source,id:p.requestId,url:p.request.url,method:p.request.method,type:p.type,mono:p.timestamp,wallTime:p.wallTime,initiator:p.initiator?.type,stack:p.initiator?.stack,redirect:p.redirectResponse&&{url:p.redirectResponse.url,status:p.redirectResponse.status}});
 else if(method==='Network.responseReceived')retain('native.response',{source,id:p.requestId,url:p.response.url,status:p.response.status,headers:p.response.headers,type:p.type,mono:p.timestamp,fromServiceWorker:p.response.fromServiceWorker,protocol:p.response.protocol});
 else if(method==='Network.loadingFinished')retain('native.eof',{source,id:p.requestId,bytes:p.encodedDataLength,mono:p.timestamp});
 else if(method==='Network.loadingFailed')retain('native.failure',{source,...p});
 else if(method==='Runtime.exceptionThrown')retain('native.exception',{source,...p});
 else if(method==='Runtime.executionContextCreated')retain('native.context',{source,context:p.context});
};
for(const method of ['Network.requestWillBeSent','Network.responseReceived','Network.loadingFinished','Network.loadingFailed','Runtime.exceptionThrown','Runtime.executionContextCreated'])listen(method,(p,s)=>network(s,method,p));
const scoped=new Set();const attached=new Set();const pending=new Set();
const attach=async info=>{
 if(!['page','worker','service_worker','shared_worker'].includes(info.type)||attached.has(info.targetId))return;
 attached.add(info.targetId);
 try{const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:info.targetId,flatten:true});record.sessions.push({targetId:info.targetId,sessionId,type:info.type,url:info.url});retain('native.attached',{targetId:info.targetId,sessionId});
 for(const method of ['Network.enable','Runtime.enable']){await cdp.send(method,{},sessionId);retain('native.enabled',{sessionId,method});}
 }catch(error){fail(error);}
};
const target=info=>{if(!(info.url?.startsWith(origin+'/')||info.url?.startsWith('blob:'+origin+'/')||scoped.has(info.openerId)))return;scoped.add(info.targetId);retain('native.target',info);const task=attach(info);pending.add(task);void task.finally(()=>pending.delete(task));};
listen('Target.targetCreated',p=>target(p.targetInfo));listen('Target.targetInfoChanged',p=>target(p.targetInfo));
listen('Target.targetDestroyed',p=>{if(scoped.has(p.targetId))retain('native.target-destroyed',p);});
const log=message=>{if(['warning','error'].includes(message.type()))retain('browser.console',{type:message.type(),text:safe(message.text()),location:message.location()});};
const pageError=error=>retain('browser.pageerror',{name:error.name,message:safe(error.message),stack:safe(error.stack)});
page.on('console',log);page.on('pageerror',pageError);
await cdp.send('Target.setDiscoverTargets',{discover:true});
const infos=(await cdp.send('Target.getTargets')).targetInfos;const pages=infos.filter(t=>t.type==='page');if(pages.length!==1||pages[0].url!=='about:blank')throw Error('Fresh session CDP page identity mismatch');scoped.add(pages[0].targetId);await attach(pages[0]);if(record.errors.length)throw Error('Native observer admission failed '+record.errors.join(';'));
state.previewNativeStop=async()=>{await Promise.allSettled([...pending]);for(const s of record.sessions){try{await cdp.send('Target.detachFromTarget',{sessionId:s.sessionId});}catch(error){fail(error);}}for(const [event,fn]of observers)cdp.off(event,fn);page.off('console',log);page.off('pageerror',pageError);await cdp.send('Target.setDiscoverTargets',{discover:false});await new Promise(resolve=>{socket.addEventListener('close',resolve,{once:true});socket.close();});return {detached:true,errors:record.errors,dropped:record.dropped};};
return {installed:true,origin};`;
}
