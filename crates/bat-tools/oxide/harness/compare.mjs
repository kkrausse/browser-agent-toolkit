// Differential: the Wasm shim against the native @tailwindcss/oxide binding, in one process,
// on one app tree. Exits 1 and prints every difference when anything differs.
//
//   node compare.mjs <app dir> [--native <dir of native @tailwindcss/oxide>] [--shim <dir>] [--json]
//
// Run it where the app sits at the path the guest sees, e.g.
//   crates/bat-tools/harness/ws.sh <app copy> node <abs path>/compare.mjs /workspace
// The first source set is what @tailwindcss/vite 4.3.3 passes for the TODO app (traced:
// `@import 'tailwindcss'` with no source(), so `{ base: <vite root>, pattern: '**/*' }`);
// the others exercise explicit globs, a dependency source and negation.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; const [, v] = args.splice(i, 2); return v; };
const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const asJson = flag('--json');
const shimDir = path.resolve(option('--shim', path.join(here, '../../../../packages/guest-shims/tailwindcss-oxide')));
const app = path.resolve(args[0] ?? '.');
const nativeDir = path.resolve(option('--native', path.join(app, 'node_modules/.bun/@tailwindcss+oxide@4.3.3/node_modules/@tailwindcss/oxide')));
const require = createRequire(import.meta.url);
const native = require(nativeDir);
const shim = require(shimDir);
process.chdir(app);

const sourceSets = {
  'vite plugin (traced)': [{ base: app, pattern: '**/*', negated: false }],
  'explicit globs + negation': [
    { base: path.join(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false },
    { base: path.join(app, 'src'), pattern: 'server/**', negated: true },
    { base: app, pattern: 'node_modules/@trpc/client', negated: false },
  ],
  'relative base, single file': [{ base: 'src', pattern: 'home.tsx', negated: false }],
  'no sources': [],
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out); else if (entry.isFile()) out.push(full);
  }
  return out;
}
const sourceFiles = walk(path.join(app, 'src')).sort();
const differences = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(label, a, b) {
  if (same(a, b)) return true;
  const detail = { label };
  if (Array.isArray(a) && Array.isArray(b)) {
    const key = v => JSON.stringify(v);
    const setA = new Set(a.map(key)), setB = new Set(b.map(key));
    detail.nativeCount = a.length; detail.wasmCount = b.length;
    detail.onlyNative = a.filter(v => !setB.has(key(v))).slice(0, 20);
    detail.onlyWasm = b.filter(v => !setA.has(key(v))).slice(0, 20);
    if (!detail.onlyNative.length && !detail.onlyWasm.length) detail.note = 'same members, different order or multiplicity';
  } else { detail.native = a; detail.wasm = b; }
  differences.push(detail);
  return false;
}
const sorted = list => [...list].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
const counts = {};

for (const [name, sources] of Object.entries(sourceSets)) {
  const n = new native.Scanner({ sources });
  const w = new shim.Scanner({ sources });
  const tag = what => `[${name}] ${what}`;
  const scanN = n.scan(), scanW = w.scan();
  // Candidates come back sorted from both; compared exactly, order included.
  check(tag('scan()'), scanN, scanW);
  // `files` and `scannedFiles` are hash-set iteration order (pointer-width dependent): compared sorted.
  const filesN = n.files, filesW = w.files;
  check(tag('files (sorted)'), sorted(filesN), sorted(filesW));
  check(tag('scannedFiles (sorted)'), sorted(n.scannedFiles), sorted(w.scannedFiles));
  const globsOrder = same(n.globs, w.globs);
  check(tag('globs (sorted)'), sorted(n.globs), sorted(w.globs));
  check(tag('normalizedSources'), n.normalizedSources, w.normalizedSources);
  check(tag('second scan()'), n.scan(), w.scan());
  check(tag('files after second scan (sorted)'), sorted(n.files), sorted(w.files));

  let scanFilesCalls = 0, positionCalls = 0, positions = 0;
  const targets = [...new Set([...sourceFiles, ...filesN])].sort();
  for (const file of targets) {
    const extension = path.extname(file).slice(1);
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    check(tag(`getCandidatesWithPositions({file}) ${file}`), attempt(() => n.getCandidatesWithPositions({ file, extension })), attempt(() => w.getCandidatesWithPositions({ file, extension })));
    const pN = n.getCandidatesWithPositions({ content, extension }), pW = w.getCandidatesWithPositions({ content, extension });
    check(tag(`getCandidatesWithPositions({content}) ${file}`), pN, pW);
    positionCalls += 2; positions += pN.length;
    // Fresh scanners too, so the result is not "nothing new" on both sides.
    const fn = new native.Scanner({ sources }), fw = new shim.Scanner({ sources });
    check(tag(`fresh scanFiles([{file}]) ${file}`), fn.scanFiles([{ file, extension }]), fw.scanFiles([{ file, extension }]));
    check(tag(`fresh scanFiles([{content}]) ${file}`), fn.scanFiles([{ content, extension }]), fw.scanFiles([{ content, extension }]));
    check(tag(`scanFiles([{file}]) after scan ${file}`), n.scanFiles([{ file, extension }]), w.scanFiles([{ file, extension }]));
    check(tag(`scanFiles([{content}]) after scan ${file}`), n.scanFiles([{ content: content + ' underline text-[13px] bat-[oxide]', extension }]), w.scanFiles([{ content: content + ' underline text-[13px] bat-[oxide]', extension }]));
    scanFilesCalls += 4;
  }
  const batch = sourceFiles.map(file => ({ file, extension: path.extname(file).slice(1) }));
  check(tag('scanFiles(all source files) on a fresh scanner'), new native.Scanner({ sources }).scanFiles(batch), new shim.Scanner({ sources }).scanFiles(batch));
  check(tag('files after scanFiles (sorted)'), sorted(n.files), sorted(w.files));
  check(tag('non-ASCII positions'), n.getCandidatesWithPositions({ content: '<p class="flex 🔥 p-4 é underline">', extension: 'html' }), w.getCandidatesWithPositions({ content: '<p class="flex 🔥 p-4 é underline">', extension: 'html' }));
  counts[name] = { candidates: scanN.length, files: filesN.length, globs: n.globs.length, globsSameOrder: globsOrder, filesSameOrder: same(filesN, filesW), targets: targets.length, scanFilesCalls, positionCalls, positions };
}
function attempt(fn) { try { return fn(); } catch (error) { return { threw: true }; } }

const report = { app, native: nativeDir, shim: shimDir, node: process.version, sourceFiles: sourceFiles.length, counts, identical: differences.length === 0, differences };
if (asJson) console.log(JSON.stringify(report, null, 1));
else {
  console.log(`app ${app}\nnative ${nativeDir}\nshim ${shimDir}\nnode ${process.version}`);
  for (const [name, c] of Object.entries(counts)) console.log(`${name}: ${JSON.stringify(c)}`);
  console.log(differences.length ? `DIFFERENT: ${differences.length} difference(s)` : 'IDENTICAL');
  for (const d of differences.slice(0, 40)) console.log(JSON.stringify(d).slice(0, 1500));
}
process.exit(differences.length ? 1 : 0);
