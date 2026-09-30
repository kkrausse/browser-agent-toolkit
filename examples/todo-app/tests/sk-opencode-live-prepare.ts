import {mkdir, symlink, writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const root=resolve(import.meta.dir,'../../..');
const frozen=join(root,'.diagnostics/single-kernel-e35eab4-full-fresh-2026-09-30-independent-17ef8e3');
const baseline=resolve(root,'../browser-agent-toolkit');
const runtime=resolve(root,'../vivari-single-kernel');
const output=resolve(process.argv[2]??join(root,'.diagnostics/sk-opencode-live-'+crypto.randomUUID()));
async function command(args:string[],cwd=root,trim=true){const p=Bun.spawn(args,{cwd,stdout:'pipe',stderr:'pipe'});const [out,err,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(exit)throw Error(err||out);return trim?out.trim():out;}
const hash=async(path:string)=>new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
const revision=await command(['git','rev-parse',process.env.SK_OPENCODE_SOURCE_REVISION??'HEAD']);
await command(['git','merge-base','--is-ancestor','55ae98c',revision]);
if(! (await command(['git','rev-parse','HEAD'],baseline)).startsWith('64de522'))throw Error('Read-only baseline pin changed');
await mkdir(output); // Must not exist; preserve partial failures for investigation.
const snapshot=join(output,'source');await mkdir(snapshot);
const archive=Bun.spawn(['git','archive',revision,'workspace-api','opencode-chat','examples/todo-app/tests'],{cwd:root,stdout:'pipe',stderr:'pipe'});
const [bytes,archiveError,archiveExit]=await Promise.all([new Response(archive.stdout).arrayBuffer(),new Response(archive.stderr).text(),archive.exited]);
if(archiveExit)throw Error(archiveError);
await Bun.write(join(output,'committed-source.tar'),bytes);
await command(['tar','-xf',join(output,'committed-source.tar'),'-C',snapshot]);
const receipt=await Bun.file(join(frozen,'receipt.json')).json();
if(receipt.revision!=='e35eab4af7a53ff08eb70c09df59c40b78bfdd67'||receipt.offline||receipt.topology.policy!=='single-kernel')throw Error('Frozen runtime admission failed');
let verified=0;
for(const [file,expected] of Object.entries(receipt.hashes)){if(await hash(join(frozen,file))!==expected)throw Error('Frozen identity mismatch '+file);verified++;}
const manifest=await Bun.file(join(frozen,'prepared/manifest.json')).json();
if(manifest.runtimeVersion!==receipt.version||manifest.dependencies.policy.runtimeVersion!==receipt.version)throw Error('Payload runtime mismatch');
for(const asset of [...manifest.assets.filter((a:any)=>a.kind==='file'),manifest.bundle,manifest.image].filter(Boolean))if(await hash(join(frozen,'prepared',asset.file))!==asset.sha256||(await Bun.file(join(frozen,'prepared',asset.file)).size)!==asset.bytes)throw Error('Payload mismatch '+asset.file);
const server=join(baseline,'vivari/.runtime/opencode-release-2.0.3/.runtime/opencode-bun-server/server.js');
const baselineServerHash=await hash(server);
if(baselineServerHash!=='1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929')throw Error('Pinned baseline server mismatch');
// Also bind the actual delivered server bytes to this hash, not just a sibling file.
const serverAssets=manifest.assets.filter((a:any)=>a.kind==='file'&&a.destination==='/app/server.js');
const serverHash='648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5';
const serverReceipt=JSON.parse(manifest.opencode.receipt);
if(serverAssets.length!==1||serverAssets[0].sha256!==serverHash||serverReceipt.source.version!=='2.0.3'||serverReceipt.outputs['server.js'].sha256!==serverHash)throw Error('Delivered SK server pin mismatch');
const deliveredServer=join(frozen,'prepared',serverAssets[0].file);
if(await hash(deliveredServer)!==serverHash)throw Error('Actual delivered server hash mismatch');
const bundle=await Bun.file(deliveredServer).text(),end=bundle.indexOf('\n// ',bundle.indexOf('var init_client7 ='));
if(end<=0||!bundle.includes('function makeSuccessSchema(endpoint5)'))throw Error('Pinned extraction anchors absent');
await Bun.write(join(output,'pinned-codec.mjs'),bundle.slice(0,end)+'\ninit_client7(); export {ClientApi as Api, exports_Schema as Schema, exports_Effect as Effect, makeSuccessSchema, exports_HttpServerResponse as HttpServerResponse, exports_HttpApiSchema as HttpApiSchema};\n');
await Bun.write(join(output,'sk-opencode-live-codec.mjs'),await Bun.file(join(snapshot,'examples/todo-app/tests/sk-opencode-live-codec.mjs')).arrayBuffer());
// Snapshot the exact e35 host sources; never consume a concurrently edited checkout.
const host=join(output,'host-source');
const hostFiles=(await command(['git','ls-tree','-r','--name-only',receipt.revision,'--','packages/core/src/host-sdk'],runtime)).split('\n').filter(Boolean);
for(const file of hostFiles)await Bun.write(join(host,file.slice('packages/core/src/host-sdk/'.length)),await command(['git','show',receipt.revision+':'+file],runtime,false));
for(const pkg of ['workspace-api','opencode-chat'])await symlink(join(root,pkg,'node_modules'),join(snapshot,pkg,'node_modules'));
const dependencies:Record<string,unknown>={};
for(const name of ['@opencode/client','@opencode/plugin','effect','react','react-dom']){
 const file=require.resolve(name+'/package.json',{paths:[join(root,'opencode-chat')]});
 const info=await Bun.file(file).json();dependencies[name]={version:info.version,manifestSha256:await hash(file)};
}
if((dependencies['@opencode/client'] as any).version!=='2.0.3'||(dependencies.effect as any).version!=='4.0.0-rc.112')throw Error('Installed dependency pin mismatch');
const external=['react','react/jsx-runtime','@kev-browser-agent-kit/workspace','@kev-browser-agent-kit/workspace/react','@kev-browser-agent-kit/workspace/diagnostics','@kev-browser-agent-kit/workspace/delivery'];
for(const [pkg,entry,name] of [['workspace-api','index.ts','index'],['workspace-api','react.tsx','react'],['workspace-api','diagnostics.ts','diagnostics'],['workspace-api','delivery.ts','delivery'],['opencode-chat','browser.ts','browser'],['opencode-chat','controller.ts','controller']]){
 const result=await Bun.build({entrypoints:[join(snapshot,pkg!,'src',entry!)],outdir:join(output,pkg==='workspace-api'?'workspace':'chat'),naming:name+'.js',target:'browser',jsx:{runtime:'automatic',development:false},external,plugins:[{name:'frozen-host',setup(b){b.onResolve({filter:/^@vivari\/core\/host$/},()=>({path:join(host,'index.ts')}));}}]});
 if(!result.success)throw new AggregateError(result.logs,'Separate library build failed');
}
const result=await Bun.build({entrypoints:[join(snapshot,'examples/todo-app/tests/sk-opencode-live-client.ts')],outdir:join(output,'client'),target:'browser',plugins:[{name:'built-consumer',setup(b){
 b.onResolve({filter:/^@kev-browser-agent-kit\/workspace(?:\/(react|diagnostics|delivery))?$/},a=>({path:join(output,'workspace',(a.path.split('/')[2]??'index')+'.js')}));
 b.onResolve({filter:/^@kev-browser-agent-kit\/opencode-chat\/browser$/},()=>({path:join(output,'chat/browser.js')}));
 b.onResolve({filter:/^sk-opencode-qualified-controller$/},()=>({path:join(output,'chat/controller.js')}));
 b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},a=>({path:require.resolve(a.path,{paths:[join(root,'workspace-api')]} )}));
}}]});
if(!result.success)throw new AggregateError(result.logs,'Consumer build failed');
const common={target:'ES2023',module:'ESNext',moduleResolution:'Bundler',jsx:'react-jsx',strict:true,skipLibCheck:true,lib:['ES2023','DOM','DOM.Iterable'],types:['bun','react'],typeRoots:[join(root,'workspace-api/node_modules/@types'),join(root,'opencode-chat/node_modules/@types')]};
const tsc=join(root,'workspace-api/node_modules/typescript/bin/tsc');
const paths:Record<string,string[]>={'@vivari/core/host':[join(frozen,'host/index.d.ts')]};
for(const [pkg,entries] of [['workspace-api',['index.ts','react.tsx','diagnostics.ts','delivery.ts']],['opencode-chat',['browser.ts','controller.ts']]] as const){
 const name=pkg==='workspace-api'?'workspace':'chat',sourceRoot=join(snapshot,pkg,'src');
 if(pkg==='workspace-api')paths['@kev-browser-agent-kit/workspace']=[join(sourceRoot,'index.ts')];
 await Bun.write(join(output,name+'.tsconfig.json'),JSON.stringify({compilerOptions:{...common,declaration:true,emitDeclarationOnly:true,rootDir:sourceRoot,outDir:join(output,name),paths},files:entries.map(entry=>join(sourceRoot,entry))}));
 await command(['bun',tsc,'-p',join(output,name+'.tsconfig.json')]);
 if(pkg==='workspace-api')for(const entry of ['index','react','diagnostics','delivery'])paths['@kev-browser-agent-kit/workspace'+(entry==='index'?'':'/'+entry)]=[join(output,'workspace',entry+'.d.ts')];
}
paths['@kev-browser-agent-kit/opencode-chat/browser']=[join(output,'chat/browser.d.ts')];paths['sk-opencode-qualified-controller']=[join(output,'chat/controller.d.ts')];
await Bun.write(join(output,'consumer.tsconfig.json'),JSON.stringify({compilerOptions:{...common,noEmit:true,paths},files:['sk-opencode-live-client.ts','sk-opencode-live-prepare.ts','sk-opencode-live-serve.ts','sk-opencode-live-staging.test.ts'].map(file=>join(snapshot,'examples/todo-app/tests',file))}));
await command(['bun',tsc,'-p',join(output,'consumer.tsconfig.json')]);
const stageHashes:Record<string,string>={};
for(const dir of ['client','chat','workspace','host-source'])for await(const file of new Bun.Glob('**/*').scan({cwd:join(output,dir),onlyFiles:true}))stageHashes[dir+'/'+file]=await hash(join(output,dir,file));
for(const file of ['committed-source.tar','pinned-codec.mjs','sk-opencode-live-codec.mjs','workspace.tsconfig.json','chat.tsconfig.json','consumer.tsconfig.json'])stageHashes[file]=await hash(join(output,file));
await writeFile(join(output,'stage.json'),JSON.stringify({status:'offline-prepared-only',output,frozen,sourceRevision:revision,sourceArchiveSha256:stageHashes['committed-source.tar'],runtimeRevision:receipt.revision,runtimeVersion:receipt.version,verifiedFrozenFiles:verified,frozenReceiptSha256:await hash(join(frozen,'receipt.json')),frozenHashes:receipt.hashes,serverSha256:serverHash,baselineServerSha256:baselineServerHash,serverReceipt,dependencies,stageHashes,retentionAccepted:false,remoteZeroRef:false,liveRuns:0},null,2),{flag:'wx'});
console.log(JSON.stringify({output,sourceRevision:revision,verifiedFrozenFiles:verified,serverHash,clientSha256:stageHashes['client/sk-opencode-live-client.js'],liveRuns:0}));
