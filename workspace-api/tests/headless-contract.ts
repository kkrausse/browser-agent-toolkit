// Real Rust VFS + Node worker_threads process workers. The small Host adapter
// below supplies the browser RPC vocabulary against that real kernel; it is NOT
// browser OPFS/SW qualification. Public Runtime/execution/tool/fetch code is used.
import assert from "node:assert/strict";
import { Worker, MessageChannel } from "node:worker_threads";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Runtime, defineRipgrepTool } from "../src/index.ts";
import { workspaceInternals, type Workspace } from "../src/workspace.ts";
import type { Host, Message } from "../src/host.ts";
import type { Execution } from "../src/types.ts";
import { runtimeSourcePath, runtimeSourceUrl } from "../../vivari/scripts/runtime-source.mjs";
const { Kernel } = await import(runtimeSourceUrl("packages/kernel-host/kernel.js").href);
const { createKernelFs } = await import(runtimeSourceUrl("packages/kernel-host/kernel-fs.js").href);

assert.ok(!process.versions.bun, "Use real Node 24 (Bun workers are not this gate)");
assert.ok(!process.env.APP_RESTORE || (process.env.PREPARED_APPS && process.env.APP_STATE_DIR), "APP_RESTORE requires PREPARED_APPS and the previous run's APP_STATE_DIR");
const root = runtimeSourcePath();
const workers = new Set<Worker>();
const timeout = setTimeout(() => { console.error("headless contract timeout"); process.exit(1); }, process.env.PREPARED_APPS ? 240_000 : 90_000);
const fsWorker = new Worker(pathToFileURL(process.env.PREPARED_APPS ? resolve(import.meta.dirname, "app-fs-worker.mjs") : resolve(root, "scripts/fs-worker.mjs")), {
  workerData: { directory: process.env.APP_STATE_DIR ?? mkdtempSync(resolve(tmpdir(), "workspace-app-state-")) },
});
workers.add(fsWorker);
const fsRequests = new Map<number, { resolve: (m: Message) => void; reject: (e: Error) => void }>();
const changes: string[] = [];
let requestSequence = 1;
let fsMessage = (_message: unknown) => {};
await new Promise<void>((resolve, reject) => {
  fsWorker.on("error", reject);
  fsWorker.on("message", m => {
    if (m.type === "ready") resolve();
    else if (m.type === "vv-fs-changed") changes.push(m.path);
    else if (m.type === "vv-reply") {
      const p = fsRequests.get(m.reqId); fsRequests.delete(m.reqId);
      if (m.ok === false) p?.reject(new Error(m.error)); else p?.resolve(m);
    } else fsMessage(m);
  });
});
const kernelFs = createKernelFs(fsWorker); fsMessage = kernelFs.onMessage;
const callbacks = new Set<(m: Message) => void>();
const emit = (message: Message) => { for (const callback of callbacks) callback(message); };
const execByPid = new Map<number, number>(), pidByExec = new Map<number, number>();
const listeners = new Map<number, string>(); let listenerSequence = 0;
const kernel = new Kernel({
  fs: kernelFs.fs,
  stdout: (chunk: Uint8Array | string, pid: number) => emit({ type: "proc-out", execId: execByPid.get(pid), stream: "stdout", chunk }),
  stderr: (chunk: Uint8Array | string, pid: number) => emit({ type: "proc-out", execId: execByPid.get(pid), stream: "stderr", chunk }),
  spawnWorker(info: { pid: number; sab: SharedArrayBuffer; spec: unknown; on: Record<string, (m: unknown) => void> }) {
    const worker = new Worker(pathToFileURL(resolve(root, "scripts/process-worker.mjs")));
    workers.add(worker);
    worker.on("message", m => info.on[m.type]?.(m));
    worker.on("error", error => { console.error(error); kernel.stop(info.pid); });
    const { port1, port2 } = new MessageChannel();
    fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
    worker.postMessage({ type: "init", sab: info.sab, spec: info.spec, fsPort: port1 }, [port1]);
    return { postMessage: (m: unknown) => worker.postMessage(m), terminate() {
      void worker.terminate(); workers.delete(worker);
      fsWorker.postMessage({ type: "fs-unregister", client: info.pid });
    } };
  },
});
kernel.onProcExit = (pid: number, result: { code: number; signal: string | null }) => {
  emit({ type: "proc-exit", execId: execByPid.get(pid), code: result.code, signal: result.signal });
  pidByExec.delete(execByPid.get(pid)!); execByPid.delete(pid);
};
kernel.onStdioOverflow = (pid: number, channel: number) => emit({ type: "proc-output-error", execId: execByPid.get(pid), channel });
kernel.onListen = (port: number) => {
  const listenerId = `headless:${++listenerSequence}`;
  listeners.set(port, listenerId); emit({ type: "listen", port, listenerId });
};
kernel.onCloseServer = (port: number) => {
  const listenerId = listeners.get(port); listeners.delete(port); emit({ type: "unlisten", port, listenerId });
};
kernel.installCoreutils(); kernel.mkdirp("/workspace");
const host = {
  listeners, nextExecution: 1,
  features: new Set(['install-tree-v1']),
  on(callback: (m: Message) => void) { callbacks.add(callback); return () => callbacks.delete(callback); },
  async request(type: string, data: Record<string, unknown> = {}): Promise<Message> {
    if (type === "vv-stat") {
      if (!kernel.exists(data.path)) return { type: "vv-reply", exists: false };
      const stat = kernel.stat(data.path); return { type: "vv-reply", exists: true, isDir: stat.kind === "dir", size: stat.size };
    }
    if (type === "workspace-read" || type === "test-flush" || type === "workspace-install-tree") return new Promise((resolve, reject) => {
      const reqId = requestSequence++; fsRequests.set(reqId,{ resolve,reject }); fsWorker.postMessage({type,reqId,...data});
    });
    if (type === "workspace-write") { await kernel.writeFilesBatch([{ path: data.path, bytes: data.bytes }]); return { type: "vv-reply" }; }
    throw Error(`Unhandled test RPC: ${type}`);
  },
  post(type: string, data: Record<string, unknown>, transfer: MessagePort[] = []) {
    if (type === "workspace-http-stream") {
      if (listeners.get(Number(data.port)) !== data.listenerId) {
        transfer[0].postMessage({ op: "error", error: "HTTP listener closed" }); transfer[0].close(); return;
      }
      kernel.openHttpStream(Number(data.port), data.request, transfer[0]); return;
    }
    if (type === "proc-spawn") {
      if (data.listenerId && listeners.get(Number(data.port)) !== data.listenerId) {
        queueMicrotask(() => emit({ type: "proc-exit", execId: data.execId, code: 127, error: "listener closed" })); return;
      }
      const pid = kernel.launch(data.command, data.args, { cwd: data.cwd, env: data.env, stdioCredits: data.stdioCredits });
      execByPid.set(pid, Number(data.execId)); pidByExec.set(Number(data.execId), pid);
      queueMicrotask(() => emit({ type: "proc-started", execId: data.execId, pid })); return;
    }
    const pid = pidByExec.get(Number(data.execId));
    if (pid === undefined) return;
    if (type === "proc-kill") kernel.stop(pid);
    else if (type === "proc-input") kernel.sendStdin(pid, data.chunk);
    else throw Error(`Unhandled test message: ${type}`);
  },
  async registerPreview() { throw new Error("Programmatic HTTP must not register a preview SW"); },
} as unknown as Host;
Object.defineProperty(globalThis, "location", { value: { href: "http://localhost:43917/" }, configurable: true });
const distribution = { name: "vivari", version: "headless-contract", assetBaseUrl: "/unused" };
const workspace = {} as Workspace;
workspaceInternals.set(workspace, { host, distribution, attached: false, closed: false });
async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = []; for await (const bytes of stream) chunks.push(bytes);
  return Buffer.concat(chunks);
}
async function output(execution: Execution) {
  const [stdout, stderr, exit] = await Promise.all([collect(execution.stdout), collect(execution.stderr), execution.exited]);
  return { stdout, stderr, exit };
}
let runtime: Awaited<ReturnType<typeof Runtime.start>> | undefined;
async function testOfflineContract() {
  const bulk = await Runtime.start({ workspace, distribution, tools: { tree: {
    name: 'bulk-contract', version: '1', async bind(context) {
      return async () => {
        const bytes = new TextEncoder().encode('bulk-installed');
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
        const result = await context.installTree({ roots: ['/workspace/deps'], entries: [
          { kind: 'directory', path: '/workspace/deps', mode: 0o755 },
          { kind: 'file', path: '/workspace/deps/file', bytes, sha256, mode: 0o755, verifyReadback: true },
        ] });
        assert.equal(result.files, 1);
        assert.deepEqual(await context.readFile('/workspace/deps/file'), bytes);
      };
    },
  } } });
  await bulk.tools.tree();
  host.features.clear();
  await assert.rejects(bulk.tools.tree(), /rebuild its distribution/);
  host.features.add('install-tree-v1');
  await bulk.stop();
  console.log('PASS bulk tool install through real FS worker and unsupported runtime rejection');
  runtime = await Runtime.start({ workspace, distribution });
  kernel.writeFile("/workspace/http-stream.cjs", readFileSync(runtimeSourcePath("scripts/fixtures/runtime-contracts/http-stream-server.cjs")));
  let httpServer = await runtime.node({ entry: "/workspace/http-stream.cjs" });
  let httpOutput = output(httpServer);
  let httpEndpoint = await runtime.expose(3187, { signal: AbortSignal.timeout(5000) });
  const nextPid = kernel.nextPid;
  const { checkHttpStreaming } = await import(runtimeSourceUrl("scripts/lib/http-stream-checks.mjs").href);
  console.log(await checkHttpStreaming(httpEndpoint.fetch));
  assert.equal(kernel.nextPid, nextPid, "HTTP requests spawned processes");
  const retired = httpEndpoint;
  const shutdown = await retired.fetch("/shutdown");
  await retired.closed;
  await assert.rejects(retired.fetch("/json"), { code: "CLOSED" });
  assert.equal(await shutdown.text(), "graceful", "accepted response must drain after listener closes");
  assert.equal((await httpOutput).exit.exitCode, 0);
  httpServer = await runtime.node({ entry: "/workspace/http-stream.cjs" });
  httpOutput = output(httpServer);
  httpEndpoint = await runtime.expose(3187, { signal: AbortSignal.timeout(5000) });
  assert.notEqual(httpEndpoint.url, retired.url);
  console.log("PASS graceful listener close drains accepted response before process exit");
  const active = await httpEndpoint.fetch("/sse");
  const activeReader = active.body!.getReader();
  await activeReader.read();
  await httpServer.stop(); await httpOutput;
  await assert.rejects(activeReader.read());
  await assert.rejects(httpEndpoint.fetch("/json"), { code: "CLOSED" });
  assert.equal(kernel.httpStreams.size, 0, "HTTP channels leaked");
  console.log("PASS HTTP process accounting/active-request exit cleanup");
  await kernel.writeFilesBatch([{ path: "/workspace/large.bin", bytes: Uint8Array.from({ length: 1_200_001 }, (_, i) => i % 256) }]);
  const large = (await host.request("workspace-read", { path: "/workspace/large.bin" })).bytes as Uint8Array;
  assert.equal(large.length,1_200_001); assert.ok(large.every((b,i)=>b===i%256));
  kernel.writeFile("/workspace/probe.cjs", `
const fs=require('node:fs');const b=fs.readFileSync('/workspace/large.bin');if(b.length!==1200001 || b[255]!==255)throw Error('shared binary');
fs.writeFileSync('/workspace/guest.bin',Buffer.from([0,255,128]));fs.renameSync('/workspace/guest.bin','/workspace/renamed.bin');
process.stdout.write(Buffer.from([0,255,195]));process.stdout.write(Buffer.from([169]));process.stderr.write(Buffer.from([254,0,128]));
if(process.argv[2]!=='argument with spaces'||process.cwd()!=='/workspace'||process.env.PROBE!=='exact')throw Error('arguments');process.exitCode=7;
`);
  const probe = await output(await runtime.node({ entry: "/workspace/probe.cjs", args: ["argument with spaces"], env: { PROBE: "exact" } }));
  assert.deepEqual([...probe.stdout], [0,255,195,169]); assert.deepEqual([...probe.stderr], [254,0,128]); assert.equal(probe.exit.exitCode,7); assert.equal(probe.exit.forced,false);
  assert.deepEqual([...kernel.readFileBytes("/workspace/renamed.bin")], [0,255,128]);
  assert.ok(changes.includes("/workspace/guest.bin") && changes.includes("/workspace/renamed.bin"));
  console.log("PASS shared large/binary VFS, exact argv/cwd/env, split byte stdout/stderr, exit 7");
  await assert.rejects(runtime.node({ entry: "/workspace/missing.cjs" }), { code: "ENTRY_NOT_FOUND" });
  kernel.writeFile("/workspace/stdin.cjs", `const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks)));process.stdin.resume();`);
  const stdin = await runtime.node({ entry: "/workspace/stdin.cjs" }); const stdinOutput = output(stdin);
  stdin.writeStdin(Uint8Array.from({ length: 256 }, (_, i) => i)); stdin.closeStdin();
  assert.deepEqual([...(await stdinOutput).stdout], Array.from({ length: 256 }, (_,i) => i));
  console.log("PASS raw stdin and EOF");
  kernel.writeFile("/workspace/child-bytes.cjs", `const child=require('child_process').spawn('node',['-e',"process.stdout.write(Buffer.from(Array.from({length:256},(_,i)=>i)));process.stderr.write(Buffer.from([0,255,128]))"],{stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));`);
  const childBytes = await output(await runtime.node({ entry: "/workspace/child-bytes.cjs" }));
  assert.deepEqual([...childBytes.stdout], Array.from({ length: 256 }, (_,i) => i));
  assert.deepEqual([...childBytes.stderr], [0,255,128]);
  console.log("PASS child-process stdout/stderr preserve arbitrary bytes");
  kernel.writeFile("/workspace/server.cjs", `
const http=require('node:http');const fs=require('node:fs');const server=http.createServer((req,res)=>{
if(req.url==='/stream'){res.setHeader('content-type','text/event-stream');res.write('data: first\\n\\n');const timer=setInterval(()=>res.write('data: later\\n\\n'),50);res.on('close',()=>{clearInterval(timer);fs.writeFileSync('/workspace/cancelled','yes')});return;}
if(req.url==='/close'){res.end('closing');setTimeout(()=>server.close(),30);return;}
if(req.method==='POST'){const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>res.end(Buffer.concat(chunks)));return;}
res.statusCode=418;res.setHeader('x-probe','real');res.end(Buffer.from([0,255,128]));});server.listen(4187);
`);
  const server = await runtime.node({ entry: "/workspace/server.cjs" }); const serverOutput = output(server);
  const endpoint = await runtime.expose(4187, { signal: AbortSignal.timeout(5000) });
  const response = await endpoint.fetch("/binary");
  assert.equal(response.status,418); assert.equal(response.headers.get("x-probe"),"real"); assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0,255,128]);
  const post = await endpoint.fetch("/echo", { method: "POST", body: Uint8Array.of(0,255,128,17) });
  assert.deepEqual([...new Uint8Array(await post.arrayBuffer())],[0,255,128,17]);
  const stream = await endpoint.fetch("/stream"); const reader = stream.body!.getReader();
  assert.match(Buffer.from((await reader.read()).value!).toString(), /first/);
  assert.match(Buffer.from((await reader.read()).value!).toString(), /later/);
  await reader.cancel();
  const until = Date.now()+3000; while (!kernel.exists("/workspace/cancelled") && Date.now()<until) await new Promise(r=>setTimeout(r,10));
  assert.equal(kernel.readFile("/workspace/cancelled"),"yes");
  console.log("PASS real guest HTTP binary/status/headers/POST and two live Fetch chunks, cancellation reaches guest");
  await (await endpoint.fetch("/close")).text(); await endpoint.closed; await serverOutput;
  await assert.rejects(endpoint.fetch("/"), { code: "CLOSED" });
  const replacement = await runtime.node({ entry: "/workspace/server.cjs" }); const replacementOutput = output(replacement);
  const newEndpoint = await runtime.expose(4187, { signal: AbortSignal.timeout(5000) }); assert.notEqual(newEndpoint.url,endpoint.url);
  await runtime.stop(); await replacementOutput; assert.equal((await replacement.exited).forced,true);
  assert.equal(kernel.procs.size,0); assert.equal(kernel.listeners.size,0);
  console.log("PASS listener explicit close, reused port identity, runtime stop cleans process tree/ports");
  kernel.writeFile("/workspace/after-stop","retained");
  runtime = await Runtime.start({ workspace, distribution });
  assert.equal(kernel.readFile("/workspace/after-stop"),"retained");
  kernel.writeFile("/workspace/overflow.cjs", `for(let i=0;i<256;i++)process.stdout.write(Buffer.alloc(16384,255));setInterval(()=>{},1000);`);
  const overflow = await runtime.node({ entry: "/workspace/overflow.cjs" });
  const overflowErr = collect(overflow.stderr); await overflow.exited;
  await assert.rejects(collect(overflow.stdout), { code: "OUTPUT_OVERFLOW" }); await overflowErr;
  await runtime.stop(); runtime = undefined;
  console.log("PASS reattach shared filesystem and bounded output overflow kills execution");

  const originalFetch = globalThis.fetch;
  const packageDir = resolve(import.meta.dirname, "../../vivari/.runtime/opencode-package");
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "tool-assets.invalid") {
      const name = parsed.pathname.slice(1); if (!/^[\w.-]+$/.test(name)) throw Error("invalid fixture asset");
      return new Response(readFileSync(resolve(packageDir,name)));
    }
    return originalFetch(url,init);
  }) as typeof fetch;
  const tools = await Runtime.start({ workspace, distribution, tools: { ripgrep: defineRipgrepTool({ receiptUrl: "http://tool-assets.invalid/rg-receipt.json" }) } });
  try {
    kernel.mkdirp("/workspace/search"); kernel.writeFile("/workspace/search/a.txt", "TODO café\nTODO second\n");
    kernel.writeFile("/workspace/search/.ignore","ignored.txt\n"); kernel.writeFile("/workspace/search/ignored.txt","TODO hidden\n");
    kernel.writeFile("/bin/rg", "throw Error('PATH shadow must not run');");
    const matches = await tools.tools.ripgrep({ pattern: "TODO", paths: ["/workspace/search"] });
    assert.equal(matches.matches.length,2); assert.match(matches.matches[0].text,/café/);
    assert.equal((await tools.tools.ripgrep({ pattern: "absent", paths: ["/workspace/search"] })).matches.length,0);
    await assert.rejects(tools.tools.ripgrep({ pattern: "[", paths: ["/workspace/search"] }), { code: "TOOL_FAILED" });
    const truncated = await tools.tools.ripgrep({ pattern: "TODO", paths: ["/workspace/search"], maxMatches: 1 }); assert.equal(truncated.truncated,true); assert.equal(truncated.matches.length,1);
    assert.equal((await tools.tools.ripgrep({ pattern: "TODO", paths: ["/workspace/search"], glob: ["!*.txt"] })).matches.length,0);
    console.log("PASS real ripgrep WASM positive/no-match/invalid-regex/Unicode/ignore/glob/truncation and shadowed CLI");
  } finally { await tools.stop(); globalThis.fetch=originalFetch; }
}
try {
  if (!process.env.APP_RESTORE) await testOfflineContract();
  if (process.env.PREPARED_APPS) throw new Error('The historical prepared-app harness remains in random; use examples/todo-app/tests for current editor acceptance');
  console.log("RESULT PASS (real headless workers; browser-only gates remain separate)");
} finally { await runtime?.stop(); for (const worker of workers) await worker.terminate(); clearTimeout(timeout); }
