import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve,relative,dirname} from 'node:path';
import {assetHash} from '../../../workspace-api/scripts/runtime-assets';
const root=resolve(import.meta.dir,'../../..');
if(!process.argv[2]||!process.argv[3]||!process.argv[4])throw Error('Usage: snapshot-single-kernel-app-input.ts <new-library-output> <qualified-toolkit-read-only> <new-snapshot>');
const output=resolve(process.argv[2]),qualified=resolve(process.argv[3]),snapshot=resolve(process.argv[4]);
await mkdir(snapshot);
const receipt=await Bun.file(join(output,'receipt.json')).json();if(receipt.offline||!receipt.version)throw Error('Require runtime-qualified source libraries');
// The unchanged UI distribution is an explicit read-only qualification input,
// not an old runtime distribution. Replace every runtime-facing emitted entry
// with the separately built source library before preparing the app consumer.
await cp(join(qualified,'opencode-chat/dist'),join(snapshot,'opencode-chat/dist'),{recursive:true});
await cp(join(qualified,'workspace-api/dist/lib'),join(snapshot,'workspace-api/dist/lib'),{recursive:true});
for(const entry of ['index','react','delivery','diagnostics'])for(const ext of ['js','d.ts'])await cp(join(output,'workspace',entry+'.'+ext),join(snapshot,'workspace-api/dist/lib',entry+'.'+ext));
await cp(join(output,'host'),join(snapshot,'workspace-api/dist/lib/vivari-host'),{recursive:true});
for await(const file of new Bun.Glob('**/*.d.ts').scan(join(snapshot,'workspace-api/dist/lib'))){
  const path=join(snapshot,'workspace-api/dist/lib',file);
  const target=relative(dirname(path),join(snapshot,'workspace-api/dist/lib/vivari-host/index.js')).replaceAll('\\','/');
  await Bun.write(path,(await Bun.file(path).text()).replaceAll('@vivari/core/host',target.startsWith('.')?target:'./'+target));
}
await cp(join(output,'chat/browser.js'),join(snapshot,'opencode-chat/dist/browser.js'));
await cp(join(output,'chat/browser.d.ts'),join(snapshot,'opencode-chat/dist/browser.d.ts'));
for(const file of ['src','package.json','bun.lock','vite.config.ts','react-router.config.ts','tsconfig.json'])await cp(join(root,'examples/todo-app',file),join(snapshot,'examples/todo-app',file),{recursive:true});
const hashes:Record<string,string>={};for await(const file of new Bun.Glob('**/*').scan({cwd:snapshot,onlyFiles:true}))hashes[file]=assetHash(await readFile(join(snapshot,file)));
await writeFile(join(snapshot,'input-receipt.json'),JSON.stringify({runtimeVersion:receipt.version,runtimeRevision:receipt.revision,qualifiedUIInput:qualified,replacedRuntimeEntries:['index','react','delivery','diagnostics','host','chat/browser'],hashes},null,2),{flag:'wx'});
console.log(join(snapshot,'examples/todo-app'));
