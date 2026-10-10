// measure-install.mjs <app dir>
//
// Puts call-recording wrappers (measure-trace-runtime.cjs) in front of the packages the
// measurements in target-tools/notes/measure.md are about, in a scratch copy of an app tree
// (Bun isolated layout). Works on both the native tree and the tree with the old Wasm
// substitutions. Each real file is renamed to <name>.measure.real<ext> once and a wrapper
// takes its place, so re-running is safe. Records go to the file named by BAT_MEASURE_TRACE;
// with the variable unset the wrappers pass the real exports through.
//
//   lightningcss       every export, with options (native: node/index.js; wasm: wasm-node.mjs/.cjs)
//   rollup             dist/native.js (parse, parseAsync, xxhash*: the binding itself) and
//                      parseAst / parseAstAsync (binding call plus buffer -> ESTree conversion)
//   @babel/core        transform*, parse*; @babel/parser parse; @babel/traverse default;
//   @babel/generator   default; babel-dead-code-elimination both exports
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(process.argv[2] ?? '');
const bun = path.join(appDir, 'node_modules/.bun');
if (!fs.existsSync(bun)) { console.error('usage: measure-install.mjs <app dir with node_modules/.bun>'); process.exit(2); }

const runtimePath = path.join(bun, 'measure-trace-runtime.cjs');
fs.copyFileSync(path.join(here, 'measure-trace-runtime.cjs'), runtimePath);

const packageDirs = name => fs.readdirSync(bun)
  .map(entry => path.join(bun, entry, 'node_modules', name))
  .filter(dir => fs.existsSync(path.join(dir, 'package.json')) && !fs.lstatSync(dir).isSymbolicLink());
const runtimeFrom = file => JSON.stringify(path.relative(path.dirname(file), runtimePath).replace(/^(?!\.)/, './'));
const realName = file => file.replace(/(\.[cm]?js)$/, '.measure.real$1');
// Rename <file> to its .measure.real twin (once) and write the wrapper source in its place.
const front = (file, source) => {
  const real = realName(file);
  if (!fs.existsSync(real)) fs.renameSync(file, real);
  fs.writeFileSync(file, source(`./${path.basename(real)}`, runtimeFrom(file)));
  console.log('wrapped', path.relative(appDir, file));
};

const describeCss = `([options], result) => ({ options: rt.safe({ ...options, code: undefined }), inBytes: rt.bytes(options?.code), outBytes: rt.bytes(result?.code) })`;
const cssFunctions = ['transform', 'transformStyleAttribute', 'bundle', 'bundleAsync', 'browserslistToTargets', 'composeVisitors'];

// lightningcss (native): node/index.mjs imports ./index.js, so one CommonJS wrapper covers both.
for (const dir of packageDirs('lightningcss')) {
  front(path.join(dir, 'node/index.js'), (real, runtime) => `const rt = require(${runtime});
const real = rt.load('lightningcss', () => require(${JSON.stringify(real)}));
const describe = ${describeCss};
for (const name of ${JSON.stringify(cssFunctions)}) module.exports[name] = rt.timed('lightningcss', name, real[name], name === 'browserslistToTargets' || name === 'composeVisitors' ? () => ({}) : describe);
module.exports.Features = real.Features;
`);
}

// lightningcss-wasm: the tree resolves `lightningcss` to this package. Node picks
// wasm-node.mjs for import and wasm-node.cjs for require; both instantiate at load.
for (const dir of packageDirs('lightningcss-wasm')) {
  front(path.join(dir, 'wasm-node.mjs'), (real, runtime) => `import { createRequire } from 'node:module';
const rt = createRequire(import.meta.url)(${runtime});
const at = performance.now();
const real = await import(${JSON.stringify(real)});
rt.log({ pkg: 'lightningcss', api: 'load', flavor: 'wasm esm', ms: +(performance.now() - at).toFixed(3) });
const describe = ${describeCss};
const wrap = name => rt.timed('lightningcss', name, real[name], name === 'browserslistToTargets' || name === 'composeVisitors' ? () => ({}) : describe);
export default real.default;
export const transform = wrap('transform'), transformStyleAttribute = wrap('transformStyleAttribute'), bundle = wrap('bundle'), bundleAsync = wrap('bundleAsync');
export const browserslistToTargets = wrap('browserslistToTargets'), composeVisitors = wrap('composeVisitors'), Features = real.Features;
`);
  front(path.join(dir, 'wasm-node.cjs'), (real, runtime) => `const rt = require(${runtime});
const real = rt.load('lightningcss', () => require(${JSON.stringify(real)}));
const describe = ${describeCss};
for (const name of ${JSON.stringify(cssFunctions)}) module.exports[name] = rt.timed('lightningcss', name, real[name], name === 'browserslistToTargets' || name === 'composeVisitors' ? () => ({}) : describe);
module.exports.Features = real.Features;
module.exports.default = real.default;
`);
}

