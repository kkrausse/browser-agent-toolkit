// measure-rollup-parse.mjs <old tree> <native tree> <dir of JavaScript files> [n=7]
//
// Rollup's parseAst outside the dev server, each sample in a fresh node process: time to
// import `rollup/parseAst` (for @rollup/wasm-node that reads, compiles and instantiates
// bindings_wasm_bg.wasm synchronously), the first parseAst call (cold), and a pass over
// every file in the directory (the served module bodies of a crawl are a fair stand-in for
// what Vite's SSR transform parses), then a second, warm pass.
// `rollup` is resolved from the tree's vite package, as the dev server does.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [oldTree, nativeTree, inputDir, count = '7'] = process.argv.slice(2);
if (!inputDir) { console.error('usage: measure-rollup-parse.mjs <old tree> <native tree> <dir of .js bodies> [n]'); process.exit(2); }
const inputs = fs.readdirSync(inputDir).map(name => path.join(inputDir, name)).filter(file => {
  const text = fs.readFileSync(file, 'utf8');
  return /__src__|entry\.client/.test(file) && /^\s*(import|export|const|var|function)\b/m.test(text) && !text.startsWith('<');
});
const script = tree => `
const { createRequire } = require('node:module'); const { pathToFileURL } = require('node:url'); const fs = require('fs');
const vite = fs.realpathSync(${JSON.stringify(path.resolve(tree, 'node_modules/vite'))});
const req = createRequire(vite + '/package.json');
const files = ${JSON.stringify(inputs)}.map(f => fs.readFileSync(f, 'utf8'));
const t = () => performance.now(); const out = { files: files.length, bytes: files.reduce((a, f) => a + Buffer.byteLength(f), 0) };
(async () => {
  let a = t(); const { parseAst, parseAstAsync } = await import(pathToFileURL(req.resolve('rollup/parseAst')).href.replace('/dist/parseAst.js', '/dist/es/parseAst.js')); out.importMs = t() - a;
  a = t(); parseAst('export const a = 1'); out.firstCallMs = t() - a;
  const ok = []; a = t(); for (const f of files) { try { parseAst(f); ok.push(f); } catch {} } out.coldPassMs = t() - a; out.parsed = ok.length; out.parsedBytes = ok.reduce((x, f) => x + Buffer.byteLength(f), 0);
  a = t(); for (const f of ok) parseAst(f); out.warmPassMs = t() - a;
  a = t(); for (const f of ok) await parseAstAsync(f); out.warmAsyncPassMs = t() - a;
  console.log(JSON.stringify(out));
})();`;
const samples = {};
for (let i = 0; i < Number(count); i++)
  for (const [name, tree] of [['@rollup/wasm-node', oldTree], ['rollup (native)', nativeTree]]) {
    const run = spawnSync(process.execPath, ['-e', script(tree)], { encoding: 'utf8' });
    if (run.status !== 0) { console.error(run.stderr.slice(-1500)); process.exit(1); }
    (samples[name] ??= []).push({ ...JSON.parse(run.stdout), load: os.loadavg()[0] });
  }
const stat = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[0] === sorted.at(-1) ? String(+median.toFixed(2)) : `${median.toFixed(2)} (${sorted[0].toFixed(2)}-${sorted.at(-1).toFixed(2)})`;
};
console.log(`node ${process.version}, n=${count} fresh processes each, interleaved\n\n| package | measure | median (range) |\n|---|---|---|`);
for (const [name, runs] of Object.entries(samples)) for (const key of Object.keys(runs[0])) console.log(`| ${name} | ${key} | ${stat(runs.map(r => r[key]))} |`);
