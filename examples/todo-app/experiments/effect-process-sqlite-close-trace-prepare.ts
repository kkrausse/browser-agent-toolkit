import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';

const stage = resolve(process.argv[2]!), evidence = resolve(process.argv[3]!);
const candidate = resolve(process.argv[4]!);
if (!process.argv[4]) throw Error('Usage: prepare <frozen-stage> <new-evidence> <candidate-root>');
await mkdir(evidence);
const sha = (bytes: Uint8Array | string) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function verify(root: string, hashes: Record<string, string>) {
  for (const [path, expected] of Object.entries(hashes)) {
    if (path.startsWith('/') || path.split('/').includes('..')) throw Error('Unsafe manifest path');
    if (sha(await readFile(join(root, path))) !== expected) throw Error('Artifact mismatch: ' + join(root, path));
  }
  return Object.keys(hashes).length;
}
const receipt = await json(join(stage, 'receipt.json')), input = await json(join(candidate, 'candidate-receipt.json'));
if (receipt.revision !== 'cc5a932bf4f9a1da4bf8b5d16f6c6c7e4aec573d' || input.runtimeRevision !== receipt.revision || input.toolkitRevision !== '9814c715cfca42309c581440577976833f4326e6' || input.effectVersion !== '4.0.0-rc.118' || input.distributionVersion !== '446021ba611932b0c531570ecc5739255e8d97f608dcc8c53ad1ca07eeceb6a6') throw Error('Admission identity mismatch');
const counts = { stage: await verify(stage, receipt.hashes), candidate: await verify(join(candidate, 'candidate'), input.hashes), freeze: await verify(candidate, await json(join(candidate, 'freeze-manifest.json'))) };
const native = await json(join(candidate, 'native-reuse.json'));
for (const row of [...native.trackedInputsEqual, ...native.outputs]) {
  for (const root of [native.source, native.destination]) if (sha(await readFile(join(root, row.path))) !== row.sha256) throw Error('Native mismatch: ' + row.path);
}
const run = join(evidence, 'run-copy');
const copy = Bun.spawn(['bun', join(import.meta.dir, 'effect-loader-full-delivery-run-copy.ts'), stage, run], { stdout: 'pipe', stderr: 'pipe' });
const copied = { stdout: await new Response(copy.stdout).text(), stderr: await new Response(copy.stderr).text(), exit: await copy.exited };
await writeFile(join(evidence, 'run-copy.json'), JSON.stringify(copied, null, 2));
if (copied.exit) throw Error(copied.stderr || copied.stdout);
const originalClient = await readFile(join(stage, 'client/single-kernel-cases-client.js'), 'utf8');
const appendix = '\n// SQLITE_CLOSE_QA_APPENDIX_BEGIN\n' + await readFile(join(import.meta.dir, 'effect-process-sqlite-close-trace-browser.js'), 'utf8') + '\n// SQLITE_CLOSE_QA_APPENDIX_END\n';
const client = originalClient + appendix;
await writeFile(join(evidence, 'observer-client.js'), client);
if (client.slice(0, -appendix.length) !== originalClient) throw Error('Client reversal failed');
const edits: { artifact: string; from: string; to: string }[] = [];
function edit(artifact: string, source: string, from: string, to: string) {
  if (source.split(from).length !== 2) throw Error('Nonunique adaptation: ' + from.slice(0, 80));
  edits.push({ artifact, from, to }); return source.replace(from, to);
}
const originalHost = await readFile(join(stage, 'qa/serve-single-kernel.js'), 'utf8');
const host = edit('host', originalHost, '  const path = new URL(request.url).pathname;', '  const path = new URL(request.url).pathname;\n  if (path === "/client/single-kernel-cases-client.js") return new Response(Bun.file(' + JSON.stringify(join(evidence, 'observer-client.js')) + '), {headers:{...headers,"Content-Type":"text/javascript"}});');
await writeFile(join(evidence, 'observer-host.js'), host);
const originalDriver = await readFile(join(stage, 'qa/effect-loader-full-app-driver-qa.js'), 'utf8');
let driver = originalDriver;
const start = driver.indexOf('    for (const id of Object.values(sessions))\n      await session(["new", id]);');
const end = driver.indexOf('    const cases = await read("contracts",');
if (start < 0 || end < start) throw Error('Original execution block unavailable');
driver = edit('driver', driver, driver.slice(start, end), '    for (const id of Object.values(sessions))\n      await session(["new", id]);\n    await fresh("contracts", contracts.url, "singleKernelCases");\n');
driver = edit('driver', driver, '  const app = await Bun.file(join2(output, "owned-origin.json")).json(), contracts = await Bun.file(join2(output, "owned-contract-origin.json")).json();\n  validateOwnedOrigins(app, contracts, output);', '  const app = null, contracts = await Bun.file(join2(output, "owned-contract-origin.json")).json();\n  if (contracts.output !== output || contracts.contracts !== true || new URL(contracts.url).hostname !== "127.0.0.1" || !Number.isSafeInteger(contracts.pid)) throw Error("Invalid isolated owned origin");');
driver = edit('driver', driver, '  const sessions = { app: "single-kernel-app-" + crypto.randomUUID().slice(0, 8), contracts: "single-kernel-cases-" + crypto.randomUUID().slice(0, 8) };', '  const sessions = { contracts: "effect-sqlite-close-" + crypto.randomUUID().slice(0, 8) };');
driver = edit('driver', driver, '    for (const [index, test] of cases.entries()) {', '    if (cases[9]?.name !== "SQLite pathname ownership, process-exit release, rollback and orderly reopen" || cases[9].steps !== 2) throw Error("Original SQLite case identity changed");\n    for (const [index, test] of [[9, cases[9]]]) {');
driver = edit('driver', driver, '    for (const id of Object.values(sessions))\n      await session(["delete", id]);', '    await read("contracts", "if(state.sqliteCloseTargetQA)await state.sqliteCloseTargetQA.cdp.detach();return {observerDetached:true};");\n    for (const id of Object.values(sessions))\n      await session(["delete", id]);');
driver = edit('driver', driver, 'status: "passed", cases: cases.length, generations: acceptancePolicy.generations, retries: 0, models: 0', 'status: "passed", cases: 1, steps: 2, generations: 0, retries: 0, models: 0');
// The original catch's expired guard and acceptance polling functions stay intact.
await writeFile(join(evidence, 'isolated-driver.js'), driver);
for (const [artifact, modified, original] of [['driver', driver, originalDriver], ['host', host, originalHost]] as const) {
  let reversed = modified;
  for (const row of edits.filter(e => e.artifact === artifact).reverse()) reversed = reversed.replace(row.to, row.from);
  if (reversed !== original) throw Error('Source reversal failed: ' + artifact);
}
await writeFile(join(evidence, 'adaptation.json'), JSON.stringify({ edits, client: { original: sha(originalClient), observer: sha(client), appendix: sha(appendix), reversal: true }, driver: { original: sha(originalDriver), isolated: sha(driver), reversal: true }, host: { original: sha(originalHost), observer: sha(host), reversal: true }, counts: { ...counts, nativeInputs: native.trackedInputsEqual.length, nativeOutputs: native.outputs.length }, stage, candidate, run }, null, 2));
console.log(JSON.stringify({ evidence, run, counts, nativeInputs: native.trackedInputsEqual.length, nativeOutputs: native.outputs.length, liveExecuted: false }));
