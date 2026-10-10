// Runs inside the staged project (cwd = project root, guest environment variables set):
// starts the project's own Vite dev server the way the guest launches it, lets the
// dependency optimizer finish, optionally walks the first page's module graph so that
// lazily discovered dependencies are optimized too, and stops. Vite writes its cache
// (<cacheDir>/deps*) itself; this file never touches it, except in "rehash" mode.
//
//   node vite-optimize-runner.mjs <result.json> [--no-crawl] [--rehash <guest root>]
//
// --rehash: the server is not running at the guest's path (no mount namespace on this
// host), so the three hashes Vite checks at startup are recomputed for the guest root with
// a copy of Vite 7's getConfigHash/getLockfileHash. The copy is first checked against the
// hashes Vite itself just wrote for the real root; if they disagree nothing is changed and
// the result says so.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const resultFile = args[0];
const crawl = !args.includes('--no-crawl');
const rehash = args.includes('--rehash') ? args[args.indexOf('--rehash') + 1] : undefined;
const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const vite = await import(pathToFileURL(require.resolve('vite')).href);

const result = { viteVersion: vite.version, root, ok: false, environments: {}, crawl: null, rehash: null, ms: {} };
const started = performance.now();
const server = await vite.createServer({ configLoader: 'native', clearScreen: false, server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
result.ms.listening = Math.round(performance.now() - started);
const address = server.httpServer.address();
const origin = `http://127.0.0.1:${address.port}`;

const optimizers = Object.entries(server.environments).filter(([, environment]) => environment.depsOptimizer);
/** Resolves when no optimizer has a scan, a discovered dependency or a queued run pending. */
async function settled() {
  for (let quiet = 0; quiet < 4;) {
    let busy = false;
    for (const [, environment] of optimizers) {
      const optimizer = environment.depsOptimizer;
      await optimizer.scanProcessing;
      const discovered = Object.values(optimizer.metadata.discovered);
      if (discovered.length) { busy = true; await Promise.allSettled(discovered.map(info => info.processing)); }
    }
    quiet = busy ? 0 : quiet + 1;
    await new Promise(done => setTimeout(done, 60)); // Vite debounces newly found dependencies by 100 ms
  }
}
await settled();
result.ms.optimized = Math.round(performance.now() - started);

if (crawl) {
  // What a browser requests for the first page: the document, then every module it imports.
  const seen = new Set(), failed = [];
  const importRe = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"'\n]+)["']/g;
  const get = async (url, accept) => {
    const response = await fetch(origin + url, { headers: { accept } });
    const body = await response.text();
    if (!response.ok) failed.push(`${response.status} ${url}`);
    return { body, type: response.headers.get('content-type') ?? '', ok: response.ok };
  };
  const visit = async url => {
    if (seen.has(url)) return;
    seen.add(url);
    const { body, type, ok } = await get(url, '*/*');
    if (!ok || !/javascript/.test(type)) return;
    const next = new Set();
    for (const match of body.matchAll(importRe)) {
      if (match[1].startsWith('/')) next.add(match[1]);
      else if (match[1].startsWith('.')) { const u = new URL(match[1], origin + url); next.add(u.pathname + u.search); }
    }
    await Promise.all([...next].map(visit));
  };
  try {
    const base = server.config.base;
    const html = await get(base, 'text/html');
    const entries = new Set();
    for (const m of html.body.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) entries.add(m[1]);
    for (const m of html.body.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)) for (const i of m[1].matchAll(importRe)) if (i[1].startsWith('/')) entries.add(i[1]);
    await Promise.all([...entries].map(visit));
    await new Promise(done => setTimeout(done, 250));
    await settled();
    result.crawl = { document: html.ok, modules: seen.size, failed: failed.filter(line => !/\/deps\/[A-Za-z]+$/.test(line)) };
  } catch (error) {
    result.crawl = { error: String(error?.message ?? error) };
  }
  result.ms.crawled = Math.round(performance.now() - started);
}

// ---- what was produced
const getHash = text => crypto.createHash('sha256').update(text).digest('hex').substring(0, 8);
const unique = list => [...new Set(list)];
/** Vite 7.3 `getConfigHash`, with `root` (and every path below it) as seen from `asRoot`. */
function configHash(environment, asRoot) {
  const { config } = environment, { optimizeDeps } = config;
  const text = JSON.stringify({
    define: !config.keepProcessEnv ? process.env.NODE_ENV || config.mode : null,
    root: config.root, resolve: config.resolve, assetsInclude: config.assetsInclude,
    plugins: config.plugins.map(plugin => plugin.name),
    optimizeDeps: {
      include: optimizeDeps.include ? unique(optimizeDeps.include).sort() : undefined,
      exclude: optimizeDeps.exclude ? unique(optimizeDeps.exclude).sort() : undefined,
      esbuildOptions: { ...optimizeDeps.esbuildOptions, plugins: optimizeDeps.esbuildOptions?.plugins?.map(plugin => plugin.name) },
    },
  }, (_, value) => typeof value === 'function' || value instanceof RegExp ? value.toString() : value);
  return getHash(asRoot === config.root ? text : text.split(JSON.stringify(config.root).slice(1, -1)).join(JSON.stringify(asRoot).slice(1, -1)));
}
const lockfiles = ['node_modules/.package-lock.json', 'node_modules/.yarn-state.yml', '.pnp.cjs', '.pnp.js', 'node_modules/.yarn-integrity', 'node_modules/.pnpm/lock.yaml', '.rush/temp/shrinkwrap-deps.json', 'bun.lock', 'bun.lockb'];
const patchDirs = { 'node_modules/.package-lock.json': 'patches', '.pnp.cjs': '.yarn/patches', '.pnp.js': '.yarn/patches', 'node_modules/.yarn-integrity': 'patches', 'bun.lock': 'patches', 'bun.lockb': 'patches' };
/** Vite 7.3 `getLockfileHash`; `climb` false = only `from` itself (the guest root has nothing above it). */
function lockfileHash(from, climb) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    for (const name of lockfiles) {
      const file = path.join(directory, name);
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
      let content = fs.readFileSync(file, 'utf8');
      const patches = patchDirs[name] && fs.statSync(path.join(file.slice(0, -name.length), patchDirs[name]), { throwIfNoEntry: false });
      if (patches?.isDirectory()) content += patches.mtimeMs.toString();
      return getHash(content);
    }
    if (!climb || path.dirname(directory) === directory) return getHash('');
  }
}

