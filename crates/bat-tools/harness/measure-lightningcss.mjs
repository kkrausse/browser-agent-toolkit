// measure-lightningcss.mjs <old tree> <native tree> <tree with the shim installed> [n=7]
//
// 1. Load cost, each sample in a fresh node process (cold code cache, as at dev-server start):
//      wasm steps    lightningcss-wasm by hand: readFileSync, new WebAssembly.Module,
//                    new WebAssembly.Instance, register_module + napi Environment
//      wasm import   import('lightningcss') in the old tree (wasm-node.mjs, what Tailwind triggers)
//      wasm require  require('lightningcss') in the old tree (wasm-node.cjs)
//      native        require('lightningcss') in the native tree (.node addon)
//      shim require / shim import / shim first transform (= the deferred load) / second transform
// 2. The shim's transform, with the options @tailwindcss/node's optimize() passes, against
//    native lightningcss on the same input: code and map must be identical. Likewise
//    transformStyleAttribute, bundle, bundleAsync (with a custom async resolver, the Asyncify
//    path), a visitor, browserslistToTargets, composeVisitors, Features.
// Resolution is done from <tree>/node_modules/.bun/@tailwindcss+node@*/node_modules/@tailwindcss/node,
// i.e. the package the dev server's `lightningcss` import comes from.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [oldTree, nativeTree, shimTree, count = '7'] = process.argv.slice(2);
if (!shimTree) { console.error('usage: measure-lightningcss.mjs <old tree> <native tree> <shim tree> [n]'); process.exit(2); }
const from = tree => {
  const bun = path.resolve(tree, 'node_modules/.bun');
  const dir = fs.readdirSync(bun).find(name => name.startsWith('@tailwindcss+node@'));
  return path.join(bun, dir, 'node_modules/@tailwindcss/node/package.json');
};
const prelude = anchor => `const { createRequire } = require('node:module'); const { pathToFileURL } = require('node:url');
const req = createRequire(${JSON.stringify(anchor)}); const t = () => performance.now(); const out = {};
const optimize = F => ({ filename: 'input.css', code: Buffer.from('@media (width >= 40rem) { .a { .b & { color: oklch(0.5 0.2 240); inset-inline: 1px } } }'), minify: false, sourceMap: false, drafts: { customMedia: true }, nonStandard: { deepSelectorCombinator: true }, include: F.Nesting | F.MediaQueries, exclude: F.LogicalProperties | F.DirSelector | F.LightDark, targets: { safari: 16 << 16 | 1024, ios_saf: 16 << 16 | 1024, firefox: 8388608, chrome: 7274496 }, errorRecovery: true });
`;
const scripts = {
  'wasm steps': tree => `${prelude(from(tree))}
const fs = require('fs'), path = require('path');
const dir = fs.realpathSync(path.dirname(req.resolve('lightningcss/lightningcss_node.wasm')));
let a = t(); const bytes = fs.readFileSync(path.join(dir, 'lightningcss_node.wasm')); out.readMs = t() - a; out.wasmBytes = bytes.length;
a = t(); const { Environment, napi } = require(path.join(dir, 'node_modules/napi-wasm/index.js')); out.napiJsMs = t() - a;
a = t(); const mod = new WebAssembly.Module(bytes); out.compileMs = t() - a;
let env; a = t(); const inst = new WebAssembly.Instance(mod, { env: { ...napi, await_promise_sync() {}, __getrandom_v03_custom: (p, l) => crypto.getRandomValues(env.memory.subarray(p, p + l)) } }); out.instantiateMs = t() - a;
a = t(); inst.exports.register_module(); env = new Environment(inst); out.registerMs = t() - a;
out.totalMs = out.readMs + out.napiJsMs + out.compileMs + out.instantiateMs + out.registerMs; out.memoryPages = inst.exports.memory.buffer.byteLength / 65536;
console.log(JSON.stringify(out));`,
  'wasm import': tree => `${prelude(from(tree))}
const a = t(); import(pathToFileURL(req.resolve('lightningcss')).href.replace('wasm-node.cjs', 'wasm-node.mjs')).then(m => { out.totalMs = t() - a; out.rssMb = process.memoryUsage().rss / 1048576; console.log(JSON.stringify(out)); });`,
  'wasm require': tree => `${prelude(from(tree))}
const a = t(); req('lightningcss'); out.totalMs = t() - a; console.log(JSON.stringify(out));`,
  native: tree => `${prelude(from(tree))}
let a = t(); const css = req('lightningcss'); out.totalMs = t() - a; out.rssMb = process.memoryUsage().rss / 1048576;
a = t(); css.transform(optimize(css.Features)); out.firstTransformMs = t() - a; console.log(JSON.stringify(out));`,
  shim: tree => `${prelude(from(tree))}
let a = t(); const css = req('lightningcss'); out.totalMs = t() - a; out.rssMb = process.memoryUsage().rss / 1048576;
a = t(); css.browserslistToTargets(['chrome 100']); css.composeVisitors([{}, {}]); out.pureJsMs = t() - a; out.rssAfterPureJsMb = process.memoryUsage().rss / 1048576;
a = t(); css.transform(optimize(css.Features)); out.firstTransformMs = t() - a;
a = t(); css.transform(optimize(css.Features)); out.secondTransformMs = t() - a; out.rssAfterMb = process.memoryUsage().rss / 1048576; console.log(JSON.stringify(out));`,
  'shim import': tree => `${prelude(from(tree))}
const a = t(); import(pathToFileURL(req.resolve('lightningcss')).href.replace(/bat-main\\.cjs$/, 'bat-main.mjs')).then(m => { out.totalMs = t() - a; out.names = Object.keys(m).sort().join(' '); console.log(JSON.stringify(out)); });`,
};
const trees = { 'wasm steps': oldTree, 'wasm import': oldTree, 'wasm require': oldTree, native: nativeTree, shim: shimTree, 'shim import': shimTree };
const samples = {};
for (let i = 0; i < Number(count); i++) {
  for (const [name, script] of Object.entries(scripts)) {
    const run = spawnSync(process.execPath, ['-e', script(trees[name])], { encoding: 'utf8' });
    if (run.status !== 0) { console.error(`${name}: ${run.stderr.slice(-1500)}`); process.exit(1); }
    (samples[name] ??= []).push({ ...JSON.parse(run.stdout), load: os.loadavg()[0] });
  }
}
const stat = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return `${median.toFixed(1)} (${sorted[0].toFixed(1)}-${sorted.at(-1).toFixed(1)})`;
};
console.log(`node ${process.version}, n=${count} fresh processes each, interleaved\n`);
console.log('| variant | measure | median (range) |\n|---|---|---|');
for (const [name, runs] of Object.entries(samples))
  for (const key of Object.keys(runs[0]).filter(k => typeof runs[0][k] === 'number'))
    console.log(`| ${name} | ${key} | ${stat(runs.map(r => r[key]))} |`);
