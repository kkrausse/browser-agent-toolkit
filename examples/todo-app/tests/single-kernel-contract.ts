export function assertZeroWork(value: unknown): void {
  const d = value as Record<string, any>;
  if (!Array.isArray(d?.procs) || d.procs.length || !Array.isArray(d.listeners) || d.listeners.length || d.pendingHttp !== 0 || d.fetch?.inflight !== 0 || d.fetch?.queued !== 0 || d.fetch?.active !== 0) throw Error('Incomplete/nonzero stopped diagnostics: ' + JSON.stringify(d));
}

/** Runtime-owned counters are a separate proof from Chrome's target inventory. */
export function assertSingleKernelDiagnostics(value: unknown): void {
  const workers = (value as any)?.workers;
  if (workers?.kernel !== 1 || workers.filesystem !== 0 || workers.httpCoordinator !== 0 || workers.fetcher !== 0 || workers.other !== 0 || !Number.isSafeInteger(workers.process) || workers.process < 0 || !Array.isArray(workers.processPids) || workers.processPids.length !== workers.process || new Set(workers.processPids).size !== workers.process || workers.processPids.some((pid:unknown)=>!Number.isSafeInteger(pid))) throw Error('Missing/incorrect runtime worker counters: ' + JSON.stringify(workers));
}
export function assertKernelWorkerURL(value:string):void{
  const url=new URL(value);
  if(!/\/kernel-worker(?:-[\w-]+)?\.js$/.test(url.pathname)||!url.searchParams.has('opfs-disable')||url.search.slice(1).includes('?'))throw Error('Kernel worker URL must preserve Vite query and explicitly disable SQLite OPFS proxy');
}

export const fsProbe = `import fs from 'node:fs';
const root='/workspace/kernel-contract'; fs.mkdirSync(root,{recursive:true});
const name='line\\nentry.txt', bytes=Buffer.from([0,1,2,255,10]);
fs.writeFileSync(root+'/'+name,bytes); fs.renameSync(root+'/'+name,root+'/renamed\\nentry.txt');
fs.symlinkSync('renamed\\nentry.txt',root+'/link');
const fail=m=>{throw Error(m)};
if(!fs.readFileSync(root+'/link').equals(bytes))fail('sync linked read');
if(fs.statSync(root+'/link').size!==5||!fs.lstatSync(root+'/link').isSymbolicLink())fail('stat/lstat');
if(fs.readlinkSync(root+'/link')!=='renamed\\nentry.txt')fail('readlink');
const names=fs.readdirSync(root).sort();
if(JSON.stringify(names)!==JSON.stringify(['link','renamed\\nentry.txt']))fail('newline readdir framing '+JSON.stringify(names));
const large=Buffer.alloc(1048583);for(let i=0;i<large.length;i++)large[i]=i%251;
fs.writeFileSync('/workspace/large-binary.dat',large);if(!fs.readFileSync('/workspace/large-binary.dat').equals(large))fail('large sync read');
console.log(JSON.stringify({syncFS:true,names,bytes:[...fs.readFileSync(root+'/link')],largeBytes:large.length}));`;

// 16 MiB exceeds the normal transport window. A stopped reader must stall the
// producer; counting only received bytes cannot prove actual backpressure.
export const streamProbe = `import http from 'node:http'; import fs from 'node:fs';
let produced=0,drains=0;
const progress=()=>fs.writeFileSync('/workspace/stream-progress.json',JSON.stringify({produced,drains}));
const server=http.createServer(async(req,res)=>{
 if(req.url!=='/stream'){fs.writeFileSync('/workspace/handler-sync.txt','healthy');res.end(fs.readFileSync('/workspace/handler-sync.txt'));return;}
 res.writeHead(200,{'content-type':'application/octet-stream'});res.flushHeaders();
 produced=0;drains=0;
 for(let i=0;i<256;i++){if(res.destroyed)break;const chunk=Buffer.alloc(65536,i%251);produced++;progress();
  if(!res.write(chunk)){const ready=await new Promise(resolve=>{
   const drain=()=>{res.removeListener('close',close);resolve(true)};
   const close=()=>{res.removeListener('drain',drain);resolve(false)};
   res.once('drain',drain);res.once('close',close);
  });if(!ready)break;drains++;}}
 res.end();progress();
});server.listen(5189);process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync('/workspace/shutdown-sync.txt','shutdown');server.close(()=>process.exit(0))});`;

export const childSyncProbe = `const fs=require('node:fs'),cp=require('node:child_process');
const script='/workspace/sync-child.cjs';
fs.writeFileSync(script,\`const fs=require('node:fs');const b=Buffer.alloc(1048583);for(let i=0;i<b.length;i++)b[i]=i%251;fs.mkdirSync('/workspace/child-sync',{recursive:true});fs.writeFileSync('/workspace/child-sync/binary.dat',b);fs.renameSync('/workspace/child-sync/binary.dat','/workspace/child-sync/renamed.dat');fs.symlinkSync('renamed.dat','/workspace/child-sync/link');if(!fs.lstatSync('/workspace/child-sync/link').isSymbolicLink())throw Error('child lstat');process.stdout.write(fs.readFileSync('/workspace/child-sync/link'));\`);
const out=cp.execSync('node '+script,{maxBuffer:2097152});
if(out.length!==1048583)throw Error('execSync child output truncated '+out.length);
for(let i=0;i<out.length;i++)if(out[i]!==i%251)throw Error('execSync child byte corruption');
console.log(JSON.stringify({execSync:true,bytes:out.length,childLink:fs.readlinkSync('/workspace/child-sync/link')}));`;

/** Test-only coupling to the fork's existing egress primitive, not browser fetch.
 * Its metadata/path handoff exercises the same SAB whole-file/fd fallback as npm. */
export function fetchedBodyProbe(origin:string){return `import fs from 'node:fs';
if(typeof globalThis.__ocfetchAsync!=='function')throw Error('Required kernel egress primitive __ocfetchAsync unavailable');
const origin=${JSON.stringify(origin)};
const first=await globalThis.__ocfetchAsync(origin+'/fetch-fixture?bytes=1048583&key=held');
if(!first.ok||first.size!==1048583||!first.path)throw Error('Fetched body metadata');
for(let i=0;i<3;i++){const filler=await globalThis.__ocfetchAsync(origin+'/fetch-fixture?bytes=8388608&key='+i);const bytes=fs.readFileSync(filler.path);if(bytes.length!==8388608)throw Error('Eviction filler truncated');}
if(!fs.existsSync(first.path))throw Error('Pinned evicted body disappeared before read');
process.stdin.once('data',()=>{
 const bytes=fs.readFileSync(first.path);if(bytes.length!==1048583)throw Error('Fetched whole-file fallback length');
 for(let i=0;i<bytes.length;i++)if(bytes[i]!==i%251)throw Error('Fetched fallback exact bytes');
 if(fs.existsSync(first.path))throw Error('Evicted pin/body not reclaimed after fd close');
 console.log(JSON.stringify({phase:'reclaimed',bytes:bytes.length,absent:true}));process.stdin.pause();
});process.stdin.resume();console.log(JSON.stringify({phase:'evicted-pinned',path:first.path,size:first.size}));`;}