let rehashOk = true;
for (const [name, environment] of optimizers) {
  const cacheDir = path.resolve(root, environment.config.cacheDir, name === 'client' ? 'deps' : `deps_${name}`);
  const metadataFile = path.join(cacheDir, '_metadata.json');
  if (!fs.existsSync(metadataFile)) { result.environments[name] = { cacheDir: null }; continue; } // nothing to optimize in this environment
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  const entry = result.environments[name] = {
    cacheDir: path.relative(root, cacheDir), optimized: Object.keys(metadata.optimized), chunks: Object.keys(metadata.chunks ?? {}).length,
    hash: metadata.hash, configHash: metadata.configHash, lockfileHash: metadata.lockfileHash,
  };
  if (rehash) {
    const mine = { configHash: configHash(environment, environment.config.root), lockfileHash: lockfileHash(environment.config.root, true) };
    if (mine.configHash !== metadata.configHash || mine.lockfileHash !== metadata.lockfileHash) {
      rehashOk = false;
      entry.rehash = { ok: false, reason: `this script's copy of Vite's hash functions does not reproduce Vite ${vite.version}'s own hashes (config ${mine.configHash} vs ${metadata.configHash}, lockfile ${mine.lockfileHash} vs ${metadata.lockfileHash})` };
      continue;
    }
    metadata.configHash = configHash(environment, rehash);
    metadata.lockfileHash = lockfileHash(environment.config.root, false);
    metadata.hash = getHash(metadata.lockfileHash + metadata.configHash);
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
    entry.rehash = { ok: true, hash: metadata.hash, configHash: metadata.configHash, lockfileHash: metadata.lockfileHash };
  }
}
if (rehash) result.rehash = { guestRoot: rehash, ok: rehashOk };
await server.close();
result.ok = rehashOk && Object.values(result.environments).some(environment => environment.cacheDir);
result.ms.total = Math.round(performance.now() - started);
fs.writeFileSync(resultFile, JSON.stringify(result, null, 1));
process.exit(0);
