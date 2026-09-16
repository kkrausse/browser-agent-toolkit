import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pin from '../src/tailwind-wasm-candidate.json';
import { readTailwindWasmCandidate } from '../src/tailwind-application';

const roots: string[] = [];
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const temp = join(realpathSync(tmpdir()), 'opencode');
  mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, 'tailwind-receipt-test-'));
  roots.push(root);
  mkdirSync(join(root, 'package'));
  mkdirSync(join(root, 'evidence'));
  const metadata = { name: pin.packageName, version: pin.packageVersion, dependencies: {} };
  const metadataBytes = JSON.stringify(metadata) + '\n';
  const wasmBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  writeFileSync(join(root, 'package/package.json'), metadataBytes);
  writeFileSync(join(root, 'evidence/original-package.json'), metadataBytes);
  writeFileSync(join(root, 'package/tailwindcss-oxide.wasm32-wasi.wasm'), wasmBytes);
  const archiveBytes = 'fixture archive identity';
  writeFileSync(join(root, 'package.tgz'), archiveBytes);
  const files = [
    { path: 'package.json', bytes: Buffer.byteLength(metadataBytes), sha256: sha(metadataBytes) },
    { path: 'tailwindcss-oxide.wasm32-wasi.wasm', bytes: wasmBytes.length, sha256: sha(wasmBytes) },
  ];
  const receipt = {
    schema: 1, kind: 'tailwind-wasm-source-candidate', id: pin.id,
    source: { repository: pin.repository, revision: pin.revision, tree: pin.tree, upstreamBase: pin.upstreamBase, pullRequest: pin.pullRequest, dirty: false },
    recipe: { pinSha256: sha(readFileSync(new URL('../src/tailwind-wasm-candidate.json', import.meta.url))), scriptSha256: '0'.repeat(64) },
    package: { name: pin.packageName, version: pin.packageVersion, path: 'package', registryArtifact: false, metadata, metadataSha256: sha(metadataBytes), originalMetadataPath: 'evidence/original-package.json', originalMetadataSha256: sha(metadataBytes), files, manifestSha256: sha(JSON.stringify(files)), wasmSha256: sha(wasmBytes), tarball: 'package.tgz', tarballSha256: sha(archiveBytes) },
    verification: { sameInstanceNativeParity: true, checkpoints: 8, browserHmrAccepted: false },
  };
  const path = join(root, 'receipt.json');
  const save = () => { const bytes = JSON.stringify(receipt); writeFileSync(path, bytes); return sha(bytes); };
  return { root, receipt, path, save, digest: save() };
}

test('explicit candidate exposes only the backend package root and immutable provenance', () => {
  const f = fixture();
  const candidate = readTailwindWasmCandidate(f.path, f.digest);
  expect(candidate.packageName).toBe('@tailwindcss/oxide-wasm32-wasi');
  expect(candidate.packageRoot).toBe(join(f.root, 'package'));
  expect(candidate.source.revision).toBe(pin.revision);
  expect(candidate.receiptSha256).toBe(f.digest);
  expect(candidate).not.toHaveProperty('browserHmrAccepted');
});

test('bundled host verifier works outside the integration source layout', async () => {
  const f = fixture();
  const built = await Bun.build({ entrypoints: [new URL('../src/tailwind-application.ts', import.meta.url).pathname],
    target: 'bun', outdir: join(f.root, 'consumer'), naming: 'candidate.mjs' });
  expect(built.success).toBe(true);
  const installed = await import(join(f.root, 'consumer/candidate.mjs'));
  const candidate = installed.readTailwindWasmCandidate(f.path, f.digest);
  expect(candidate.source.revision).toBe(pin.revision);
  expect(candidate.receiptSha256).toBe(f.digest);
});

test('rejects a receipt that does not match the caller-selected digest', () => {
  const f = fixture();
  f.receipt.verification.sameInstanceNativeParity = false;
  f.save();
  expect(() => readTailwindWasmCandidate(f.path, f.digest)).toThrow('receipt hash mismatch');
});

test('rejects a different source revision even with its correct receipt digest', () => {
  const f = fixture();
  f.receipt.source.revision = '0'.repeat(40);
  expect(() => readTailwindWasmCandidate(f.path, f.save())).toThrow('immutable pin');
});

test('rejects swapped binary bytes and undeclared additional package files', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'package/tailwindcss-oxide.wasm32-wasi.wasm'), 'registry or other binary');
  expect(() => readTailwindWasmCandidate(f.path, f.digest)).toThrow('bytes or file inventory changed');
  const other = fixture();
  writeFileSync(join(other.root, 'package/extra.cjs'), 'unrecorded');
  expect(() => readTailwindWasmCandidate(other.path, other.digest)).toThrow('bytes or file inventory changed');
});

test('rejects symlink substitution and metadata rewriting', () => {
  const f = fixture();
  rmSync(join(f.root, 'package/package.json'));
  symlinkSync('../evidence/original-package.json', join(f.root, 'package/package.json'));
  expect(() => readTailwindWasmCandidate(f.path, f.digest)).toThrow('non-file');
  const other = fixture();
  writeFileSync(join(other.root, 'evidence/original-package.json'), '{"rewritten":true}');
  expect(() => readTailwindWasmCandidate(other.path, other.digest)).toThrow();
});

test('rejects a replaced candidate tarball before exposing its integrity to the installer', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'package.tgz'), 'other archive');
  expect(() => readTailwindWasmCandidate(f.path, f.digest)).toThrow('Candidate archive hash mismatch');
});
