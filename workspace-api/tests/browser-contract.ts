import { Workspace, Runtime, opfsStore, defineRipgrepTool, attachPreview, type Distribution, type Execution } from "../src/index";

const results: string[] = [];
const log = (message: string) => { results.push(message); document.querySelector("pre")!.textContent = results.join("\n"); };
function assert(value: unknown, label: string): asserts value { if (!value) throw new Error(label); log("PASS " + label); }
async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const bytes of stream) { chunks.push(bytes); size += bytes.length; }
  const all = new Uint8Array(size); let offset = 0;
  for (const bytes of chunks) { all.set(bytes, offset); offset += bytes.length; }
  return all;
}
async function output(execution: Execution) {
  const [stdout, stderr, exit] = await Promise.all([collect(execution.stdout), collect(execution.stderr), execution.exited]);
  return { stdout, stderr, exit };
}
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
async function distribution(): Promise<Distribution> {
  const manifest = await fetch("/runtime/distribution.json").then(r => r.json());
  return { name: "vivari", version: manifest.version, assetBaseUrl: "/runtime/" };
}
export async function run() {
  const dist = await distribution();
  log("BUILD " + dist.version);
  const workspace = await Workspace.open({ id: "default", storage: opfsStore(dist) });
  let runtime: Awaited<ReturnType<typeof Runtime.start>> | undefined;
  try {
    assert(workspace.persistence.status === "durable", "structured durable storage ready");
    const binary = Uint8Array.from({ length: 1_200_001 }, (_, i) => i % 256);
    await workspace.fs.writeFile("/binary.dat", binary);
    const read = await workspace.fs.readFile("/binary.dat");
    assert(read.length === binary.length && read.every((b, i) => b === binary[i]), "large binary host write/read");
    assert((await workspace.fs.stat("/binary.dat")).size === binary.length, "real stat size");
    const changes: string[] = [];
    const unwatch = workspace.fs.watch(event => changes.push(...event.paths));
    runtime = await Runtime.start({ distribution: dist, workspace });
    await workspace.close().then(() => { throw new Error("close accepted attached runtime"); }, () => log("PASS close rejects attached runtime"));
    await workspace.fs.writeFile("/probe.cjs", `
const fs = require('node:fs');
const b = fs.readFileSync('/workspace/binary.dat');
if(b.length !== 1200001 || b[255] !== 255) throw Error('shared file');
fs.writeFileSync('/workspace/guest.bin', Buffer.from([0,255,128,1]));
fs.renameSync('/workspace/guest.bin','/workspace/renamed.bin');
process.stdout.write(Buffer.from([0,255,0xc3])); process.stdout.write(Buffer.from([0xa9]));
process.stderr.write(Buffer.from([254,0,128]));
if (process.argv[2] !== 'argument with spaces' || process.cwd() !== '/workspace' || process.env.PROBE !== 'exact') throw Error('arguments');
process.exitCode = 7;
`);
    const probe = await output(await runtime.node({ entry: "/workspace/probe.cjs", args: ["argument with spaces"], env: { PROBE: "exact" } }));
    assert(JSON.stringify([...probe.stdout]) === "[0,255,195,169]", "arbitrary binary/split UTF-8 stdout");
    assert(JSON.stringify([...probe.stderr]) === "[254,0,128]", "separate binary stderr");
    assert(probe.exit.exitCode === 7 && !probe.exit.forced, "ordinary exit 7, exact argv/cwd/env");
    assert(JSON.stringify([...(await workspace.fs.readFile("/renamed.bin"))]) === "[0,255,128,1]", "guest rename/write visible through same Workspace");
    assert(changes.includes("/renamed.bin") && changes.includes("/guest.bin"), "guest rename/watch events");
    unwatch();
    await runtime.node({ entry: "/workspace/missing.cjs" }).then(() => { throw new Error("missing entry launched"); }, e => assert(e.code === "ENTRY_NOT_FOUND", "missing entry rejects"));
    await workspace.fs.writeFile("/server.cjs", `
const http=require('node:http'); const fs=require('node:fs');
const server=http.createServer((req,res)=>{
 if(req.url==='/stream'){ res.setHeader('content-type','text/event-stream'); res.write('data: first\\n\\n'); const timer=setInterval(()=>res.write('data: later\\n\\n'),80); res.on('close',()=>{clearInterval(timer);fs.writeFileSync('/workspace/cancelled','yes')}); return; }
 if(req.url==='/close'){res.end('closing');setTimeout(()=>server.close(),30);return;}
 if(req.url==='/binary'){res.statusCode=418;res.setHeader('x-probe','real');res.end(Buffer.from([0,255,128]));return;}
 if(req.method==='POST'){const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>res.end(Buffer.concat(chunks)));return;}
 res.setHeader('content-type','text/html');res.end('<html><body>guest preview</body></html>');
});server.listen(4179);
`);
    const server = await runtime.node({ entry: "/workspace/server.cjs" });
    const serverOutput = output(server);
    const endpoint = await runtime.expose(4179, { signal: AbortSignal.timeout(10_000) });
    const response = await endpoint.fetch("/binary");
    assert(response.status === 418 && response.headers.get("x-probe") === "real" && JSON.stringify([...new Uint8Array(await response.arrayBuffer())]) === "[0,255,128]", "HTTP status/headers/binary response");
    const posted = await endpoint.fetch("/echo", { method: "POST", body: Uint8Array.of(0,255,128,17), headers: { "content-type": "application/octet-stream" } });
    assert(JSON.stringify([...new Uint8Array(await posted.arrayBuffer())]) === "[0,255,128,17]", "binary POST echo");
    const stream = await endpoint.fetch("/stream"); const reader = stream.body!.getReader();
    assert(decode((await reader.read()).value!).includes("first"), "Fetch first chunk before response completion");
    assert(decode((await reader.read()).value!).includes("later"), "Fetch second live chunk");
    await reader.cancel();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { try { await workspace.fs.readFile("/cancelled"); break; } catch { await new Promise(r => setTimeout(r, 30)); } }
    assert(decode(await workspace.fs.readFile("/cancelled")) === "yes", "Fetch cancellation reached guest connection");
    const iframe = document.createElement("iframe"); document.body.append(iframe);
    const attachment = attachPreview(iframe, endpoint);
    await new Promise<void>((resolve, reject) => { const deadline = Date.now() + 5000; const timer = setInterval(() => { if (iframe.contentDocument?.body?.textContent?.includes("guest preview")) { clearInterval(timer); resolve(); } else if (Date.now() > deadline) { clearInterval(timer); reject(Error("preview timeout")); } }, 30); });
    assert(iframe.contentDocument?.body.textContent?.includes("guest preview"), "fresh iframe SW preview");
    attachment.dispose();
    assert((await endpoint.fetch("/")).status === 200, "preview detach leaves server alive");
    await (await endpoint.fetch("/close")).text();
    await endpoint.closed;
    await server.exited; await serverOutput;
    await endpoint.fetch("/").then(() => { throw Error("stale endpoint fetched"); }, () => log("PASS closed endpoint rejects"));
    const replacement = await runtime.node({ entry: "/workspace/server.cjs" }); const replacementOutput = output(replacement);
    const newEndpoint = await runtime.expose(4179, { signal: AbortSignal.timeout(10_000) });
    assert(newEndpoint.url !== endpoint.url, "reused port gets new listener identity");
    assert((await fetch(endpoint.url)).status === 410, "old preview URL cannot retarget replacement listener");
    await runtime.stop(); await replacementOutput;
    assert((await replacement.exited).forced, "runtime stop forces execution cleanup");
    await workspace.fs.writeFile("/after-stop", "survives");
    runtime = await Runtime.start({ distribution: dist, workspace });
    assert(decode(await workspace.fs.readFile("/after-stop")) === "survives", "same Workspace usable after stop/reattach");
    await runtime.stop(); runtime = undefined;
    await workspace.flush(); await workspace.close();
    log("PASS flush + close");
    const reopened = await Workspace.open({ id: "default", storage: opfsStore(dist) });
    assert(decode(await reopened.fs.readFile("/after-stop")) === "survives", "durable reopen text");
    assert((await reopened.fs.readFile("/binary.dat")).every((b,i) => b === binary[i]), "durable reopen binary bytes");
    await reopened.close();
    log("RESULT PASS");
  } finally { await runtime?.stop(); await workspace.close(); }
  return results;
}
export async function search() {
  const dist = await distribution(); const workspace = await Workspace.open({ id: "default", storage: opfsStore(dist) });
  const runtime = await Runtime.start({ distribution: dist, workspace, tools: { ripgrep: defineRipgrepTool({ receiptUrl: "/tools/rg-receipt.json" }) } });
  try {
    await workspace.fs.writeFile("/search/a.txt", "TODO café\nsecond\n");
    await workspace.fs.writeFile("/search/.ignore", "ignored.txt\n");
    await workspace.fs.writeFile("/search/ignored.txt", "TODO hidden\n");
    const match = await runtime.tools.ripgrep({ pattern: "TODO", paths: ["/workspace/search"] });
    assert(match.matches.length === 1 && match.matches[0].text.includes("café"), "real WASM ripgrep Unicode/ignore");
    assert((await runtime.tools.ripgrep({ pattern: "absent", paths: ["/workspace/search"] })).matches.length === 0, "ripgrep exit 1 is no-match");
    await runtime.tools.ripgrep({ pattern: "[", paths: ["/workspace/search"] }).then(() => { throw Error("invalid regex succeeded"); }, e => assert(e.code === "TOOL_FAILED", "ripgrep invalid regex fails"));
    log("SEARCH PASS");
  } finally { await runtime.stop(); await workspace.close(); }
  return results;
}
Object.assign(window, { contract: { run, search, results } });
log("READY");
