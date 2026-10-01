// browser-control execute --session <owned-session> --file tests/diagnose-clean-start.js
// Requires state.startupDiagnosticController and state.editorAcceptanceConfig.evidenceDir.
// This is a diagnostic restart, never a clean-start acceptance receipt.
const controller = state.startupDiagnosticController;
if (!controller) throw Error('Capture the existing workspace controller before diagnosis');
const directory = state.editorAcceptanceConfig.evidenceDir;
const phase = state.startupDiagnosticPhase ?? 'graph';
let result;
if (phase === 'graph') {
  result = await controller.evaluate(async c => {
    const script = `const fs=require('node:fs');const out={paths:[],optimizer:[]};
for(const p of ['@tanstack/react-query','@tanstack/query-core','@trpc/client','@trpc/react-query','@trpc/tanstack-react-query','react','vite','esbuild']){
const path='/workspace/node_modules/'+p;try{const st=fs.lstatSync(path);const pkg=JSON.parse(fs.readFileSync(path+'/package.json','utf8'));out.paths.push({path,symlink:st.isSymbolicLink(),link:st.isSymbolicLink()?fs.readlinkSync(path):null,real:fs.realpathSync(path),native:fs.realpathSync.native(path),nativeFile:fs.realpathSync.native(path+'/package.json'),name:pkg.name,version:pkg.version,dependencies:pkg.dependencies})}catch(e){out.paths.push({path,error:e.stack})}}
const query='/workspace/node_modules/.bun/@tanstack+react-query@5.102.8+62547eec5a2188e3/node_modules/@tanstack/query-core';out.queryCore={path:query,target:fs.readlinkSync(query),real:fs.realpathSync(query),package:JSON.parse(fs.readFileSync(query+'/package.json','utf8')).version};
for(const name of fs.readdirSync('/workspace/node_modules/.vite')){const path='/workspace/node_modules/.vite/'+name;out.optimizer.push({path,files:fs.readdirSync(path)})}
console.log(JSON.stringify(out));`;
    await c.workspace.fs.mkdir('/.browser-editor-diagnosis');
    await c.workspace.fs.writeFile('/.browser-editor-diagnosis/graph.cjs', script);
    const child = await c.runtime.node({ entry: '/workspace/.browser-editor-diagnosis/graph.cjs', cwd: '/workspace', signal: AbortSignal.timeout(15000) });
    const collect = async stream => { let text = ''; for await (const b of stream) text += new TextDecoder().decode(b); return text; };
    const drains = Promise.all([collect(child.stdout), collect(child.stderr)]);
    child.closeStdin();
    const exit = await child.exited, [stdout, stderr] = await drains;
    return { exit, stdout, stderr };
  });
} else if (phase === 'restart') {
  // Parent host stays running. Only the controller-owned guest Vite is stopped.
  result = await controller.evaluate(async c => {
    const previous = c.getSnapshot().services.vite;
    if (!previous) throw Error('Original Vite service is absent');
    await c.stopService('vite');
    await previous.drained;
    return { originalExit: await previous.execution.exited, at: new Date().toISOString(), cleanStartAcceptance: 'INVALIDATED: diagnostic guest restart' };
  });
  state.startupDiagnosticRun = await controller.evaluateHandle(async c => {
    const manifest = await (await fetch('/editor/prepared/manifest.json')).json();
    const execution = await c.runtime.node({ ...manifest.preview, env: { ...manifest.preview.env, DEBUG: 'vite:deps*' } });
    const run = { execution, endpoint: null, stdout: '', stderr: '', exit: null, events: [] };
    const drain = async (stream, name) => { for await (const bytes of stream) { const text = new TextDecoder().decode(bytes); run[name] += text; run.events.push({ at: Date.now(), channel: name, text }); } };
    run.drained = Promise.all([drain(execution.stdout, 'stdout'), drain(execution.stderr, 'stderr')]);
    execution.exited.then(exit => { run.exit = exit; });
    run.endpoint = await c.runtime.expose(5173, { signal: AbortSignal.timeout(30000) });
    return run;
  });
  result.diagnostic = await state.startupDiagnosticRun.evaluate(r => ({ stdout: r.stdout, stderr: r.stderr, exit: r.exit, listener: r.endpoint.listenerID, url: r.endpoint.url }));
} else if (phase === 'observe') {
  result = await state.startupDiagnosticRun.evaluate(r => ({ stdout: r.stdout, stderr: r.stderr, exit: r.exit, events: r.events }));
} else if (phase === 'stop') {
  result = await state.startupDiagnosticRun.evaluate(async r => {
    r.endpoint?.dispose();
    await r.execution.stop();
    await r.drained;
    return { exit: await r.execution.exited, stdout: r.stdout, stderr: r.stderr };
  });
} else throw Error('Unknown diagnostic phase');
const receipt = { at: new Date().toISOString(), phase, cleanStartAcceptance: 'FAILED; diagnostic only', result };
fs.writeFileSync(path.join(directory, `diagnosis-${Date.now()}-${phase}.json`), JSON.stringify(receipt, null, 2));
return receipt;
