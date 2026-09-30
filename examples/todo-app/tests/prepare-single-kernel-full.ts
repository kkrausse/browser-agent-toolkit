import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {assetHash} from '../../../workspace-api/scripts/runtime-assets';

const revision='e35eab4af7a53ff08eb70c09df59c40b78bfdd67';
export function frozenFile(output:string,file:string){
  if(!file||file.startsWith('/')||file.split('/').some(part=>part==='..'||part==='.'||!part)||file==='receipt.json')throw Error('Unsafe frozen artifact path: '+file);
  return join(output,file);
}
// New harness receipt, not a relabelled historical receipt. All consumer,
// dependency, library, license and runtime bytes remain exactly as prepared.
export async function prepareFull(inputPath:string,outputPath:string){
  const input=resolve(inputPath),output=resolve(outputPath);
  if(output===input||output.startsWith(input+'/')||input.startsWith(output+'/'))throw Error('Require separate new output');
  const sourceBytes=await readFile(join(input,'receipt.json'));
  const sourceReceipt=JSON.parse(sourceBytes.toString());
  if(sourceReceipt.revision!==revision||sourceReceipt.offline||!sourceReceipt.prepared||sourceReceipt.remainingOnly||sourceReceipt.topology?.policy!=='single-kernel'||!sourceReceipt.version||!Object.keys(sourceReceipt.hashes??{}).length)throw Error('Require frozen full e35 app preparation');
  for(const [file,hash] of Object.entries(sourceReceipt.hashes))if(assetHash(await readFile(frozenFile(input,file)))!==hash)throw Error('Frozen artifact mismatch: '+file);
  await mkdir(output); // Exclusive: never overwrite old origins or receipts.
  for(const file of Object.keys(sourceReceipt.hashes)){
    const target=frozenFile(output,file);await mkdir(dirname(target),{recursive:true});await cp(frozenFile(input,file),target,{force:false,errorOnExist:true});
    if(assetHash(await readFile(target))!==sourceReceipt.hashes[file])throw Error('Copied artifact mismatch: '+file);
  }
  const provenanceFile='full-source-receipt.json';
  await writeFile(join(output,provenanceFile),sourceBytes,{flag:'wx'});
  const driverSources:Record<string,string>={};
  for(const file of ['single-kernel-driver.ts','matched-pair-driver.ts','matched-readiness.ts','prepare-single-kernel-full.ts','serve-single-kernel.ts'])driverSources['examples/todo-app/tests/'+file]=assetHash(await readFile(join(import.meta.dir,file)));
  const hashes={...sourceReceipt.hashes,[provenanceFile]:assetHash(sourceBytes)};
  const receipt={output,runtimeSource:sourceReceipt.runtimeSource,revision,offline:false,version:sourceReceipt.version,topology:sourceReceipt.topology,prepared:true,fullConsumerCopy:true,
    provenance:{input,receiptFile:provenanceFile,receiptSha256:assetHash(sourceBytes),sourceDriverSources:sourceReceipt.driverSources,verifiedArtifacts:Object.keys(sourceReceipt.hashes).length,consumerBuilds:0,runtimeBuilds:0},hashes,driverSources,liveRuns:0,models:0};
  await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
  return receipt;
}
if(import.meta.main){
  if(process.argv.length!==4)throw Error('Usage: prepare-single-kernel-full.ts <frozen-full-e35-output> <new-output>');
  const receipt=await prepareFull(process.argv[2]!,process.argv[3]!);console.log(receipt.output);
}
