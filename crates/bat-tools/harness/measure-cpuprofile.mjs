// measure-cpuprofile.mjs <file.cpuprofile> [--top N] [--until <ms>] [--functions <group>]
//
// Aggregates a V8 CPU profile (node --cpu-prof) by package. Take one through the crawl harness:
//   node vite-crawl.mjs <app> <out> --port 4107 --env "NODE_OPTIONS=--cpu-prof --cpu-prof-dir=<abs dir>"
//
// Groups: node_modules/.bun/<pkg>@<version>/... becomes <pkg>, merged into families (babel,
// vite, rollup, esbuild, tailwind, lightningcss, react-router, ...); node: URLs are
// "node internals", split into module loading (node:internal/modules/*, compile/eval) and
// the rest; "(garbage collector)", "(idle)", "(program)" are V8's own rows. Wasm frames
// (wasm://) count for the package of the nearest JavaScript caller, marked "[wasm]".
//   self   time in frames of the group itself
//   total  time with any frame of the group on the stack (inclusive; groups overlap)
// --until <ms> cuts the profile off that many ms after its first sample (e.g. crawl done).
// --functions <group> lists that group's top functions by self time instead.
import fs from 'node:fs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; return args.splice(i, 2)[1]; };
const top = Number(option('--top', '30'));
const until = Number(option('--until', 'Infinity'));
const functionsOf = option('--functions', undefined);
const profile = JSON.parse(fs.readFileSync(args[0], 'utf8'));

const families = [
  [/^@babel\/|^babel-|^gensync$|^@jridgewell\/|^jsesc$|^react-refresh$|^debug$|^semver$|^json5$|^convert-source-map$|^browserslist$|^caniuse-lite$|^picocolors$|^js-tokens$/, 'babel (+ its deps)'],
  [/^vite$/, 'vite'],
  [/^rollup$|^@rollup\//, 'rollup'],
  [/^esbuild|^@esbuild\//, 'esbuild'],
  [/^@tailwindcss\/|^tailwindcss$|^enhanced-resolve$|^jiti$|^magic-string$|^tapable$|^graceful-fs$/, 'tailwind (+ its deps)'],
  [/^lightningcss/, 'lightningcss'],
  [/^@react-router\/|^react-router$|^react$|^react-dom$|^scheduler$/, 'react-router / react (SSR)'],
  [/^vite-tsconfig-paths$|^tsconfck$|^globrex$/, 'vite-tsconfig-paths'],
  [/^@kkrausse\//, 'browser-agent-toolkit plugin'],
];
const groupOfUrl = url => {
  if (!url) return undefined;
  if (url.startsWith('wasm://')) return 'wasm';
  if (url.startsWith('node:')) return /node:internal\/modules|node:internal\/vm|node:internal\/process\/esm_loader|node:module/.test(url) ? 'node internals: module loading' : 'node internals: other';
  const match = /node_modules\/\.bun\/((?:@[^+/]+\+)?[^@/]+)@/.exec(url);
  if (match) {
    const name = match[1].replace('+', '/');
    return families.find(([re]) => re.test(name))?.[1] ?? `other: ${name}`;
  }
  return url.includes('/workspace/') || url.startsWith('file://') || url.startsWith('/') ? 'app (config, routes, src)' : `other: ${url.slice(0, 40)}`;
};

const nodes = new Map(profile.nodes.map(node => [node.id, node]));
for (const node of profile.nodes) for (const child of node.children ?? []) nodes.get(child).parent = node.id;
// The group of each node: its own URL, or V8's pseudo-functions, with wasm handed to its caller.
const groupOf = new Map();
const resolveGroup = node => {
  if (groupOf.has(node.id)) return groupOf.get(node.id);
  const { url, functionName } = node.callFrame;
  let group = groupOfUrl(url);
  if (!group) {
    if (/^\((garbage collector|idle|program|root)\)$/.test(functionName)) group = functionName;
    else group = node.parent ? resolveGroup(nodes.get(node.parent)).replace(/ \[wasm\]$/, '') : '(native)'; // builtins: charge the caller
  } else if (group === 'wasm') {
    let up = node.parent && nodes.get(node.parent);
    while (up && up.callFrame.url.startsWith('wasm://')) up = up.parent && nodes.get(up.parent);
    group = `${(up ? resolveGroup(up) : 'unknown').replace(/ \[wasm\]$/, '')} [wasm]`;
  }
  groupOf.set(node.id, group);
  return group;
};
for (const node of profile.nodes) resolveGroup(node);

const self = new Map(), total = new Map(), functions = new Map();
let elapsed = 0, counted = 0;
profile.samples.forEach((id, index) => {
  const delta = (profile.timeDeltas[index + 1] ?? 0) / 1000; // a sample's time runs until the next sample
  if (elapsed > until) return;
  elapsed += delta;
  counted += delta;
  const node = nodes.get(id);
  const group = groupOf.get(id);
  self.set(group, (self.get(group) ?? 0) + delta);
  if (functionsOf && group.startsWith(functionsOf)) {
    const key = `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.replace(/^.*node_modules\/\.bun\/[^/]+\/node_modules\//, '')}:${node.callFrame.lineNumber + 1}`;
    functions.set(key, (functions.get(key) ?? 0) + delta);
  }
  const onStack = new Set();
  for (let up = node; up; up = up.parent && nodes.get(up.parent)) onStack.add(groupOf.get(up.id).replace(/ \[wasm\]$/, ''));
  for (const name of onStack) total.set(name, (total.get(name) ?? 0) + delta);
});

const active = counted - (self.get('(idle)') ?? 0);
const pct = ms => `${((100 * ms) / active).toFixed(1)}%`;
console.log(`profile ${args[0]}\nsampled ${counted.toFixed(0)} ms${until < Infinity ? ` (cut at ${until} ms)` : ''}, idle ${(self.get('(idle)') ?? 0).toFixed(0)} ms, active ${active.toFixed(0)} ms; shares are of active time\n`);
if (functionsOf) {
  console.log(`| ${functionsOf}: function | self ms |\n|---|---|`);
  for (const [key, ms] of [...functions].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`| ${key} | ${ms.toFixed(1)} |`);
} else {
  console.log('| group | self ms | self share | total ms (inclusive) |\n|---|---|---|---|');
  const rows = [...self].filter(([name]) => name !== '(idle)' && name !== '(root)').sort((a, b) => b[1] - a[1]);
  const shown = rows.slice(0, top), rest = rows.slice(top);
  for (const [name, ms] of shown) console.log(`| ${name} | ${ms.toFixed(0)} | ${pct(ms)} | ${name.endsWith('[wasm]') || name.startsWith('(') ? '' : (total.get(name) ?? 0).toFixed(0)} |`);
  if (rest.length) console.log(`| ${rest.length} smaller groups | ${rest.reduce((a, [, ms]) => a + ms, 0).toFixed(0)} | ${pct(rest.reduce((a, [, ms]) => a + ms, 0))} | |`);
}
