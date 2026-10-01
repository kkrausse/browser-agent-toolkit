import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const input = '/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-full-app-UMORaL/frozen';
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || output === input || output.startsWith(input + '/')) throw Error('Require new separate output');
const hash = (bytes: string | ArrayBuffer) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const originalReceipt = await Bun.file(join(input, 'receipt.json')).json();
if (originalReceipt.revision !== '3ee918522c1233a1f8e10a9b798c09b6c3e30c81' || originalReceipt.toolkitRevision !== '9814c715cfca42309c581440577976833f4326e6') throw Error('Wrong frozen revisions');
for (const [file, digest] of Object.entries(originalReceipt.hashes)) if (hash(await Bun.file(join(input, file)).arrayBuffer()) !== digest) throw Error('Frozen mismatch: ' + file);
const native = await Bun.file(join(input, 'native-build-provenance.json')).json();
for (const entry of [...native.trackedInputsEqual, ...native.outputs]) if (hash(await Bun.file(join(native.destination, entry.path)).arrayBuffer()) !== entry.sha256) throw Error('Native mismatch: ' + entry.path);
await mkdir(output); // Refuse an existing stage, including a partially used stage.
for (const file of Object.keys(originalReceipt.hashes)) { await mkdir(dirname(join(output, file)), { recursive: true }); await cp(join(input, file), join(output, file), { force: false, errorOnExist: true }); }
const observerSource = join(import.meta.dir, 'effect-preview-readiness-trace-observer.ts');
const build = await Bun.build({ entrypoints: [observerSource], target: 'browser', format: 'iife' });
if (!build.success || build.outputs.length !== 1) throw Error('Observer build failed');
const prefix = await build.outputs[0]!.text() + '\nvar readinessTrace = globalThis.effectPreviewReadinessTrace;\n';
const edits: { original: string; observed: string }[] = [];
const clientPath = 'client/single-kernel-client.js';
const original = await Bun.file(join(input, clientPath)).text();
let client = original;
const edit = (original: string, observed: string) => {
  if (client.split(original).length !== 2) throw Error('Nonunique observer anchor: ' + original.slice(0, 80));
  edits.push({ original, observed }); client = client.replace(original, observed);
};
edit('function fetchHttpStream(channel, request, onClose = () => {}, onCleanup = () => {}) {', 'function fetchHttpStream(channel, request, onClose = () => {}, onCleanup = () => {}) {\n  readinessTrace.record("adapter.request", {url:request.url, mode:request.mode, method:request.method});\n  readinessTrace.signal(request.signal, "adapter.request.signal");');
edit('    const cleanup = () => {\n      if (closed)', '    const cleanup = () => {\n      readinessTrace.record("adapter.cleanup.enter", {closed,receivedHeaders});\n      if (closed)');
edit('    const fail = (reason) => {\n      if (closed)', '    const fail = (reason) => {\n      readinessTrace.record("adapter.fail", {closed,receivedHeaders,error:readinessTrace.error(reason)});\n      if (closed)');
edit('    const abort = () => fail(request.signal.reason);', '    const abort = () => { readinessTrace.record("adapter.abort", {reason:readinessTrace.error(request.signal.reason)}); return fail(request.signal.reason); };');
edit('    const send = (op, extra = {}) => channel.postMessage({\n      op,\n      ...extra\n    });', '    const send = (op, extra = {}) => { readinessTrace.message("send", {op,...extra}); return channel.postMessage({op,...extra}); };');
edit('    channel.onmessage = ({ data: message }) => {\n      if (closed)', '    channel.onmessage = ({ data: message }) => {\n      readinessTrace.message("receive", message);\n      if (closed)');
edit('        host.post("workspace-http-stream", {', '        readinessTrace.record("endpoint.transport", {port,listenerId,metadata});\n        host.post("workspace-http-stream", {');
edit('  const response = await fetch2();\n  if (!response.ok)', '  readinessTrace.record("fetch.start");\n  let response;\n  try { response = await fetch2(); readinessTrace.response(response); } catch(error) { readinessTrace.record("fetch.reject", {error:readinessTrace.error(error)}); throw error; }\n  if (!response.ok)');
edit('  await response.arrayBuffer();\n  signal.throwIfAborted();\n  attach();', '  readinessTrace.record("body.read.start");\n  try { const bytes = await response.arrayBuffer(); readinessTrace.record("body.read.eof", {bytes:bytes.byteLength}); } catch(error) { readinessTrace.record("body.read.reject", {error:readinessTrace.error(error)}); throw error; }\n  signal.throwIfAborted();\n  readinessTrace.record("attach.start");\n  attach();\n  readinessTrace.record("attach.returned");');
edit('  await previewHTTPThenAttach(owner.signal, () => preview.endpoint.fetch("/", { signal: AbortSignal.timeout(policy.requestMs) }), () => {', '  readinessTrace.arm();\n  await previewHTTPThenAttach(owner.signal, () => preview.endpoint.fetch("/", { signal: readinessTrace.signal(AbortSignal.timeout(policy.requestMs), "readiness.timeout", policy.requestMs) }), () => {');
// Original rejection object is retained at its final client boundary as well.
edit('    evidence.error = String(error);', '    readinessTrace.record("stage.reject", {name,error:readinessTrace.error(error)});\n    evidence.error = String(error);');
let reversed = client;
for (const { original, observed } of edits.toReversed()) { if (reversed.split(observed).length !== 2) throw Error('Nonunique reverse anchor'); reversed = reversed.replace(observed, original); }
if (reversed !== original) throw Error('Observer reversal changed original actions');
await writeFile(join(output, clientPath), prefix + client);

