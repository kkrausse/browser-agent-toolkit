// Continue preflight only: the contract has NOT been invoked. Do not clear
// Dark Reader's extension marker or claim literally zero session storage.
const dir=state.closeRetentionEvidence;
if(page.url()!=='http://127.0.0.1:55466/inspect-empty')throw Error('Wrong preflight page');
const baseline=await page.evaluate(async()=>{
 const opfs=[];for await(const k of (await navigator.storage.getDirectory()).keys())opfs.push(k);
 return {opfs,idb:await indexedDB.databases(),caches:await caches.keys(),sw:(await navigator.serviceWorker.getRegistrations()).map(r=>r.scope),localStorage:localStorage.length,sessionStorageKeys:Object.keys(sessionStorage),locks:await singleKernelCloseObserver.sample('preflight-extension-marker-retained')};
});
fs.writeFileSync(dir+'/preflight-extension-marker.json',JSON.stringify(baseline,null,2),{flag:'wx'});
if(baseline.opfs.length||baseline.idb.length||baseline.caches.length||baseline.sw.length||baseline.localStorage||baseline.locks.held.length||baseline.locks.pending.length||baseline.sessionStorageKeys.some(k=>k!=='__darkreader__wasEnabledForHost'))throw Error('Unexpected existing application state');
await page.goto('http://127.0.0.1:55466/');
await page.waitForFunction(()=>!!window.singleKernelCases,{},{timeout:15000});
const tree=await snapshot();fs.writeFileSync(dir+'/before-snapshot.txt',String(tree),{flag:'wx'});
await page.screenshot({path:dir+'/before.png',fullPage:true});
const cdp=await context.newCDPSession(page);const engine=await cdp.send('Browser.getVersion');await cdp.detach();
fs.writeFileSync(dir+'/engine.json',JSON.stringify(engine,null,2),{flag:'wx'});
return {url:page.url(),baseline,engine,snapshot:tree};
