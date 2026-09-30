import {expect, test} from 'bun:test';
import {assertSingleKernelDiagnostics, assertZeroWork, assertKernelWorkerURL,fsProbe,connectionApiURL,binaryCaptureBoundariesProbe} from './single-kernel-contract';
test('zero-work validation never interprets missing fields as zero', () => {
  expect(()=>assertZeroWork({})).toThrow();
  const zero={procs:[],listeners:[],pendingHttp:0,fetch:{inflight:0,queued:0,active:0}};
  expect(()=>assertZeroWork(zero)).not.toThrow();
  expect(()=>assertZeroWork({...zero,pendingHttp:1})).toThrow();
});
test('topology is explicit, not inferred from empty processes', () => {
  expect(()=>assertSingleKernelDiagnostics({procs:[]})).toThrow();
  const workers={kernel:1,filesystem:0,httpCoordinator:0,fetcher:0,other:0,process:2,processPids:[1,2]};
  expect(()=>assertSingleKernelDiagnostics({workers})).not.toThrow();
  expect(()=>assertSingleKernelDiagnostics({workers:{...workers,filesystem:1}})).toThrow();
  expect(()=>assertSingleKernelDiagnostics({workers:{...workers,fetcher:1}})).toThrow();
  expect(()=>assertSingleKernelDiagnostics({workers:{...workers,processPids:[1,1]}})).toThrow();
});
test('probe really contains newline filenames and synchronous operations', () => {
  expect(fsProbe).toContain("'line\\nentry.txt'");
  expect(fsProbe).toContain('fs.lstatSync');
  expect(fsProbe).toContain('fs.readdirSync');
});
test('source-mode Vite worker query remains valid with explicit SQLite proxy opt-out',()=>{
  expect(()=>assertKernelWorkerURL('http://127.0.0.1:54321/packages/kernel-host/kernel-worker.js?worker_file&type=module&opfs-disable')).not.toThrow();
  expect(()=>assertKernelWorkerURL('http://127.0.0.1:54321/packages/kernel-host/kernel-worker.js?worker_file&type=module?opfs-disable')).toThrow();
  expect(()=>assertKernelWorkerURL('http://127.0.0.1:54321/runtime/assets/kernel-worker-fresh.js?opfs-disable=')).not.toThrow();
});
test('authenticated OpenCode API calls remain inside their endpoint mount',()=>{
  const endpoint='http://127.0.0.1:51587/preview/4096/?__vv_listener=owned';
  expect(connectionApiURL(endpoint,'/api/event')).toBe('http://127.0.0.1:51587/preview/4096/api/event');
  expect(connectionApiURL(endpoint,'/api/health')).toBe('http://127.0.0.1:51587/preview/4096/api/health');
  expect(()=>connectionApiURL(endpoint,'https://other.invalid/api/event')).toThrow();
});
test('binary capture probe checks bytes and bounded errors rather than decoded length',()=>{
  expect(binaryCaptureBoundariesProbe).toContain('b[i]!==i%251');
  expect(binaryCaptureBoundariesProbe).toContain("overflow.error?.code!=='ENOBUFS'");
  expect(binaryCaptureBoundariesProbe).toContain('check(both.stderr,1048583)');
});
