// Preparation only: adapt the committed conservative preparer, never its workloads.
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const temp = '/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode';
const inputName = 'effect-loader-vendor-url-repair-l9k65fzh';
const input = join(temp, inputName);
const donor = join(temp, 'conservative-full-app-Yb8T8p');
const runtimeRevision = '3ee918522c1233a1f8e10a9b798c09b6c3e30c81';
const toolkitRevision = '9814c715cfca42309c581440577976833f4326e6';
const version = 'bd39000ff5bbc334f836ad65a4433e627525070413f810d7169132102f49b9f9';
const hash = async (file: string) => new Bun.CryptoHasher('sha256').update(await Bun.file(file).arrayBuffer()).digest('hex');
if (await hash(join(input, 'candidate-receipt.json')) !== 'e242092e6a920b88a6a2ae7eb76654f1f61773a3bcf99ee4bcbe61f6b85ee6e6') throw Error('Wrong frozen Effect receipt');
const inputReceipt = await Bun.file(join(input, 'candidate-receipt.json')).json();
const inputFreeze = await Bun.file(join(input, 'freeze-manifest.json')).json();
if (Object.keys(inputReceipt.hashes).length !== 107 || Object.keys(inputFreeze).length !== 1020) throw Error('Wrong input cohort size');
for (const [file, expected] of Object.entries(inputFreeze)) {
  if (file.startsWith('/') || file.split('/').includes('..') || await hash(join(input, file)) !== expected) throw Error('Frozen repair input mismatch: ' + file);
}
// Import the exact committed verifier, not an altered contract or the old library.
const verifier = await import(join(input, 'toolkit-source/opencode-chat/src/opencode-application.ts'));
const application = await verifier.readQualifiedOpenCodeApplication(join(donor, 'qualified-opencode'));
const receipt = JSON.parse(application.receiptBytes.toString());
const recipe = '/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-upstream/vivari/experiments/opencode-release-server';
for (const [file, expected] of Object.entries(receipt.recipe)) if (await hash(join(recipe, file)) !== expected) throw Error('Application recipe mismatch: ' + file);
const staging = await mkdtemp(join(temp, 'effect-loader-full-delivery-preparer-'));
// Take the old preparer from its exact commit. All edits are on a fresh private copy.
const archive = Bun.spawn(['git', 'show', '1fb7efe:examples/todo-app/tests/conservative-full-app-prepare.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
let script = await new Response(archive.stdout).text();
if (await archive.exited) throw Error(await new Response(archive.stderr).text());
const originalSha256 = new Bun.CryptoHasher('sha256').update(script).digest('hex');
function change(before: string, after: string) {
  if (!script.includes(before)) throw Error('Missing exact adaptation anchor: ' + before);
  script = script.replace(before, after);
}
change("const root = resolve(import.meta.dir, '../../..');", 'const root = ' + JSON.stringify(root) + ';');
change("kernel-egress-repair-3GsF7d", inputName);
change('33fa1359a003ca9c50cb3bc49699b99bc1a063f1', runtimeRevision);
change('d0eec346dbc749db1c0cd82dd8aad0b27c1da363', toolkitRevision);
change('3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62', version);
change('candidateReceipt.version !== version', 'JSON.parse(await Bun.file(join(input,"candidate/runtime/distribution.json")).text()).version !== version');
change('conservative-full-app-', 'effect-loader-full-app-');
change("const runtimeSource = await archive('/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel'", "const runtimeSource = await archive(" + JSON.stringify(join(temp, 'vivari-effect-loader-pilot')));
change("['runtime', 'sdk', 'workspace', 'chat']", "['runtime', 'sdk']");
change("await cp(join(input, 'toolkit-source/vivari/.runtime/patched-build.json'), join(stage, 'native-build-provenance.json'));", "await cp(join(input,'native-reuse.json'),join(stage,'native-build-provenance.json'));\nawait cp(join(input,'candidate/runtime/distribution.json'),join(stage,'runtime-build-provenance.json'));");
const recoveryStart = script.indexOf("const historical = ");
const recoveryEnd = script.indexOf('const workspaceEntries =');
if (recoveryStart < 0 || recoveryEnd < recoveryStart) throw Error('Recovery anchors absent');
script = script.slice(0, recoveryStart) + `
const applicationInput = join(out, 'qualified-opencode');
const verifier = await import(join(source,'opencode-chat/src/opencode-application.ts'));
const verified = await verifier.readQualifiedOpenCodeApplication(${JSON.stringify(join(donor, 'qualified-opencode'))});
await Bun.write(join(applicationInput,'build-receipt.json'),verified.receiptBytes);
for(const asset of verified.assets) await Bun.write(join(applicationInput,'.runtime/opencode-bun-server',asset.file),asset.bytes);
const recipeReceipt=JSON.parse(verified.receiptBytes.toString());
for(const [file,digest] of Object.entries(recipeReceipt.recipe)) {
  if(await hash(join(${JSON.stringify(recipe)},file))!==digest)throw Error('Recipe changed '+file);
  await cp(join(${JSON.stringify(recipe)},file),join(applicationInput,file));
}
await Bun.write(join(stage,'application-closure.json'),JSON.stringify({provenance:verified.provenance,recipe:recipeReceipt.recipe,applicationRebuilt:false,verifierSourceSha256:await hash(join(source,'opencode-chat/src/opencode-application.ts'))},null,2));
const native=await Bun.file(join(stage,'native-build-provenance.json')).json();
for(const file of native.trackedInputsEqual)if(await hash(join(runtimeSource,file.path))!==file.sha256)throw Error('Native input mismatch '+file.path);
for(const file of native.outputs)if(await hash(join(input,'runtime-source',file.path ?? file.name))!==file.sha256)throw Error('Native output mismatch '+JSON.stringify(file));
` + script.slice(recoveryEnd);
// One index graph owns the WeakMap, including the focused observer escape hatch.
change("const result = await Bun.build({ entrypoints: [join(source, pkg, 'src', file + (['editor', 'react'].includes(file) ? '.tsx' : '.ts'))]", "const result = await Bun.build({ entrypoints: [pkg === 'workspace-api' && entry === 'index' ? join(source,'workspace-api/tests/browser/test-library.ts') : join(source, pkg, 'src', file + (['editor', 'react'].includes(file) ? '.tsx' : '.ts'))]");
change("await build(join(source, 'workspace-api/tests/browser/test-library.ts'), 'browser', 'workspace');", "await Bun.write(join(stage,'workspace/test-library.js'),\"export * from './index.js';\\n\");");
change("const paths: Record<string, string[]>", `await Bun.write(join(out,'build-styles.ts'),"import {buildUIStyles} from " + JSON.stringify(join(source,'opencode-chat/scripts/build-ui-styles.ts')) + "; await buildUIStyles(new URL(" + JSON.stringify('file://'+join(stage,'chat/')) + "));\\n");
await command(['bun',join(out,'build-styles.ts')],source);
const paths: Record<string, string[]>`);
change("const packageInput = join(out, 'package-input');", "await cp(applicationInput,join(stage,'chat/application'),{recursive:true});\nconst packageInput = join(out, 'package-input');");
change("originalClientSha256:", "singleWorkspaceGraph: true, originalClientSha256:");
change("fullClient.replace('fetchedBodyProbe(location.origin)', 'fetchedBodyProbe(' + clientHostOrigin + ')')", "fullClient.replace('fetchedBodyProbe(location.origin)', 'fetchedBodyProbe(' + clientHostOrigin + ')').replace('distribution.runtimeBuild.source.commit','distribution.runtimeBuild.source.revision')");
// Preserve original actions/assertions/deadlines; names describe the fresh pilot.
script = script.replaceAll('conservative-full-client-qa', 'effect-loader-full-client-qa').replaceAll('conservative-full-app-driver-qa', 'effect-loader-full-app-driver-qa');
script = script.replaceAll('exact repaired 33fa135', 'exact URL-repaired Effect pilot 3ee9185');
change('preparationOnly: true', 'preparationOnly: true, effectVersion: "4.0.0-rc.118", fullMigrationAccepted: false');
change("const manifest = await Bun.file(join(stage, 'prepared/manifest.json')).json();", `
// Only the normal committed vendor producer fetches/builds the real tsgo pack.
// Its scratch installation is private; registry access is allowed and recorded.
const vendorScratch=join(out,'tsgo-vendor-input');
await command(['node',join(runtimeSource,'scripts/vendor-tsgo.mjs')],runtimeSource,{...process.env,VV_VENDOR_TSGO_DIR:vendorScratch});
await cp(join(runtimeSource,'packages/studio/public/vendor/tsgo-pack.bin'),join(stage,'runtime/vendor/tsgo-pack.bin')).catch(async error=>{if(error.code!=='ENOENT')throw error;await mkdir(join(stage,'runtime/vendor'),{recursive:true});await cp(join(runtimeSource,'packages/studio/public/vendor/tsgo-pack.bin'),join(stage,'runtime/vendor/tsgo-pack.bin'));});
const vendorPackage=await Bun.file(join(vendorScratch,'node_modules/tsgo-wasm/package.json')).json();
for(const file of ['package.json','LICENSE','tsgo-wasm'])await cp(join(vendorScratch,'node_modules/tsgo-wasm',file),join(stage,'runtime/vendor/tsgo-'+file));
await cp(join(vendorScratch,'node_modules/.package-lock.json'),join(stage,'runtime/vendor/tsgo-package-lock.json'));
await Bun.write(join(stage,'tsgo-vendor-provenance.json'),JSON.stringify({producerRevision:runtimeRevision,producerSha256:await hash(join(runtimeSource,'scripts/vendor-tsgo.mjs')),packageVersion:vendorPackage.version,networkAllowed:true,networkOfflineClaim:false,packSha256:await hash(join(stage,'runtime/vendor/tsgo-pack.bin'))},null,2));
for(const name of ['pilot','host','run-copy','offline-verify']) {
  const file='examples/todo-app/tests/effect-loader-full-delivery-'+name+'.ts';
  const bytes=await command(['git','show','HEAD:'+file],root);
  await Bun.write(join(out,'qa-source',file),bytes);
}
await build(join(out,'qa-source/examples/todo-app/tests/effect-loader-full-delivery-pilot.ts'),'browser','client');
await build(join(out,'qa-source/examples/todo-app/tests/effect-loader-full-delivery-host.ts'),'bun','qa');
await cp(join(out,'qa-source'),join(stage,'qa-source'),{recursive:true});
await cp(applicationInput,join(stage,'qualified-application'),{recursive:true});
await command(['bun',join(out,'qa-source/examples/todo-app/tests/effect-loader-full-delivery-offline-verify.ts'),stage,input],source);
const manifest = await Bun.file(join(stage, 'prepared/manifest.json')).json();`);
change("const hashes: Record<string, string> = {};", `
const workspaceGraphs:Record<string,number>={};
for(const file of await walk(join(stage,'client')))if(file.endsWith('.js')) {
  const text=await Bun.file(join(stage,'client',file)).text();
  const count=[...text.matchAll(/workspaceInternals(?:_\\d+)? = new WeakMap/g)].length;
  workspaceGraphs[file]=count;
  if(count!==1)throw Error('Consumer must contain one actual workspace WeakMap graph: '+file+' '+count);
}
await Bun.write(join(stage,'consumer-graph-verification.json'),JSON.stringify({workspaceGraphs,focusedObserver:'workspace/test-library.js reexports the same built workspace/index.js',kernelWorker:JSON.parse(await Bun.file(join(stage,'runtime/distribution.json')).text()).kernelWorker,coreSha256:await hash(join(input,'runtime-source/packages/kernel-lifecycle/dist/index.js'))},null,2));
const hashes: Record<string, string> = {};`);
script += `
await cp(join(input,'runtime-runnable-source.tar.gz'),join(out,'runtime-runnable-source.tar.gz'));
await cp(join(${JSON.stringify(staging)},'adaptation.json'),join(out,'preparer-adaptation.json'));
const sourceDigests:Record<string,string>={};
for(const [directory,label] of [[source,'toolkit'],[runtimeSource,'runtime']])for(const file of await walk(directory))if(!file.startsWith('packages/studio/public/vendor/'))sourceDigests[label+'/'+file]=await hash(join(directory,file));
await Bun.write(join(out,'source-digests.json'),JSON.stringify(sourceDigests,null,2));
const frozenHashes:Record<string,string>={};
for(const file of [...(await walk(stage)).map(file=>'frozen/'+file),'toolkit-source.tar','runtime-source.tar','runtime-runnable-source.tar.gz','source-digests.json','preparer-adaptation.json','handoff.json'])frozenHashes[file]=await hash(join(out,file));
await Bun.write(join(out,'freeze-manifest.json'),JSON.stringify({runtimeRevision,toolkitRevision,hashes:frozenHashes,preparationOnly:true},null,2));
await command(['tar','-czf',join(out,'delivery.tar.gz'),'frozen','toolkit-source.tar','runtime-source.tar','runtime-runnable-source.tar.gz','source-digests.json','preparer-adaptation.json','handoff.json','freeze-manifest.json'],out);
await Bun.write(join(out,'delivery-handoff.json'),JSON.stringify({stage,receiptSha256:await hash(join(stage,'receipt.json')),deliverySha256:await hash(join(out,'delivery.tar.gz')),freezeManifestSha256:await hash(join(out,'freeze-manifest.json')),sourceDigestsSha256:await hash(join(out,'source-digests.json')),runtimeRevision,toolkitRevision,version,effectVersion:'4.0.0-rc.118',applicationReceiptSha256:verified.provenance.receiptSha256,applicationRebuilt:false,browserStarted:false,hostStarted:false,guestStarted:false,performanceMeasured:false},null,2));
console.log(await Bun.file(join(out,'delivery-handoff.json')).text());
`;
await Bun.write(join(staging, 'adaptation.json'), JSON.stringify({ originalCommit: '1fb7efe', originalSha256, assertionsChanged: false, deadlinesChanged: false, browserStarted: false, hostStarted: false, guestStarted: false, application: application.provenance }, null, 2));
await Bun.write(join(staging, 'prepare.ts'), script);
const child = Bun.spawn(['bun', join(staging, 'prepare.ts')], { cwd: root, env: process.env, stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
console.log('Preparation adaptation evidence: ' + staging);
