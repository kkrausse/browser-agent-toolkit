import {cp, mkdir, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {resolveRuntimeSource} from '../../../vivari/scripts/runtime-source.mjs';
import {assetHash} from '../../../workspace-api/scripts/runtime-assets';

// Invoke only after the runtime agent supplies a committed built checkpoint.
// No canonical vendor symlink, production pin, archive, or published dist edits.
const root=resolve(import.meta.dir,'../../..');
if(!process.env.VIVARI_SOURCE)throw Error('An explicit VIVARI_SOURCE fork checkout is required');
const source=resolveRuntimeSource();
const offlineRevision=process.env.SINGLE_KERNEL_OFFLINE_REVISION;
if(source===resolve(root,'vendor/vivari'))throw Error('Do not prepare this experiment against canonical vendor/vivari');
const output=resolve(process.argv[2]??join(root,'.diagnostics','single-kernel-'+new Date().toISOString().replaceAll(/[:.]/g,'-')));
await mkdir(output); // Exclusive artifact directory, never overwrite evidence.
async function command(args:string[],cwd=root,trim=true){
  const p=Bun.spawn(args,{cwd,stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  if(exit)throw Error(args.join(' ')+' failed: '+stderr+stdout);return trim?stdout.trim():stdout;
}
const revision=await command(['git','rev-parse',offlineRevision??'HEAD'],source);
let distribution:any={version:null,topology:null};
let hostSource=join(source,'packages/core/src/host-sdk');
if(offlineRevision){
  hostSource=join(output,'host-checkpoint-source');
  const files=(await command(['git','ls-tree','-r','--name-only',revision,'--','packages/core/src/host-sdk'],source)).split('\n').filter(Boolean);
  for(const file of files)await Bun.write(join(hostSource,file.slice('packages/core/src/host-sdk/'.length)),await command(['git','show',revision+':'+file],source,false));
}else{
  if(await command(['git','status','--porcelain'],source))throw Error('Commit the runtime checkpoint before consumer preparation');
  const build=JSON.parse(await readFile(join(root,'vivari/.runtime/patched-build.json'),'utf8'));
  if(build.source?.path!==source||build.source.commit!==revision||build.source.dirty)throw Error('Integration build receipt must match the clean committed checkpoint');
  await command(['bun',join(root,'workspace-api/scripts/distribution.ts'),join(output,'runtime')]);
  distribution=await Bun.file(join(output,'runtime/distribution.json')).json();
  if(distribution.topology?.policy!=='single-kernel')throw Error('Set VIVARI_WORKER_TOPOLOGY=single-kernel');
}
const external=['react','react/jsx-runtime','@kev-browser-agent-kit/workspace','@kev-browser-agent-kit/workspace/react','@kev-browser-agent-kit/workspace/delivery','@kev-browser-agent-kit/workspace/diagnostics'];
for(const [directory,entry,name] of [['workspace-api','index.ts','index'],['workspace-api','react.tsx','react'],['workspace-api','delivery.ts','delivery'],['workspace-api','diagnostics.ts','diagnostics'],['opencode-chat','browser.ts','browser']]){
  const result=await Bun.build({entrypoints:[join(root,directory!,'src',entry!)],outdir:join(output,directory==='workspace-api'?'workspace':'chat'),naming:name+'.js',target:'browser',jsx:{runtime:'automatic',development:false},external,plugins:[{name:'checkpoint-host',setup(builder){builder.onResolve({filter:/^@vivari\/core\/host$/},()=>({path:join(hostSource,'index.ts')}));}}]});
  if(!result.success)throw new AggregateError(result.logs,'Library build failed');
}
const testLibrary=await Bun.build({entrypoints:[join(root,'workspace-api/tests/browser/test-library.ts')],outdir:join(output,'workspace'),naming:'test-library.js',target:'browser',external,plugins:[{name:'checkpoint-host',setup(builder){builder.onResolve({filter:/^@vivari\/core\/host$/},()=>({path:join(hostSource,'index.ts')}));}}]});
if(!testLibrary.success)throw new AggregateError(testLibrary.logs,'Test-only library build');
// Emit/check declarations separately. The consumer resolves generated library
// declarations, never directly aliases the workspace/chat implementation source.
const common={target:'ES2023',module:'ESNext',moduleResolution:'Bundler',jsx:'react-jsx',strict:true,skipLibCheck:true,lib:['ES2023','DOM','DOM.Iterable'],typeRoots:[join(root,'workspace-api/node_modules/@types'),join(root,'opencode-chat/node_modules/@types')],types:['bun','react']};
const tsc=join(root,'workspace-api/node_modules/typescript/bin/tsc');
async function declarations(name:string,sourceRoot:string,entries:string[],paths:Record<string,string[]>){
  const config=join(output,name+'.tsconfig.json');
  await Bun.write(config,JSON.stringify({compilerOptions:{...common,rootDir:sourceRoot,outDir:join(output,name),declaration:true,emitDeclarationOnly:true,paths},files:entries.map(entry=>join(sourceRoot,entry))}));
  await command(['bun',tsc,'-p',config]);
}
await declarations('host',hostSource,['index.ts'],{});
await declarations('workspace',join(root,'workspace-api/src'),['index.ts','react.tsx','delivery.ts','diagnostics.ts','assets.ts','prepare.ts'],{'@vivari/core/host':[join(output,'host/index.d.ts')],'@kev-browser-agent-kit/workspace':[join(root,'workspace-api/src/index.ts')]});
const paths:Record<string,string[]>={'@vivari/core/host':[join(output,'host/index.d.ts')]};
for(const name of ['index','react','delivery','diagnostics','assets','prepare'])paths['@kev-browser-agent-kit/workspace'+(name==='index'?'':'/'+name)]=[join(output,'workspace',name+'.d.ts')];
await declarations('chat',join(root,'opencode-chat/src'),['browser.ts','prepare.ts'],paths);
paths['@kev-browser-agent-kit/opencode-chat/browser']=[join(output,'chat/browser.d.ts')];
paths['@kev-browser-agent-kit/opencode-chat/prepare']=[join(output,'chat/prepare.d.ts')];
paths['@/*']=[join(root,'examples/todo-app/src/*')];
await Bun.write(join(output,'consumer.tsconfig.json'),JSON.stringify({compilerOptions:{...common,allowJs:true,noEmit:true,paths},files:['single-kernel-client.ts','single-kernel-cases-client.ts','single-kernel-driver.ts','single-kernel-driver.test.ts','prepare-single-kernel.ts','serve-single-kernel.ts','setup-single-kernel-deps.ts','single-kernel-prepare-apps-consumer.ts','build-single-kernel-app-preparer.ts','snapshot-single-kernel-app-input.ts'].map(file=>join(import.meta.dir,file))}));
await command(['bun',tsc,'-p',join(output,'consumer.tsconfig.json')]);
const result=await Bun.build({entrypoints:[join(import.meta.dir,'single-kernel-client.ts')],outdir:join(output,'client'),target:'browser',plugins:[{name:'isolated-libraries',setup(builder){
  builder.onResolve({filter:/^@kev-browser-agent-kit\/workspace(?:\/(?:react|delivery|diagnostics))?$/},args=>({path:join(output,'workspace',(args.path.split('/')[2]??'index')+'.js')}));
  builder.onResolve({filter:/^@kev-browser-agent-kit\/opencode-chat\/browser$/},()=>({path:join(output,'chat/browser.js')}));
  builder.onResolve({filter:/^react(?:\/jsx-runtime)?$/},args=>({path:require.resolve(args.path,{paths:[join(root,'workspace-api')]} )}));
}}]});
if(!result.success)throw new AggregateError(result.logs,'Consumer build failed');
const cases=await Bun.build({entrypoints:[join(import.meta.dir,'single-kernel-cases-client.ts')],outdir:join(output,'client'),target:'browser',plugins:[{name:'isolated-contract-library',setup(builder){
  builder.onResolve({filter:/^@kev-browser-agent-kit\/workspace$/},()=>({path:join(output,'workspace/test-library.js')}));
  builder.onResolve({filter:/\/src\/(?:index|workspace)\.js$/},args=>{
    const path=resolve(args.resolveDir,args.path);
    if([join(root,'workspace-api/src/index.js'),join(root,'workspace-api/src/workspace.js')].includes(path))return {path:join(output,'workspace/test-library.js')};
  });
}}]});
if(!cases.success)throw new AggregateError(cases.logs,'Isolated reused-contract consumer build');
for(const [directory,files] of [['workspace',['README.md','LOCAL-PACKAGES.md']],['chat',['README.md','PROVENANCE.md','LICENSE','LICENSE.marked','LICENSE.shadcn','LICENSE.upstream']]] as const){
  for(const file of files)await cp(join(root,directory==='workspace'?'workspace-api':'opencode-chat',file),join(output,directory,file));
}
await cp(join(source,'LICENSE'),join(output,'workspace/LICENSE.vivari'));
// Prepared payloads must be generated for this runtime version, not relabeled
// from a historical candidate. Freeze their complete byte/hash identity.
const prepared=offlineRevision?undefined:process.env.SINGLE_KERNEL_PREPARED;
if(prepared){
  const input=resolve(prepared);const manifest=await Bun.file(join(input,'manifest.json')).json();
  if(manifest.runtimeVersion!==distribution.version||manifest.dependencies?.policy?.runtimeVersion!==distribution.version)throw Error('Prepared payload runtime identity mismatch; run fresh preparation');
  for(const asset of [...manifest.assets.filter((a:any)=>a.kind==='file'),manifest.bundle,manifest.image].filter(Boolean)){
    if(asset.file.startsWith('/')||asset.file.split('/').includes('..'))throw Error('Unsafe prepared path');
    const bytes=await readFile(join(input,asset.file));if(bytes.length!==asset.bytes||assetHash(bytes)!==asset.sha256)throw Error('Prepared payload mismatch: '+asset.file);
  }
  await cp(input,join(output,'prepared'),{recursive:true});
}
const hashes:Record<string,string>={};
for await(const file of new Bun.Glob('**/*').scan({cwd:output,onlyFiles:true}))hashes[file]=assetHash(await readFile(join(output,file)));
const driverSources:Record<string,string>={};
for(const file of ['single-kernel-driver.ts','matched-pair-driver.ts','matched-readiness.ts'])driverSources['examples/todo-app/tests/'+file]=assetHash(await readFile(join(import.meta.dir,file)));
await Bun.write(join(output,'receipt.json'),JSON.stringify({output,runtimeSource:source,revision,offline:!!offlineRevision,version:distribution.version,topology:distribution.topology,prepared:!!prepared,hashes,driverSources,liveRuns:0,models:0},null,2));
console.log(output);