// rollup and @rollup/wasm-node share the layout: dist/native.js is the binding surface.
for (const dir of [...packageDirs('rollup'), ...packageDirs('@rollup/wasm-node')]) {
  front(path.join(dir, 'dist/native.js'), (real, runtime) => `const rt = require(${runtime});
const real = rt.load('rollup-binding', () => require(${JSON.stringify(real)}), ['/rollup/dist/', '/wasm-node/dist/']);
const skip = ['/rollup/dist/', '/wasm-node/dist/'];
for (const name of Object.keys(real)) module.exports[name] = rt.timed('rollup-binding', name, real[name], ([input], result) => ({ inBytes: rt.bytes(input), outBytes: rt.bytes(result) }), skip);
// Names for Node's CommonJS export detection (rollup's ES files import these by name).
0 && (module.exports = { parse, parseAsync, xxhashBase64Url, xxhashBase36, xxhashBase16, flushLlvmCoverage });
`);
  const describeParse = `([code, options], result) => ({ inBytes: rt.bytes(code), options, nodes: undefined, bodyLength: result?.body?.length })`;
  front(path.join(dir, 'dist/es/parseAst.js'), (real, runtime) => `import { createRequire } from 'node:module';
import * as real from ${JSON.stringify(real)};
const rt = createRequire(import.meta.url)(${runtime});
const skip = ['/rollup/dist/', '/wasm-node/dist/'];
const describe = ${describeParse};
export const parseAst = rt.timed('rollup', 'parseAst', real.parseAst, describe, skip);
export const parseAstAsync = rt.timed('rollup', 'parseAstAsync', real.parseAstAsync, describe, skip);
`);
  front(path.join(dir, 'dist/parseAst.js'), (real, runtime) => `const rt = require(${runtime});
const real = require(${JSON.stringify(real)});
const skip = ['/rollup/dist/', '/wasm-node/dist/'];
const describe = ${describeParse};
exports.parseAst = rt.timed('rollup', 'parseAst', real.parseAst, describe, skip);
exports.parseAstAsync = rt.timed('rollup', 'parseAstAsync', real.parseAstAsync, describe, skip);
`);
}

// Babel. All CommonJS with main ./lib/index.js; the wrapper becomes lib/index.js.
const babelSkip = `['@babel+', 'babel-dead-code-elimination@']`;
const babel = (name, relMain, wrapSource) => {
  for (const dir of packageDirs(name)) {
    front(path.join(dir, relMain), (real, runtime) => `const rt = require(${runtime});
const real = rt.load(${JSON.stringify(name)}, () => require(${JSON.stringify(real)}), ${babelSkip});
const skip = ${babelSkip};
const pkg = ${JSON.stringify(name)};
if (!rt.enabled) { module.exports = real; } else {
${wrapSource}
}
`);
  }
};
// Copy every own property descriptor (Babel's index files define getters), then replace some.
const copyAll = `  for (const key of Reflect.ownKeys(real)) Object.defineProperty(exports, key, { ...Object.getOwnPropertyDescriptor(real, key), configurable: true });
  const replace = (name, describe) => { if (typeof real[name] === 'function') Object.defineProperty(exports, name, { enumerable: true, configurable: true, writable: true, value: rt.timed(pkg, name, real[name], describe, skip) }); };`;
babel('@babel/core', 'lib/index.js', `${copyAll}
  const describe = ([code, options], result) => ({ inBytes: rt.bytes(typeof code === 'string' ? code : undefined), filename: options?.filename, plugins: options?.plugins?.length, outBytes: rt.bytes(result?.code) });
  for (const name of ['transform', 'transformSync', 'transformAsync', 'transformFromAst', 'transformFromAstSync', 'transformFromAstAsync', 'transformFile', 'transformFileSync', 'transformFileAsync', 'parse', 'parseSync', 'parseAsync', 'loadOptions', 'loadOptionsSync', 'loadOptionsAsync', 'loadPartialConfig', 'loadPartialConfigSync', 'loadPartialConfigAsync']) replace(name, describe);`);
babel('@babel/parser', 'lib/index.js', `${copyAll}
  const describe = ([code, options]) => ({ inBytes: rt.bytes(code), sourceType: options?.sourceType, plugins: options?.plugins });
  replace('parse', describe); replace('parseExpression', describe);`);
babel('@babel/traverse', 'lib/index.js', `${copyAll}
  replace('default', ([ast, visitor]) => ({ root: ast?.type, visitorKeys: visitor && Object.keys(visitor).length }));`);
babel('@babel/generator', 'lib/index.js', `${copyAll}
  const describe = ([ast], result) => ({ root: ast?.type, outBytes: rt.bytes(result?.code) });
  replace('default', describe); replace('generate', describe);`);
babel('babel-dead-code-elimination', 'dist/index.cjs', `${copyAll}
  replace('deadCodeElimination', () => ({})); replace('findReferencedIdentifiers', () => ({}));
  replace('default', () => ({}));`);
