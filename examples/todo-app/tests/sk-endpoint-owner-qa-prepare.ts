import {cp,mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dir,'../../..');
const frozen='/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/endpoint-repair-frozen-H0Z3JO';
const retained=join(root,'.diagnostics/single-kernel-e35eab4-full-fresh-2026-09-30-independent-17ef8e3');
const hash=async(path:string)=>new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
const receipt=await Bun.file(join(frozen,'stage.json')).json();
if(receipt.hostRevision!=='724909bff00c9c0994ecde7c767a218ae2af25a0'||receipt.sourceRevision!=='7713686e26d1fe61da5c75b37796875126f60e11'||!receipt.unchangedWorkerNativeInputs)throw Error('Frozen identity mismatch');
const expected={
 'host/index.js':'d7d63f2784a797340375d7c4500b232512dea6f6639ecb0eeb28dc2a674ac919',
 'workspace/index.js':'6188d78d03c9ce8247e6187eba73a6a5fff719e3a36ddb365ceb32aea0660c20',
 'workspace/react.js':'527a1a6eb8a163dbca33a57fc0245c7205b1c3f375fefae79b280cfc29c60da0',
 'source.tar':'1a2003a348d52ab4ffa25d9971d6e2b1b2765787ac5ad9e4c88ea2c287d1c3f4',
 'host-source.tar':'451a5d98a45575f468a32d9ad241f74e29f8eb25d27357f2a6eb9943e4b3cf4e',
 'stage.json':'39a536cc2bfb526462eebdac334d106678f0215640e0afa8c1ac511575096995',
};
for(const [file,digest] of Object.entries({...receipt.hashes,...expected}))if(await hash(join(frozen,file))!==digest)throw Error('Frozen byte mismatch '+file);
if(await hash(join(retained,'receipt.json'))!==receipt.frozenReceiptSha256)throw Error('Retained receipt mismatch');
for(const [file,digest] of Object.entries(receipt.frozenHashes))if(await hash(join(retained,file))!==digest)throw Error('Retained byte mismatch '+file);
const out=await mkdtemp('/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/sk-endpoint-owner-qa-');
for(const dir of ['host','workspace'])await cp(join(frozen,dir),join(out,dir),{recursive:true,errorOnExist:true});
await cp(join(retained,'runtime'),join(out,'runtime'),{recursive:true,errorOnExist:true});
for(const file of ['source.tar','host-source.tar','stage.json'])await cp(join(frozen,file),join(out,'input-'+file));
await mkdir(join(out,'source'));
const files=['sk-endpoint-owner-qa-client.ts','sk-endpoint-owner-qa-prepare.ts','sk-endpoint-owner-qa-serve.ts','sk-endpoint-owner-qa-headless.ts'];
const revisionProcess=Bun.spawn(['git','rev-parse','HEAD'],{cwd:root,stdout:'pipe'});
const fixtureSourceRevision=(await new Response(revisionProcess.stdout).text()).trim();if(await revisionProcess.exited)throw Error('Fixture revision missing');
for(const file of files){
 const committed=Bun.spawn(['git','show',fixtureSourceRevision+':examples/todo-app/tests/'+file],{cwd:root,stdout:'pipe',stderr:'pipe'});
 const bytes=await new Response(committed.stdout).arrayBuffer();if(await committed.exited)throw Error('Commit fixture before preparing '+file);
 if(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')!==await hash(join(import.meta.dir,file)))throw Error('Uncommitted fixture '+file);
 await Bun.write(join(out,'source',file),bytes);
}
const build=await Bun.build({entrypoints:[join(out,'source/sk-endpoint-owner-qa-client.ts')],outdir:join(out,'client'),target:'browser',plugins:[{name:'frozen-built-consumer',setup(b){
 b.onResolve({filter:/^@kev-browser-agent-kit\/workspace(?:\/react)?$/},a=>({path:join(out,'workspace',a.path.endsWith('/react')?'react.js':'index.js')}));
 b.onResolve({filter:/^react(?:\/.*)?$/},a=>({path:require.resolve(a.path,{paths:[join(root,'workspace-api')]} )}));
}}]});
if(!build.success)throw new AggregateError(build.logs,'Built consumer');
const config={compilerOptions:{target:'ES2023',module:'ESNext',moduleResolution:'Bundler',strict:true,noUncheckedIndexedAccess:true,skipLibCheck:true,lib:['ES2023','DOM','DOM.Iterable'],noEmit:true,paths:{'@kev-browser-agent-kit/workspace':[join(out,'workspace/index.d.ts')],'@kev-browser-agent-kit/workspace/react':[join(out,'workspace/react.d.ts')],'@vivari/core/host':[join(out,'host/index.d.ts')]}},files:[join(out,'source/sk-endpoint-owner-qa-client.ts')]};
await Bun.write(join(out,'consumer.tsconfig.json'),JSON.stringify(config));
const proc=Bun.spawn(['bun',join(root,'workspace-api/node_modules/typescript/bin/tsc'),'-p',join(out,'consumer.tsconfig.json')],{stdout:'pipe',stderr:'pipe'});
const [stdout,stderr,exit]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
await Bun.write(join(out,'typed-consumer-check.json'),JSON.stringify({stdout,stderr,exit}));if(exit)throw Error(stdout+stderr);
await Bun.write(join(out,'tools.tsconfig.json'),JSON.stringify({...config,compilerOptions:{...config.compilerOptions,types:['bun'],typeRoots:[join(root,'workspace-api/node_modules/@types')]},files:files.filter(file=>!file.endsWith('-client.ts')).map(file=>join(out,'source',file))}));
const tools=Bun.spawn(['bun',join(root,'workspace-api/node_modules/typescript/bin/tsc'),'-p',join(out,'tools.tsconfig.json')],{stdout:'pipe',stderr:'pipe'});
const [toolOut,toolErr,toolExit]=await Promise.all([new Response(tools.stdout).text(),new Response(tools.stderr).text(),tools.exited]);
await Bun.write(join(out,'typed-tools-check.json'),JSON.stringify({stdout:toolOut,stderr:toolErr,exit:toolExit}));if(toolExit)throw Error(toolOut+toolErr);
const hashes:Record<string,string>={};
for await(const file of new Bun.Glob('**/*').scan({cwd:out,onlyFiles:true}))hashes[file]=await hash(join(out,file));
await Bun.write(join(out,'stage.json'),JSON.stringify({status:'prepared-not-started',scope:'real-workspace-public-built-library-fixture',fixtureSourceRevision,hostRevision:receipt.hostRevision,toolkitRevision:receipt.sourceRevision,workerNativeRevision:receipt.retainedWorkerNativeRevision,runtimeVersion:receipt.runtimeVersion,originalStage:frozen,inputHashes:expected,hashes,typedBuiltConsumer:true,typedPreparationTools:true,dependencyReuse:'installed React bundled read-only; no fresh lock reproducibility claim',guestDelivery:'plain CJS node:http builtins; no app/model/Vite/preparedApps dependency',liveRuns:0},null,2));
console.log(out);
