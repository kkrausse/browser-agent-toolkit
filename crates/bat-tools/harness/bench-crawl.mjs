// Interleaved dev-server startup comparison over app trees, using vite-crawl.mjs.
//   node bench-crawl.mjs [--n 5] [--port 4105] <label>=<app dir>[:fresh|:keep] ...
// fresh: the Vite cache is removed before each run (first open, optimizer runs);
// keep: the cache in the tree is kept (a shipped or reused cache).
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const take = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args.splice(i, 2)[1]; };
const n = +take('--n', '5'), port = take('--port', '4105');
const crawl = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vite-crawl.mjs');
const variants = args.map(arg => { const [label, rest] = arg.split('='); const [dir, mode = 'fresh'] = rest.split(':'); return { label, dir, mode, runs: [] }; });
for (let i = 0; i < n; i++) for (const v of variants) {
  const out = execFileSync(process.execPath, [crawl, v.dir, `/tmp/claude-1000/bench-crawl-${v.label}`, '--port', port, ...(v.mode === 'keep' ? ['--keep-cache'] : [])], { encoding: 'utf8', env: { ...process.env, CRAWL_SETTLE_MS: '200' } });
  v.runs.push(JSON.parse(out.trim().split('\n').pop()));
}
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const cell = list => `${median(list)} (${Math.min(...list)}-${Math.max(...list)})`;
console.log(`load average ${os.loadavg().map(v => v.toFixed(1)).join(' ')}; n = ${n} interleaved; ms, median (min-max)`);
console.log('| tree | spawn → listening | document | spawn → first page crawled |\n| --- | --- | --- | --- |');
for (const v of variants) console.log(`| ${v.label} (${v.mode}) | ${cell(v.runs.map(r => r.listeningMs))} | ${cell(v.runs.map(r => r.documentMs))} | ${cell(v.runs.map(r => r.crawlDoneMs))} |`);
