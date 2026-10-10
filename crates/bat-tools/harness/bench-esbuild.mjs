// Cost of the esbuild package a tree resolves, in fresh Node processes: require, first
// transform, and the recorded startup transforms of the TODO app replayed in order.
//   node bench-esbuild.mjs <esbuild-trace.jsonl> <app dir>... [--n 7]
// With --child (internal) it measures once and prints JSON.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args[0] === '--child') {
  const [, traceFile, appDir] = args;
  const records = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(r => r.api === 'transform');
  const t0 = performance.now();
  const esbuild = createRequire(fs.realpathSync(path.resolve(appDir, 'node_modules/vite')) + '/')('esbuild');
  const t1 = performance.now();
  await esbuild.transform(records[0].input, records[0].options);
  const t2 = performance.now();
  for (const record of records.slice(1)) await esbuild.transform(record.input, record.options);
  const t3 = performance.now();
  // Warm per-call cost: the largest app file, 50 times.
  const big = records.reduce((a, b) => (b.options.loader === 'tsx' && b.input.length > a.input.length ? b : a), records[0]);
  const times = [];
  for (let i = 0; i < 50; i++) { const s = performance.now(); await esbuild.transform(big.input, big.options); times.push(performance.now() - s); }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ requireMs: t1 - t0, firstMs: t2 - t1, restMs: t3 - t2, calls: records.length, warmMs: times[25], warmFile: path.basename(big.options.sourcefile), warmBytes: big.input.length }));
  process.exit(0);
}
const n = args.includes('--n') ? +args.splice(args.indexOf('--n'), 2)[1] : 7;
const [traceFile, ...apps] = args;
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const range = list => `${median(list).toFixed(1)} (${Math.min(...list).toFixed(1)}-${Math.max(...list).toFixed(1)})`;
const runs = Object.fromEntries(apps.map(app => [app, []]));
for (let i = 0; i < n; i++) for (const app of apps) // interleaved
  runs[app].push(JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--child', traceFile, app], { encoding: 'utf8' })));
console.log(`load average ${os.loadavg().map(v => v.toFixed(1)).join(' ')}, n = ${n} fresh processes each, median (min-max) ms`);
for (const app of apps) {
  const r = runs[app];
  console.log(`${path.basename(app).padEnd(12)} require ${range(r.map(x => x.requireMs))} | first transform ${range(r.map(x => x.firstMs))} | other ${r[0].calls - 1} startup transforms ${range(r.map(x => x.restMs))} | warm ${r[0].warmFile} (${r[0].warmBytes} B) ${range(r.map(x => x.warmMs))}`);
}
