// measure-repeat.mjs <out dir> <n> <label>=<app dir> [<label>=<app dir> ...] [-- extra vite-crawl args]
//
// Runs vite-crawl.mjs n times per app, interleaved (a1 b1 a2 b2 ...) so drifting machine load
// hits every variant alike, on port 4107, waiting for the port to be free between runs.
// Keeps each run's out dir (<out dir>/<label>-<i>) and prints, per label, median and range of
// listening / document / crawl-done ms with the 1-minute load average of every run.
// A run's BAT_MEASURE_TRACE, if wanted, is <out dir>/<label>-<i>.trace.jsonl (flag --trace-calls).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const extra = split < 0 ? [] : argv.slice(split + 1);
const own = split < 0 ? argv : argv.slice(0, split);
const traceCalls = own.includes('--trace-calls');
const [outDir, count, ...apps] = own.filter(a => a !== '--trace-calls');
const port = 4107;
if (!outDir || !Number(count) || !apps.length) { console.error('usage: measure-repeat.mjs <out dir> <n> <label>=<app dir>... [--trace-calls] [-- vite-crawl args]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const portFree = () => new Promise(resolve => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(true));
});
const results = {};
for (let i = 1; i <= Number(count); i++) {
  for (const app of apps) {
    const [label, dir] = app.split('=');
    while (!(await portFree())) await new Promise(r => setTimeout(r, 50));
    const out = path.resolve(outDir, `${label}-${i}`);
    const args = [path.join(here, 'vite-crawl.mjs'), dir, out, '--port', String(port), ...extra];
    if (traceCalls) { fs.rmSync(`${out}.trace.jsonl`, { force: true }); args.push('--env', `BAT_MEASURE_TRACE=${out}.trace.jsonl`); }
    const before = os.loadavg()[0];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
    const line = run.stdout.trim().split('\n').pop();
    let summary;
    try { summary = JSON.parse(line); } catch { console.error(`${label}-${i} failed:\n${run.stderr.slice(-2000)}`); continue; }
    (results[label] ??= []).push({ ...summary, loadBefore: +before.toFixed(1) });
    console.log(`${label}-${i} listening ${summary.listeningMs} document ${summary.documentMs} crawlDone ${summary.crawlDoneMs} requests ${summary.requests} failed ${summary.failed.length} load ${before.toFixed(1)}`);
  }
}
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return `${median} (${sorted[0]}-${sorted.at(-1)})`;
};
console.log('\n| variant | n | listening ms | document ms | crawl done ms | load avg (1 min) |\n|---|---|---|---|---|---|');
for (const [label, runs] of Object.entries(results))
  console.log(`| ${label} | ${runs.length} | ${stats(runs.map(r => r.listeningMs))} | ${stats(runs.map(r => r.documentMs))} | ${stats(runs.map(r => r.crawlDoneMs))} | ${stats(runs.map(r => r.loadBefore))} |`);
fs.writeFileSync(path.join(outDir, 'runs.json'), JSON.stringify(results, null, 1));
