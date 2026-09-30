import {mkdir,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dir,'../../..'),runtime=resolve(root,'../vivari-single-kernel');
const frozen=join(root,'.diagnostics/single-kernel-e35eab4-full-fresh-2026-09-30-independent-17ef8e3');
const output=resolve(process.argv[2]??join(root,'.diagnostics/sk-stable-opencode-'+crypto.randomUUID()));
const runtimeRevision='e35eab4af7a53ff08eb70c09df59c40b78bfdd67',hostRevision='724909bff00c9c0994ecde7c767a218ae2af25a0';
async function command(args:string[],cwd=root){const p=Bun.spawn(args,{cwd,stdout:'pipe',stderr:'pipe'});const [out,err,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(exit)throw Error(err||out);return out;}
const hash=async(path:string)=>new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
const sourceRevision=(await command(['git','rev-parse',process.env.SK_STABLE_OPENCODE_SOURCE_REVISION??'HEAD'])).trim();
await command(['git','merge-base','--is-ancestor','7713686',sourceRevision]);
const files=['sk-stable-opencode-client.ts','sk-stable-opencode-codec.mjs','sk-stable-opencode-serve.ts','sk-stable-opencode-host-owner.ts','sk-stable-opencode-prepare.ts'];
for(const file of files)await command(['git','cat-file','-e',sourceRevision+':examples/todo-app/tests/'+file]);
// Host-only repair is paired with the unchanged e35 kernel/filesystem protocol.
for(const file of ['packages/core/src/workers/kernel-worker.ts','packages/core/src/workers/kernel-filesystem.ts'])if((await command(['git','diff',runtimeRevision,hostRevision,'--',file],runtime)).trim())throw Error('Host/guest kernel parity changed '+file);
const receipt=await Bun.file(join(frozen,'receipt.json')).json();
if(receipt.revision!==runtimeRevision||receipt.offline||receipt.topology.policy!=='single-kernel')throw Error('Frozen runtime mismatch');
for(const [file,expected] of Object.entries(receipt.hashes))if(await hash(join(frozen,file))!==expected)throw Error('Frozen artifact changed '+file);
const manifest=await Bun.file(join(frozen,'prepared/manifest.json')).json();
if(manifest.runtimeVersion!==receipt.version||manifest.dependencies.policy.runtimeVersion!==receipt.version)throw Error('Runtime version mismatch');
for(const asset of [...manifest.assets.filter((a:any)=>a.kind==='file'),manifest.bundle,manifest.image].filter(Boolean))if(await hash(join(frozen,'prepared',asset.file))!==asset.sha256||await Bun.file(join(frozen,'prepared',asset.file)).size!==asset.bytes)throw Error('Prepared asset mismatch');
const serverSha256='648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5';
const server=manifest.assets.filter((a:any)=>a.kind==='file'&&a.destination==='/app/server.js');
if(server.length!==1||server[0].sha256!==serverSha256)throw Error('Actual648 required');
const bundle=await Bun.file(join(frozen,'prepared',server[0].file)).text();
for(const text of ['"/api/debug/location"','Array.from(yield* exports_RcMap.keys(locations.rcMap))','config: { project: false, content: \'{"snapshot":false}\' }'])if(!bundle.includes(text))throw Error('Reviewed actual source boundary missing');
await mkdir(output);await mkdir(join(output,'source'));
const archive=Bun.spawn(['git','archive',sourceRevision,'workspace-api','opencode-chat','examples/todo-app/tests'],{cwd:root,stdout:'pipe',stderr:'pipe'});
const [bytes,err,exit]=await Promise.all([new Response(archive.stdout).arrayBuffer(),new Response(archive.stderr).text(),archive.exited]);if(exit)throw Error(err);
await Bun.write(join(output,'committed-source.tar'),bytes);await command(['tar','-xf',join(output,'committed-source.tar'),'-C',join(output,'source')]);
for(const pkg of ['workspace-api','opencode-chat'])await symlink(join(root,pkg,'node_modules'),join(output,'source',pkg,'node_modules'));
const host=join(output,'host-source');
for(const file of (await command(['git','ls-tree','-r','--name-only',hostRevision,'--','packages/core/src/host-sdk'],runtime)).trim().split('\n'))await Bun.write(join(host,file.slice('packages/core/src/host-sdk/'.length)),await command(['git','show',hostRevision+':'+file],runtime));
const end=bundle.indexOf('\n// ',bundle.indexOf('var init_client7 ='));if(end<=0)throw Error('Actual codec extraction failed');
await Bun.write(join(output,'pinned-codec.mjs'),bundle.slice(0,end)+'\ninit_client7(); export {ClientApi as Api, exports_Schema as Schema, exports_Effect as Effect, makeSuccessSchema, exports_HttpServerResponse as HttpServerResponse, exports_HttpApiSchema as HttpApiSchema};\n');
await Bun.write(join(output,'sk-stable-opencode-codec.mjs'),await Bun.file(join(output,'source/examples/todo-app/tests/sk-stable-opencode-codec.mjs')).arrayBuffer());
const dependencies:any={};for(const name of ['@opencode/client','effect','react','react-dom']){const path=require.resolve(name+'/package.json',{paths:[join(root,'opencode-chat')]});dependencies[name]={version:(await Bun.file(path).json()).version,sha256:await hash(path)};}
if(dependencies['@opencode/client'].version!=='2.0.3'||dependencies.effect.version!=='4.0.0-rc.112')throw Error('Dependency pin changed');
const entries=[['workspace-api','index.ts','index'],['workspace-api','react.tsx','react'],['workspace-api','delivery.ts','delivery'],['opencode-chat','browser.ts','browser']] as const;
const external=['react','react/jsx-runtime','@kev-browser-agent-kit/workspace','@kev-browser-agent-kit/workspace/react','@kev-browser-agent-kit/workspace/delivery'];
for(const [pkg,entry,name] of entries){const result=await Bun.build({entrypoints:[join(output,'source',pkg,'src',entry)],outdir:join(output,pkg==='workspace-api'?'workspace':'chat'),naming:name+'.js',target:'browser',external,plugins:[{name:'frozen-host',setup(b){b.onResolve({filter:/^@vivari\/core\/host$/},()=>({path:join(host,'index.ts')}));}}]});if(!result.success)throw new AggregateError(result.logs,'Library build');}
const result=await Bun.build({entrypoints:[join(output,'source/examples/todo-app/tests/sk-stable-opencode-client.ts')],outdir:join(output,'client'),target:'browser',plugins:[{name:'separate-built-consumer',setup(b){
 b.onResolve({filter:/^@kev-browser-agent-kit\/workspace(?:\/(react|delivery))?$/},a=>({path:join(output,'workspace',(a.path.split('/')[2]??'index')+'.js')}));
 b.onResolve({filter:/^@kev-browser-agent-kit\/opencode-chat\/browser$/},()=>({path:join(output,'chat/browser.js')}));
 b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},a=>({path:require.resolve(a.path,{paths:[join(root,'workspace-api')]} )}));
}}]});if(!result.success)throw new AggregateError(result.logs,'Consumer build');
const common={target:'ES2023',module:'ESNext',moduleResolution:'Bundler',jsx:'react-jsx',strict:true,noUncheckedIndexedAccess:true,skipLibCheck:true,lib:['ES2023','DOM','DOM.Iterable'],types:['bun','react'],typeRoots:[join(root,'workspace-api/node_modules/@types'),join(root,'opencode-chat/node_modules/@types')]};
const tsc=join(root,'workspace-api/node_modules/typescript/bin/tsc');
await Bun.write(join(output,'host.tsconfig.json'),JSON.stringify({compilerOptions:{...common,declaration:true,emitDeclarationOnly:true,rootDir:host,outDir:join(output,'host-types')},files:[join(host,'index.ts')]}));
await command(['bun',tsc,'-p',join(output,'host.tsconfig.json')]);
const paths:any={'@vivari/core/host':[join(output,'host-types/index.d.ts')]};
for(const pkg of ['workspace-api','opencode-chat']){
 const sourceRoot=join(output,'source',pkg,'src'),name=pkg==='workspace-api'?'workspace':'chat';
 if(pkg==='workspace-api')paths['@kev-browser-agent-kit/workspace']=[join(sourceRoot,'index.ts')];
 await Bun.write(join(output,name+'.tsconfig.json'),JSON.stringify({compilerOptions:{...common,declaration:true,emitDeclarationOnly:true,rootDir:sourceRoot,outDir:join(output,name),paths},files:entries.filter(e=>e[0]===pkg).map(e=>join(sourceRoot,e[1]))}));
 // Emit declarations against a separately generated host declaration surface.
 await command(['bun',tsc,'-p',join(output,name+'.tsconfig.json')]);
 if(pkg==='workspace-api')for(const entry of ['index','react','delivery'])paths['@kev-browser-agent-kit/workspace'+(entry==='index'?'':'/'+entry)]=[join(output,'workspace',entry+'.d.ts')];
}
paths['@kev-browser-agent-kit/opencode-chat/browser']=[join(output,'chat/browser.d.ts')];
await Bun.write(join(output,'consumer.tsconfig.json'),JSON.stringify({compilerOptions:{...common,noEmit:true,paths},files:files.filter(f=>f.endsWith('.ts')).map(f=>join(output,'source/examples/todo-app/tests',f))}));
await command(['bun',tsc,'-p',join(output,'consumer.tsconfig.json')]);
const stageHashes:any={};
for(const dir of ['client','workspace','chat','host-source','host-types'])for await(const file of new Bun.Glob('**/*').scan({cwd:join(output,dir),onlyFiles:true}))stageHashes[dir+'/'+file]=await hash(join(output,dir,file));
for(const file of ['committed-source.tar','pinned-codec.mjs','sk-stable-opencode-codec.mjs','host.tsconfig.json','workspace.tsconfig.json','chat.tsconfig.json','consumer.tsconfig.json',...files.map(f=>'source/examples/todo-app/tests/'+f)])stageHashes[file]=await hash(join(output,file));
await writeFile(join(output,'stage.json'),JSON.stringify({status:'offline-prepared-only',runnablePrepared:true,sourceRevision,runtimeRevision,hostRevision,runtimeVersion:receipt.version,frozen,frozenHashes:receipt.hashes,frozenReceiptSha256:await hash(join(frozen,'receipt.json')),serverSha256,dependencies,stageHashes,configPolicy:'shared-frozen-global-config',backgroundWork:'models.fetch:true; server-owned global refresh and retained location subscribers not drained',retentionAccepted:false,remoteZeroRef:false,liveRuns:0},null,2),{flag:'wx'});
console.log(JSON.stringify({output,sourceRevision,hostRevision,runnablePrepared:true,liveRuns:0,retentionAccepted:false}));
