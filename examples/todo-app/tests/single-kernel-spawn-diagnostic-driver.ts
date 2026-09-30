import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {acquirePairLock,createDriverCommands} from './matched-pair-driver';
import {acceptanceRequestCode,inventoryCode} from './single-kernel-driver';
export const diagnosticSpawnPlan=['async','spawnSync','execSync'] as const;
export async function runDiagnosticSpawnPlan(run:(mode:typeof diagnosticSpawnPlan[number])=>Promise<void>){for(const mode of diagnosticSpawnPlan)await run(mode);}

if(import.meta.main){
  if(process.env.SINGLE_KERNEL_AUTHORIZE_DIAGNOSTIC!=='yes')throw Error('Require explicit parent diagnostic checkpoint authorization');
  if(!process.argv[2]||!process.argv[3])throw Error('Usage: single-kernel-spawn-diagnostic-driver.ts <new-output> <new-evidence>');
  const root=resolve(import.meta.dir,'../../..'),output=resolve(process.argv[2]),evidence=resolve(process.argv[3]);
  const receipt=await Bun.file(join(output,'receipt.json')).json(),origin=await Bun.file(join(output,'owned-spawn-diagnostic-origin.json')).json();
  if(receipt.offline||receipt.revision!=='3e390d4d664c50268a6f8a8662ca73085820eb42'||receipt.topology?.policy!=='single-kernel'||origin.output!==output||origin.diagnostic!==true||!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(origin.url))throw Error('Require exact authorized fresh diagnostic artifact/origin');
  for(const [file,expected] of Object.entries(receipt.hashes))if(createHash('sha256').update(await readFile(join(output,file))).digest('hex')!==expected)throw Error('Diagnostic artifact hash changed: '+file);
  const lock=join(root,'.diagnostics/single-kernel-spawn-diagnostic.lock'),release=await acquirePairLock(lock);
  try{await mkdir(evidence);}catch(error){await release();throw error;}
  const session='single-kernel-spawn-'+crypto.randomUUID().slice(0,8),cli=process.env.BROWSER_CONTROL_CLI??Bun.which('browser-control');if(!cli)throw Error('Browser Control CLI missing');
  let expired=false;
  const commands=createDriverCommands(evidence,{diagnostic:session},()=>expired,undefined,['bun',cli]);
  const command=(code:string)=>commands.command('diagnostic',code);
  await writeFile(join(evidence,'ownership.json'),JSON.stringify({lock,session,origin,revision:receipt.revision,version:receipt.version,probeDeadlineMs:20000,probeOrder:diagnosticSpawnPlan,originalProbeMaxBuffer:2097152,oldCohortUntouched:true},null,2),{flag:'wx'});
  async function lifecycle(args:string[]){const p=Bun.spawn(['bun',cli!,'session',...args],{stdout:'pipe',stderr:'pipe'});const joined=await Promise.allSettled([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(joined.some(result=>result.status==='rejected')){expired=true;throw Error('Ambiguous diagnostic session lifecycle; ownership retained');}const [stdout,stderr,exit]=joined.map(result=>(result as PromiseFulfilledResult<any>).value);if(exit)throw Error(stderr||stdout);}
  async function poll(code:string,ms:number,accept:(value:any)=>boolean){const until=Date.now()+ms;while(Date.now()<until){const value=await command(code);if(accept(value))return value;await Bun.sleep(100);}expired=true;throw Error('Diagnostic bounded observation deadline; unresolved work retained');}
  async function request(action:string,args:unknown[]=[],ms=25000){
    const token=crypto.randomUUID();await command(acceptanceRequestCode('singleKernelSpawnDiagnostic',action,args,token));
    const result=await poll(`return await page.evaluate(token=>{const r=window.singleKernelRuns?.[token];if(!r)throw Error('Diagnostic request lost');return {status:r.status,error:r.error}},${JSON.stringify(token)})`,ms,value=>value.status!=='pending');
    if(result.status!=='completed')throw Error(result.error);
  }
  async function snapshot(name:string){
    // One full read-only vv-diag request. Freeze its result before bounded chunks.
    const manifest=await command(`const cdp=await page.context().newCDPSession(page);let targets;try{targets=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.url?.startsWith(${JSON.stringify(origin.url)})||t.url?.startsWith('blob:'+${JSON.stringify(origin.url)}));}finally{await cdp.detach();}
      const full=await page.evaluate(async()=>({url:location.href,evidence:window.singleKernelSpawnDiagnostic.evidence,diagnostics:await Promise.race([window.singleKernelSpawnDiagnostic.diagnostics(),new Promise(resolve=>setTimeout(()=>resolve({unavailable:'5000ms diagnostic read deadline'}),5000))])}));
      const json=JSON.stringify({targets,...full});state.spawnDiagnosticSnapshot=json;return {length:json.length,hash:modules.crypto.createHash('sha256').update(json).digest('hex')};`);
    if(!Number.isSafeInteger(manifest.length)||manifest.length>16*1024*1024)throw Error('Diagnostic snapshot bound');
    let json='';for(let offset=0;offset<manifest.length;offset+=8000){const part=await command(`if(typeof state.spawnDiagnosticSnapshot!=='string')throw Error('Diagnostic snapshot lost');return {offset:${offset},text:state.spawnDiagnosticSnapshot.slice(${offset},${offset+8000})};`);if(part.offset!==offset||part.text.length!==Math.min(8000,manifest.length-offset))throw Error('Diagnostic chunk incomplete');json+=part.text;}
    if(createHash('sha256').update(json).digest('hex')!==manifest.hash)throw Error('Diagnostic snapshot digest changed');await writeFile(join(evidence,name+'.json'),json,{flag:'wx'});return JSON.parse(json);
  }
  try{
    await lifecycle(['new',session]);
    await command(`if(page.url()!=='about:blank')throw Error('Fresh diagnostic session required');await page.goto(${JSON.stringify(origin.url+'inspect-empty')});return await page.evaluate(async()=>{const root=await navigator.storage.getDirectory();for await(const key of root.keys())throw Error('Diagnostic origin not empty: '+key);if((await navigator.serviceWorker.getRegistrations()).length)throw Error('Diagnostic origin has existing relay');return {empty:true};});`);
    await command(`await page.goto(${JSON.stringify(origin.url)});return {url:page.url()};`);
    await poll(`return await page.evaluate(()=>({ready:!!window.singleKernelSpawnDiagnostic}));`,15000,value=>value.ready);
    await request('open',[],65000);await snapshot('open');
    await runDiagnosticSpawnPlan(async mode=>{await request('probe',[mode]);await snapshot('minimal-'+mode);});
    await request('original');await snapshot('original-maxBuffer2097152');
    await request('close');await command(inventoryCode(false));await lifecycle(['delete',session]);
    await writeFile(join(evidence,'result.json'),JSON.stringify({status:'passed',minimalProbes:diagnosticSpawnPlan,originalProbes:1,revision:receipt.revision,version:receipt.version,models:0,oldCohortUntouched:true},null,2),{flag:'wx'});await release();console.log(evidence);
  }catch(error){let captureError; if(!expired&&!commands.pending)try{await snapshot('first-failure-full-trace');}catch(failure){captureError=String(failure);}
    await writeFile(join(evidence,'result.json'),JSON.stringify({status:'failed',error:String(error),captureError,expired,commandPending:commands.pending,session,origin,retained:true,oldCohortUntouched:true},null,2),{flag:'wx'});console.error('Diagnostic failure retained: '+evidence);throw error;
  }
}
