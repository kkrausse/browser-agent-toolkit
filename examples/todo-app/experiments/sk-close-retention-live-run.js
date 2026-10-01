// Exactly one bounded contract entrypoint invocation. No lifecycle retries.
const dir=state.closeRetentionEvidence;
const origin=new URL(page.url()).origin;
if(origin!=='http://127.0.0.1:55466')throw Error('Wrong owned origin');
const cdp=await context.newCDPSession(page);
const samples=[];
async function sample(label){
 const beginMs=Date.now();
 const locks=await page.evaluate(label=>singleKernelCloseObserver.sample(label),label);
 const {targetInfos}=await cdp.send('Target.getTargets');
 const targets=targetInfos.filter(t=>(t.url.startsWith(origin+'/')||t.url.startsWith('blob:'+origin+'/'))&&['worker','shared_worker','service_worker'].includes(t.type));
 const action=await page.evaluate(()=>window.closeRetentionAction??null);
 const r={label,beginMs,endMs:Date.now(),locks,targets,action};samples.push(r);
 fs.appendFileSync(dir+'/samples.jsonl',JSON.stringify(r)+'\n');return r;
}
await sample('pre-run');
await page.evaluate(()=>{
 if(window.closeRetentionAction)throw Error('Duplicate initiation');
 const action=window.closeRetentionAction={status:'pending',startedMs:Date.now()};
 Promise.resolve().then(()=>singleKernelCases.run(1,0)).then(value=>Object.assign(action,{status:'completed',value,settledMs:Date.now()}),error=>Object.assign(action,{status:'failed',error:String(error),settledMs:Date.now()}));
});
let joined;
const actionDeadline=Date.now()+120000;
while(Date.now()<actionDeadline){const s=await sample('action');if(s.action.status!=='pending'){joined=s.action;break;}await new Promise(r=>setTimeout(r,150));}
if(!joined)throw Error('Original action bound failed; no retry');
// Deadline starts at the actual joined settlement in the page, not receipt time.
const deadline=joined.settledMs+15000;
while(Date.now()<deadline){await sample('original-15s-post-close');await new Promise(r=>setTimeout(r,150));}
const eligible=samples.filter(s=>s.label==='original-15s-post-close'&&s.endMs<=deadline);
const empty=s=>!s.locks.held.length&&!s.locks.pending.length&&!s.targets.some(t=>t.type!=='service_worker');
const acceptance={joined,deadlineMs:deadline,passed:joined.status==='completed'&&eligible.some(empty),sampleCount:eligible.length,firstEmpty:eligible.find(empty)??null};
fs.writeFileSync(dir+'/acceptance.json',JSON.stringify(acceptance,null,2),{flag:'wx'});
if(!acceptance.passed){for(let i=0;i<5;i++){await sample('postfailure-readonly-not-acceptance');await new Promise(r=>setTimeout(r,150));}}
const result=await page.evaluate(()=>({action:window.closeRetentionAction,evidence:singleKernelCases.evidence,observer:{entries:singleKernelCloseObserver.entries,dropped:singleKernelCloseObserver.dropped},rendered:document.querySelector('pre').textContent}));
fs.writeFileSync(dir+'/result.json',JSON.stringify(result,null,2),{flag:'wx'});
fs.writeFileSync(dir+'/logs.json',JSON.stringify(state.closeRetentionLogs,null,2),{flag:'wx'});
const tree=await snapshot();fs.writeFileSync(dir+'/after-snapshot.txt',String(tree),{flag:'wx'});
await page.screenshot({path:dir+'/after.png',fullPage:true});
await cdp.detach();
return {acceptance,observerDropped:result.observer.dropped,queryFailures:result.observer.entries.filter(e=>e.kind==='lock-query-failed').length,last:samples.at(-1),snapshot:tree};
