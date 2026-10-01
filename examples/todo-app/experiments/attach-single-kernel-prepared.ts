// Attach matching app preparation to frozen verified libraries/runtime without
// reading or rebuilding a concurrently changing runtime source checkout.
import {cp,mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {assetHash} from '../../../workspace-api/scripts/runtime-assets';
if(process.argv.length!==5)throw Error('Usage: attach-single-kernel-prepared.ts <frozen-output> <prepared> <new-output>');
const [input,prepared,output]=process.argv.slice(2).map(p=>resolve(p));
const receipt=await Bun.file(join(input!,'receipt.json')).json();
if(receipt.offline||receipt.prepared||receipt.topology?.policy!=='single-kernel')throw Error('Require frozen unprepared single-kernel artifact');
for(const [file,hash] of Object.entries(receipt.hashes))if(assetHash(await readFile(join(input!,file)))!==hash)throw Error('Frozen artifact changed: '+file);
const manifest=await Bun.file(join(prepared!,'manifest.json')).json();
if(manifest.runtimeVersion!==receipt.version||manifest.dependencies?.policy?.runtimeVersion!==receipt.version)throw Error('Prepared runtime identity mismatch');
for(const asset of [...manifest.assets.filter((a:any)=>a.kind==='file'),manifest.bundle,manifest.image].filter(Boolean)){
  if(asset.file.startsWith('/')||asset.file.split('/').includes('..'))throw Error('Unsafe prepared asset path');
  const bytes=await readFile(join(prepared!,asset.file));if(bytes.length!==asset.bytes||assetHash(bytes)!==asset.sha256)throw Error('Prepared asset mismatch: '+asset.file);
}
await mkdir(output!);
await cp(input!,output!,{recursive:true});await cp(prepared!,join(output!,'prepared'),{recursive:true});
const hashes:Record<string,string>={};
for await(const file of new Bun.Glob('**/*').scan({cwd:output!,onlyFiles:true}))if(file!=='receipt.json')hashes[file]=assetHash(await readFile(join(output!,file)));
await Bun.write(join(output!,'receipt.json'),JSON.stringify({...receipt,output,frozenInput:input,prepared:true,hashes},null,2));
console.log(output);
