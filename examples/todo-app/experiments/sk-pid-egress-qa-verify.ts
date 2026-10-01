import {cp, mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';

// Offline qualification gate only. Does not start a host, browser or guest.
const input='/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/kernel-egress-repair-3GsF7d';
const provenance='/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean';
const runtimeRevision='33fa1359a003ca9c50cb3bc49699b99bc1a063f1';
const toolkitRevision='d0eec346dbc749db1c0cd82dd8aad0b27c1da363';
const version='3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62';
const hash=async(path:string)=>new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
const assert=(ok:unknown,message:string)=>{if(!ok)throw Error(message);};
const verify=async(path:string,expected:string)=>assert(await hash(path)===expected,'Byte mismatch: '+path);
const receipt=await Bun.file(join(input,'candidate-receipt.json')).json();
const final=await Bun.file(join(input,'final-provenance.json')).json();
const manifest=await Bun.file(join(input,'toolkit-source/vivari/.runtime/patched-build.json')).json();
const distribution=await Bun.file(join(input,'candidate/runtime/distribution.json')).json();
assert(receipt.runtimeRevision===runtimeRevision&&receipt.toolkitRevision===toolkitRevision&&receipt.version===version,'Candidate identity');
assert(receipt.nativeRebuilt===false&&receipt.jsWorkerRebuilt===true&&receipt.liveQualification===false,'Qualification boundary');
assert(final.nativeRebuilt===false&&final.provenance===provenance,'Final provenance identity');
assert(manifest.revision===runtimeRevision&&manifest.source.commit===runtimeRevision&&manifest.native.rebuilt===false,'Build manifest identity');
assert(distribution.version===version&&distribution.runtimeBuild.revision===runtimeRevision&&distribution.topology.policy==='single-kernel','Distribution identity');
await verify(join(input,'runtime-source.tar'),receipt.runtimeArchiveSha256);
await verify(join(input,'toolkit-source.tar'),receipt.toolkitArchiveSha256);
for(const [file,digest] of Object.entries(receipt.hashes))await verify(join(input,'candidate',file),digest as string);
assert(Object.keys(receipt.hashes).length===final.candidateFilesVerified,'Candidate file count');
for(const file of manifest.source.files)await verify(join(input,'runtime-source',file.name),file.sha256);
for(const file of manifest.assets)await verify(join(input,'runtime-source/packages/core/dist',file.name),file.sha256);
for(const file of manifest.native.outputs){
 await verify(join(input,'runtime-source',file.name),file.sha256);
 await verify(join(provenance,file.name),file.sha256);
}
assert(manifest.native.outputs.length===final.nativeFilesVerified,'Native file count');
for(const file of distribution.topology.workerAssets)await verify(join(input,'candidate/runtime',file.name),file.sha256);
await verify(join(input,'candidate/runtime',distribution.kernelWorker),distribution.kernelSha256);
assert(JSON.stringify(distribution.runtimeBuild)===JSON.stringify(manifest),'Distribution build manifest differs');
const nativeDiff=Bun.spawn(['git','diff',manifest.native.matchingTrackedInputBaseline,runtimeRevision,'--','packages/vfs','packages/codec','packages/crypto','packages/wasi-demo','.cargo','Cargo.toml','Cargo.lock'],{cwd:'/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel',stdout:'pipe',stderr:'pipe'});
const [diff,error,exit]=await Promise.all([new Response(nativeDiff.stdout).text(),new Response(nativeDiff.stderr).text(),nativeDiff.exited]);
assert(exit===0&&diff==='','Native tracked inputs differ: '+error);
// A separate immutable-by-convention input snapshot; not a runnable QA consumer.
const stage=await mkdtemp('/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/sk-pid-egress-qa-prep-');
await cp(join(input,'candidate'),join(stage,'libraries-and-assets'),{recursive:true,errorOnExist:true});
for(const file of ['candidate-receipt.json','final-provenance.json','runtime-source.tar','toolkit-source.tar'])await cp(join(input,file),join(stage,file),{errorOnExist:true});
await cp(join(input,'toolkit-source/vivari/.runtime/patched-build.json'),join(stage,'patched-build.json'),{errorOnExist:true});
await cp(import.meta.path,join(stage,'sk-pid-egress-qa-verify.ts'),{errorOnExist:true});
for(const [file,digest] of Object.entries(receipt.hashes))await verify(join(stage,'libraries-and-assets',file),digest as string);
const hashes:Record<string,string>={};
for await(const file of new Bun.Glob('**/*').scan({cwd:stage,onlyFiles:true,dot:true}))hashes[file]=await hash(join(stage,file));
await Bun.write(join(stage,'verification.json'),JSON.stringify({status:'verified-inputs-prep-blocked-no-consumer-no-launch',runtimeRevision,toolkitRevision,version,input,provenance,candidateFilesVerified:Object.keys(receipt.hashes).length,sourceFilesVerified:manifest.source.files.length,builtAssetsVerified:manifest.assets.length,nativeFilesVerified:manifest.native.outputs.length,nativeTrackedInputsUnchanged:true,nativeRebuilt:false,browserRuns:0,headlessRuns:0,hostStarts:0,guestStarts:0,blocker:'Browser kernel uses native fetch with AbortSignal; no supported callback controls abort-ignoring backend/body or failed VFS rollback. Local HTTP hold is not ignored-abort ownership proof.',hashes},null,2)+'\n');
console.log(JSON.stringify({stage,verificationSha256:await hash(join(stage,'verification.json')),candidateFilesVerified:Object.keys(receipt.hashes).length,sourceFilesVerified:manifest.source.files.length,builtAssetsVerified:manifest.assets.length,nativeFilesVerified:manifest.native.outputs.length},null,2));
