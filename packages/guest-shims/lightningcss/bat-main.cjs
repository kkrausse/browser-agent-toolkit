// lightningcss, lazily. `require('lightningcss')` here reads no Wasm: Tailwind's Vite plugin
// (@tailwindcss/node) imports { Features, transform } at startup and, in a dev server, never
// calls transform. The first call of transform / transformStyleAttribute / bundle /
// bundleAsync loads lightningcss-wasm's module (see bat-load.cjs); Features,
// browserslistToTargets and composeVisitors are plain JavaScript and never load it.
//
// Packaging: these files are laid over an installed lightningcss-wasm package by the prepare
// step (package.overlay.json points main/module/exports here; every file is named bat-* so
// nothing lightningcss-wasm ships is replaced, and .cjs/.mjs because that package is
// "type": "module"). The directory also works as a package of its own named lightningcss
// with lightningcss-wasm as a dependency (package.json).
//
// Same surface and behaviour as lightningcss-wasm's Node entry (wasm-node.mjs), including
// its visitor-function wrapper and its fs-backed default resolver for bundle().
'use strict';

let wasm;
const api = () => (wasm ??= require('./bat-load.cjs').load());

// A `visitor` given as a function receives { addDependency }; collected dependencies are
// appended to the result (as lightningcss's own entry points do).
function wrap(call, options) {
  if (typeof options.visitor !== 'function') return call(options);
  const deps = [];
  options.visitor = options.visitor({ addDependency(dep) { deps.push(dep); } });
  const append = result => {
    if (deps.length) {
      result.dependencies ??= [];
      result.dependencies.push(...deps);
    }
    return result;
  };
  const result = call(options);
  return result instanceof Promise ? result.then(append) : append(result);
}

const readFile = filePath => require('fs').readFileSync(filePath, 'utf8');

function transform(options) {
  return wrap(api().transform, options);
}

function transformStyleAttribute(options) {
  return wrap(api().transformStyleAttribute, options);
}

function bundle(options) {
  return wrap(api().bundle, { ...options, resolver: { read: readFile } });
}

async function bundleAsync(options) {
  if (!options.resolver?.read) options.resolver = { ...options.resolver, read: readFile };
  return wrap(api().bundleAsync, options);
}

const browserslistToTargets = require('./bat-vendor/browserslistToTargets.cjs');
// 11 KB that only callers passing several visitors need; loaded on first use.
function composeVisitors(visitors) {
  return require('./bat-vendor/composeVisitors.cjs')(visitors);
}
const { Features } = require('./bat-vendor/flags.cjs');

exports.transform = transform;
exports.transformStyleAttribute = transformStyleAttribute;
exports.bundle = bundle;
exports.bundleAsync = bundleAsync;
exports.browserslistToTargets = browserslistToTargets;
exports.composeVisitors = composeVisitors;
exports.Features = Features;
