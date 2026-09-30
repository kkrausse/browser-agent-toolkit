import {test,expect} from 'bun:test';
const source=await Bun.file(new URL('./export-matched-lifecycle.js',import.meta.url)).text();
const run=new Function('page','return (async()=>{'+source+'})()') as (page:unknown)=>Promise<any>;
test('complete ordered export includes all bytes and validates digest before receipt',async()=>{
 const evidence={condition:'reuse',status:'passed',privatePayload:'x'.repeat(180000)},parts:string[]=[];
 const fetch=async(path:string,init:{body:string})=>{
  if(path.endsWith('/complete')){const manifest=JSON.parse(init.body),text=parts.join('');expect(manifest.chunks).toBe(parts.length);expect(manifest.bytes).toBe(Buffer.byteLength(text));expect(manifest.sha256).toBe(new Bun.CryptoHasher('sha256').update(text).digest('hex'));expect(JSON.parse(text)).toEqual(evidence);return Response.json({...manifest,validated:true});}
  const index=Number(path.split('/').at(-1));expect(index).toBe(parts.length);expect(init.body.length).toBeLessThanOrEqual(65536);parts.push(init.body);return Response.json({index});
 };
 const page={evaluate:(fn:Function)=>new Function('window','location','fetch','return ('+fn.toString()+')()')({matchedPilot:{evidence}},{href:'http://isolated.test/'},fetch)};
 const result=await run(page);expect(result.receipt.validated).toBe(true);expect(parts.length).toBe(3);
});
test('nonterminal export refuses any request',async()=>{
 let calls=0;
 const page={evaluate:(fn:Function)=>new Function('window','location','fetch','return ('+fn.toString()+')()')({matchedPilot:{evidence:{status:'transition-1'}}},{},()=>{calls++;})};
 await expect(run(page)).rejects.toThrow('Not terminal');expect(calls).toBe(0);
});
test('failed chunk stops immediately without retry or complete commit',async()=>{
 let calls=0;
 const page={evaluate:(fn:Function)=>new Function('window','location','fetch','return ('+fn.toString()+')()')({matchedPilot:{evidence:{condition:'restart',status:'failed'}}},{href:'http://isolated.test/'},async()=>{calls++;return new Response('No',{status:400});})};
 await expect(run(page)).rejects.toThrow('Chunk export HTTP 400');expect(calls).toBe(1);
});
