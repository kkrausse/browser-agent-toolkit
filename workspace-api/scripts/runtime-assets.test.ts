import {expect, test} from 'bun:test';
import {assetHash, inspectRuntimeAssets} from './runtime-assets';

function fixture(fs = false) {
  const files: Record<string, string> = {
    'index.js': 'new Worker(new URL("assets/kernel-worker-new.js",import.meta.url))',
    'assets/kernel-worker-new.js': 'new Worker(new URL("./process-worker-new.js",import.meta.url))' + (fs ? ';new Worker(new URL("./fs-worker-new.js",import.meta.url))' : ''),
    'assets/process-worker-new.js': 'guest',
    'assets/fs-worker-old.js': 'retained old topology',
    ...(fs ? {'assets/fs-worker-new.js':'fs'} : {}),
  };
  const assets = Object.entries(files).map(([name, text]) => ({name, sha256:assetHash(text), retained:name.endsWith('old.js')}));
  return {files, assets, read:async(name: string) => new TextEncoder().encode(files[name]!)};
}
test('single kernel ignores retained unreachable FS worker; hashes remain verified', async () => {
  const f=fixture(); const result=await inspectRuntimeAssets(f.assets,f.read,true);
  expect(result.topology.workerAssets.map(asset=>asset.role).sort()).toEqual(['kernel','process']);
  f.files['assets/fs-worker-old.js']='tampered';
  await expect(inspectRuntimeAssets(f.assets,f.read,true)).rejects.toThrow('differs');
});
test('single kernel is the default and rejects a reachable FS worker; explicit unrestricted packaging permits it', async () => {
  const f=fixture(true);
  await expect(inspectRuntimeAssets(f.assets,f.read)).rejects.toThrow('Single-kernel');
  expect((await inspectRuntimeAssets(f.assets,f.read,false)).topology.workerAssets).toHaveLength(3);
});
test('unreceipted URLs, retained active assets and unsafe names fail closed', async () => {
  const f=fixture();
  await expect(inspectRuntimeAssets(f.assets.filter(a=>a.name!=='assets/process-worker-new.js'),f.read,true)).rejects.toThrow('Unreceipted');
  f.assets.find(a=>a.name==='assets/process-worker-new.js')!.retained=true;
  await expect(inspectRuntimeAssets(f.assets,f.read,true)).rejects.toThrow('retained');
  await expect(inspectRuntimeAssets([{name:'../escape.js',sha256:''}],f.read)).rejects.toThrow('Unsafe');
});
test('Vite bare worker URLs are followed relative to their owning bundle', async () => {
  const f=fixture();
  f.files['assets/kernel-worker-new.js']='new Worker(new URL("process-worker-new.js",import.meta.url))';
  f.assets.find(a=>a.name==='assets/kernel-worker-new.js')!.sha256=assetHash(f.files['assets/kernel-worker-new.js']!);
  expect((await inspectRuntimeAssets(f.assets,f.read,true)).topology.workerAssets).toHaveLength(2);
});
test('guest loader filename strings are not mistaken for emitted assets', async () => {
  const f=fixture();
  f.files['assets/kernel-worker-new.js']+=';const guestRelative="./guest-module.js";';
  f.assets.find(a=>a.name==='assets/kernel-worker-new.js')!.sha256=assetHash(f.files['assets/kernel-worker-new.js']!);
  expect((await inspectRuntimeAssets(f.assets,f.read,true)).topology.workerAssets).toHaveLength(2);
});
