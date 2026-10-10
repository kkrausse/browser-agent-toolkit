// node --import <this file> ...   (pass through the crawl harness with
//   --env NODE_OPTIONS=--import=/abs/path/measure-resolve-hook.mjs)
//
// Says who asks for which package and when, for both require() and import, using Node's
// synchronous module hooks (module.registerHooks, Node >= 22.15). Appends to the file named
// by BAT_MEASURE_TRACE:
//   { api: 'resolve', specifier, parent, url, at }   for specifiers matching BAT_MEASURE_WATCH
//                                                    (default: the native-tool packages and Babel)
//   { api: 'modules', count, byPackage }             at intervals: every module loaded so far
// The hooks slow loading down, so timings from a run with this hook are not startup timings.
import { registerHooks } from 'node:module';
import fs from 'node:fs';

const out = process.env.BAT_MEASURE_TRACE;
const watch = new RegExp(process.env.BAT_MEASURE_WATCH ?? '^(lightningcss|rollup|@rollup/|esbuild|@tailwindcss/oxide|@babel/|babel-dead-code-elimination|react-refresh)');
const short = url => String(url ?? '').replace(/^file:\/\//, '').replace(/^.*node_modules\/\.bun\/([^/]+)\/node_modules\//, '$1:');
const packageOf = url => {
  if (url.startsWith('node:')) return 'node:builtin';
  const match = /node_modules\/\.bun\/([^/]+)\//.exec(url);
  return match ? match[1].replace(/@[^@]*$/, '').replace(/\+/g, '/') : '(app)';
};
if (out) {
  const loaded = new Map();
  let count = 0;
  const seen = new Set();
  const log = record => fs.appendFileSync(out, JSON.stringify({ pid: process.pid, at: +performance.now().toFixed(2), pkg: 'hook', ...record }) + '\n');
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (watch.test(specifier)) {
        const key = `${specifier}\n${context.parentURL}`;
        if (!seen.has(key)) { seen.add(key); log({ api: 'resolve', specifier, parent: short(context.parentURL), url: short(result.url), first: !loaded.has(result.url) }); }
      }
      return result;
    },
    load(url, context, nextLoad) {
      if (!loaded.has(url)) { loaded.set(url, performance.now()); count++; }
      return nextLoad(url, context);
    },
  });
  const report = label => {
    const byPackage = {};
    for (const url of loaded.keys()) { const name = packageOf(url); byPackage[name] = (byPackage[name] ?? 0) + 1; }
    log({ api: 'modules', label, count, byPackage });
  };
  // The dev server is stopped with SIGTERM, which skips 'exit'; report on a timer instead.
  for (const ms of [500, 1000, 2000, 3000, 5000, 8000, 12000, 20000]) setTimeout(() => report(`t+${ms}`), ms).unref();
  process.on('exit', () => report('exit'));
}
