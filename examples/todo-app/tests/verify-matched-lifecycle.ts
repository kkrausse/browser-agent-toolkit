import {join,resolve} from 'node:path';
const root=resolve(import.meta.dir,'../../..'),output=resolve(process.argv[2]!);
const bundle=await Bun.file(join(root,'vivari/.runtime/opencode-release-2.0.3/.runtime/opencode-bun-server/server.js')).text();
if(new Bun.CryptoHasher('sha256').update(bundle).digest('hex')!=='1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929')throw Error('Bundle mismatch');
const end=bundle.indexOf('\n// ',bundle.indexOf('var init_client7 ='));if(end<0)throw Error('Protocol prefix absent');
await Bun.write(join(output,'codec.mjs'),bundle.slice(0,end)+'\ninit_client7(); export {ClientApi as Api, exports_Schema as Schema, exports_Effect as Effect, makeSuccessSchema, exports_HttpServerResponse as HttpServerResponse, exports_HttpApiSchema as HttpApiSchema};\n');
const inputs:any[]=[];
const summary:any={};
const live:any={};
for(const condition of ['restart','reuse']){
 const file=Bun.file(join(output,'live-'+condition+'.json'));if(!await file.exists())continue;
 const text=await file.text(),data=JSON.parse(text),receipt=await Bun.file(join(output,'export-'+condition+'.json')).json();live[condition]=data;
 if(Buffer.byteLength(text)!==receipt.bytes||new Bun.CryptoHasher('sha256').update(text).digest('hex')!==receipt.sha256)throw Error('Export integrity');
 const records=data.requests.flatMap((group:any)=>group.records),finite=records.filter((r:any)=>r.state!=='stream');
 for(const record of finite){if(!record.wire)throw Error('Missing wire');const bytes=Buffer.from(record.wire.bodyBase64,'base64');if(bytes.length!==record.wire.bytes||new Bun.CryptoHasher('sha256').update(bytes).digest('hex')!==record.wire.sha256)throw Error('Raw wire integrity');const url=new URL(record.url),path=url.pathname.slice(url.pathname.indexOf('/api/'));inputs.push({condition,path,method:record.method,status:record.status,text:bytes.toString(),headers:record.wire.headers});}
 const stages:any={};for(const sample of data.samples.filter((s:any)=>s.generation>0&&s.generation<=5)){(stages[sample.name]??=[]).push(sample.ms);}
 const readyComponents=data.samples.filter((s:any)=>s.name==='controller.ready').map((sample:any)=>{const calls=data.requests.filter((g:any)=>g.generation===sample.generation&&!g.admin).flatMap((g:any)=>g.records).filter((r:any)=>r.started>=sample.started&&r.started<=sample.finished);const create=calls.find((r:any)=>r.method==='POST'&&new URL(r.url).pathname.endsWith('/api/session'));if(!create)return {generation:sample.generation,missingCreate:true};const parts={bootstrap:create.started-sample.started,create:create.finished-create.started,hydration:sample.finished-create.finished};if(sample.generation)for(const [name,ms] of Object.entries(parts))(stages['controller.'+name]??=[]).push(ms);return {generation:sample.generation,...parts,calls:calls.length};});
 for(const [name,values] of Object.entries(stages) as [string,number[]][]){const sorted=[...values].sort((a,b)=>a-b);stages[name]={samples:values,min:sorted[0],median:sorted[Math.floor(sorted.length/2)],max:sorted.at(-1)};}
 const requestsByGeneration=data.requests.filter((g:any)=>!g.admin).map((g:any)=>({generation:g.generation,routes:g.records.map((r:any)=>({method:r.method,path:new URL(r.url).pathname.slice(new URL(r.url).pathname.indexOf('/api/')),ms:r.finished===undefined?null:r.finished-r.started,state:r.state}))}));
 summary[condition]={status:data.status,error:data.error,attempts:data.attempts,finite:finite.length,streams:records.length-finite.length,failed:records.filter((r:any)=>r.state==='failed'||r.state==='pending').length,bytes:finite.reduce((sum:number,r:any)=>sum+r.wire.bytes,0),pids:data.generations.map((g:any)=>g.health.pid),sessions:data.generations.map((g:any)=>g.session?.id),markers:data.generations.map((g:any)=>g.config?.username),stages,readyComponents,requestsByGeneration,cold:data.samples.filter((s:any)=>s.generation===0),exit:data.exit,zero:data.zero};
}
if(live.restart&&live.reuse){
 const check=(value:unknown,label:string)=>{if(!value)throw Error('Matched postflight: '+label);};
 check(JSON.stringify(live.restart.identity)===JSON.stringify(live.reuse.identity),'identical config/plugins/dependencies/runtime/location');
 const ids=new Set<string>();
 for(const condition of ['restart','reuse']){
  const data=live[condition];check(data.status==='passed'&&data.attempts.cold===1&&data.attempts.transition===5,'complete fixed condition '+condition);
  check(data.transitions.length===5&&data.transitions.every((t:any)=>t.unresolved===0&&t.localDisposed),'joined outgoing work '+condition);
  check(data.generations.length===6,'six qualified generations '+condition);
  for(const g of data.generations){check(g.snapshot.messages.length===0&&g.snapshot.execution==='idle'&&!g.snapshot.permissions.length&&!g.snapshot.questions.length,'fresh histories');check(g.diagnostics.procs.length===1&&g.diagnostics.listeners.length===1&&g.diagnostics.pendingHttp===0,'qualified exclusive process, no pending HTTP');check(!ids.has(g.session.id),'unique root');ids.add(g.session.id);}
  check(data.zero.procs.length===0&&data.zero.listeners.length===0&&data.zero.pendingHttp===0,'final zero');
  const calls=data.requests.flatMap((g:any)=>g.records);check(calls.every((r:any)=>r.state==='stream'?r.status===200:r.state==='normal'&&r.transport==='normal'&&r.semantic==='accepted'),'normal accepted finite / healthy global SSE');
  const admin=data.requests.filter((g:any)=>g.admin).flatMap((g:any)=>g.records);check(admin.length===(condition==='reuse'?5:0)&&admin.every((r:any)=>r.method==='DELETE'&&r.status===204),'condition administrative calls');
 }
 const normalize=(data:any,n:number)=>data.requests.filter((g:any)=>g.generation===n&&!g.admin).flatMap((g:any)=>g.records).map((r:any)=>({method:r.method,path:new URL(r.url).pathname.slice(new URL(r.url).pathname.indexOf('/api/')).replace(/ses_[^/]+/g,':sessionID'),status:r.status}));
 for(let n=0;n<=5;n++)check(JSON.stringify(normalize(live.restart,n))===JSON.stringify(normalize(live.reuse,n)),'same workload routes generation '+n);
 const restart=summary.restart.stages['transition.to-ready'].median,reuse=summary.reuse.stages['transition.to-ready'].median;
 summary.comparison={completed:10,workloadMatched:true,uniqueRoots:ids.size,medianDifferenceMs:restart-reuse,reuseRestartRatio:reuse/restart,observedReductionPercent:100*(1-reuse/restart),confidence:'one fixed-order pair; repeated serial generations, not independent or randomized cohorts'};
}
await Bun.write(join(output,'codec-input.json'),JSON.stringify(inputs));
await Bun.write(join(output,'verify-codec.mjs'),`import {Api,Schema,Effect,makeSuccessSchema,HttpServerResponse,HttpApiSchema} from './codec.mjs';import fs from 'node:fs';
const inputs=JSON.parse(fs.readFileSync(new URL('./codec-input.json',import.meta.url)));const checked=[];
for(const input of inputs){const endpoint=Object.values(Api.groups).flatMap(g=>Object.values(g.endpoints)).find(e=>e.method===input.method&&(e.path===input.path||e.path.replace(':sessionID',input.path.split('/')[3])===input.path));if(!endpoint)throw Error('Unknown route '+input.path);const success=[...endpoint.success][0];const body=input.status===204?HttpApiSchema.NoContent.make():Schema.decodeSync(success)(JSON.parse(input.text));const response=HttpServerResponse.toWeb(await Effect.runPromise(Schema.encodeEffect(makeSuccessSchema(endpoint))(body)));const text=await response.text();if(response.status!==input.status||text!==input.text)throw Error('Codec parity '+input.path);const actual=new Map(input.headers);for(const name of ['content-type','content-length'])if(response.headers.has(name)&&response.headers.get(name)!==actual.get(name))throw Error('Header parity '+name);checked.push({condition:input.condition,path:input.path,method:input.method,status:input.status,bytes:Buffer.byteLength(text)});}fs.writeFileSync(new URL('./live-codec-parity.json',import.meta.url),JSON.stringify({checked:checked.length,byteParity:true,results:checked},null,2));console.log(checked.length+' codec-backed finite responses verified');`);
const p=Bun.spawn(['node',join(output,'verify-codec.mjs')],{stdout:'pipe',stderr:'pipe'});const [out,err,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(exit)throw Error(err);console.log(out.trim());
await Bun.write(join(output,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
