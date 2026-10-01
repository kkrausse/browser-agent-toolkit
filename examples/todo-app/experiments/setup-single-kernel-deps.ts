import {mkdir,lstat,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dir,'../../..');
const output=join(root,'.diagnostics/single-kernel-deps');
await mkdir(output,{recursive:true});
const dependencies:Record<string,string>={};
for(const directory of ['examples/todo-app','workspace-api','opencode-chat']){
  const metadata=await Bun.file(join(root,directory,'package.json')).json();
  for(const [name,version] of Object.entries({...metadata.dependencies,...metadata.devDependencies}) as [string,string][]){
    if(!version.startsWith('file:'))dependencies[name]=version;
  }
}
const manifest=join(output,'package.json');
const text=JSON.stringify({name:'single-kernel-isolated-test-dependencies',private:true,type:'module',dependencies},null,2)+'\n';
if(await Bun.file(manifest).exists()&&await Bun.file(manifest).text()!==text)throw Error('Existing isolated dependency manifest differs; preserve it');
await Bun.write(manifest,text);
// First creation generates this experiment's own lock. Every subsequent install
// is frozen. Neither production manifests/locks nor vendor links are rewritten.
const locked=await Bun.file(join(output,'bun.lock')).exists();
const child=Bun.spawn(['bun','install','--ignore-scripts',...(locked?['--frozen-lockfile']:[])],{cwd:output,stdout:'inherit',stderr:'inherit'});
if(await child.exited)throw Error('Isolated dependency installation failed');
if(!locked){const verify=Bun.spawn(['bun','install','--ignore-scripts','--frozen-lockfile'],{cwd:output,stdout:'inherit',stderr:'inherit'});if(await verify.exited)throw Error('Frozen dependency verification failed');}
for(const directory of ['workspace-api','opencode-chat','examples/todo-app']){
  const path=join(root,directory,'node_modules');
  const exists=await lstat(path).then(()=>true,()=>false);
  if(!exists)await symlink(join(output,'node_modules'),path,'dir');
}
console.log(output);
