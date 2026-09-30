import {expect,test} from 'bun:test';
import {runInNewContext} from 'node:vm';
import {acceptanceRequestCode,runFoundation,validateOwnedOrigins,inventoryCode} from './single-kernel-driver';

test('foundation starts serially and never starts after first failure',async()=>{
  const seen:string[]=[];let active=0;
  await expect(runFoundation(async action=>{expect(++active).toBe(1);seen.push(action);await Bun.sleep(1);--active;if(action==='watches')throw Error('watch failure');})).rejects.toThrow('watch failure');
  expect(seen).toEqual(['open','childSync','captureBoundaries','initialize','minimalAsyncSpawn','minimalSpawnSync','minimalExecSync','fetchedBody','watches']);
});
test('page initiation is one-shot and blocks another token until settlement',async()=>{
  let release!:()=>void,calls=0;
  const window:any={accept:{start:()=>{calls++;return new Promise<void>(resolve=>{release=resolve;})}}};
  const page={evaluate:(fn:any,args:any)=>fn(args)};
  const execute=(token:string)=>runInNewContext(`(async()=>{${acceptanceRequestCode('accept','start',[],token)}})()`,{page,window,Promise,Error});
  await execute('first');await Promise.resolve();
  await expect(execute('second')).rejects.toThrow('Duplicate or competing');expect(calls).toBe(1);
  release();await Bun.sleep(1);await expect(execute('first')).rejects.toThrow('Duplicate or competing');expect(calls).toBe(1);
});
test('only distinct owned fresh loopback origin metadata can authorize driver',()=>{
  const output='/owned',app={url:'http://127.0.0.1:54321/',output,pid:1,contracts:false},contracts={url:'http://127.0.0.1:54322/',output,pid:2,contracts:true};
  expect(()=>validateOwnedOrigins(app,contracts,output)).not.toThrow();
  expect(()=>validateOwnedOrigins({...app,url:'http://127.0.0.1:43222/'},contracts,output)).toThrow();
  expect(()=>validateOwnedOrigins(app,{...contracts,url:app.url},output)).toThrow();
  expect(()=>validateOwnedOrigins({...app,output:'/other'},contracts,output)).toThrow();
});
test('actual Chrome census permits relay and dynamic processes but rejects hidden auxiliary blob workers',async()=>{
  const origin='http://127.0.0.1:54321';let detached=0;
  const targets:any[]=[{targetId:'page',type:'page',url:origin+'/'},{targetId:'kernel',type:'worker',url:origin+'/runtime/assets/kernel-worker-fresh.js?opfs-disable'},{targetId:'process1',type:'worker',url:origin+'/runtime/assets/process-worker-fresh.js'},{targetId:'process2',type:'worker',url:origin+'/runtime/assets/process-worker-fresh.js'},{targetId:'relay',type:'service_worker',url:origin+'/runtime/assets/sw.js'},{targetId:'old',type:'worker',url:'http://127.0.0.1:43222/assets/fs-worker-old.js'}];
  const page={url:()=>origin+'/',context:()=>({newCDPSession:async()=>({send:async()=>({targetInfos:targets}),detach:async()=>{detached++;}})}),evaluate:async()=>({workers:{kernel:1,process:2}})};
  const execute=()=>runInNewContext(`(async()=>{${inventoryCode(true)}})()`,{page,URL,Set,Error,JSON});
  expect((await execute()).targets).toHaveLength(4);expect(detached).toBe(1);
  targets.push({targetId:'sqlite-proxy',type:'worker',url:'blob:'+origin+'/opaque'});
  await expect(execute()).rejects.toThrow('Chrome worker topology mismatch');expect(detached).toBe(2);
  targets.pop();targets.push({targetId:'opaque-child',type:'worker',url:'data:text/javascript,opaque',openerId:'kernel'});
  await expect(execute()).rejects.toThrow('Chrome worker topology mismatch');expect(detached).toBe(3);
});
test('close census observes target propagation without replaying stop or hiding auxiliaries',async()=>{
  const origin='http://127.0.0.1:54321';let targets:any[]=[{targetId:'kernel',type:'worker',url:origin+'/runtime/assets/kernel-worker-fresh.js?opfs-disable='},{targetId:'process',type:'worker',url:origin+'/runtime/assets/process-worker-fresh.js'}];
  const page={url:()=>origin+'/',context:()=>({newCDPSession:async()=>({send:async()=>({targetInfos:targets}),detach:async()=>{}})})};
  const observe=()=>runInNewContext(`(async()=>{${inventoryCode(false,true)}})()`,{page,URL,Set,Error,JSON});
  expect((await observe()).closed).toBe(false);
  targets=[];expect((await observe()).closed).toBe(true);
  targets=[{targetId:'extra',type:'worker',url:'blob:'+origin+'/opaque'}];await expect(observe()).rejects.toThrow('Chrome worker topology mismatch');
});
