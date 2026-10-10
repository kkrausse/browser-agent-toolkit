// Wraps an esbuild-shaped package and records every API call as a JSON line.
// Installed by install-trace.sh as the package's main; the real main stays main.js (esbuild checks its own file name).
// Active only when BAT_ESBUILD_TRACE names a file.
const real = require('./main.js');
const out = process.env.BAT_ESBUILD_TRACE;
if (!out) {
  module.exports = real;
} else {
  const fs = require('fs');
  const { performance } = require('perf_hooks');
  const safe = value => JSON.parse(JSON.stringify(value, (_, v) => {
    if (typeof v === 'function') return `[function ${v.name}]`;
    if (v instanceof RegExp) return `[regexp ${v}]`;
    if (v instanceof Uint8Array) return `[bytes ${v.length}]`;
    return v;
  }) ?? 'null');
  const log = record => fs.appendFileSync(out, JSON.stringify({ pid: process.pid, at: +performance.now().toFixed(1), ...record }) + '\n');
  const timed = (api, fn, describe) => (...args) => {
    const start = performance.now();
    const finish = (result, error) => {
      log({ api, ms: +(performance.now() - start).toFixed(2), ...describe(args, result), error: error ? String(error.message ?? error) : undefined });
    };
    let result;
    try { result = fn(...args); } catch (error) { finish(undefined, error); throw error; }
    if (result && typeof result.then === 'function') return result.then(v => { finish(v); return v; }, e => { finish(undefined, e); throw e; });
    finish(result);
    return result;
  };
  const transformInfo = ([input, options], result) => ({ input: String(input), options: safe(options), result: result && { code: result.code, map: result.map, warnings: result.warnings } });
  const buildInfo = ([options], result) => ({ options: safe(options), result: result && safe({ errors: result.errors, warnings: result.warnings, metafile: result.metafile, outputFiles: result.outputFiles?.map(f => ({ path: f.path, bytes: f.contents?.length })) }) });
  const wrapped = { ...real };
  wrapped.transform = timed('transform', real.transform, transformInfo);
  wrapped.transformSync = timed('transformSync', real.transformSync, transformInfo);
  wrapped.build = timed('build', real.build, buildInfo);
  wrapped.buildSync = timed('buildSync', real.buildSync, buildInfo);
  wrapped.formatMessages = timed('formatMessages', real.formatMessages, ([messages, options], result) => ({ messages: safe(messages), options, result }));
  wrapped.formatMessagesSync = timed('formatMessagesSync', real.formatMessagesSync, ([messages, options], result) => ({ messages: safe(messages), options, result }));
  wrapped.analyzeMetafile = timed('analyzeMetafile', real.analyzeMetafile, () => ({}));
  wrapped.stop = timed('stop', real.stop, () => ({}));
  wrapped.initialize = timed('initialize', real.initialize, ([options]) => ({ options: safe(options) }));
  wrapped.context = async options => {
    const start = performance.now();
    const context = await real.context(options);
    log({ api: 'context', ms: +(performance.now() - start).toFixed(2), options: safe(options) });
    return {
      ...context,
      rebuild: timed('context.rebuild', () => context.rebuild(), (_, result) => buildInfo([{}], result)),
      cancel: timed('context.cancel', () => context.cancel(), () => ({})),
      dispose: timed('context.dispose', () => context.dispose(), () => ({})),
    };
  };
  for (const key of Object.keys(real)) if (!(key in wrapped)) wrapped[key] = real[key];
  module.exports = wrapped;
  log({ api: 'load', version: real.version });
}
// Names for Node's CommonJS export detection (as esbuild's own main.js does).
0 && (module.exports = { analyzeMetafile, analyzeMetafileSync, build, buildSync, context, formatMessages, formatMessagesSync, initialize, stop, transform, transformSync, version });
