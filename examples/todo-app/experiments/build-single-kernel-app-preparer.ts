import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {assetHash} from '../../../workspace-api/scripts/runtime-assets';
const root=resolve(import.meta.dir,'../../..'),output=resolve(process.argv[2]??'');
const receipt=await Bun.file(join(output,'receipt.json')).json();
if(receipt.offline||!receipt.version)throw Error('Require receipted runtime output, not offline typecheck artifacts');
const tools=join(output,'preparation-tools');await mkdir(tools);
const external=['@kev-browser-agent-kit/workspace/assets','@kev-browser-agent-kit/workspace/prepare','@kev-browser-agent-kit/workspace/diagnostics'];
for(const entry of ['assets','prepare','diagnostics']){
  const built=await Bun.build({entrypoints:[join(root,'workspace-api/src',entry+'.ts')],target:'bun',outdir:join(tools,'workspace'),naming:entry+'.js',external});
  if(!built.success)throw new AggregateError(built.logs,'Preparation library build');
}
const chat=await Bun.build({entrypoints:[join(root,'opencode-chat/src/prepare.ts')],target:'bun',outdir:join(tools,'chat'),naming:'prepare.js',external});
if(!chat.success)throw new AggregateError(chat.logs,'Chat preparation library build');
const consumer=await Bun.build({entrypoints:[join(import.meta.dir,'single-kernel-prepare-apps-consumer.ts')],target:'bun',outdir:tools,plugins:[{name:'isolated-node-libraries',setup(builder){
  builder.onResolve({filter:/^@kev-browser-agent-kit\/workspace\/(?:assets|prepare|diagnostics)$/},args=>({path:join(tools,'workspace',args.path.split('/').at(-1)+'.js')}));
  builder.onResolve({filter:/^@kev-browser-agent-kit\/opencode-chat\/prepare$/},()=>({path:join(tools,'chat/prepare.js')}));
}}]});
if(!consumer.success)throw new AggregateError(consumer.logs,'Preparation consumer build');
const hashes:Record<string,string>={};for await(const file of new Bun.Glob('**/*').scan({cwd:tools,onlyFiles:true}))hashes[file]=assetHash(await readFile(join(tools,file)));
await writeFile(join(tools,'receipt.json'),JSON.stringify({runtimeVersion:receipt.version,runtimeRevision:receipt.revision,hashes},null,2),{flag:'wx'});
console.log(join(tools,'single-kernel-prepare-apps-consumer.js'));
