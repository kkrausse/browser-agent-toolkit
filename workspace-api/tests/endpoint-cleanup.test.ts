// Observed source-owner failure: actual SDK endpoint, real streams/ports.
import { expect, test } from 'bun:test';
import { Runtime } from '../src/runtime';
import { workspaceInternals, type Workspace } from '../src/workspace';
import type { Host } from '../src/host';
import { WorkspaceController } from '../src/react';
import type { Execution } from '../src/types';
function deferred() {let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
for (const owner of ['runtime','controller']) for (const rejectCancel of [false,true]) test(`${owner} stop joins held cancellation (reject=${rejectCancel})`, async()=>{
  const oldLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:new URL('http://fixture.invalid/')});
  const gate=deferred(),started=deferred();let cancels=0;
  const ports:MessagePort[]=[];
  const distribution={name:'vivari',version:'fixture',assetBaseUrl:'/runtime/'};
  const workspace={} as Workspace;
  const host={features:new Set<string>(),listeners:new Map([[5173,'fixture']]),on(){return ()=>{};},async waitForListener(){return 'fixture';},
    post(_type:string,_message:unknown,transfer:MessagePort[]){ports.push(...transfer);}} as unknown as Host;
  const state={host,distribution,attached:false,clearing:false,closed:false};workspaceInternals.set(workspace,state);
  const runtime=await Runtime.start({workspace,distribution});
  try {
    const endpoint=await runtime.expose(5173);
    const controller=new WorkspaceController();
    if(owner==='controller') {
      const exit=deferred();
      const stream={async *[Symbol.asyncIterator](){await exit.promise;}};
      const execution:Execution={stdout:stream,stderr:stream,exited:exit.promise.then(()=>({exitCode:0,signal:null,forced:false})),writeStdin(){},closeStdin(){exit.resolve();},async stop(){exit.resolve();}};
      Object.defineProperty(controller,'runtime',{get:()=>({async node(){return execution;},async expose(){return endpoint;},stop:()=>runtime.stop()})});
      await controller.launch('fixture',{entry:'/fixture.js'},5173,async()=>({url:endpoint.url,fetch:async(input,init)=>endpoint.fetch(input instanceof Request?input.url:String(input),init)}));
    }
    const body=new ReadableStream<Uint8Array>({async cancel(){cancels++;started.resolve();await gate.promise;if(rejectCancel)throw Error('cancel failure');}});
    const request=endpoint.fetch('/',{method:'POST',body,duplex:'half'} as RequestInit);void request.catch(()=>{});
    endpoint.dispose();await endpoint.closed;await started.promise;
    const stop=owner==='runtime'?runtime.stop():controller.stopServices();
    if(owner==='runtime')expect(runtime.stop()).toBe(stop);
    let finished=false;void stop.then(()=>{finished=true;},()=>{finished=true;});
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(finished).toBe(false);expect(state.attached).toBe(true);
    if(owner==='runtime')await expect(runtime.expose(5173)).rejects.toThrow('Runtime stopped');
    gate.resolve();
    if(rejectCancel){await expect(stop).rejects.toThrow(owner==='runtime'?'workspace remains attached':'quiescence unproven');expect(state.attached).toBe(true);
      if(owner==='controller'){await expect(runtime.stop()).rejects.toThrow('workspace remains attached');}
      await expect(Runtime.start({workspace,distribution})).rejects.toThrow('already has an active runtime');
      // Each owner reported the gone endpoint's failure once; the retry is not sticky.
      if(owner==='controller')await controller.stopServices();
      await runtime.stop();expect(state.attached).toBe(false);}
    else {await stop;if(owner==='controller')await runtime.stop();expect(state.attached).toBe(false);}
    expect(cancels).toBe(1);await expect(request).rejects.toThrow();
  } finally {gate.resolve();for(const port of ports)port.close();if(oldLocation)Object.defineProperty(globalThis,'location',oldLocation);else delete (globalThis as {location?:Location}).location;}
});
