// Differential check of the esbuild shim against recorded calls of the real esbuild.
//
//   node replay-esbuild.mjs <esbuild-trace.jsonl> <app dir with the shim installed> [--show]
//
// Every recorded transform()/build() (inputs, options, real result: see esbuild-trace.cjs)
// is replayed through the shim. Outputs are compared as syntax trees (Babel's parser from
// the app's tree), positions and comments ignored, after undoing the three places where
// oxc's printer legitimately differs from esbuild's:
//   - the JSX runtime import is aliased (`jsxDEV as _jsxDEV`),
//   - JSX source locations name the file through one `var _jsxFileName`,
//   - the JSX runtime import is placed after the other imports,
// and the two rewrites esbuild applies even without minification and oxc does not:
//   - a global `undefined` is printed as `void 0`,
//   - comparisons of two string literals (left behind by `define`) are folded to a boolean,
//   - `"a" + "b"` is folded to one string,
//   - a binding that shadows an outer name gets a numeric suffix (`value` -> `value2`):
//     identifier names are compared without trailing digits,
//   - a module left without statements gets `export {}` (and then an empty map),
//   - a template literal without substitutions is printed as a string; template text is re-escaped.
// Anything else that differs is printed.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [traceFile, appDir] = process.argv.slice(2);
const show = process.argv.includes('--show');
const appRequire = createRequire(fs.realpathSync(path.resolve(appDir, 'node_modules/@react-router/dev/package.json')));
const parser = appRequire('@babel/parser');
const viteDir = fs.realpathSync(path.resolve(appDir, 'node_modules/vite'));
const shim = createRequire(viteDir + '/')('esbuild');

function normalize(code) {
  const ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx'] }).program;
  const aliases = new Map(); // local name -> imported name, for underscore-prefixed runtime imports
  let fileName;
  ast.body = ast.body.filter(node => {
    if (node.type === 'ImportDeclaration') for (const s of node.specifiers) {
      if (s.type === 'ImportSpecifier' && s.local.name === '_' + s.imported.name) { aliases.set(s.local.name, s.imported.name); s.local.name = s.imported.name; }
    }
    if (node.type === 'VariableDeclaration' && node.declarations.length === 1 && node.declarations[0].id.name === '_jsxFileName') { fileName = node.declarations[0].init.value; return false; }
    return true;
  });
  const imports = ast.body.filter(n => n.type === 'ImportDeclaration');
  const rest = ast.body.filter(n => n.type !== 'ImportDeclaration' && !(n.type === 'ExportNamedDeclaration' && !n.declaration && !n.source && n.specifiers.length === 0));
  const clean = node => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'Identifier' && node.name === '_jsxFileName' && fileName !== undefined) return { type: 'StringLiteral', value: fileName };
    if (node.type === 'Identifier' && aliases.has(node.name)) return { type: 'Identifier', name: aliases.get(node.name) };
    if (node.type === 'Identifier' || node.type === 'JSXIdentifier') return { type: node.type, name: node.name.replace(/\d+$/, '') };
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return { type: 'StringLiteral', value: node.quasis[0].value.cooked }; // esbuild prints these as strings
    if (node.type === 'TemplateElement') return { type: node.type, cooked: node.value.cooked, tail: node.tail }; // esbuild re-escapes the raw text
    if (node.type === 'ParenthesizedExpression') return clean(node.expression);
    if (node.type === 'UnaryExpression' && node.operator === 'void' && node.argument.type === 'NumericLiteral') return { type: 'Identifier', name: 'undefined' };
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (['start', 'end', 'loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'shorthand'].includes(key)) continue;
      out[key] = clean(value);
    }
    if (out.type === 'ImportDeclaration') out.specifiers = out.specifiers.map(x => JSON.stringify(x)).sort();
    if (out.type === 'BinaryExpression' && out.left.type === 'StringLiteral' && out.right.type === 'StringLiteral') {
      if (/^[!=]==?$/.test(out.operator)) return { type: 'BooleanLiteral', value: (out.left.value === out.right.value) === out.operator.startsWith('=') };
      if (out.operator === '+') return { type: 'StringLiteral', value: out.left.value + out.right.value };
    }
    return out;
  };
  const key = n => JSON.stringify(clean(n));
  return [...imports.map(key).sort(), ...rest.map(key)];
}

function firstDifference(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) {
    const x = a[i] ?? '', y = b[i] ?? '';
    let j = 0; while (j < x.length && x[j] === y[j]) j++;
    return `statement ${i}: …${x.slice(Math.max(0, j - 80), j + 120)}…\n      vs …${y.slice(Math.max(0, j - 80), j + 120)}…`;
  }
}

const records = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
let same = 0, different = 0, mapsChecked = 0, nativeMs = 0, shimMs = 0, seen = new Set();
for (const record of records) {
  if (record.api !== 'transform' && record.api !== 'transformSync') continue;
  const name = record.options.sourcefile ?? '<stdin>';
  const start = performance.now();
  const out = await shim.transform(record.input, record.options);
  const ms = performance.now() - start;
  shimMs += ms; nativeMs += record.ms;
  const id = name + JSON.stringify(record.options);
  const difference = firstDifference(normalize(record.result.code), normalize(out.code));
  if (difference) different++; else same++;
  // The map must be a version 3 map of the same single source with its content.
  if (record.options.sourcemap) {
    const expected = JSON.parse(record.result.map), actual = JSON.parse(out.map);
    const ok = (expected.sources.length === 0 && out.code.trim() === '') || actual.version === 3 && JSON.stringify(actual.sources) === JSON.stringify(expected.sources) && actual.sourcesContent?.[0] === expected.sourcesContent?.[0] && actual.mappings.length > 0;
    if (!ok) { different++; console.log(`MAP differs: ${name}: sources ${JSON.stringify(actual.sources)} vs ${JSON.stringify(expected.sources)}`); } else mapsChecked++;
  }
  if (!seen.has(id)) {
    seen.add(id);
    console.log(`${difference ? 'DIFF' : 'same'} ${ms.toFixed(2).padStart(7)} ms (real ${String(record.ms).padStart(7)} ms) ${name.slice(-70)}${difference ? '\n      ' + difference : ''}`);
    if (show) console.log(out.code);
  }
}
for (const record of records) {
  if (record.api !== 'build') continue;
  console.log(`build ${JSON.stringify(record.options.entryPoints)}: recorded metafile inputs ${JSON.stringify(Object.keys(record.result.metafile?.inputs ?? {}))} (replayed by the dev server run, not here: plugins are functions)`);
}
console.log(JSON.stringify({ transforms: same + different, same, different, mapsChecked, shimMs: +shimMs.toFixed(1), realMs: +nativeMs.toFixed(1) }));
process.exit(different ? 1 : 0);
