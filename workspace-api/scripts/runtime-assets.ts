import { posix } from 'node:path';
import { createHash } from 'node:crypto';

export interface ReceiptedAsset { name: string; sha256: string; retained?: boolean }
export const assetHash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Traverse actual emitted JS references, not old retained worker filenames. */
export async function inspectRuntimeAssets(assets: ReceiptedAsset[], read: (name: string) => Promise<Uint8Array>, singleKernel = false) {
  const names = new Set<string>();
  for (const asset of assets) {
    if (asset.name.startsWith('/') || asset.name.includes('\\') || posix.normalize(asset.name) !== asset.name || asset.name.startsWith('../') || names.has(asset.name)) throw Error('Unsafe/duplicate runtime asset: ' + asset.name);
    names.add(asset.name);
    if (assetHash(await read(asset.name)) !== asset.sha256) throw Error('Runtime differs from its build receipt: ' + asset.name);
  }
  const active = new Set<string>();
  const visit = async (name: string): Promise<void> => {
    if (active.has(name)) return;
    if (!names.has(name)) throw Error('Unreceipted active runtime asset: ' + name);
    if (assets.find(asset => asset.name === name)?.retained) throw Error('Active runtime references retained output: ' + name);
    active.add(name);
    if (!name.endsWith('.js')) return;
    const text = new TextDecoder().decode(await read(name));
    // Vite emits literal new-URL references and chunk imports. Do not scan all
    // strings: guest loader code also contains non-asset relative JS filenames.
    const references = [
      ...text.matchAll(/\bnew\s+URL\(\s*["'`]([^"'`\s]+\.(?:js|wasm))["'`]/g),
      ...text.matchAll(/\b(?:import|export)\s+(?:[^;\n]*?\sfrom\s*)?["']([^"'\s]+\.js)["']/g),
      ...text.matchAll(/\bimport\(\s*["']([^"'\s]+\.js)["']/g),
    ];
    for (const match of references) {
      const reference = match[1]!;
      if (/^[a-z]+:/.test(reference)) continue;
      const target = posix.normalize(posix.join(posix.dirname(name), reference));
      if (!/^(?:\.\.?\/|\/?assets\/)/.test(reference) && !names.has(target) && !/^[\w-]*worker-[\w-]+\.js$/.test(reference)) continue;
      if (reference.startsWith('/assets/')) throw Error('Runtime assets are root-absolute: ' + reference);
      await visit(target);
    }
  };
  await visit('index.js');
  const workers = [...active].filter(name => /(?:^|\/)[\w-]*worker[\w-]*\.js$/.test(name));
  const role = (name: string) => /kernel-worker/.test(name) ? 'kernel' : /process-worker/.test(name) ? 'process' : /(?:fs|filesystem)-worker/.test(name) ? 'filesystem' : /http.*worker/.test(name) ? 'http' : 'unknown';
  const workerAssets = workers.map(name => ({name, role: role(name), sha256: assets.find(asset => asset.name === name)!.sha256}));
  const kernels = workerAssets.filter(asset => asset.role === 'kernel');
  if (kernels.length !== 1) throw Error('Expected exactly one active kernel worker asset');
  if (singleKernel && (workerAssets.some(asset => !['kernel', 'process'].includes(asset.role)) || !workerAssets.some(asset => asset.role === 'process'))) throw Error('Single-kernel distribution requires only kernel and guest-process worker assets: ' + JSON.stringify(workerAssets));
  return {kernelWorker: kernels[0]!.name, topology: {policy: singleKernel ? 'single-kernel' : 'unrestricted', activeAssets: [...active].sort(), workerAssets}};
}
