// Shared by the wrappers measure-install.mjs puts in front of lightningcss, rollup and Babel.
// Every wrapped call becomes one JSON line in the file named by BAT_MEASURE_TRACE:
//   { pid, at, pkg, api, ms, depth, caller, ...describe(args, result) }
// `depth` counts wrapped calls already on the stack (0 = called from unwrapped code), so
// nested work (parseAst -> native parse, transformAsync -> parse/traverse/generate) is not
// summed twice. `caller` is the first stack frame outside the wrappers and outside the
// wrapped package itself. With the variable unset the wrappers hand back the real exports.
'use strict';
const fs = require('fs');
const { performance } = require('perf_hooks');

const out = process.env.BAT_MEASURE_TRACE;
const enabled = Boolean(out);
let depth = 0;

const log = record => {
  if (enabled) fs.appendFileSync(out, JSON.stringify({ pid: process.pid, at: +performance.now().toFixed(2), ...record }) + '\n');
};

// Frames of the stack that are not ours and not node internals, innermost first.
const frames = (skip = []) => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const stack = new Error().stack.split('\n').slice(1).map(line => line.trim().replace(/^at /, ''));
  Error.stackTraceLimit = limit;
  return stack
    .filter(line => !/measure-trace|\.measure\.|node:internal|\(node:|^node:|^async Promise\.all/.test(line))
    .filter(line => !skip.some(part => line.includes(part)))
    .map(line => line.replace(/\(?(?:file:\/\/)?\/[^\s)]*node_modules\/\.bun\/([^/]+)\/node_modules\//, '($1:').replace(/file:\/\//, ''));
};
const caller = skip => frames(skip).slice(0, 4).join(' < ');

const timed = (pkg, api, fn, describe = () => ({}), skip = []) => {
  if (!enabled || typeof fn !== 'function') return fn;
  const wrapped = function (...args) {
    const from = depth === 0 ? caller(skip) : undefined;
    const at = performance.now();
    const myDepth = depth++;
    let sync = true;
    const finish = (result, error) => {
      let extra;
      try { extra = describe(args, result); } catch (e) { extra = { describeError: String(e) }; }
      log({ pkg, api, ms: +(performance.now() - at).toFixed(3), depth: myDepth, async: sync ? undefined : true, caller: from, ...extra, error: error ? String(error.message ?? error).slice(0, 300) : undefined });
    };
    let result;
    try { result = new.target ? new fn(...args) : fn.apply(this, args); } catch (error) { depth--; finish(undefined, error); throw error; }
    depth--;
    if (result && typeof result.then === 'function') {
      sync = false;
      return result.then(v => { finish(v); return v; }, e => { finish(undefined, e); throw e; });
    }
    finish(result);
    return result;
  };
  // Functions such as @babel/traverse's default carry properties (visitors, cache, ...).
  for (const key of Reflect.ownKeys(fn)) {
    if (key === 'length' || key === 'name' || key === 'prototype' || key === 'arguments' || key === 'caller') continue;
    try { Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(fn, key)); } catch {}
  }
  wrapped.prototype = fn.prototype;
  return wrapped;
};

// Time loading the real module and say who asked for it.
const load = (pkg, loader, skip = []) => {
  if (!enabled) return loader();
  const from = frames(skip).slice(0, 8).join(' < ');
  const memory = process.memoryUsage();
  const at = performance.now();
  const real = loader();
  const after = process.memoryUsage();
  log({ pkg, api: 'load', ms: +(performance.now() - at).toFixed(3), rssDeltaMb: +((after.rss - memory.rss) / 1048576).toFixed(1), caller: from });
  return real;
};

const bytes = value => (typeof value === 'string' ? Buffer.byteLength(value) : value?.length ?? value?.byteLength);
const safe = value => JSON.parse(JSON.stringify(value, (key, v) => {
  if (typeof v === 'function') return `[function ${v.name}]`;
  if (v instanceof RegExp) return `[regexp ${v}]`;
  if (v instanceof Uint8Array) return `[bytes ${v.length}]`;
  if (typeof v === 'string' && v.length > 200) return `[string ${v.length}]`;
  return v;
}) ?? 'null');

module.exports = { enabled, log, timed, load, caller, frames, bytes, safe };
