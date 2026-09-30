import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dir,'../../..');
const output=join(root,'.diagnostics/opencode-exclusive-reuse-'+new Date().toISOString().replaceAll(/[:.]/g,'-'));
await mkdir(output);
const previous=await Bun.file(join(root,'.diagnostics/ownership-fixed-pair-prep-20260930/receipt.json')).json();
const runtimeSource=previous.runtimeSource;
const command=async(args:string[],cwd=root)=>{const p=Bun.spawn(args,{cwd,stdout:'pipe',stderr:'pipe'}); const [out,err,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]); if(exit) throw Error(err||out); return out.trim();};
if(await command(['git','rev-parse','HEAD'],runtimeSource)!==previous.pin||await command(['git','status','--porcelain'],runtimeSource)) throw Error('Runtime source not clean pinned 446df00');
const frozen=join(root,'.diagnostics/phase4-clean-completion');
const identity=await Bun.file(join(frozen,'served-identity.json')).json();
const hash=async(path:string)=>{const b=await Bun.file(path).arrayBuffer();return {bytes:b.byteLength,sha256:new Bun.CryptoHasher('sha256').update(b).digest('hex')};};
const verified:any={};
for(const [url,expected] of Object.entries(identity.served)) {
  if(url.startsWith('/client/')) continue;
  const path=url==='/prepared/baseline/manifest.json'?join(frozen,'server-output/baseline/manifest.json'):join(frozen,url.slice(1));
  const actual=await hash(path); if(JSON.stringify(actual)!==JSON.stringify(expected)) throw Error('Frozen mismatch '+url); verified[url]=actual;
}
const manifest=await Bun.file(join(frozen,'server-output/baseline/manifest.json')).json();
let managedFileChecks=0;
for(const asset of [...manifest.assets.filter((a:any)=>a.kind==='file'),identity.payload.image,identity.payload.bundle]) {const actual=await hash(join(frozen,'prepared',asset.file)); if(actual.bytes!==asset.bytes||actual.sha256!==asset.sha256)throw Error('Payload mismatch '+asset.file);managedFileChecks++;}
const bundle=await hash(join(root,'vivari/.runtime/opencode-release-2.0.3/.runtime/opencode-bun-server/server.js'));
if(bundle.sha256!=='1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929')throw Error('Packaged server mismatch');
const external=['react','react/jsx-runtime','@kev-browser-agent-kit/workspace','@kev-browser-agent-kit/workspace/react','@kev-browser-agent-kit/workspace/diagnostics','@kev-browser-agent-kit/workspace/delivery'];
for(const [source,entry,name] of [['workspace-api','index.ts','index'],['workspace-api','react.tsx','react'],['workspace-api','diagnostics.ts','diagnostics'],['workspace-api','delivery.ts','delivery'],['opencode-chat','browser.ts','browser']]) {
  const result=await Bun.build({entrypoints:[join(root,source!,'src',entry!)],outdir:join(output,source==='workspace-api'?'workspace':'chat'),naming:name+'.js',target:'browser',jsx:{runtime:'automatic',development:false},external,plugins:[{name:'pinned-host',setup(build){build.onResolve({filter:/^@vivari\/core\/host$/},()=>({path:join(runtimeSource,'packages/core/src/host-sdk/index.ts')}));}}]});
  if(!result.success)throw new AggregateError(result.logs,'Isolated library build');
}
const result=await Bun.build({entrypoints:[join(root,'examples/todo-app/tests/reuse-pilot-client.ts')],outdir:join(output,'client'),target:'browser',plugins:[{name:'isolated-libraries',setup(build){
  build.onResolve({filter:/^@kev-browser-agent-kit\/workspace(?:\/(?:react|diagnostics|delivery))?$/},args=>({path:join(output,'workspace',(args.path.split('/')[2]??'index')+'.js')}));
  build.onResolve({filter:/^@kev-browser-agent-kit\/opencode-chat\/browser$/},()=>({path:join(output,'chat/browser.js')}));
  build.onResolve({filter:/^react(?:\/jsx-runtime)?$/},args=>({path:require.resolve(args.path,{paths:[join(root,'workspace-api')]} )}));
}}]});
if(!result.success)throw new AggregateError(result.logs,'Isolated consumer build');
const paths: Record<string,string[]>={};
for(const entry of ['index','react','diagnostics','delivery'])paths['@kev-browser-agent-kit/workspace'+(entry==='index'?'':'/'+entry)]=[join(root,'.diagnostics/reviewed-client-prep-2026-09-30T02-30-20-204Z/workspace',entry+'.d.ts')];
paths['@kev-browser-agent-kit/opencode-chat/browser']=[join(root,'.diagnostics/reviewed-client-prep-2026-09-30T02-30-20-204Z/chat/browser.d.ts')];
await Bun.write(join(output,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'ESNext',moduleResolution:'Bundler',strict:true,skipLibCheck:true,noEmit:true,lib:['ES2023','DOM','DOM.Iterable'],typeRoots:[join(root,'opencode-chat/node_modules/@types'),join(root,'workspace-api/node_modules/@types')],types:['bun','react'],jsx:'react-jsx',paths},files:['reuse-pilot-client.ts','reuse-pilot-contract.ts','reuse-pilot-contract.test.ts','reuse-pilot-fence.ts','reuse-pilot-fence.test.ts','prepare-reuse-pilot.ts','serve-reuse-pilot.ts'].map(f=>join(root,'examples/todo-app/tests',f))}));
await command(['bun',join(root,'workspace-api/node_modules/typescript/bin/tsc'),'-p',join(output,'tsconfig.json')]);
await Bun.write(join(output,'receipt.json'),JSON.stringify({output,runtimeSource,pin:previous.pin,version:identity.version,verified,managedFileChecks,bundle,client:await hash(join(output,'client/reuse-pilot-client.js')),policy:{launches:1,resets:1,coldMs:90000,resetMs:60000,requestMs:20000,drainMs:20000,cleanupMs:15000,observationMs:180000,retries:0},frozen},null,2));
console.log(output);
