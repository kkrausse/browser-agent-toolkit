import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

export interface ApplicationOutput { bytes: number; sha256: string }
export interface ApplicationContract {
  id: string;
  receiptSha256: string;
  sourceRevision: string;
  publishedPackage?: { name: string; version: string; integrity: string };
  outputs: Record<string, ApplicationOutput>;
}

/** Qualification identity, not a general OpenCode release pin or a rebuild recipe. */
export const qualifiedOpenCodeCandidate = {
  id: 'opencode-server-process-2.0.3',
  receiptSha256: 'df6a3d88f014f95c1dd5957a06c6e3baa3ca4d4dd45ca4be5ea88d6518627813',
  sourceRevision: 'd44b52ca66b6bf69626c0384626d1a9cd9555977',
  publishedPackage: { name: '@opencode/server', version: '2.0.3', integrity: 'sha512-XlUL8p9fpW9FEssTY5aWS0qpcrDb1pV3dEbu6lU8KOgCIt6/gHwAKibEz4XPYf978vSRrvYGjreHIv0loA7fTg==' },
  outputs: {
    'ffi-rs.darwin-arm64-xwnmxr1d.node': { bytes: 721896, sha256: '50158069dfc4fcef50af699b84f41b746eeeda076b43950c51828e1eb62f9bc7' },
    'server.js': { bytes: 27721709, sha256: '1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929' },
    'tree-sitter-bash.wasm': { bytes: 1380769, sha256: '364f0a2cd385c792239423026ef442dbd073d34c396b7bc9e5932426b8e4aa5d' },
    'tree-sitter-powershell.wasm': { bytes: 983236, sha256: '1d30b5a21866354aa2eb94845556f1e19126ff00e3335048719a0e6435b1c154' },
    'tree-sitter.wasm': { bytes: 205488, sha256: 'f38dcc4b43b818f9a0785bc1c6d5611a75ac4cdd428ff3f02757c34ca4e46d7f' },
  },
} as const satisfies ApplicationContract;

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Generic supporting verifier. Trust comes from the caller's independent contract. */
export async function verifyApplicationDelivery(options: {
  receiptPath: string; outputDirectory: string; guestDirectory: string; contract: ApplicationContract;
}) {
  const { contract } = options;
  if (!/^\/(?:[\w.-]+\/)*[\w.-]+$/.test(options.guestDirectory)
    || options.guestDirectory.split('/').some(p => p === '.' || p === '..')) throw Error('Invalid application guest directory');
  const receiptBytes = await readFile(resolve(options.receiptPath));
  if (hash(receiptBytes) !== contract.receiptSha256) throw Error('Application receipt integrity failure');
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  const inputMatches = contract.publishedPackage
    ? receipt.source?.kind === 'published-packages'
      && receipt.source.package === contract.publishedPackage.name
      && receipt.source.version === contract.publishedPackage.version
      && receipt.source.integrity === contract.publishedPackage.integrity
      && /^[a-f0-9]{64}$/.test(receipt.recipe?.['bun.lock'] ?? '')
    : receipt.sourceStatus === '';
  if (receipt.result !== 'BUILD_PASS' || receipt.exitCode !== 0 || !inputMatches
    || receipt.sourceRevision !== contract.sourceRevision || !receipt.outputs
    || Object.keys(receipt.outputs).length !== Object.keys(contract.outputs).length) throw Error('Application receipt contract mismatch');
  const assets = await Promise.all(Object.entries(contract.outputs).map(async ([file, expected]) => {
    if (!/^[\w.-]+$/.test(file) || file === '.' || file === '..'
      || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw Error('Invalid application output contract');
    const recorded = receipt.outputs[file];
    if (recorded?.bytes !== expected.bytes || recorded?.sha256 !== expected.sha256) throw Error(`Application receipt output mismatch: ${file}`);
    const bytes = await readFile(join(resolve(options.outputDirectory), file));
    if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw Error(`Application output integrity failure: ${file}`);
    // Return the verified bytes, avoiding a second host read between checking and packaging.
    return { file, destination: options.guestDirectory + '/' + file, bytes, sha256: expected.sha256, length: expected.bytes };
  }));
  return { provenance: { id: contract.id, receiptSha256: contract.receiptSha256, sourceRevision: contract.sourceRevision }, receiptBytes, assets };
}

/** Retained-root defaults; relocated archives may supply explicit receipt/output paths. */
export function readQualifiedOpenCodeApplication(root: string, paths: { receiptPath?: string; outputDirectory?: string } = {}) {
  return verifyApplicationDelivery({
    receiptPath: paths.receiptPath ?? join(root, 'build-receipt.json'),
    outputDirectory: paths.outputDirectory ?? join(root, '.runtime/opencode-bun-server'),
    guestDirectory: '/app', contract: qualifiedOpenCodeCandidate,
  });
}
