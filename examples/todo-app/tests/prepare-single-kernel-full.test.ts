import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assetHash} from '../../../workspace-api/scripts/runtime-assets';
import {frozenFile,prepareFull} from './prepare-single-kernel-full';
import {acceptanceLock} from './single-kernel-driver';

test('fresh full preparation verifies bytes, retains old provenance and receipts current drivers',async()=>{
  const input=await mkdtemp(join(tmpdir(),'full-preparation-')),output=input+'-copy';
  try{
    const payload=Buffer.from('immutable runtime and consumer');await writeFile(join(input,'client.js'),payload);
    const source={revision:'e35eab4af7a53ff08eb70c09df59c40b78bfdd67',offline:false,prepared:true,version:'frozen',topology:{policy:'single-kernel'},hashes:{'client.js':assetHash(payload)},driverSources:{historical:'old-hash'}};
    const bytes=JSON.stringify(source);await writeFile(join(input,'receipt.json'),bytes);
    const receipt=await prepareFull(input,output);
    expect(await readFile(join(output,'client.js'))).toEqual(payload);
    expect(await readFile(join(output,'full-source-receipt.json'),'utf8')).toBe(bytes);
    expect(receipt.provenance.sourceDriverSources).toEqual(source.driverSources);
    expect(receipt.provenance.receiptSha256).toBe(assetHash(Buffer.from(bytes)));
    expect(receipt.driverSources['examples/todo-app/tests/single-kernel-driver.ts']).toBe(assetHash(await readFile(join(import.meta.dir,'single-kernel-driver.ts'))));
    expect(receipt.provenance.runtimeBuilds).toBe(0);expect(receipt.provenance.consumerBuilds).toBe(0);
    await expect(prepareFull(input,output)).rejects.toThrow();
    await writeFile(join(input,'client.js'),'changed');await expect(prepareFull(input,output+'-bad')).rejects.toThrow('Frozen artifact mismatch');
    expect(await Bun.file(join(input,'receipt.json')).text()).toBe(bytes);
  }finally{await rm(input,{recursive:true,force:true});await rm(output,{recursive:true,force:true});}
});
test('frozen paths and cohort locks cannot escape or reuse historical ownership',()=>{
  for(const file of ['../old','/old','a/../b','a//b','receipt.json'])expect(()=>frozenFile('/new',file)).toThrow();
  expect(acceptanceLock('/new/evidence')).toBe('/new/evidence.lock');
  expect(acceptanceLock('/new/other')).not.toBe(acceptanceLock('/new/evidence'));
});
