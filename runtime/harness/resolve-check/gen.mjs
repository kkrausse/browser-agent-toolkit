// Generates resolver comparison cases by asking real Node.
// usage: node --experimental-import-meta-resolve gen.mjs <todo-app dir> <fixture dir> <out dir> [extra conds]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, isBuiltin, findPackageJSON } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [T, FX, OUT] = process.argv.slice(2, 5).map((p) => fs.realpathSync(p));
const CONDS = process.argv[5] ?? 'module-sync';
const map = (p) => (p.startsWith(T + '/') || p === T ? '/workspace' + p.slice(T.length) : p.startsWith(FX + '/') || p === FX ? '/fx' + p.slice(FX.length) : 'OUTSIDE:' + p);
const errno = (e) => ({
  MODULE_NOT_FOUND: 'ENOENT', ERR_MODULE_NOT_FOUND: 'ENOENT', ERR_PACKAGE_PATH_NOT_EXPORTED: 'EACCES',
  ERR_PACKAGE_IMPORT_NOT_DEFINED: 'EACCES', ERR_INVALID_MODULE_SPECIFIER: 'EINVAL', ERR_INVALID_PACKAGE_TARGET: 'EINVAL',
  ERR_UNSUPPORTED_DIR_IMPORT: 'DIR',
}[e?.code] ?? 'OTHER:' + e?.code);
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

