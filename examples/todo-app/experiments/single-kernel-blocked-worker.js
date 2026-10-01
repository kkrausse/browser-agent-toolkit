// Browser Control --file diagnostic, after a retained first failure. Attach only
// the exact owned process target; always resume it and close this raw client.
// Override these two evidence constants for a separately authorized repair run.
const targetID = '4E5F03019AEA084B110F06CB01741A3A';
const output = '/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-live-33e74eb-attempt1/blocked-worker-stack.json';
if (page.url() !== 'http://127.0.0.1:62428/') throw Error('Wrong retained acceptance page');
const version = await (await fetch('http://127.0.0.1:19989/json/version')).json();
const endpoint = new URL(version.webSocketDebuggerUrl);
endpoint.searchParams.set('browserControlSessionId','single-kernel-app-3abef79d');
const socket = new WebSocket(endpoint);
let sequence = 0, sessionID;
const pending = new Map();
const events = [];
const deadline = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error('3000ms diagnostic deadline')), 3000))]);
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data));
  if (message.id) { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request?.reject(Error(message.error.message)); else request?.resolve(message.result); }
  else events.push(message);
});
async function send(method, params = {}, targetSession = undefined) {
  return deadline(new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method, params, ...(targetSession ? {sessionId:targetSession} : {})}));
  }));
}
try {
  await deadline(new Promise((resolve, reject) => {socket.addEventListener('open', resolve, {once:true});socket.addEventListener('error', reject, {once:true});}));
  const root = await send('Target.attachToTarget',{targetId:'AEFC36AB5EFB6EEB30E8FC0BA5B2D586',flatten:true});
  await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},root.sessionId);
  const info = await send('Target.getTargetInfo', {targetId:targetID});
  if (info.targetInfo.type !== 'worker' || info.targetInfo.url !== 'http://127.0.0.1:62428/runtime/assets/process-worker-vyBhnbjL.js') throw Error('Wrong owned worker');
  sessionID = (await send('Target.attachToTarget', {targetId:targetID, flatten:true})).sessionId;
  await send('Debugger.enable', {}, sessionID);
  await send('Debugger.pause', {}, sessionID);
  const until = Date.now() + 3000;
  while (!events.some(event => event.sessionId === sessionID && event.method === 'Debugger.paused') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  const paused = events.find(event => event.sessionId === sessionID && event.method === 'Debugger.paused');
  if (!paused) throw Error('Owned worker pause stack unavailable');
  const frames = paused.params.callFrames.map(({functionName, location, url}) => ({functionName, location, url}));
  const excerpts = [];
  for (const frame of frames.slice(0, 8)) {
    const {scriptSource} = await send('Debugger.getScriptSource', {scriptId:frame.location.scriptId}, sessionID);
    const lines = scriptSource.split('\n'), line = frame.location.lineNumber;
    excerpts.push({frame, source:lines.slice(Math.max(0,line-3),line+4).join('\n')});
  }
  await fs.promises.writeFile(output, JSON.stringify({target:info.targetInfo,reason:paused.params.reason,frames,excerpts},null,2), {flag:'wx'});
  return {output,reason:paused.params.reason,frames:frames.slice(0,12)};
} finally {
  if (sessionID) {try {await send('Debugger.resume', {}, sessionID);} catch {} }
  socket.close();
}
