import {test, expect} from 'bun:test';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createPilotFence, resetPilot, pilotReuseAllowed, pilotRequestURL, type ReuseIdentity} from './reuse-pilot-fence';
const url = 'http://pilot/api/config';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return {promise,resolve}; };
test('HTTP 200 semantic rejection retains complete bytes/hash/headers and normal transport without admitting reset', async () => {
  const text = '{"data":[],"cursor":{"next":42}}';
  const fence = createPilotFence(async () => new Response(text, {headers:{'content-type':'application/json','x-proof':'complete'}}), false, undefined, true);
  await expect(fence.fetch('http://pilot/api/session')).rejects.toThrow('paged');
  const record = fence.records[0]!;
  expect(record.status).toBe(200); expect(record.state).toBe('failed');
  expect(record.transport).toBe('normal'); expect(record.semantic).toBe('rejected');
  expect(atob(record.wire!.bodyBase64)).toBe(text);
  expect(record.wire!.bytes).toBe(new TextEncoder().encode(text).length);
  expect(record.wire!.sha256).toBe(new Bun.CryptoHasher('sha256').update(text).digest('hex'));
  expect(record.wire!.headers).toContainEqual(['x-proof','complete']);
  fence.freeze(); await expect(fence.drain(100)).rejects.toThrow('normal completion unproven');
});
test('aborting an outstanding body cancels its reader and leaves transport uncertain', async () => {
  let cancelled = false;
  const joined = deferred<void>();
  const cancellation = new AbortController();
  const fence = createPilotFence(async (_url, init) => {
    expect(init?.signal).toBeDefined();
    return new Response(new ReadableStream({cancel(){cancelled=true;return joined.promise;}}));
  });
  const call = fence.fetch(url, {signal:cancellation.signal});
  let settled = false; void call.catch(() => {settled=true;});
  await Bun.sleep(1); cancellation.abort();
  await Bun.sleep(1); expect(cancelled).toBe(true); expect(settled).toBe(false);
  joined.resolve();
  await expect(call).rejects.toThrow();
  expect(cancelled).toBe(true); expect(fence.records[0]!.transport).toBe('failed');
  expect(fence.records[0]!.wire).toBeUndefined();
});
test('fully consumed normal responses precede awaited disposal, DELETE, writes, acquisition', async () => {
  const body = deferred<Uint8Array>(); const disposal = deferred<void>(); const deletion = deferred<void>(); const order: string[] = [];
  const fence = createPilotFence(async () => new Response(new ReadableStream({async start(c) { c.enqueue(await body.promise); c.close(); }})));
  const call = fence.fetch(url); await Promise.resolve();
  const reset = resetPilot({fence,deadlineMs:1000,dispose:async () => {order.push('dispose'); await disposal.promise;},evict:async () => {order.push('DELETE'); await deletion.promise;},replace:async () => {order.push('write');},acquire:async () => {order.push('acquire');}});
  await expect(fence.fetch(url)).rejects.toThrow('frozen'); expect(order).toEqual([]);
  body.resolve(new Uint8Array([1])); await call; await Bun.sleep(1); expect(order).toEqual(['dispose']);
  disposal.resolve(); await Bun.sleep(1); expect(order).toEqual(['dispose','DELETE']);
  deletion.resolve(); await reset; expect(order).toEqual(['dispose','DELETE','write','acquire']); expect(fence.records[0]?.state).toBe('normal');
});
for (const failure of ['cancel','timeout','dispose','DELETE'] as const) test(failure + ' forbids replacement/reacquisition', async () => {
  const cancellation = new AbortController(); const unresolved = deferred<Response>(); const order: string[] = [];
  const fence = createPilotFence(async () => failure === 'timeout' ? unresolved.promise : new Response('ok'));
  const call = fence.fetch(url,{signal:cancellation.signal});
  if (failure === 'cancel') cancellation.abort();
  const settled = call.catch(() => undefined);
  if (failure !== 'timeout') await settled;
  await expect(resetPilot({fence,deadlineMs:2,dispose:async () => {order.push('dispose'); if(failure==='dispose') throw Error('dispose');},evict:async () => {order.push('DELETE'); if(failure==='DELETE') throw Error('DELETE');},replace:async () => {order.push('write');},acquire:async () => {order.push('acquire');}})).rejects.toThrow();
  expect(order).toEqual(failure==='dispose' ? ['dispose'] : failure==='DELETE' ? ['dispose','DELETE'] : []);
  await expect(fence.fetch(url)).rejects.toThrow('frozen');
  unresolved.resolve(new Response('late')); await settled;
});
test('source-only comparator rejects changed route/model/plugin/dependency/env/cwd/runtime', () => {
  const a: ReuseIdentity = {location:'/workspace',modelConfig:'fixed',pluginBytes:'hash',dependencies:'hash',environment:'fixed',cwd:'/app',runtime:'446df00'};
  expect(pilotReuseAllowed(a,{...a})).toBe(true);
  for (const key of Object.keys(a)) expect(pilotReuseAllowed(a,{...a,[key]:'changed'})).toBe(false);
});
test('response headers are not completion; aborted body fails the fence', async () => {
  const body = deferred<Uint8Array>(); const cancellation = new AbortController(); let evictions=0;
  const fence=createPilotFence(async()=>new Response(new ReadableStream({async start(c){c.enqueue(await body.promise);c.close();}})));
  const request=fence.fetch(url,{signal:cancellation.signal}); const failed=request.catch(()=>undefined);
  await Promise.resolve(); expect(fence.records[0]?.state).toBe('pending'); cancellation.abort(); body.resolve(new Uint8Array([1])); await failed;
  await expect(resetPilot({fence,deadlineMs:100,dispose:async()=>{},evict:async()=>{evictions++;},replace:async()=>{},acquire:async()=>{}})).rejects.toThrow();
  expect(evictions).toBe(0); expect(fence.records[0]?.state).toBe('failed');
});
test('endpoint routing retains preview prefix/listener and rejects host-root/other endpoint', async () => {
  const endpoint='http://127.0.0.1:43224/preview/4096/?__vv_listener=owned';
  const routed=pilotRequestURL(endpoint,'/api/config?location%5Bdirectory%5D=%2Fworkspace');
  expect(routed).toBe('http://127.0.0.1:43224/preview/4096/api/config?location%5Bdirectory%5D=%2Fworkspace&__vv_listener=owned');
  let calls=0; const fence=createPilotFence(async()=>{calls++;return new Response('ok');},false,endpoint);
  await fence.fetch(routed);
  await expect(fence.fetch(new URL('/api/config',endpoint).href)).rejects.toThrow('route changed');
  await expect(fence.fetch('http://127.0.0.1:43224/preview/5173/api/config')).rejects.toThrow('route changed');
  await expect(fence.fetch(pilotRequestURL(endpoint,'/api/config?location[directory]=/other'))).rejects.toThrow('location changed');
  await expect(fence.fetch(pilotRequestURL(endpoint,'/api/config?location[workspace]=other'))).rejects.toThrow('workspace identity changed');
  await expect(fence.fetch(pilotRequestURL(endpoint,'/api/session/example/move'),{method:'POST'})).rejects.toThrow('forbidden');
  expect(calls).toBe(1);
});
// This test imports the SDK endpoint from a frozen runtime snapshot that exists only
// in the ignored, machine-local .diagnostics/ directory of the checkout that
// prepared it. Point REUSE_PILOT_PINNED_ENDPOINT at an equivalent endpoint.ts to run
// it elsewhere; without the file the test is skipped (and says so) instead of failing.
const pinnedEndpoint = resolve(import.meta.dir, process.env.REUSE_PILOT_PINNED_ENDPOINT
  ?? '../../../.diagnostics/reviewed-client-prep-2026-09-30T02-30-20-204Z/runtime-source/packages/core/src/host-sdk/browser/endpoint.ts');