console.log(`\nshim ES export names: ${samples['shim import'][0].names}`);

// Part 2: outputs, shim against native, one process (both packages loaded side by side).
const compare = `${prelude(from(shimTree))}
const native = createRequire(${JSON.stringify(from(nativeTree))})('lightningcss');
const shim = req('lightningcss');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-lightningcss-'));
fs.writeFileSync(path.join(dir, 'a.css'), '@import "./b.css"; .a { color: red }');
fs.writeFileSync(path.join(dir, 'b.css'), '.b { margin-inline: 2px; &:hover { color: blue } }');
const norm = r => JSON.stringify(r, (k, v) => v instanceof Uint8Array ? Buffer.from(v).toString() : v);
const visitor = () => ({ Length: l => (l.unit === 'px' ? { unit: 'px', value: l.value * 2 } : l) });
(async () => {
  const cases = {
    'transform (Tailwind optimize options)': css => css.transform(optimize(css.Features)),
    'transform (optimize, minify + source map)': css => css.transform({ ...optimize(css.Features), minify: true, sourceMap: true }),
    'transform with composed visitors': css => css.transform({ filename: 'v.css', code: Buffer.from('.a { width: 4px; height: 1em }'), visitor: css.composeVisitors([visitor(), visitor()]) }),
    transformStyleAttribute: css => css.transformStyleAttribute({ filename: 's.css', code: Buffer.from('color: red; inset-inline: 1px'), minify: true, targets: css.browserslistToTargets(['chrome 80', 'safari 13.1']) }),
    bundle: css => css.bundle({ filename: path.join(dir, 'a.css'), minify: true }),
    'bundleAsync (default resolver)': css => css.bundleAsync({ filename: path.join(dir, 'a.css'), minify: true }),
    'bundleAsync (async custom resolver)': css => css.bundleAsync({ filename: path.join(dir, 'a.css'), resolver: { read: async file => { await new Promise(r => setTimeout(r, 2)); return fs.readFileSync(file, 'utf8'); } } }),
    browserslistToTargets: css => css.browserslistToTargets(['chrome 100', 'ios_saf 15.4', 'op_mini all']),
    Features: css => css.Features,
    'export names': css => Object.keys(css).sort(),
  };
  const results = [];
  for (const [name, run] of Object.entries(cases)) {
    let a, b;
    try { a = norm(await run(native)); } catch (e) { a = 'threw ' + e.message; }
    try { b = norm(await run(shim)); } catch (e) { b = 'threw ' + e.message; }
    results.push({ name, same: a === b, bytes: a.length, native: a === b ? undefined : a.slice(0, 400), shim: a === b ? undefined : b.slice(0, 400) });
  }
  fs.rmSync(dir, { recursive: true });
  console.log(JSON.stringify(results));
})();`;
const run = spawnSync(process.execPath, ['-e', compare], { encoding: 'utf8' });
if (run.status !== 0) { console.error(run.stderr.slice(-3000)); process.exit(1); }
console.log('\n| shim against native lightningcss | identical | result bytes |\n|---|---|---|');
let failed = false;
for (const r of JSON.parse(run.stdout)) {
  console.log(`| ${r.name} | ${r.same ? 'yes' : 'NO'} | ${r.bytes} |`);
  if (!r.same) { failed = true; console.log(`native: ${r.native}\nshim:   ${r.shim}`); }
}
console.log(`\nload average: ${os.loadavg().map(n => n.toFixed(1)).join(' ')}`);
process.exit(failed ? 1 : 0);
