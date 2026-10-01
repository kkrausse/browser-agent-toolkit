// QA-only, offline repair of the observed two-library WeakMap identity failure.
import { cp, mkdir, mkdtemp, readdir, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const historical = '/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-full-app-Yb8T8p/frozen';
const candidate = '/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/kernel-egress-repair-3GsF7d';
const hash = async (file: string) => new Bun.CryptoHasher('sha256').update(await Bun.file(file).arrayBuffer()).digest('hex');
async function verify(stage: string, hashes: Record<string, string>) {
  for (const [file, expected] of Object.entries(hashes)) {
    if (file.startsWith('/') || file.split('/').includes('..') || await hash(join(stage, file)) !== expected) throw Error('Artifact mismatch: ' + file);
  }
}
async function walk(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const file = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...await walk(directory, file));
    else if (entry.isFile() && file !== 'receipt.json') files.push(file);
  }
  return files.sort();
}
if (process.argv[2] === '--verify' || process.argv[2] === '--run-copy') {
  const stage = resolve(process.argv[3]!);
  const receipt = await Bun.file(join(stage, 'receipt.json')).json();
  if (receipt.qaScope !== 'focused-observer-identity') throw Error('Wrong QA scope');
  await verify(stage, receipt.hashes);
  if (process.argv[2] === '--run-copy') {
    if (!process.argv[4]) throw Error('Require new output path');
    const output = resolve(process.argv[4]);
    if (output === stage || output.startsWith(stage + '/')) throw Error('Require separate output');
    await mkdir(output);
    for (const file of Object.keys(receipt.hashes)) {
      await mkdir(dirname(join(output, file)), { recursive: true });
      await cp(join(stage, file), join(output, file), { force: false, errorOnExist: true });
    }
    await Bun.write(join(output, 'receipt.json'), JSON.stringify({ ...receipt, output, frozenInput: stage }, null, 2));
    await verify(output, receipt.hashes);
    console.log(output);
  } else console.log(JSON.stringify({ verifiedFiles: Object.keys(receipt.hashes).length, receiptSha256: await hash(join(stage, 'receipt.json')), liveRuns: 0 }));
  process.exit(0);
}
const receipt = await Bun.file(join(historical, 'receipt.json')).json();
const owner = await Bun.file(join(candidate, 'candidate-receipt.json')).json();
if (receipt.revision !== owner.runtimeRevision || receipt.toolkitRevision !== owner.toolkitRevision || receipt.version !== owner.version) throw Error('Mismatched candidate');
await verify(historical, receipt.hashes);
await verify(join(candidate, 'candidate'), owner.hashes);
const native = await Bun.file(join(historical, 'native-build-provenance.json')).json();
for (const file of native.native.outputs) {
  if (await hash(join(candidate, 'runtime-source', file.name)) !== file.sha256 || await hash(join('/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean', file.name)) !== file.sha256) throw Error('Native provenance mismatch: ' + file.name);
}
const out = await mkdtemp('/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/focused-observer-identity-');
let commandId = 0;
async function command(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  await Bun.write(join(out, 'command-' + ++commandId + '.json'), JSON.stringify({ args, cwd, stdout, stderr, exit }, null, 2));
  if (exit) throw Error(stdout + stderr);
}
async function archive(repo: string, revision: string, name: string, expected: string) {
  const destination = join(out, name);
  await mkdir(destination);
  const child = Bun.spawn(['git', 'archive', revision], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  const [bytes, stderr, exit] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  if (exit) throw Error(stderr);
  await Bun.write(destination + '.tar', bytes);
  if (await hash(destination + '.tar') !== expected) throw Error('Archive mismatch');
  await command(['tar', '-xf', destination + '.tar', '-C', destination], out);
  return destination;
}
const source = await archive(root, receipt.toolkitRevision, 'toolkit-source', owner.toolkitArchiveSha256);
await archive('/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel', receipt.revision, 'runtime-source', owner.runtimeArchiveSha256);
for (const pkg of ['', 'workspace-api', 'examples/todo-app']) await symlink(join(root, pkg, 'node_modules'), join(source, pkg, 'node_modules'));
const stage = join(out, 'frozen');
await mkdir(stage);
for (const file of Object.keys(receipt.hashes)) {
  await mkdir(dirname(join(stage, file)), { recursive: true });
  await cp(join(historical, file), join(stage, file), { force: false, errorOnExist: true });
}
const tests = join(source, 'examples/todo-app/tests');
const canonical = join(stage, 'workspace/index.js');
// The actual built public export already contains the private test escape hatch.
// Re-export it: never compile implementation source into a second library instance.
const bridge = 'export * from "./index.js";\nexport {workspaceInternals} from "./index.js";\n';
await Bun.write(join(stage, 'workspace/test-library.js'), bridge);
const resolutions: any[] = [];
const plugin = { name: 'one-canonical-built-workspace', setup(builder: any) {
  builder.onResolve({ filter: /^@kev-browser-agent-kit\/workspace$|\/src\/(index|workspace)\.js$/ }, (args: any) => {
    resolutions.push({ importer: args.importer, specifier: args.path, resolved: canonical });
    return { path: canonical };
  });
} };
async function build(entry: string, target: 'browser' | 'bun', directory: string) {
  const result = await Bun.build({ entrypoints: [entry], target, outdir: join(stage, directory), plugins: [plugin] });
  if (!result.success) throw new AggregateError(result.logs);
}
await build(join(tests, 'single-kernel-cases-client.ts'), 'browser', 'client');
// Keep the original driver helpers and complete focused loop; omit only the
// previously completed app phase through explicit reversible QA substitutions.
const original = await Bun.file(join(tests, 'single-kernel-driver.ts')).text();
const substitutions: [string, string][] = [];
function substitute(before: string, after: string) { substitutions.push([before, after]); }
substitute("const root=resolve(import.meta.dir,'../../..')", 'const root=' + JSON.stringify(source));
substitute("receipt.revision!=='e35eab4af7a53ff08eb70c09df59c40b78bfdd67'", 'receipt.revision!==' + JSON.stringify(receipt.revision));
substitute("const app=await Bun.file(join(output,'owned-origin.json')).json(),contracts=await Bun.file(join(output,'owned-contract-origin.json')).json();\n  validateOwnedOrigins(app,contracts,output);", "const contracts=await Bun.file(join(output,'owned-contract-origin.json')).json();\n  const url=new URL(contracts.url);\n  if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||url.pathname!=='/'||!url.port||['43222','43223'].includes(url.port)||contracts.output!==output||!Number.isSafeInteger(contracts.pid)||contracts.contracts!==true)throw Error('Invalid owned focused origin');");
substitute("const receipt=await Bun.file(join(output,'receipt.json')).json();", "const receipt=await Bun.file(join(output,'receipt.json')).json();\n  if(receipt.qaScope!=='focused-observer-identity')throw Error('Wrong focused scope');");
substitute("const sessions={app:'single-kernel-app-'+crypto.randomUUID().slice(0,8),contracts:'single-kernel-cases-'+crypto.randomUUID().slice(0,8)};", "const sessions={contracts:'focused-identity-cases-'+crypto.randomUUID().slice(0,8)};");
substitute('{output,app,contracts,sessions,policy:acceptancePolicy,receipt,lock,', "{output,scope:'focused-only',contracts,sessions,policy:acceptancePolicy,receipt,lock,");
const appPhase = original.slice(original.indexOf("    await fresh('app'"), original.indexOf("    await fresh('contracts'"));
substitute(appPhase, '    // Focused-only: original application phase already completed in the failed full cohort.\n');
substitute('generations:acceptancePolicy.generations,retries:0,models:0,servers:', "generations:0,scope:'focused-only',retries:0,models:0,servers:");
substitute("      try{await retainDiagnostics();}catch(captureError){captureErrors.push(String(captureError));}\n", '      // App diagnostics are outside this focused-only cohort.\n');
substitute("[['app','singleKernelAcceptance'],['contracts','singleKernelCases']]", "[['contracts','singleKernelCases']]");
let driver = original;
for (const [before, after] of substitutions) {
  if (driver.split(before).length !== 2) throw Error('Ambiguous driver adaptation');
  driver = driver.replace(before, after);
}
let reversed = driver;
for (const [before, after] of [...substitutions].reverse()) {
  reversed = reversed.replace(after, before);
}
if (reversed !== original) throw Error('Driver source reversal failed');
const driverFile = join(tests, 'focused-observer-identity-driver-qa.ts');
await Bun.write(driverFile, driver);
await build(driverFile, 'bun', 'qa');
await Bun.write(join(stage, 'qa/focused-driver-source.ts'), driver);
await Bun.write(join(stage, 'qa/focused-driver-substitutions.json'), JSON.stringify(substitutions, null, 2));
const originalLoop = original.slice(original.indexOf("    await fresh('contracts'"), original.indexOf("    for(const id of Object.values(sessions))await session(['delete'"));
if (!driver.includes(originalLoop)) throw Error('Original focused loop changed');
const graph = join(out, 'identity-probe.ts');
const control = join(out, 'historical-identity-control.ts');
await Bun.write(control, `import * as publicAPI from ${JSON.stringify(join(historical, 'workspace/index.js'))};
import * as testAPI from ${JSON.stringify(join(historical, 'workspace/test-library.js'))};
if(publicAPI.Workspace===testAPI.Workspace||publicAPI.diagnoseWorkspace===testAPI.diagnoseWorkspace||publicAPI.workspaceInternals===testAPI.workspaceInternals)throw Error('Historical negative control did not reproduce distinct built module identity');
console.log(JSON.stringify({historicalDistinctBuiltFunctions:true,historicalDistinctInternalsMaps:true}));\n`);
await command(['bun', control], out);
await Bun.write(graph, `import * as publicAPI from ${JSON.stringify(canonical)};
import * as testAPI from ${JSON.stringify(join(stage, 'workspace/test-library.js'))};
if(publicAPI.Workspace!==testAPI.Workspace||publicAPI.Runtime!==testAPI.Runtime||publicAPI.diagnoseWorkspace!==testAPI.diagnoseWorkspace||publicAPI.workspaceInternals!==testAPI.workspaceInternals)throw Error('Built module identity mismatch');
export const identity={Workspace:true,Runtime:true,diagnoseWorkspace:true,workspaceInternals:true};
console.log(JSON.stringify(identity));\n`);
const probe = await Bun.build({ entrypoints: [graph], target: 'bun', outdir: out, naming: 'identity-probe.js' });
if (!probe.success) throw new AggregateError(probe.logs);
await command(['bun', join(out, 'identity-probe.js')], out);
const focusedBundle = await Bun.file(join(stage, 'client/single-kernel-cases-client.js')).text();
const maps = focusedBundle.match(/var workspaceInternals\d* = new WeakMap/g) ?? [];
if (maps.length !== 1) throw Error('Expected exactly one actual workspace internals map, got ' + maps.length);
const historicalMaps = (await Bun.file(join(historical, 'client/single-kernel-cases-client.js')).text()).match(/var workspaceInternals\d* = new WeakMap/g) ?? [];
if (historicalMaps.length !== 2) throw Error('Historical two-map negative control changed');
const config = await Bun.file(join(dirname(historical), 'consumer.tsconfig.json')).json();
config.files = [join(tests, 'single-kernel-cases-client.ts'), driverFile];
config.compilerOptions.paths = { '@kev-browser-agent-kit/workspace': [join(stage, 'workspace/index.d.ts')], '@vivari/core/host': [join(stage, 'sdk/host-sdk/index.d.ts')] };
await Bun.write(join(out, 'focused.tsconfig.json'), JSON.stringify(config));
await command(['node', join(root, 'workspace-api/node_modules/typescript/bin/tsc'), '-p', join(out, 'focused.tsconfig.json')], source);
const preparationConfig = { ...config, files: [join(root, 'examples/todo-app/tests/focused-observer-identity-prepare.ts')] };
await Bun.write(join(out, 'preparation.tsconfig.json'), JSON.stringify(preparationConfig));
await command(['node', join(root, 'workspace-api/node_modules/typescript/bin/tsc'), '-p', join(out, 'preparation.tsconfig.json')], root);
for (const [name, expected] of Object.entries(receipt.hashes)) {
  if (/^(runtime|sdk|workspace|chat)\//.test(name) && name !== 'workspace/test-library.js' && await hash(join(stage, name)) !== expected) throw Error('Candidate library/asset changed: ' + name);
}
const originalSourceHashes: Record<string, string> = {};
for (const file of ['examples/todo-app/tests/single-kernel-cases-client.ts', 'examples/todo-app/tests/single-kernel-cases.ts', 'examples/todo-app/tests/single-kernel-contract.ts', ...['harness', 'http-cases', 'process-cases', 'storage-cases', 'test-library'].map(name => 'workspace-api/tests/browser/' + name + '.ts')]) originalSourceHashes[file] = await hash(join(source, file));
const evidence = { scope: 'offline-only', liveRuns: 0, browsers: 0, hosts: 0, guests: 0, models: 0, canonicalBuiltEntrySha256: await hash(canonical), focusedBundleSha256: await hash(join(stage, 'client/single-kernel-cases-client.js')), workspaceInternalsMaps: maps.length, historicalWorkspaceInternalsMaps: historicalMaps.length, historicalDistinctBuiltFunctionReferences: true, sameBuiltFunctionReferences: true, driverReversesByteForByte: reversed === original, originalSourceHashes, originalFocusedLoopUnchanged: true, originalFocusedLoopSha256: new Bun.CryptoHasher('sha256').update(originalLoop).digest('hex'), focusedClientSourceUnchanged: await hash(join(tests, 'single-kernel-cases-client.ts')) === await hash(join(root, 'examples/todo-app/tests/single-kernel-cases-client.ts')), substitutions, resolutions, nativeRebuilt: false, nativeOutputsReverified: native.native.outputs.length, candidateUnchanged: true };
await Bun.write(join(stage, 'qa/module-identity-evidence.json'), JSON.stringify(evidence, null, 2));
const hashes: Record<string, string> = {};
for (const file of await walk(stage)) hashes[file] = await hash(join(stage, file));
await Bun.write(join(stage, 'receipt.json'), JSON.stringify({ ...receipt, output: stage, hashes, qaScope: 'focused-observer-identity', preparationOnly: true, liveRuns: 0, models: 0, historicalInput: historical, historicalReceiptSha256: await hash(join(historical, 'receipt.json')), sourceArchives: receipt.sourceArchives }, null, 2));
await verify(stage, hashes);
await verify(historical, receipt.hashes);
await verify(join(candidate, 'candidate'), owner.hashes);
await Bun.write(join(out, 'handoff.json'), JSON.stringify({ stage, receiptSha256: await hash(join(stage, 'receipt.json')), files: Object.keys(hashes).length, evidence }, null, 2));
console.log(stage);
