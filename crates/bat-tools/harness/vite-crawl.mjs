// Start the guest's Vite dev server natively with <app dir> mounted at /workspace (bwrap),
// then fetch what a browser fetches for the first page: the document, every module it
// imports (transitively), stylesheets. Bodies go to <out dir>; timings to stdout as JSON.
//
//   node vite-crawl.mjs <app dir> <out dir> [--port 4105] [--trace] [--keep-cache] [--env K=V]...
//
// --trace sets BAT_ESBUILD_TRACE=<out dir>/esbuild-trace.jsonl (see esbuild-trace.cjs).
// The Vite cache (.browser-editor-cache) is removed first unless --keep-cache.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const option = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; const [, v] = args.splice(i, 2); return v; };
const port = Number(option('--port', '4105'));
const trace = flag('--trace');
const keepCache = flag('--keep-cache');
const extraEnv = {};
for (let v; (v = option('--env', undefined)) !== undefined;) { const i = v.indexOf('='); extraEnv[v.slice(0, i)] = v.slice(i + 1); }
const [appDir, outDir] = args.map(p => path.resolve(p));
if (!appDir || !outDir) { console.error('usage: vite-crawl.mjs <app dir> <out dir> [options]'); process.exit(2); }

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
if (!keepCache) fs.rmSync(path.join(appDir, '.browser-editor-cache'), { recursive: true, force: true });

const env = { ...process.env, BROWSER_AGENT_GUEST: '1', NODE_ENV: 'development', ...extraEnv };
if (trace) env.BAT_ESBUILD_TRACE = path.join(outDir, 'esbuild-trace.jsonl');
const started = performance.now();
const child = spawn(path.join(here, 'ws.sh'), [appDir, 'node', 'node_modules/vite/bin/vite.js', '--configLoader', 'native', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let log = '';
child.stdout.on('data', d => { log += d; });
child.stderr.on('data', d => { log += d; });
child.on('exit', (code, signal) => { if (!stopping) console.error(`vite exited early (code ${code}, signal ${signal})\n` + log.slice(-3000)); });
let stopping = false;
const stop = () => { stopping = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }; // the whole group: bwrap, node, tool children
process.on('exit', stop);

const origin = `http://127.0.0.1:${port}`;
const base = '/preview/5173/';
async function waitListening() {
  for (;;) {
    if (child.exitCode !== null) throw new Error('vite exited:\n' + log);
    if (/Local:|ready in/.test(log)) return;
    await new Promise(r => setTimeout(r, 5));
  }
}
await waitListening();
const listeningMs = performance.now() - started;

const seen = new Map();
const requests = [];
const fileName = url => url.replace(/^\//, '').replace(/[?&=:@]/g, '_').replace(/\//g, '__') || 'index';
async function get(url, accept) {
  if (seen.has(url)) return seen.get(url);
  const t0 = performance.now();
  const promise = (async () => {
    const response = await fetch(origin + url, { headers: { accept, 'sec-fetch-dest': accept.includes('html') ? 'document' : 'script' } });
    const body = await response.text();
    const ms = performance.now() - t0;
    requests.push({ url, status: response.status, type: response.headers.get('content-type'), bytes: body.length, ms: +ms.toFixed(1), at: +(t0 - started).toFixed(1) });
    fs.writeFileSync(path.join(outDir, fileName(url)), body);
    return { body, type: response.headers.get('content-type') ?? '', status: response.status };
  })();
  seen.set(url, promise);
  return promise;
}
const importRe = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"'\n]+)["']/g;
async function crawlModule(url) {
  if (seen.has(url)) return;
  const { body, type, status } = await get(url, '*/*');
  if (status !== 200 || !/javascript/.test(type)) return;
  const next = new Set();
  for (const match of body.matchAll(importRe)) {
    const spec = match[1];
    if (spec.startsWith('/')) next.add(spec);
    else if (spec.startsWith('.')) next.add(new URL(spec, origin + url).pathname + new URL(spec, origin + url).search);
  }
  await Promise.all([...next].map(crawlModule));
}
const documentStart = performance.now();
const html = await get(base, 'text/html');
const documentMs = performance.now() - documentStart;
const entries = new Set();
for (const match of html.body.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) entries.add(match[1]);
for (const match of html.body.matchAll(/<link[^>]*\bhref="([^"]+)"/g)) entries.add(match[1]);
for (const match of html.body.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g))
  for (const m of match[1].matchAll(importRe)) if (m[1].startsWith('/')) entries.add(m[1]);
await Promise.all([...entries].map(crawlModule));
// A second pass, as a reload after the dependency optimizer has settled.
const totalMs = performance.now() - started;
await new Promise(r => setTimeout(r, Number(process.env.CRAWL_SETTLE_MS ?? 1500)));
stop();
if (child.exitCode === null && child.signalCode === null) await new Promise(r => child.once('exit', r));
requests.sort((a, b) => a.at - b.at);
const summary = {
  app: appDir, loadavg: os.loadavg().map(n => +n.toFixed(1)), listeningMs: +listeningMs.toFixed(0), documentMs: +documentMs.toFixed(0),
  crawlDoneMs: +totalMs.toFixed(0), requests: requests.length, failed: requests.filter(r => r.status !== 200).map(r => `${r.status} ${r.url}`),
};
fs.writeFileSync(path.join(outDir, 'requests.json'), JSON.stringify(requests, null, 1));
fs.writeFileSync(path.join(outDir, 'vite.log'), log);
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
process.exit(0);
