// Explicit later execution only; preparation never imports this host module.
import { join, resolve } from 'node:path';
const stage = resolve(process.argv[2]!);
const receipt = await Bun.file(join(stage, 'receipt.json')).json();
for (const [file, digest] of Object.entries(receipt.hashes)) if (new Bun.CryptoHasher('sha256').update(await Bun.file(join(stage, file)).arrayBuffer()).digest('hex') !== digest) throw Error('Artifact mismatch: ' + file);
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-store' };
let held = false;
const pending = new Set<() => void>();
const release = () => { held = false; for (const resume of pending) resume(); pending.clear(); };
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 240, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/pilot/')) {
    if (request.method === 'POST' && path === '/pilot/hold') held = true;
    if (request.method === 'POST' && path === '/pilot/release') release();
    return Response.json({ held, pending: pending.size, maxPending: 2, inferenceAllowed: false }, { headers });
  }
  if (path === '/') return new Response('<!doctype html><title>Effect loader Phase-1 pilot</title><h1>Real kernel loader pilot — no inference</h1><nav></nav><pre></pre><script type="module" src="/client/effect-loader-full-delivery-pilot.js"></script>', { headers: { ...headers, 'Content-Type': 'text/html' } });
  if (path.includes('/model/') || !/^\/(runtime|client)\//.test(path)) return new Response('Not found; inference prohibited', { status: 404, headers });
  const file = resolve(stage, '.' + decodeURIComponent(path));
  if (!file.startsWith(stage + '/') || !Object.hasOwn(receipt.hashes, file.slice(stage.length + 1))) return new Response('Not found', { status: 404, headers });
  if (held && path.endsWith('/vendor/tsgo-pack.bin')) {
    if (pending.size >= 2) return new Response('Bounded native hold admission', { status: 429, headers });
    await new Promise<void>(resolve => {
      const done = () => { pending.delete(done); request.signal.removeEventListener('abort', done); resolve(); };
      pending.add(done); request.signal.addEventListener('abort', done, { once: true });
      if (request.signal.aborted) done();
    });
  }
  return new Response(Bun.file(file), { headers: { ...headers, 'Content-Type': Bun.file(file).type } });
} });
console.log(JSON.stringify({ url: String(server.url), pid: process.pid, inferenceAllowed: false }));
process.on('SIGTERM', () => { release(); void server.stop(true).then(() => process.exit(0)); });
