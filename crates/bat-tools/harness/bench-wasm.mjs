// Size and cost of one build of bat_esbuild.wasm, in fresh Node processes. The module is
// handed to the shim through its documented hook, globalThis.__bat_wasm(name).
//   node bench-wasm.mjs <esbuild-trace.jsonl> <app dir with the shim> <file.wasm>... [--n 7]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args[0] === '--child') {
  const [, traceFile, appDir, wasmFile] = args;
  const records = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(r => r.api === 'transform');
  const t0 = performance.now();
  const bytes = fs.readFileSync(wasmFile);
  const t1 = performance.now();
  const module = new WebAssembly.Module(bytes);
  const t2 = performance.now();
  new WebAssembly.Instance(module, {});
  const t3 = performance.now();
  let asked;
  globalThis.__bat_wasm = name => { asked = name; return module; };
  const esbuild = createRequire(fs.realpathSync(path.resolve(appDir, 'node_modules/vite')) + '/')('esbuild');
  const t4 = performance.now();
  await esbuild.transform(records[0].input, records[0].options);
  const t5 = performance.now();
  for (const record of records.slice(1)) await esbuild.transform(record.input, record.options);
  const t6 = performance.now();
  const big = records.reduce((a, b) => (b.options.loader === 'tsx' && b.input.length > a.input.length ? b : a), records[0]);
  const times = [];
  for (let i = 0; i < 200; i++) { const s = performance.now(); await esbuild.transform(big.input, big.options); times.push(performance.now() - s); }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ hook: asked, readMs: t1 - t0, compileMs: t2 - t1, instantiateMs: t3 - t2, firstMs: t5 - t4, restMs: t6 - t5, warmMs: times[100] }));
  process.exit(0);
}
const n = args.includes('--n') ? +args.splice(args.indexOf('--n'), 2)[1] : 7;
const [traceFile, appDir, ...files] = args;
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const range = list => `${median(list).toFixed(1)} (${Math.min(...list).toFixed(1)}-${Math.max(...list).toFixed(1)})`;
const runs = Object.fromEntries(files.map(file => [file, []]));
for (let i = 0; i < n; i++) for (const file of files)
  runs[file].push(JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--child', traceFile, appDir, file], { encoding: 'utf8' })));
console.log(`load average ${os.loadavg().map(v => v.toFixed(1)).join(' ')}, n = ${n} fresh processes each, median (min-max) ms; hook asked for "${runs[files[0]][0].hook}"`);
for (const file of files) {
  const r = runs[file], bytes = fs.readFileSync(file);
  console.log(`${path.basename(file).padEnd(18)} ${bytes.length} B, gzip ${zlib.gzipSync(bytes, { level: 9 }).length}, brotli ${zlib.brotliCompressSync(bytes).length} | read ${range(r.map(x => x.readMs))} | compile ${range(r.map(x => x.compileMs))} | instantiate ${range(r.map(x => x.instantiateMs))} | first transform ${range(r.map(x => x.firstMs))} | 20 more ${range(r.map(x => x.restMs))} | warm ${range(r.map(x => x.warmMs))}`);
}
