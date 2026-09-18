import type { PreparedEntry } from './package-tree';
import { createDiagnosticScope } from '@kev-browser-agent-kit/workspace/diagnostics';

export interface PreparedBundle { file: string; bytes: number; sha256: string }
export const preparedBundleCache = 'browser-editor-prepared-bundles-v1';

/** Unique content, in manifest order; paths and metadata remain in the manifest. */
export function bundleFiles(entries: PreparedEntry[]) {
  const seen = new Set<string>();
  return entries.filter((entry): entry is Extract<PreparedEntry, { kind: 'file' }> => {
    if (entry.kind !== 'file' || seen.has(entry.file)) return false;
    seen.add(entry.file);
    return true;
  });
}

export async function readPreparedBundle(bundle: PreparedBundle, entries: PreparedEntry[], base: string, signal: AbortSignal, report: (text: string) => void = () => {}, diagnostics = createDiagnosticScope()) {
  if (!/^[a-f0-9]{64}$/.test(bundle.sha256) || bundle.file !== bundle.sha256 + '.bundle.gz'
    || !Number.isSafeInteger(bundle.bytes) || bundle.bytes < 0) throw Error('Invalid prepared bundle');
  signal.throwIfAborted();
  const url = base + bundle.file;
  async function verified(bytes: Uint8Array<ArrayBuffer>) {
    if (bytes.length !== bundle.bytes) return false;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    return hash === bundle.sha256;
  }
  let cache: Cache | undefined, compressed: Uint8Array<ArrayBuffer> | undefined;
  // CacheStorage is an optimization: quota/private-mode failures must not prevent startup.
  await diagnostics.stage('bundle.cache', async () => { try {
    if (typeof caches !== 'undefined') {
      cache = await caches.open(preparedBundleCache);
      const response = await cache.match(url);
      if (response) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (await verified(bytes)) compressed = bytes;
        else await cache.delete(url);
      }
    }
  } catch (error) { diagnostics.record('bundle.cache.unavailable', { error }); }
  });
  diagnostics.record('bundle.cache.result', { hit: !!compressed, compressedBytes: bundle.bytes });
  signal.throwIfAborted();
  if (compressed) report('Using cached prepared workspace bundle');
  else {
    report('Downloading prepared workspace bundle…');
    compressed = await diagnostics.stage('bundle.download', async () => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw Error(`Prepared bundle HTTP ${response.status}`);
    const downloaded = new Uint8Array(await response.arrayBuffer());
    if (!await verified(downloaded)) throw Error('Prepared bundle integrity failure');
    return downloaded;
    }, { compressedBytes: bundle.bytes });
    signal.throwIfAborted();
    if (cache) {
      try {
        await cache.put(url, new Response(compressed, { headers: { 'Content-Type': 'application/gzip' } }));
        // Retain one original bundle per preparation URL, not every historical build.
        const current = new URL(url, location.href).href, prefix = current.slice(0, current.lastIndexOf('/') + 1);
        for (const request of await cache.keys()) if (request.url.startsWith(prefix) && request.url !== current) await cache.delete(request);
      } catch { /* The verified download is usable even if caching fails. */ }
    }
  }
  signal.throwIfAborted();
  report('Unpacking prepared workspace bundle…');
  const bytes = await diagnostics.stage('bundle.decompress', async () => new Uint8Array(await new Response(new Blob([compressed!]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()));
  diagnostics.record('bundle.size', { compressedBytes: bundle.bytes, expandedBytes: bytes.length });
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  let offset = 0;
  for (const entry of bundleFiles(entries)) {
    files.set(entry.file, bytes.subarray(offset, offset + entry.bytes));
    offset += entry.bytes;
  }
  if (offset !== bytes.length) throw Error('Prepared bundle size mismatch');
  return files;
}
