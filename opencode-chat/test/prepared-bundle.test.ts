import { test, expect, spyOn } from 'bun:test';
import { bundleFiles, readPreparedBundle, preparedBundleCache } from '../src/prepared-bundle';
import { sha256 } from '../src/prepare-tree';
import type { PreparedEntry } from '../src/package-tree';

test('one compressed download restores binary and empty files, deduplicates content, and rejects corruption', async () => {
  const binary = new Uint8Array([0, 255, 128, 10]), empty = new Uint8Array();
  const entry = (destination: string, bytes: Uint8Array): PreparedEntry => ({ kind: 'file', destination,
    mode: 0o644, file: sha256(bytes) + '.bin', sha256: sha256(bytes), bytes: bytes.length });
  const entries = [entry('/a', binary), entry('/b', empty), entry('/c', binary)];
  expect(bundleFiles(entries)).toHaveLength(2);
  const compressed = Bun.gzipSync(binary), hash = sha256(compressed);
  const bundle = { file: hash + '.bundle.gz', sha256: hash, bytes: compressed.length };
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(compressed));
  try {
    const files = await readPreparedBundle(bundle, entries, '/prepared/', new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('/prepared/' + bundle.file);
    expect(files.get(sha256(binary) + '.bin')).toEqual(binary);
    expect(files.get(sha256(empty) + '.bin')).toEqual(empty);
    await expect(readPreparedBundle(bundle, [entry('/a', empty)], '/', new AbortController().signal)).rejects.toThrow('size mismatch');
    fetch.mockImplementation(async () => new Response('corrupt'));
    await expect(readPreparedBundle(bundle, entries, '/', new AbortController().signal)).rejects.toThrow('integrity failure');
  } finally { fetch.mockRestore(); }
});

test('browser cache reuses verified bundles, repairs corruption, replaces old versions, and tolerates storage failure', async () => {
  const cacheDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const stored = new Map<string, Response>();
  const key = (input: string | Request) => new URL(typeof input === 'string' ? input : input.url, 'https://editor.test/').href;
  let unavailable = false;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://editor.test/' } });
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: {
    async open(name: string) {
      expect(name).toBe(preparedBundleCache);
      if (unavailable) throw Error('Storage unavailable');
      return {
        async match(input: string) { return stored.get(key(input))?.clone(); },
        async put(input: string, response: Response) { stored.set(key(input), response.clone()); },
        async delete(input: string | Request) { return stored.delete(key(input)); },
        async keys() { return [...stored.keys()].map(url => new Request(url)); },
      };
    },
  } });
  const make = (text: string) => {
    const bytes = new TextEncoder().encode(text), sha = sha256(bytes), compressed = Bun.gzipSync(bytes), hash = sha256(compressed);
    return { compressed, bundle: { file: hash + '.bundle.gz', bytes: compressed.length, sha256: hash },
      entries: [{ kind: 'file', destination: '/a', mode: 0o644, file: sha + '.bin', bytes: bytes.length, sha256: sha }] as PreparedEntry[] };
  };
  const first = make('first'), second = make('second'), signal = new AbortController().signal;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(first.compressed));
  const messages: string[] = [];
  try {
    await readPreparedBundle(first.bundle, first.entries, '/prepared/', signal);
    await readPreparedBundle(first.bundle, first.entries, '/prepared/', signal, text => messages.push(text));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(messages).toContain('Using cached prepared workspace bundle');
    // A same-size corrupted cache entry must not bypass integrity checking.
    const corrupt = first.compressed.slice(); corrupt[corrupt.length - 1]! ^= 1;
    stored.set(key('/prepared/' + first.bundle.file), new Response(corrupt));
    await readPreparedBundle(first.bundle, first.entries, '/prepared/', signal);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockImplementation(async () => new Response(second.compressed));
    await readPreparedBundle(second.bundle, second.entries, '/prepared/', signal);
    expect([...stored.keys()]).toEqual([key('/prepared/' + second.bundle.file)]);
    unavailable = true;
    await readPreparedBundle(second.bundle, second.entries, '/prepared/', signal);
    expect(fetch).toHaveBeenCalledTimes(4);
    await expect(readPreparedBundle(second.bundle, second.entries, '/prepared/', AbortSignal.abort())).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(4);
  } finally {
    fetch.mockRestore();
    if (cacheDescriptor) Object.defineProperty(globalThis, 'caches', cacheDescriptor);
    else Reflect.deleteProperty(globalThis, 'caches');
    if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});
