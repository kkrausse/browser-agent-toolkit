// Record real esbuild transforms over a corpus of source files, in esbuild-trace.jsonl form,
// so replay-esbuild.mjs can compare the shim on more than one app's files.
//   node corpus-trace.mjs <app dir with real esbuild> <out.jsonl> <dir>...
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [appDir, outFile, ...dirs] = process.argv.slice(2);
const esbuild = createRequire(fs.realpathSync(path.resolve(appDir, 'node_modules/vite')) + '/')('esbuild');
const base = { sourcemap: true, target: 'esnext', charset: 'utf8', legalComments: 'none', minify: false, minifyIdentifiers: false, minifySyntax: false, minifyWhitespace: false, treeShaking: false, keepNames: false, supported: { 'dynamic-import': true, 'import-meta': true } };
// Vite's dev options for this app, then the other branches of the option mapping.
const variants = [
  { ...base, jsxDev: true, jsx: 'automatic', tsconfigRaw: { compilerOptions: { target: 'ESNext', verbatimModuleSyntax: true } } },
  { ...base, tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', useDefineForClassFields: false } } },
  { ...base, tsconfigRaw: { compilerOptions: { jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment', target: 'ES2020' } }, define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'true' } },
];
const files = [];
const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'dist' || entry.name === 'build') continue;
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) walk(full); else if (/\.(m?[jt]s|[jt]sx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(full);
} };
dirs.forEach(walk);
fs.writeFileSync(outFile, '');
let failed = 0;
for (const file of files) for (const [index, variant] of variants.entries()) {
  const input = fs.readFileSync(file, 'utf8');
  const ext = path.extname(file).slice(1);
  const options = { ...variant, sourcefile: file, loader: ext === 'mjs' ? 'js' : ext === 'mts' ? 'ts' : ext };
  const start = performance.now();
  try {
    const result = await esbuild.transform(input, options);
    fs.appendFileSync(outFile, JSON.stringify({ api: 'transform', variant: index, ms: +(performance.now() - start).toFixed(2), input, options, result: { code: result.code, map: result.map, warnings: result.warnings } }) + '\n');
  } catch (error) { failed++; console.log(`real esbuild rejects ${file} (variant ${index}): ${String(error.message).split('\n')[1]}`); }
}
console.log(`${files.length} files x ${variants.length} option sets recorded, ${failed} rejected by real esbuild`);
await esbuild.stop?.();