const cjs = (importer, spec) => {
  try { return map(createRequire(importer).resolve(spec)); } catch (e) { return errno(e); }
};
let lenient = 0, byRule = 0;
// The kernel's documented leniency for path requests, restated: exact file,
// TypeScript behind a JavaScript name, the extension list, then directory.
const EXTS = ['.js', '.json', '.node', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsx'];
const TS = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };
const asFile = (x) => {
  if (isFile(x)) return x;
  const e = path.extname(x);
  for (const t of TS[e] ?? []) if (isFile(x.slice(0, -e.length) + t)) return x.slice(0, -e.length) + t;
  for (const t of EXTS) if (isFile(x + t)) return x + t;
};
const asIndex = (x) => ['index.js', 'index.json', 'index.node', 'index.mjs', 'index.cjs', 'index.ts', 'index.tsx'].map((i) => path.join(x, i)).find(isFile);
const asDir = (x) => {
  let main; try { main = JSON.parse(fs.readFileSync(path.join(x, 'package.json'), 'utf8')).main; } catch {}
  if (typeof main === 'string' && main) { const m = path.resolve(x, main); const r = asFile(m) ?? asIndex(m); if (r) return r; }
  return asIndex(x);
};
const isPathSpec = (s) => /^(\.\.?(\/|$)|\/|file:)/.test(s);
const rule = (importer, spec, got) => {
  if (got.startsWith('/') || !isPathSpec(spec)) return got;
  const x = spec.startsWith('file:') ? fileURLToPath(spec.replace(/[?#].*$/, '')) : path.resolve(path.dirname(importer), spec);
  const r = (/(^|\/)\.{0,2}$/.test(spec) ? undefined : asFile(x)) ?? asDir(x);
  if (!r) return got;
  byRule++;
  return map(fs.realpathSync(r));
};
const esm = (importer, spec) => {
  let r;
  try {
    const u = import.meta.resolve(spec, pathToFileURL(importer));
    if (!u.startsWith('file:')) return u;
    const p = fileURLToPath(u);
    if (isFile(p)) return map(p);
    // import settled on this location; the kernel still probes around it
    if (spec.startsWith('#')) return 'ENOENT';
    const l = (spec.endsWith('/') ? undefined : asFile(p)) ?? asDir(p);
    if (l) lenient++;
    return l ? map(fs.realpathSync(l)) : 'ENOENT';
  } catch (e) { r = errno(e); }
  // The kernel resolver probes extensions and directories in import mode too.
  if ((r === 'ENOENT' || r === 'DIR') && !spec.startsWith('#')) {
    const c = cjs(importer, spec);
    if (c.startsWith('/')) { lenient++; return c; }
    return 'ENOENT';
  }
  return r === 'DIR' ? 'ENOENT' : r;
};

const rows = new Set();
// Node's own nearest-package.json lookup for a resolved file: its path and `type`.
const unmap = (p) => (p.startsWith('/workspace') ? T + p.slice(10) : FX + p.slice(3));
const scopeCache = new Map();
const scope = (res) => {
  if (!res.startsWith('/')) return res;
  const host = unmap(res);
  const dir = path.dirname(host);
  if (!scopeCache.has(dir)) {
    const pj = findPackageJSON(pathToFileURL(host));
    let t = 0;
    if (pj) try { const ty = JSON.parse(fs.readFileSync(pj, 'utf8')).type; t = ty === 'commonjs' ? 1 : ty === 'module' ? 2 : 0; } catch { console.log('unparseable', pj); }
    scopeCache.set(dir, t + '\t' + (pj && path.basename(pj) === 'package.json' ? map(pj) : 'ENOENT')); // (findPackageJSON answers with the file itself when there is no package.json below node_modules)
  }
  return res + '\t' + scopeCache.get(dir);
};
const add = (importer, spec, dirFlag = 0) => {
  if (!spec || isBuiltin(spec) || spec.includes('\t') || spec.includes('\n')) return;
  const real = dirFlag ? path.join(importer, '__x.js') : importer;
  const imp = map(importer);
  // specifiers that name host paths are rewritten to the guest's
  const gs = spec.startsWith('/') ? map(spec) : spec.startsWith('file://') ? 'file://' + encodeURI(map(fileURLToPath(spec.replace(/[?#].*$/, '')))) + (spec.match(/[?#].*$/)?.[0] ?? '') : spec;
  rows.add([0 | dirFlag, CONDS, imp, gs, scope(rule(real, spec, cjs(real, spec)))].join('\t'));
  rows.add([1 | dirFlag, CONDS, imp, gs, scope(rule(real, spec, esm(real, spec)))].join('\t'));
};

// 1. the named list, from the app root
const root = path.join(T, 'vite.config.ts');
for (const s of ['vite', 'vite/package.json', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/server', 'react-dom/client',
  '@babel/core', 'typescript', 'typescript/lib/typescript.js', 'rollup', 'rollup/parseAst', 'esbuild', 'picocolors', 'react-router', 'react-router/dom',
  '@react-router/dev', '@react-router/dev/vite', '@react-router/dev/config', 'tailwindcss', '@tailwindcss/vite', 'valibot', 'pdf-lib', 'vite-tsconfig-paths',
  '@tanstack/react-query', '@trpc/client', '@trpc/server', '@trpc/server/adapters/fetch', 'concurrently', 'no-such-package', '@no/such', 'react/not-exported',
  'vite/dist/node/index.js', 'react/', 'vite/', './package.json', './vite.config.ts', './vite.config', '.', './', '..', './node_modules/react', './node_modules/react/',
  './node_modules/react/index', './node_modules/typescript/lib/typescript', './node_modules/typescript/package', '@', '@babel', 'react/package.json']) add(root, s);
add(T, 'react', 2); add(T, './package.json', 2); add(path.join(T, 'node_modules'), 'react', 2);

// 2. every package in the store: self-reference, own exports/imports keys, each dependency and its exports keys
const store = path.join(T, 'node_modules/.bun');
const pkgDirs = [];
for (const s of fs.readdirSync(store)) {
  const nm = path.join(store, s, 'node_modules');
  if (!fs.existsSync(nm)) continue;
  for (const n of fs.readdirSync(nm)) {
    if (n.startsWith('.')) continue;
    if (n.startsWith('@')) for (const m of fs.readdirSync(path.join(nm, n))) pkgDirs.push([path.join(nm, n, m), n + '/' + m]);
    else pkgDirs.push([path.join(nm, n), n]);
  }
}
const readPkg = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch { return null; } };
const expKeys = (pj) => (pj?.exports && typeof pj.exports === 'object' && !Array.isArray(pj.exports) ? Object.keys(pj.exports).filter((k) => k.startsWith('.')) : []);
const subs = (name, pj, d) => {
  const out = [name, name + '/package.json', name + '/not/exported/anywhere'];
  for (const k of expKeys(pj)) {
    if (!k.includes('*')) out.push(name + k.slice(1));
    else if (d) {
      // instantiate a pattern with a real file when the target makes that easy
      const t = JSON.stringify(pj.exports[k]).match(/"(\.\/[^"*]*)\*([^"*]*)"/);
      if (t) try {
        const dir = path.join(d, t[1]);
        const f = fs.readdirSync(dir).find((f) => f.endsWith(t[2]) && f.length > t[2].length);
        if (f) out.push(name + k.slice(1).replace('*', f.slice(0, f.length - t[2].length)));
      } catch {}
    }
  }
  return out;
};
for (const [d, name] of pkgDirs) {
  let real; try { real = fs.realpathSync(d); } catch { continue; }
  if (real !== d) continue; // sibling symlinks are reached as dependencies
  const pj = readPkg(d);
  if (!pj) continue;
  const importer = path.join(d, '__importer__.js');
  for (const s of subs(name, pj, d)) add(importer, s);
  for (const k of Object.keys(pj.imports ?? {})) add(importer, k.replace('*', 'x'));
  add(importer, '#not-defined');
  if (typeof pj.main === 'string') { add(importer, './' + pj.main.replace(/^\.\//, '').replace(/\.[cm]?js$/, '')); add(importer, './' + pj.main.replace(/^\.\//, '')); }
  add(importer, './package.json'); add(importer, './package'); add(importer, '.'); add(importer, './'); add(importer, './lib'); add(importer, './dist'); add(importer, './src/index');
  // from a nested directory too (the walk passes through the package's own directory)
  const deep = path.join(d, 'lib/deep/__importer__.js');
  for (const dep of Object.keys({ ...pj.dependencies, ...pj.peerDependencies, ...pj.optionalDependencies })) {
    const dd = path.join(path.dirname(d.slice(0, d.length - name.length)), 'node_modules', dep);
    const dpj = readPkg(dd);
    for (const s of subs(dep, dpj, dpj ? dd : null)) add(importer, s);
    add(deep, dep);
  }
}

// 3. the fixture
const F = (p) => path.join(FX, p);
const specs = ['fxpkg', 'fxpkg/feat/a', 'fxpkg/feat/internal/z', 'fxpkg/package.json', 'fxpkg/gone', 'fxpkg/src/index.js', '#dep', '#depsub', '#local', '#int/q', '#int/deep/r',
  '#int/nope', '#missingfile', '#null', '#undefined', '#', '#/x', '#scoped/a', '#scoped/nope', 'dep', 'dep/', 'dep/sub', 'dep/sub/', 'dep/sub/x', 'dep/sub/x.js', 'dep/data', 'dep/data.json', 'dep/lib/main',
  'dep/package.json', '@sc/exp', '@sc/exp/a', '@sc/exp/pat/a.js', '@sc/exp/pat/a', '@sc/exp/pat/i', '@sc/exp/arr', '@sc/exp/onlyimport', '@sc/exp/dev', '@sc/exp/hidden.js', '@sc/exp/package.json',
  '@sc/exp/cjs/a.js', '@sc', '@sc/', 'nopkg', 'nopkg/other', 'nopkg/other.js', 'nopkg/nope', 'jsonmain', 'typed', 'symlinked', 'symlinked/index.js', 'symlinked/package.json', 'peer', 'shadow',
  './index.js', './index', './both', './both/', './both.js', './sub', './sub/', './sub2', './sub3', './noext', './dir', './cjs/x', './cjs/x.js', './nope', '../package.json', '../package',
  '..', '../', '.', './', './feat/a', './feat/a.mjs', './sp ace/é.js', './sp ace/é', F('src/index.js'), F('src/index'), F('src/sub'), F('nope'),
  pathToFileURL(F('src/index.js')).href, pathToFileURL(F('src/sp ace/é.js')).href, pathToFileURL(F('src/nope.js')).href, pathToFileURL(F('src/index.js')).href + '?q=1#h'];
for (const imp of ['src/__i.js', 'src/inner/x.js', 'src/cjs/x.js', 'store/symlinked/index.js', 'node_modules/@sc/exp/cjs/i.js', 'node_modules/dep/lib/main.js', '__root.js'])
  for (const s of specs) add(F(imp), s);
add(F('src'), './index.js', 2); add(F('src'), 'dep', 2); add(F(''), '#dep', 2);

// 4. TypeScript leniency (not Node behaviour; expectations by rule)
const hand = [['./a', '/fx/src/a.ts'], ['./a.js', '/fx/src/a.ts'], ['./a.ts', '/fx/src/a.ts'], ['./comp', '/fx/src/comp.tsx'], ['./comp.js', '/fx/src/comp.tsx'], ['./comp.jsx', '/fx/src/comp.tsx'],
  ['./m.mjs', '/fx/src/m.mts'], ['./m', '/fx/src/m.mts'], ['./c.cjs', '/fx/src/c.cts'], ['./dir', '/fx/src/dir/index.tsx'], ['./dir/', '/fx/src/dir/index.tsx'], ['./dir/index.js', '/fx/src/dir/index.tsx'],
  ['#builtin', 'node:fs']];
for (const [s, want] of hand) for (const f of [0, 1]) rows.add([f, CONDS, '/fx/src/__i.js', s, want].join('\t'));

// 5. preserve-symlinks (flag bit 2): the path as found, not its real path
for (const [f, imp, sp, want] of [[4, '/fx/src/__i.js', 'symlinked', '/fx/node_modules/symlinked/index.js'], [5, '/fx/src/__i.js', 'symlinked/package.json', '/fx/node_modules/symlinked/package.json'],
  [5, '/workspace/vite.config.ts', 'react', '/workspace/node_modules/react/index.js'], [4, '/workspace/vite.config.ts', 'react/jsx-runtime', '/workspace/node_modules/react/jsx-runtime.js'],
  [6, '/workspace', './node_modules/react', '/workspace/node_modules/react/index.js']]) rows.add([f, CONDS, imp, sp, want].join('\t'));
const list = [...rows];
const outside = list.filter((r) => r.includes('OUTSIDE:') || r.includes('OTHER:'));
fs.writeFileSync(path.join(OUT, 'cases.tsv'), list.filter((r) => !outside.includes(r)).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'skipped.tsv'), outside.join('\n') + '\n');

const ov = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isSymbolicLink()) ov.push(['L', map(p), fs.readlinkSync(p)].join('\t'));
    else if (e.isDirectory()) walk(p);
    else ov.push(['F', map(p), p].join('\t'));
  }
};
walk(FX);
fs.writeFileSync(path.join(OUT, 'overlay.tsv'), ov.join('\n') + '\n');
const tally = {};
for (const r of list) { const e = r.split('\t')[4]; const k = e.startsWith('/') ? 'path' : e.split(':')[0]; tally[k] = (tally[k] ?? 0) + 1; }
console.log({ cases: list.length - outside.length, skipped: outside.length, lenientEsm: lenient, byRule, tally });
