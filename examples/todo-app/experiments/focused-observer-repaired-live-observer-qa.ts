// QA-only passive evidence transport. The frozen driver and returned values stay unchanged.
import {join, dirname, basename} from 'node:path';
const cli=process.env.FOCUSED_REAL_BROWSER_CONTROL_CLI;
if(!cli)throw Error('Require the actual Bun-backed Browser Control CLI');
const args=process.argv.slice(2);
const fileIndex=args.indexOf('--file');
if(args[0]==='execute'&&fileIndex>=0){
  const file=args[fileIndex+1]!;
  const code=await Bun.file(file).text();
  const evidence=dirname(file), id=basename(file,'.js');
  const setup=id==='0001'?`
    if(state.focusedPassiveObserver)throw Error('Passive observer already installed');
    const observer=state.focusedPassiveObserver={events:[],targets:new Set(),screenshots:new Set()};
    await page.addInitScript(()=>{
      const records=window.__focusedNativeCloseQA=[];
      const original=Worker.prototype.terminate;
      Worker.prototype.terminate=function(...args){
        const record={kind:'native-Worker.terminate',at:performance.now(),wall:Date.now(),status:'called'};
        records.push(record);
        try{const result=Reflect.apply(original,this,args);record.status='returned';return result;}
        catch(error){record.status='threw';throw error;}
      };
    });
    observer.cdp=await page.context().newCDPSession(page);
    observer.cdp.on('Target.targetCreated',({targetInfo:t})=>{
      const origin=page.url().startsWith('http:')?new URL(page.url()).origin:null;
      if(origin&&(t.url?.startsWith(origin+'/')||t.url?.startsWith('blob:'+origin+'/'))){
        observer.targets.add(t.targetId);observer.events.push({kind:'created',wall:Date.now(),target:t});
      }
    });
    observer.cdp.on('Target.targetDestroyed',({targetId})=>{if(observer.targets.has(targetId))observer.events.push({kind:'destroyed',wall:Date.now(),targetId});});
    await observer.cdp.send('Target.setDiscoverTargets',{discover:true});
  `:'';
  const wrapped=`${setup}
    try{return await (async()=>{${code}\n})();}
    finally{
      const observer=state.focusedPassiveObserver;
      try{
        const value=await page.evaluate(async()=>({url:location.href,wall:Date.now(),nativeClose:window.__focusedNativeCloseQA??[],locks:await navigator.locks.query(),status:window.singleKernelCases?.evidence.status,steps:window.singleKernelCases?.evidence.steps,error:window.singleKernelCases?.evidence.error}));
        const record={command:${JSON.stringify(id)},...value,targetEvents:observer?.events??[]};
        modules.fs.writeFileSync(${JSON.stringify(join(evidence,'passive-'+id+'.json'))},JSON.stringify(record,null,2),{flag:'wx'});
        const key=value.steps?.length===1?'first-completed-step':value.status==='failed'?'failure-state':null;
        if(key&&observer&&!observer.screenshots.has(key)){
          observer.screenshots.add(key);
          await page.screenshot({path:${JSON.stringify(evidence)}+'/'+key+'-viewport.png',fullPage:false});
        }
      }catch(error){modules.fs.writeFileSync(${JSON.stringify(join(evidence,'passive-'+id+'-error.txt'))},String(error),{flag:'wx'});}
    }`;
  const observerFile=join(evidence,'passive-command-'+id+'.js');
  await Bun.write(observerFile,wrapped);
  args[fileIndex+1]=observerFile;
}
const child=Bun.spawn(['bun',cli,...args],{stdout:'pipe',stderr:'pipe'});
const joined=await Promise.allSettled([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
if(joined.some(r=>r.status==='rejected'))throw Error('Unjoined actual CLI transport');
const [stdout,stderr,exit]=joined.map(r=>(r as PromiseFulfilledResult<any>).value);
process.stdout.write(stdout);process.stderr.write(stderr);process.exit(exit);
