// Load and scan cost of an @tailwindcss/oxide implementation on an app tree, in fresh Node
// processes (cold numbers) with repeat scans inside each. Prints medians as JSON.
//
//   node bench.mjs <app dir> <name>=<package dir> [<name>=<package dir>...] [--runs 11] [--env K=V]
//
// Each run: require() the package, `new Scanner` with the source set @tailwindcss/vite
// passes (`{ base: <app>, pattern: '**/*' }`), first scan(), ten more scan() calls, `files`.
// For the Wasm shim (a directory holding tailwindcss-oxide.wasm) it also times a bare
// synchronous compile and instantiate of the module, and reports its size.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; const [, v] = args.splice(i, 2); return v; };
const median = list => { const s = [...list].sort((a, b) => a - b); return +s[Math.floor(s.length / 2)].toFixed(2); };

if (args[0] === '--child') {
  const [, app, dir] = args;
  const require = createRequire(import.meta.url);
  process.chdir(app);
  const out = {};
  const wasmPath = path.join(dir, 'tailwindcss-oxide.wasm');
  if (fs.existsSync(wasmPath)) {
    // Bare module cost, before anything has touched it: read, compile, instantiate.
    const { createWasi } = require(path.join(dir, 'wasi.js'));
    let t = performance.now();
    const bytes = fs.readFileSync(wasmPath);
    out.readMs = performance.now() - t;
    t = performance.now();
    const module = new WebAssembly.Module(bytes);
    out.compileMs = performance.now() - t;
    t = performance.now();
    new WebAssembly.Instance(module, { wasi_snapshot_preview1: createWasi().imports });
    out.instantiateMs = performance.now() - t;
  }
  let t = performance.now();
  const { Scanner } = require(dir);
  out.requireMs = performance.now() - t;
  t = performance.now();
  const scanner = new Scanner({ sources: [{ base: app, pattern: '**/*', negated: false }] });
  out.newMs = performance.now() - t;
  t = performance.now();
  out.candidates = scanner.scan().length;
  out.firstScanMs = performance.now() - t;
  const repeats = [];
  for (let i = 0; i < 10; i++) { t = performance.now(); scanner.scan(); repeats.push(performance.now() - t); }
  out.repeatScanMs = median(repeats);
  t = performance.now();
  out.files = scanner.files.length;
  out.filesMs = performance.now() - t;
  console.log('BENCH ' + JSON.stringify(out));
  process.exit(0); // the N-API Wasm build keeps worker threads alive
}

const runs = Number(option('--runs', '11'));
const env = { ...process.env };
for (let v; (v = option('--env', undefined)) !== undefined;) { const i = v.indexOf('='); env[v.slice(0, i)] = v.slice(i + 1); }
const [app, ...impls] = args;
const report = { app: path.resolve(app), node: process.version, runs, loadavgBefore: os.loadavg().map(n => +n.toFixed(1)), impls: {} };
for (const impl of impls) {
  const [name, dir] = impl.split('=');
  const samples = [];
  let failure;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', path.resolve(app), path.resolve(dir)], { env, encoding: 'utf8' });
    const line = child.stdout.split('\n').find(l => l.startsWith('BENCH '));
    if (!line) { failure = (child.stderr || child.stdout).slice(-600); break; }
    samples.push({ ...JSON.parse(line.slice(6)), processMs: performance.now() - started });
  }
  if (failure) { report.impls[name] = { failed: failure }; continue; }
  const result = { loadavg: os.loadavg().map(n => +n.toFixed(1)) };
  for (const key of Object.keys(samples[0])) result[key] = median(samples.map(s => s[key]));
  result.loadPlusFirstScanMs = median(samples.map(s => s.requireMs + s.newMs + s.firstScanMs));
  const wasm = fs.readdirSync(dir).find(f => f.endsWith('.wasm'));
  if (wasm) {
    const bytes = fs.readFileSync(path.join(dir, wasm));
    result.wasmBytes = bytes.length;
    result.wasmGzipBytes = zlib.gzipSync(bytes, { level: 9 }).length;
  }
  report.impls[name] = result;
}
console.log(JSON.stringify(report, null, 1));
