import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
const stage = resolve(process.argv[2]!), output = process.argv[3] && resolve(process.argv[3]);
const receipt = await Bun.file(join(stage, 'receipt.json')).json();
async function verify(directory: string) {
  for (const [file, digest] of Object.entries(receipt.hashes)) {
    if (file.startsWith('/') || file.split('/').includes('..')) throw Error('Unsafe receipt path');
    if (new Bun.CryptoHasher('sha256').update(await Bun.file(join(directory, file)).arrayBuffer()).digest('hex') !== digest) throw Error('Artifact mismatch: ' + file);
  }
}
await verify(stage);
if (output) {
  if (output === stage || output.startsWith(stage + '/')) throw Error('Require separate nonexisting output');
  await mkdir(output);
  for (const file of Object.keys(receipt.hashes)) { await mkdir(dirname(join(output, file)), { recursive: true }); await cp(join(stage, file), join(output, file), { force: false, errorOnExist: true }); }
  await cp(join(stage, 'receipt.json'), join(output, 'receipt.json'), { force: false, errorOnExist: true });
  await verify(output);
}
console.log(JSON.stringify({ verifiedFiles: Object.keys(receipt.hashes).length, output: output ?? stage, receiptSha256: new Bun.CryptoHasher('sha256').update(await Bun.file(join(stage, 'receipt.json')).arrayBuffer()).digest('hex'), executed: false }));
