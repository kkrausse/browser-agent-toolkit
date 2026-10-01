import {mkdir,cp,readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {assetHash} from '../../../workspace-api/scripts/runtime-assets';
if(process.argv.length!==4)throw Error('Usage: prepare-single-kernel-remaining.ts <frozen-e35-output> <new-output>');
const [input,output]=process.argv.slice(2).map(p=>resolve(p));
const receipt=await Bun.file(join(input!,'receipt.json')).json();
if(receipt.revision!=='e35eab4af7a53ff08eb70c09df59c40b78bfdd67'||receipt.offline)throw Error('Require exact frozen e35 runtime');
for(const [file,hash] of Object.entries(receipt.hashes))if(assetHash(await readFile(join(input!,file)))!==hash)throw Error('Frozen artifact mismatch: '+file);
await mkdir(output!);
for(const file of Object.keys(receipt.hashes)){await mkdir(dirname(join(output!,file)),{recursive:true});await cp(join(input!,file),join(output!,file));}
for(const entry of ['single-kernel-reload-client','single-kernel-cases-client']){
  const result=await Bun.build({entrypoints:[join(import.meta.dir,entry+'.ts')],outdir:join(output!,'client'),target:'browser',plugins:[{name:'frozen-libraries',setup(b){
    const library=join(output!,'workspace',entry.includes('cases')?'test-library.js':'index.js');
    b.onResolve({filter:/^@kev-browser-agent-kit\/workspace$/},()=>({path:library}));
    b.onResolve({filter:/\/src\/(?:index|workspace)\.js$/},args=>{const p=resolve(args.resolveDir,args.path);if(p.includes('/workspace-api/src/'))return {path:library};});
  }}]});if(!result.success)throw new AggregateError(result.logs,'Remaining consumer build');
}
const hashes:Record<string,string>={};for await(const file of new Bun.Glob('**/*').scan({cwd:output!,onlyFiles:true}))hashes[file]=assetHash(await readFile(join(output!,file)));
const driverSources:Record<string,string>={};for(const file of ['single-kernel-remaining-driver.ts','single-kernel-driver.ts','matched-pair-driver.ts'])driverSources['examples/todo-app/tests/'+file]=assetHash(await readFile(join(import.meta.dir,file)));
await Bun.write(join(output!,'receipt.json'),JSON.stringify({...receipt,output,frozenInput:input,remainingOnly:true,hashes,driverSources},null,2));console.log(output);