// Actual combined broker, unchanged returns/routes/budgets. Memory-only native
// request/abort records are printed after its exact owned SIGTERM shutdown.
const hostPath = 'qa/serve-single-kernel.js';
const originalHost = await Bun.file(join(input, hostPath)).text();
const hostPrefix = `const traceNative = {events:[],dropped:0,bytes:0,limit:{events:2048,bytes:1048576}};
function retainNative(event,data){const entry={wall:Date.now(),mono:performance.now(),event,data};const text=JSON.stringify(entry);if(traceNative.events.length>=traceNative.limit.events||traceNative.bytes+text.length>traceNative.limit.bytes){traceNative.dropped++;return;}traceNative.bytes+=text.length;traceNative.events.push(entry);}
`;
const hostAnchor = '  const path = new URL(request.url).pathname;';
const hostObserved = hostAnchor + '\n  retainNative("request", {url:request.url,method:request.method,aborted:request.signal.aborted});\n  request.signal.addEventListener("abort",()=>retainNative("abort",{url:request.url,method:request.method,reason:String(request.signal.reason)}),{once:true});';
if (originalHost.split(hostAnchor).length !== 2) throw Error('Host observer anchor');
const hostSuffix = '\nprocess.on("SIGTERM",()=>{void server.stop(false).then(()=>{console.log(JSON.stringify({traceNative,shutdown:"joined"}));process.exit(0);});});\n';
const host = hostPrefix + originalHost.replace(hostAnchor, hostObserved) + hostSuffix;
if (host.slice(hostPrefix.length, -hostSuffix.length).replace(hostObserved, hostAnchor) !== originalHost) throw Error('Host reversal failed');
await writeFile(join(output, hostPath), host);
const changed = { [clientPath]: hash(prefix + client), [hostPath]: hash(host) };
const receipt = { ...originalReceipt, output, observerOnly: true, observerInputs: { frozen: input, receiptSha256: hash(await Bun.file(join(input, 'receipt.json')).arrayBuffer()), observerSourceSha256: hash(await Bun.file(observerSource).arrayBuffer()), prefixSha256: hash(prefix), originalClientSha256: hash(original), originalHostSha256: hash(originalHost), edits, nativeInputs: native.trackedInputsEqual.length, nativeOutputs: native.outputs.length, nativeRebuilt: false, reverseByteIdentical: true }, hashes: { ...originalReceipt.hashes, ...changed } };
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
for (const [file, digest] of Object.entries(receipt.hashes)) if (hash(await Bun.file(join(output, file)).arrayBuffer()) !== digest) throw Error('New observer mismatch: ' + file);
console.log(JSON.stringify({ output, verified: Object.keys(receipt.hashes).length, changed, observerInputs: { ...receipt.observerInputs, edits: edits.length }, receiptSha256: hash(JSON.stringify(receipt, null, 2)), launched: false }, null, 2));
