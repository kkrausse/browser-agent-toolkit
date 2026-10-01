// Concrete emitted URL/actual handler/native adapter verification. No listener or worker boot.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
const stage = resolve(process.argv[2]!), input = resolve(process.argv[3]!);
const { parse } = await import(join(input, 'runtime-source/packages/runtime/vendor/acorn.mjs'));
const { fetchLoaderVendorBytes } = await import(join(input, 'runtime-source/packages/kernel-host/loader-vendor-bytes.js'));
const { Host } = await import(join(stage, 'sdk/host.js'));
const { createBrowserEditorHandler } = await import(join(stage, 'qa/live-backend.js'));
const sha = (bytes: Uint8Array | string) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const manifest = await Bun.file(join(stage, 'runtime/distribution.json')).json();
assert.equal(manifest.version, 'bd39000ff5bbc334f836ad65a4433e627525070413f810d7169132102f49b9f9');
const workerText = await Bun.file(join(stage, 'runtime', manifest.kernelWorker)).text();
assert.equal(sha(workerText), 'c4193ae0cba8419149738ed2b3a74d79d5f59f5e447eff129106ca2f3532fecb');
const declaration = parse(workerText, { ecmaVersion: 'latest', sourceType: 'module' }).body.find((node: any) => node.type === 'FunctionDeclaration' && node.id.name === 'vendorUrl');
assert.ok(declaration);
const emitted = workerText.slice(declaration.start, declaration.end);
const evaluate = new Function('self', 'meta', emitted.replaceAll('import.meta', 'meta') + '; return vendorUrl;');
const origin = 'http://127.0.0.1:54321';
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' };
const hashes: Record<string, string> = {};
for await (const file of new Bun.Glob('**/*').scan({ cwd: stage, onlyFiles: true })) hashes[file] = sha(new Uint8Array(await Bun.file(join(stage, file)).arrayBuffer()));
const receipt = { hashes, version: manifest.version, topology: { policy: 'single-kernel' } };
async function extractHandler(file: string, bindings: Record<string, unknown>) {
  const source = await Bun.file(join(stage, file)).text();
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let node: any;
  function walk(value: any) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'CallExpression' && value.callee?.object?.name === 'Bun' && value.callee?.property?.name === 'serve') node = value.arguments[0].properties.find((p: any) => p.key.name === 'fetch').value;
    for (const child of Object.values(value)) { if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child); }
  }
  walk(ast); assert.ok(node, 'actual emitted host fetch handler');
  const body = source.slice(node.body.start, node.body.end);
  return { bodySha256: sha(body), fetch: new Function(...Object.keys(bindings), 'return async function(request) ' + body)(...Object.values(bindings)) };
}
const pilot = await extractHandler('qa/effect-loader-full-delivery-host.js', { stage, receipt, headers, held: false, pending: new Set(), release: () => {}, resolve, Bun });
const full = await extractHandler('qa/serve-single-kernel.js', { output: stage, receipt, headers, contracts: false, diagnostic: false, reload: false, resolve, Bun });
const editor = createBrowserEditorHandler({ preparedDirectory: join(stage, 'prepared'), runtimeDirectory: join(stage, 'runtime'), providers: {} });
const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(key: string, value: unknown) {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
const workerURLs: URL[] = [];
replace('location', new URL(origin + '/'));
replace('crossOriginIsolated', true);
replace('Worker', class {
  url: URL;
  onmessage?: (event: unknown) => void;
  constructor(url: string) { this.url = new URL(url); workerURLs.push(this.url); }
  postMessage(message: any) { if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } })); }
  terminate() {}
});
const results: unknown[] = [];
try {
  for (const [name, base, handler, bodySha256] of [
    ['minimal-pilot', '/runtime/', pilot.fetch, pilot.bodySha256],
    ['full-and-focused', '/runtime/', full.fetch, full.bodySha256],
    ['todo-editor', '/editor/runtime/', (request: Request) => editor.fetch(request), undefined],
  ] as const) {
    replace('fetch', async (url: string) => {
      assert.equal(String(url), origin + base + 'distribution.json');
      const response = await handler(new Request(url)); assert.ok(response); assert.equal(response.status, 200); return response;
    });
    const host = await Host.open({ name: 'vivari', version: manifest.version, assetBaseUrl: base });
    const workerURL = workerURLs.at(-1)!;
    assert.equal(workerURL.searchParams.get('vivari-asset-base'), origin + base);
    const emittedResolver = evaluate({ location: workerURL }, { env: { BASE_URL: './' } });
    const vendorURL = emittedResolver('vendor/tsgo-pack.bin');
    assert.equal(vendorURL, origin + base + 'vendor/tsgo-pack.bin');
    let calls = 0;
    const bytes = await fetchLoaderVendorBytes(vendorURL, new AbortController().signal, async (url: string, init: RequestInit) => {
      calls++; const response = await handler(new Request(url, init)); assert.ok(response); assert.equal(response.status, 200); return response;
    });
    assert.equal(calls, 1); assert.equal(bytes.length, 10793012);
    assert.equal(sha(bytes), 'f318c6ec229471e1f53be8363e90e2ecdc55faf6549a9e696ee825689129c465');
    const workerResponse = await handler(new Request(workerURL));
    assert.ok(workerResponse); assert.equal(workerResponse.status, 200);
    assert.equal(sha(new Uint8Array(await workerResponse.arrayBuffer())), sha(workerText));
    results.push({ name, base, workerURL: workerURL.href, vendorURL, calls, bytes: bytes.length, sha256: sha(bytes), fetchBodySha256: bodySha256 });
    host.destroy();
  }
} finally {
  for (const [key, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as any)[key];
}
await Bun.write(join(stage, 'offline-vendor-route-verification.json'), JSON.stringify({ emitted, results, actualManifestSha256: sha(await readFile(join(stage, 'runtime/distribution.json'))), browserStarted: false, hostListener: false, guestStarted: false, executedWorker: false, nativeAdapterExecuted: true, retention: false, inference: false }, null, 2));
console.log(JSON.stringify({ offlineRoutesVerified: results.length, browserStarted: false, hostListener: false, guestStarted: false }));
