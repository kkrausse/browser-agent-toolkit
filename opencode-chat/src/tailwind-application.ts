/** Host-only verification for an explicitly selected, source-pinned Tailwind backend. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import pin from './tailwind-wasm-candidate.json';

type CandidateFile = { path: string; bytes: number; sha256: string };
type CandidateReceipt = {
  schema: number;
  kind: string;
  id: string;
  source: { repository: string; revision: string; tree: string; upstreamBase: string; pullRequest: string; dirty: boolean };
  recipe: { pinSha256: string; scriptSha256: string };
  package: {
    name: string; version: string; path: string; registryArtifact: boolean;
    metadata: Record<string, unknown>; metadataSha256: string;
    originalMetadataPath: string; originalMetadataSha256: string;
    files: CandidateFile[]; manifestSha256: string; wasmSha256: string;
    tarball: string; tarballSha256: string;
  };
  verification: { sameInstanceNativeParity: boolean; checkpoints: number; browserHmrAccepted: boolean };
};
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Caller supplies the receipt digest explicitly (e.g. from a selected current.json).
 * Returns a package root suitable for a generic dependency override. Never installs,
 * mutates metadata, chooses a global default, or substitutes the oxide entry package.
 */
export function readTailwindWasmCandidate(receiptPath: string, expectedReceiptSha256: string) {
  assert(/^[a-f0-9]{64}$/.test(expectedReceiptSha256), 'Expected an explicit candidate receipt SHA-256');
  const receiptFile = resolve(receiptPath);
  const bytes = readFileSync(receiptFile);
  assert.equal(sha256(bytes), expectedReceiptSha256, 'Candidate receipt hash mismatch');
  const receipt = JSON.parse(bytes.toString()) as CandidateReceipt;
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.kind, 'tailwind-wasm-source-candidate');
  assert.equal(receipt.id, pin.id);
  for (const key of ['repository', 'revision', 'tree', 'upstreamBase', 'pullRequest'] as const) assert.equal(receipt.source[key], pin[key], `Candidate source ${key} does not match immutable pin`);
  assert.equal(receipt.source.dirty, false);
  // The canonical pin is bundled with the host helper. Installed consumers do
  // not carry the integration checkout's vivari/ directory beside their package.
  assert.equal(receipt.recipe.pinSha256, sha256(JSON.stringify(pin, null, 2) + '\n'), 'Candidate pin file changed');
  assert.equal(receipt.verification.sameInstanceNativeParity, true);
  assert.equal(receipt.verification.checkpoints, 8);
  const pkg = receipt.package;
  assert.equal(pkg.name, pin.packageName);
  assert.equal(pkg.version, pin.packageVersion);
  assert.equal(pkg.registryArtifact, false, 'Source candidate must not masquerade as registry bytes');
  assert.equal(pkg.path, 'package');
  assert.equal(pkg.originalMetadataPath, 'evidence/original-package.json');
  const packageRoot = join(dirname(receiptFile), pkg.path);
  assert(lstatSync(packageRoot).isDirectory() && !lstatSync(packageRoot).isSymbolicLink());
  function files(prefix = ''): CandidateFile[] {
    return readdirSync(join(packageRoot, prefix)).sort().flatMap(name => {
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(packageRoot, path), stat = lstatSync(full);
      if (stat.isDirectory()) return files(path);
      assert(stat.isFile(), `Candidate package contains non-file ${path}`);
      return [{ path, bytes: stat.size, sha256: sha256(readFileSync(full)) }];
    });
  }
  const actualFiles = files();
  assert.deepEqual(actualFiles, pkg.files, 'Candidate package bytes or file inventory changed');
  assert.equal(sha256(JSON.stringify(actualFiles)), pkg.manifestSha256, 'Candidate manifest hash mismatch');
  const metadataBytes = readFileSync(join(packageRoot, 'package.json'));
  assert.equal(sha256(metadataBytes), pkg.metadataSha256);
  const metadata = JSON.parse(metadataBytes.toString());
  assert.deepEqual(metadata, pkg.metadata);
  assert.equal(metadata.name, pkg.name);
  assert.equal(metadata.version, pkg.version);
  const original = readFileSync(join(dirname(receiptFile), pkg.originalMetadataPath));
  assert.equal(sha256(original), pkg.originalMetadataSha256);
  assert.deepEqual(metadata, JSON.parse(original.toString()), 'Candidate rewrote original upstream metadata');
  assert.equal(sha256(readFileSync(join(packageRoot, 'tailwindcss-oxide.wasm32-wasi.wasm'))), pkg.wasmSha256);
  assert.equal(pkg.tarball, 'package.tgz');
  const archivePath = join(dirname(receiptFile), pkg.tarball);
  assert(lstatSync(archivePath).isFile() && !lstatSync(archivePath).isSymbolicLink(), 'Candidate archive must be a regular file');
  const archiveBytes = readFileSync(archivePath);
  assert.equal(sha256(archiveBytes), pkg.tarballSha256, 'Candidate archive hash mismatch');
  return {
    id: receipt.id,
    packageName: pkg.name,
    packageVersion: pkg.version,
    packageRoot,
    receiptPath: receiptFile,
    receiptSha256: expectedReceiptSha256,
    source: receipt.source,
    packageManifestSha256: pkg.manifestSha256,
    wasmSha256: pkg.wasmSha256,
    files: actualFiles,
    metadata,
    archive: { path: archivePath, sha256: pkg.tarballSha256, sha512: 'sha512-' + createHash('sha512').update(archiveBytes).digest('base64') },
    // Browser acceptance belongs to the embedding's later HMR gate.
    scannerNativeParity: true as const,
  };
}
