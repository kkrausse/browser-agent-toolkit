// Passive CLI transport: original command/result preserved, additive post-command evidence.
import { basename, dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
const cli = process.env.SQLITE_CLOSE_REAL_CLI;
if (!cli) throw Error('Require actual Bun-backed Browser Control CLI');
const args = process.argv.slice(2), fileIndex = args.indexOf('--file');
if (args[0] === 'execute' && fileIndex >= 0) {
  const file = args[fileIndex + 1]!, evidence = dirname(file), id = basename(file, '.js');
  const code = await readFile(file, 'utf8');
  const setup = id === '0001' ? `
    const origin=${JSON.stringify(process.env.SQLITE_CLOSE_ORIGIN)};
    const observer=state.sqliteCloseTargetQA={events:[],targets:new Set(),errors:[],origin,transport:'Browser Control page CDP; no verified independent native transport'};
    observer.cdp=await page.context().newCDPSession(page);
    const retain=(kind,data)=>{if(observer.events.length<2048)observer.events.push({kind,wall:Date.now(),data});};
    for(const [event,kind]of [['Target.targetCreated','created'],['Target.targetInfoChanged','changed']])observer.cdp.on(event,({targetInfo:t})=>{if(t.url?.startsWith(origin)||observer.targets.has(t.targetId)){observer.targets.add(t.targetId);retain(kind,t);}});
    observer.cdp.on('Target.targetDestroyed',({targetId})=>{if(observer.targets.has(targetId))retain('destroyed',{targetId});});
    try{await observer.cdp.send('Target.setDiscoverTargets',{discover:true});}catch(error){observer.errors.push(String(error));}
    page.on('console',m=>{if(['error','warning'].includes(m.type()))retain('console',{type:m.type(),text:m.text(),location:m.location()});});
    page.on('pageerror',e=>retain('pageerror',{message:e.message,stack:e.stack}));
  ` : '';
  const wrapped = `${setup}
    try{return await(async()=>{${code}\n})();}
    finally{
      try{
        const passive=await page.evaluate(async()=>({url:location.href,wall:Date.now(),trace:window.__sqliteCloseTraceQA?.read()??null,locks:navigator.locks?await navigator.locks.query():{unavailable:'nonsecure initial document'},evidence:window.singleKernelCases?.evidence??null,runs:window.singleKernelRuns??null}));
        const o=state.sqliteCloseTargetQA;
        let targets=null;
        if(!${JSON.stringify(code.includes('observerDetached:true'))})try{targets=(await o.cdp.send('Target.getTargets')).targetInfos.filter(t=>t.url?.startsWith(o.origin));for(const t of targets)o.targets.add(t.targetId);}catch(error){o.errors.push(String(error));}
        modules.fs.writeFileSync(${JSON.stringify(join(evidence, 'passive-' + id + '.json'))},JSON.stringify({...passive,targetSample:{wall:Date.now(),targets},targetEvents:o?.events??[],observerErrors:o?.errors??[],transport:o?.transport},null,2),{flag:'wx'});
        if(passive.evidence?.steps?.length===1&&!o.screenshot){o.screenshot=true;await page.screenshot({path:${JSON.stringify(join(evidence, 'step-completed-viewport.png'))},fullPage:false});}
      }catch(error){modules.fs.writeFileSync(${JSON.stringify(join(evidence, 'passive-' + id + '-error.txt'))},String(error),{flag:'wx'});}
    }`;
  const observerFile = join(evidence, 'observer-command-' + id + '.js');
  await writeFile(observerFile, wrapped, { flag: 'wx' });
  args[fileIndex + 1] = observerFile;
}
const child = Bun.spawn(['bun', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
const outcomes = await Promise.allSettled([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
if (outcomes.some(r => r.status === 'rejected')) throw Error('Actual CLI transport unjoined');
const [stdout, stderr, exit] = outcomes.map(r => (r as PromiseFulfilledResult<string | number>).value);
process.stdout.write(String(stdout)); process.stderr.write(String(stderr)); process.exit(Number(exit));
