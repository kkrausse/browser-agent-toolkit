import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dir, '../../.runtime/opencode-release-2.0.3');
const outputDirectory = resolve(root, '.runtime/opencode-bun-server');
const sourceIntegrity = 'sha512-XlUL8p9fpW9FEssTY5aWS0qpcrDb1pV3dEbu6lU8KOgCIt6/gHwAKibEz4XPYf978vSRrvYGjreHIv0loA7fTg==';
const lock = Bun.JSONC.parse(await Bun.file(resolve(import.meta.dir, 'bun.lock')).text());
const serverPackage = lock.packages['@opencode/server'];
if (serverPackage?.[0] !== '@opencode/server@2.0.3' || serverPackage.at(-1) !== sourceIntegrity) throw Error('Published server lock identity mismatch');
await mkdir(outputDirectory, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'server.ts')],
  target: 'node', outdir: outputDirectory,
  plugins: [{
    name: 'published-jsonc-esm-entry',
    setup(build) {
      build.onResolve({ filter: /^jsonc-parser$/ }, args => {
        const main = createRequire(args.importer).resolve('jsonc-parser');
        return { path: resolve(dirname(main), '../esm/main.js') };
      });
    },
  }],
});
if (!result.success) throw new AggregateError(result.logs, 'OpenCode release build failed');
const requireServer = createRequire(import.meta.resolve('@opencode/server/process'));
const requireCore = createRequire(requireServer.resolve('@opencode/core/package.json'));
const assetCopies = [];
for (const [pkg, file] of [
  ['web-tree-sitter', 'tree-sitter.wasm'],
  ['tree-sitter-bash', 'tree-sitter-bash.wasm'],
  ['tree-sitter-powershell', 'tree-sitter-powershell.wasm'],
]) {
  const source = requireCore.resolve(`${pkg}/${file}`);
  await Bun.write(resolve(outputDirectory, file), Bun.file(source));
  assetCopies.push({ source, file });
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const outputs = Object.fromEntries(await Promise.all((await readdir(outputDirectory)).sort().map(async file => {
  const bytes = await readFile(resolve(outputDirectory, file));
  return [file, { bytes: bytes.length, sha256: hash(bytes) }];
})));
const recipe = Object.fromEntries(await Promise.all(['package.json', 'bun.lock', 'server.ts', 'build.ts'].map(async file =>
  [file, hash(await readFile(resolve(import.meta.dir, file)))])));
const receipt = {
  result: 'BUILD_PASS', exitCode: 0,
  sourceRevision: 'd44b52ca66b6bf69626c0384626d1a9cd9555977',
  source: { kind: 'published-packages', package: '@opencode/server', version: '2.0.3', integrity: sourceIntegrity,
    revisionMeaning: 'upstream v2.0.3 tag; installed inputs are the registry archives recorded in bun.lock' },
  builder: { version: Bun.version, revision: Bun.revision },
  recipe, outputs, assetCopies,
  policy: 'Node-target Bun bundle, existing published jsonc-parser ESM selection, original tree-sitter asset copies; no source or output rewrites',
};
const path = resolve(root, 'build-receipt.json');
for (const file of Object.keys(recipe)) await Bun.write(resolve(root, 'recipe', file), Bun.file(resolve(import.meta.dir, file)));
await Bun.write(path, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ root, receiptSha256: hash(await readFile(path)), ...receipt }, null, 2));
