import {expect,test} from 'bun:test';
import {join,resolve} from 'node:path';
import {captureQualificationRequest,createQualificationFence,qualifyRootPayload,qualifyRootResult} from './sk-opencode-live-fence';
import {guardedFailureCleanup} from './sk-opencode-live-failure-cleanup';

const output=process.env.SK_OPENCODE_STAGE;
const pinnedTest=output?test:test.skip;
const rootWire={id:null,title:null,agent:null,model:null,location:{directory:'/workspace'},metadata:null,permissions:null};
const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
const base=new URL('https://owned.invalid/listener/?listener=owned');
const request=(path:string,method='GET',body?:unknown)=>new Request(new URL(path.replace(/^\//,''),base).href+'?listener=owned&location%5Bdirectory%5D=%2Fworkspace',{method,...(body===undefined?{}:{body:JSON.stringify(body)})});

pinnedTest('observed null regression: real pinned Effect SDK transport equals actual 648 payload schema encoding',async()=>{
 // Execute the same committed API adapter/Effect SDK as the controller. The
 // capture transport throws deliberately; no host, guest, browser or network.
 const chat=resolve(import.meta.dir,'../../../opencode-chat');
 const code=`import {Effect} from ${JSON.stringify(join(chat,'node_modules/effect/dist/index.js'))};
 import {OpenCodeAPI} from ${JSON.stringify(join(chat,'src/api.ts'))};
 let capture;const endpoint={url:'https://offline.invalid/listener/?location%5Bdirectory%5D=%2Fworkspace',fetch:async(input,init)=>{const r=new Request(input,init);capture={method:r.method,url:r.url,bodyBase64:Buffer.from(await r.arrayBuffer()).toString('base64')};throw Error('Offline capture only');}};
 await Effect.runPromise(Effect.gen(function*(){const api=yield* OpenCodeAPI;return yield* api.create();}).pipe(Effect.provide(OpenCodeAPI.layer(endpoint,'/workspace')),Effect.exit));
 console.log(JSON.stringify(capture));`;
 const child=Bun.spawn(['bun','-e',code],{stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect(exit,stderr).toBe(0);const record=JSON.parse(stdout);
 expect(record.method).toBe('POST');expect(new URL(record.url).pathname).toBe('/listener/api/session');
 const bytes=Buffer.from(record.bodyBase64,'base64');expect(JSON.parse(bytes.toString())).toEqual(rootWire);
 expect(()=>qualifyRootPayload(bytes)).not.toThrow();
 const codec=Bun.spawn(['node',join(resolve(output!),'sk-opencode-live-codec.mjs')],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 codec.stdin.write(JSON.stringify({...record,path:'/api/session',mode:'root-request-schema'}));codec.stdin.end();
 const [proof,errors,result]=await Promise.all([new Response(codec.stdout).text(),new Response(codec.stderr).text(),codec.exited]);
 expect(result,errors).toBe(0);const receipt=JSON.parse(proof);expect(receipt.kind).toBe('root-request-schema');
 expect(receipt.canonicalBodyBase64).toBe(record.bodyBase64);
},20000);

test('rejected request bytes/hash are preserved before root semantic admission; auth excluded',async()=>{
 const attempted={...rootWire,model:{providerID:'prohibited',model:'m'}};
 const req=request('/api/session','POST',attempted);req.headers.set('authorization','Basic do-not-retain');
 const records:any[]=[],order:string[]=[];
 const captured=await captureQualificationRequest(req,r=>{records.push(r);order.push('append');},async r=>{expect(r.authorization).toBe('omitted');order.push('preserve');});
 order.push('admit');expect(()=>qualifyRootPayload(captured.bytes)).toThrow('Non-absent root setting: model');
 expect(order).toEqual(['append','preserve','admit']);
 expect(Buffer.from(records[0].bodyBase64,'base64')).toEqual(Buffer.from(encode(attempted)));
 expect(records[0].sha256).toBe(new Bun.CryptoHasher('sha256').update(encode(attempted)).digest('hex'));
 expect(JSON.stringify(records)).not.toContain('do-not-retain');expect(records[0].method).toBe('POST');expect(records[0].url).toBe(req.url);
});

test('root fence keeps schema-specific absence, payload routing, exact owned ID and initial inventory restrictions',()=>{
 for(const patch of [{id:'ses_existing'},{title:'inherit'},{agent:'build'},{model:{}},{metadata:{}},{permissions:[]},{parentID:null},{fork:null},{unknown:null},{location:null},{location:{directory:'/other'}},{location:{directory:'/workspace',workspaceID:null}},{location:{directory:'/workspace',workspaceID:'ws_other'}},{location:{directory:'/workspace',unknown:null}}])expect(()=>qualifyRootPayload(encode({...rootWire,...patch}))).toThrow();
 const fence=createQualificationFence();expect(()=>fence.admit(request('/api/session'),base,new Uint8Array())).toThrow();
 fence.admitFreshOrigin();fence.admit(request('/api/session'),base,new Uint8Array());fence.admitEmptyInventory([]);
 expect(()=>fence.admit(request('/api/session/ses_other'),base,new Uint8Array())).toThrow();
 fence.admit(request('/api/session','POST',rootWire),base,encode(rootWire));
 const root={id:'ses_owned',projectID:'project',location:{directory:'/workspace'}};
 fence.ownRoot(qualifyRootResult(root,'project',[]));
 fence.admit(request('/api/session/ses_owned/message'),base,new Uint8Array());
 for(const path of ['/api/session/ses_other/message','/api/session','/api/debug/location'])expect(()=>fence.admit(request(path),base,new Uint8Array())).toThrow();
 for(const patch of [{parentID:null},{model:{}},{metadata:{}},{fork:{}},{location:{directory:'/workspace',workspaceID:null}}])expect(()=>qualifyRootResult({...root,...patch},'project',[])).toThrow();
 expect(()=>qualifyRootResult(root,'project',['ses_owned'])).toThrow();
 const ambiguous=new Request(request('/api/health').url+'&location%5Bdirectory%5D=%2Fworkspace');expect(()=>fence.admit(ambiguous,base,new Uint8Array())).toThrow();
});

test('cleanup error stays failed, stops uncertain release and never supplies successful qualification',async()=>{
 const calls:string[]=[];
 const receipt=await guardedFailureCleanup({dispose:async()=>{calls.push('dispose');},finiteJoin:async()=>{calls.push('finite');},guestEOFJoin:async()=>{calls.push('EOF');throw Error('observed cleanup join failure');},zeroWork:async()=>{calls.push('zero');},workspaceClose:async()=>{calls.push('close');}});
 expect(calls).toEqual(['dispose','finite','EOF']);expect(receipt.completed).toBe(false);expect(receipt.qualificationPassed).toBe(false);expect(receipt.error).toContain('observed cleanup join failure');
});
