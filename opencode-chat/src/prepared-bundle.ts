import type { PreparedEntry } from './package-tree';

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

export async function readPreparedBundle(bundle: PreparedBundle, entries: PreparedEntry[], base: string, signal: AbortSignal, report: (text: string) => void = () => {}) {
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
  try {
    if (typeof caches !== 'undefined') {
      cache = await caches.open(preparedBundleCache);
      const response = await cache.match(url);
      if (response) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (await verified(bytes)) compressed = bytes;
        else await cache.delete(url);
      }
    }
  } catch { /* Fetch a fresh verified bundle if browser storage is unavailable. */ }
  signal.throwIfAborted();
  if (compressed) report('Using cached prepared workspace bundle');
  else {
    report('Downloading prepared workspace bundle…');
    const response = await fetch(url, { signal });
    if (!response.ok) throw Error(`Prepared bundle HTTP ${response.status}`);
    compressed = new Uint8Array(await response.arrayBuffer());
    if (!await verified(compressed)) throw Error('Prepared bundle integrity failure');
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
  const bytes = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  let offset = 0;
  for (const entry of bundleFiles(entries)) {
    files.set(entry.file, bytes.subarray(offset, offset + entry.bytes));
    offset += entry.bytes;
  }
  if (offset !== bytes.length) throw Error('Prepared bundle size mismatch');
  return files;
}
