// Labelled observer UI only, after immutable acceptance evidence was retained.
const dir=state.closeRetentionEvidence;
const cdp=await context.newCDPSession(page);
try {
 const {targetInfos}=await cdp.send('Target.getTargets');
 const origin=new URL(page.url()).origin;
 const targets=targetInfos.filter(t=>t.url.startsWith(origin+'/')&&['worker','shared_worker','service_worker'].includes(t.type));
 const view=await page.evaluate(async()=>{
  const stopped=singleKernelCases.evidence.topology.find(t=>t.phase==='stopped')?.diagnostics;
  return {case:singleKernelCases.evidence.steps,action:window.closeRetentionAction,locks:await singleKernelCloseObserver.sample('manual-postacceptance-not-deadline'),events:singleKernelCloseObserver.entries.filter(e=>e.kind!=='locks'),dropped:singleKernelCloseObserver.dropped,stopped:stopped?{now:stopped.now,procs:stopped.procs,workers:stopped.workers,listeners:stopped.listeners,pendingHttp:stopped.pendingHttp,fetch:stopped.fetch,filesystemClients:stopped.syscallRouting.clients,lazyInflight:stopped.syscallRouting.lazyInflight,ownedSpills:stopped.spawnCapture.ownedSpills}:null};
 });
 const receipt={label:'POSTACCEPTANCE READ-ONLY DIAGNOSTIC VIEW — NOT ORIGINAL DEADLINE',wallMs:Date.now(),...view,targets};
 fs.writeFileSync(dir+'/manual-observer-view.json',JSON.stringify(receipt,null,2),{flag:'wx'});
 await page.evaluate(receipt=>{
  const panel=document.createElement('pre');panel.id='qa-postacceptance-observer';
  panel.textContent=JSON.stringify(receipt,null,2);
  panel.style.cssText='position:relative;background:#fff;color:#000;border:3px solid #333;padding:16px;font:14px/1.3 monospace;white-space:pre-wrap';
  document.body.prepend(panel);window.scrollTo(0,0);
 },receipt);
 await page.screenshot({path:dir+'/manual-observer-view.png',timeout:10000});
 return {url:page.url(),receipt,snapshot:await snapshot()};
} finally {await cdp.detach();}
