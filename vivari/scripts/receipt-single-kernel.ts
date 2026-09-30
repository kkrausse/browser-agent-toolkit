// Receipt an explicitly built experimental checkpoint with verified native reuse.
// This never claims wasm-pack ran and never borrows another source's JS receipt.
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {integrationRoot,resolveRuntimeSource,runtimeConfig} from './runtime-source.mjs';
import {fileManifest,fingerprint,hashFile,sha256,treeFiles} from './runtime-fingerprint.mjs';
if(!process.env.VIVARI_SOURCE||!process.argv[2])throw Error('Require explicit VIVARI_SOURCE and native donor checkout argument');
const source=resolveRuntimeSource(),donor=resolve(process.argv[2]);
const git=(cwd:string,...args:string[])=>{const p=Bun.spawnSync(['git',...args],{cwd,stdout:'pipe',stderr:'pipe'});if(p.exitCode)throw Error(p.stderr.toString());return p.stdout.toString().trim();};
if(git(source,'status','--porcelain')||git(donor,'status','--porcelain'))throw Error('Source and native donor must be clean committed checkouts');
const revision=git(source,'rev-parse','HEAD'),donorRevision=git(donor,'rev-parse','HEAD');
const list=(cwd:string)=>git(cwd,'ls-files','-z').split('\0').filter(Boolean);
const native=(files:string[])=>files.filter(name=>/^(?:packages\/(?:vfs|codec|crypto|wasi-demo)\/|\.cargo\/|Cargo\.(?:toml|lock)$|rust-toolchain(?:\.toml)?$)/.test(name));
const sourceNative=fileManifest(source,native(list(source))),donorNative=fileManifest(donor,native(list(donor)));
if(fingerprint(sourceNative)!==fingerprint(donorNative))throw Error('Native donor inputs do not exactly match checkpoint');
const outputPaths=['vfs','codec','crypto'].flatMap(crate=>['pkg','pkg-node'].flatMap(directory=>treeFiles(source,`packages/${crate}/${directory}`))).concat(treeFiles(source,'packages/wasi-demo/pkg'));
const outputs=fileManifest(source,outputPaths),donorOutputs=fileManifest(donor,outputPaths);
if(!outputs.length||outputs.some(file=>!file.sha256)||fingerprint(outputs)!==fingerprint(donorOutputs))throw Error('Native reuse outputs differ from donor');
const expectedWasm:Record<string,string>={vfs:'3db4d587e67436621234dac17dbce7d3b9e33df7fcc0c37e079df1fe6a35eb11',codec:'d8b5bc42e4032e00066d4aa5dfb4b6f1d7fd7cb6aeda8785a1aa608e0c748ed1',crypto:'dd21d8390ce30f8935678d136d4086511e4f3b98a035c9c793166524d187449b','wasi-demo':'33e2bcd61a5b5d033c8de2fc1f9369a9f5e0b7190a793fc5d286a1aa15dc9736'};
for(const [crate,expected] of Object.entries(expectedWasm))for(const directory of crate==='wasi-demo'?['pkg']:['pkg','pkg-node']){
  const file=join(source,`packages/${crate}/${directory}/${crate==='wasi-demo'?'wasi_demo':`vivari_${crate}`}${crate==='wasi-demo'?'':'_bg'}.wasm`);
  if(!existsSync(file)||hashFile(file)!==expected)throw Error('Checkpoint documented native hash mismatch: '+file);
}
// Build only JS/declarations from the verified clean source. Native artifacts
// were checked above; this does not invoke unavailable wasm-pack or npm ci.
const build=Bun.spawnSync(['bun','run','--cwd','packages/core','build'],{cwd:source,stdout:'inherit',stderr:'inherit'});
if(build.exitCode)throw Error('Checkpoint core JS/declaration build failed');
const dist=join(source,'packages/core/dist');
if(!existsSync(join(dist,'index.js')))throw Error('Core build did not emit index.js');
mkdirSync(join(dist,'assets'),{recursive:true});
copyFileSync(join(source,'LICENSE'),join(dist,'assets/LICENSE.vivari.txt'));
copyFileSync(join(integrationRoot,'LICENSE.sqlite-wasm'),join(dist,'assets/LICENSE.sqlite-wasm.txt'));
const sourceFiles=fileManifest(source,list(source));
const receipt={schema:2,mode:'fork',revision,expectedRevision:revision,release:false,builtAt:new Date().toISOString(),license:'MIT',
  source:{path:source,repository:runtimeConfig.repository,origin:git(source,'remote','get-url','origin'),commit:revision,dirty:false,status:'',fingerprint:fingerprint(sourceFiles),diffSha256:sha256(git(source,'diff','--binary','HEAD')),files:sourceFiles},
  upstream:{repository:runtimeConfig.upstream,baseRevision:runtimeConfig.upstreamBase},
  toolchain:{bun:Bun.version,nativeBuild:'not rerun; wasm-pack unavailable',jsBuild:'bun run --cwd packages/core build'},
  sqlite:{package:'@sqlite.org/sqlite-wasm',version:'3.49.1-build1',engine:'3.49.1',license:'Apache-2.0 (package); public domain (SQLite)'},
  npmLockSha256:hashFile(join(source,'package-lock.json')),patches:[],locks:sourceFiles.filter(file=>/(?:^|\/)(?:bun.lockb?|package-lock.json|Cargo.lock)$/.test(file.name)),
  native:{rebuilt:false,reuse:{path:donor,commit:donorRevision,inputs:sourceNative,inputsFingerprint:fingerprint(sourceNative),documentation:'docs/single-kernel-build.md'},outputs},
  assets:fileManifest(dist,treeFiles(dist)).map(file=>({...file,retained:false})),
};
if(git(source,'rev-parse','HEAD')!==revision||git(source,'status','--porcelain'))throw Error('Checkpoint changed during receipt');
mkdirSync(join(integrationRoot,'.runtime'),{recursive:true});
writeFileSync(join(integrationRoot,'.runtime/patched-build.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({source,revision,donor,donorRevision,nativeOutputs:outputs.length,assets:receipt.assets.length}));