const pinnedEndpointAvailable = existsSync(pinnedEndpoint);
(pinnedEndpointAvailable ? test : test.skip)('corrected caller URL reaches the pinned SDK as the exact guest route'
  + (pinnedEndpointAvailable ? '' : ` [SKIPPED: pinned SDK snapshot not found at ${pinnedEndpoint}; set REUSE_PILOT_PINNED_ENDPOINT]`), async () => {
  const {createEndpoint} = await import(pinnedEndpoint);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {configurable:true,value:{href:'http://127.0.0.1:43225/'}});
  const sent: any[] = [];
  const host = {listeners:new Map([[4096,'owned']]),on:()=>()=>{},post:(...args:any[])=>{sent.push(args);throw Error('offline transport boundary');}};
  const endpoint = createEndpoint(host,4096,'owned',new AbortController().signal);
  try {
    const route = '/api/config?location%5Bdirectory%5D=%2Fworkspace';
    await expect(endpoint.fetch(pilotRequestURL(endpoint.url,route))).rejects.toThrow('offline transport boundary');
    expect(sent[0][0]).toBe('workspace-http-stream');
    expect(sent[0][1].request.path).toBe(route);
    expect(sent[0][1].port).toBe(4096);
    expect(sent[0][1].listenerId).toBe('owned');
    await expect(endpoint.fetch(new URL('/api/config',endpoint.url).href)).rejects.toThrow('another endpoint');
    expect(sent.length).toBe(1);
  } finally {
    endpoint.dispose();
    if(previous) Object.defineProperty(globalThis,'location',previous);
    else Reflect.deleteProperty(globalThis,'location');
  }
});
