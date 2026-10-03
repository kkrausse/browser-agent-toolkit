// Opt-in guest tracing entry for the Vite preview server (measurement only).
//
// Launched in place of Vite's bin, with the bin's path in VITE_TRACE_ENTRY. It installs
// timers and counters, turns on Vite's own debug timing lines, then runs the unchanged
// bin as the process entry module. Everything it reports is counts, durations, sizes,
// module request names and URL paths. Request and response bodies, headers and query
// values are never read into a report (query keys are kept, values dropped).
//
// Output: one-line JSON on stdout, each prefixed with `VITE_TRACE `, so the host's
// guest-output capture carries them. Full detail is served on demand at
// GET <any base>/__vite_trace on the preview server.
'use strict';

const PREFIX = 'VITE_TRACE ';
const ENTRY = process.env.VITE_TRACE_ENTRY || '/workspace/node_modules/vite/bin/vite.js';
const DUMP_SUFFIX = '/__vite_trace';
const ROOT = process.cwd();
// vite:config is left out on purpose: it formats the whole resolved config.
const DEBUG = 'vite:deps,vite:optimize-deps,vite:load,vite:transform,vite:time,vite:cache,vite:esbuild';
const LIMIT = 4000, LINE_LIMIT = 60;

const fs = require('node:fs');
const now = () => performance.now();
const t0 = now(), epoch0 = Date.now();
const since = () => Math.round((now() - t0) * 10) / 10;
const round = value => Math.round(value * 100) / 100;
const write = process.stdout.write.bind(process.stdout);
let lineCount = 0;
function emit(kind, data) {
  if (lineCount++ >= LINE_LIMIT) return;
  try { write(PREFIX + JSON.stringify({ k: kind, t: since(), ...data }) + '\n'); } catch { /* tracing never breaks the server */ }
}
const patches = {};
function attempt(name, install) {
  try { install(); patches[name] = true; } catch (error) { patches[name] = String(error && error.message || error).slice(0, 120); }
}

// ---- dependency optimizer cache --------------------------------------------------
// Whether Vite finds its dependency cache from an earlier start, and what is in it.
// Vite's default directory and the one the toolkit's guest config selects.
const CACHES = [ROOT + '/node_modules/.vite', ROOT + '/.browser-editor-cache/vite'];
function cacheState() {
  const out = { exists: false };
  try {
    const cache = CACHES.find(path => fs.existsSync(path));
    if (!cache) return out;
    out.exists = true; out.path = cache;
    out.dirs = fs.readdirSync(cache);
    let files = 0, bytes = 0;
    for (const dir of out.dirs) {
      let names = [];
      try { names = fs.readdirSync(cache + '/' + dir); } catch { continue; }
      for (const name of names) { try { bytes += fs.statSync(cache + '/' + dir + '/' + name).size; files++; } catch { /* raced */ } }
    }
    out.files = files; out.bytes = bytes;
    try {
      const metadata = JSON.parse(fs.readFileSync(cache + '/deps/_metadata.json', 'utf8'));
      out.metadata = { hash: metadata.hash, browserHash: metadata.browserHash, lockfileHash: metadata.lockfileHash, configHash: metadata.configHash, optimized: Object.keys(metadata.optimized || {}).length, chunks: Object.keys(metadata.chunks || {}).length };
    } catch { out.metadata = null; }
  } catch (error) { out.error = String(error && error.message || error).slice(0, 120); }
  return out;
}

// ---- event loop ------------------------------------------------------------------
const LAG_INTERVAL = 50;
const lag = { total: 0, max: 0, markMax: 0, over50: 0, over250: 0 };
let lagLast = now();
const lagTimer = setInterval(() => {
  const tick = now(), late = Math.max(0, tick - lagLast - LAG_INTERVAL);
  lagLast = tick; lag.total += late;
  if (late > lag.max) lag.max = late;
  if (late > lag.markMax) lag.markMax = late;
  if (late >= 50) lag.over50++;
  if (late >= 250) lag.over250++;
}, LAG_INTERVAL);
if (lagTimer && typeof lagTimer.unref === 'function') lagTimer.unref();

// ---- synchronous filesystem calls ---------------------------------------------------
// The guest's module resolver and Vite's own resolver probe the filesystem with these;
// each is one synchronous exchange with the kernel. Counts and time, no paths.
// Off unless VITE_TRACE_FS=1: timing tens of thousands of calls adds about a tenth to the start.
const fsCalls = { n: 0, ms: 0, by: {} };
const fsOriginal = {};
if (process.env.VITE_TRACE_FS === '1') attempt('fs', () => {
  for (const name of ['statSync', 'lstatSync', 'existsSync', 'readFileSync', 'realpathSync', 'readdirSync', 'accessSync', 'readlinkSync']) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fsOriginal[name] = original;
    const stats = fsCalls.by[name] = { n: 0, ms: 0, failed: 0 };
    const traced = function (...args) {
      const started = now();
      try { return original.apply(this, args); }
      catch (error) { stats.failed++; throw error; }
      finally { const ms = now() - started; stats.n++; stats.ms += ms; fsCalls.n++; fsCalls.ms += ms; }
    };
    Object.assign(traced, original);
    fs[name] = traced;
  }
  if (fs.statSync === fsOriginal.statSync) throw Error('fs is not patchable');
});
// On demand (`probe=1` on the dump): what one such call costs right now, unpatched.
function fsProbe() {
  const time = (count, task) => { const started = now(); for (let i = 0; i < count; i++) { try { task(i); } catch { /* a missing path is the point */ } } return round((now() - started) / count * 1000) / 1000; };
  const pkg = ROOT + '/package.json', missing = ROOT + '/node_modules/__vite_trace_missing__/package.json';
  const call = (name, ...args) => (fsOriginal[name] || fs[name]).call(fs, ...args);
  return { unit: 'ms per call', statExisting: time(300, () => call('statSync', pkg)), statMissing: time(300, () => call('statSync', missing)), existsMissing: time(300, () => call('existsSync', missing)),
    realpath: time(300, () => call('realpathSync', ENTRY)), readSmallFile: time(100, () => call('readFileSync', pkg, 'utf8')), readdir: time(50, () => call('readdirSync', ROOT)) };
}

// ---- module loads ----------------------------------------------------------------
// Outermost Module._load calls only: a nested require is inside its parent's time.
// `timeline` keeps every outermost load of 2 ms or more, in order, so config load and
// lazily imported pieces (optimizer, esbuild, plugins) can be read off it.
const modules = { n: 0, ms: 0, nested: 0, timeline: [] };
const esbuild = { loads: 0, calls: {}, firstCallAt: null };
function wrapEsbuild(exports) {
  // Vite reaches esbuild through the module's exports each call: hand back a copy
  // whose entry points are timed. Promise-returning calls are timed to settlement.
  const wrapped = Object.create(null);
  for (const key of Object.keys(exports)) {
    const value = exports[key];
    if (typeof value !== 'function' || !['transform', 'build', 'context', 'formatMessages', 'transformSync', 'buildSync', 'initialize'].includes(key)) { wrapped[key] = value; continue; }
    wrapped[key] = function (...args) {
      const stats = esbuild.calls[key] ??= { n: 0, ms: 0, max: 0, first: since() };
      if (esbuild.firstCallAt === null) esbuild.firstCallAt = since();
      const started = now();
      const done = () => { const ms = now() - started; stats.n++; stats.ms += ms; if (ms > stats.max) stats.max = ms; };
      let result;
      try { result = value.apply(this === wrapped ? exports : this, args); } catch (error) { done(); throw error; }
      if (result && typeof result.then === 'function') result.then(done, done); else done();
      return result;
    };
  }
  return wrapped;
}
attempt('module', () => {
  const Module = require('node:module');
  const original = Module._load;
  if (typeof original !== 'function') throw Error('no Module._load');
  let depth = 0, esbuildExports = null, esbuildWrapped = null;
  Module._load = function _load(request, parent, isMain) {
    if (typeof request !== 'string' || request.startsWith('node:')) return original.call(this, request, parent, isMain);
    const outer = depth === 0;
    if (!outer) modules.nested++;
    depth++;
    const started = now(), startedAt = since();
    let result;
    try { result = original.call(this, request, parent, isMain); }
    finally {
      depth--;
      if (outer) {
        const ms = now() - started;
        modules.n++; modules.ms += ms;
        if (ms >= 2 && modules.timeline.length < 400) modules.timeline.push({ at: startedAt, ms: round(ms), request: request.slice(-100), nested: modules.nested });
      }
    }
    if (request === 'esbuild' && result && typeof result.transform === 'function') {
      esbuild.loads++;
      if (esbuildExports !== result) { esbuildExports = result; try { esbuildWrapped = wrapEsbuild(result); } catch { esbuildWrapped = null; } }
      if (esbuildWrapped) return esbuildWrapped;
    }
    return result;
  };
});

// ---- Vite's own debug timing lines -------------------------------------------------
// Kept in memory instead of printed: load, transform and per-request times, and the
// dependency optimizer's messages. Lines are cut to 240 characters.
const debug = { n: 0, lines: [], load: { n: 0, ms: 0 }, transform: { n: 0, ms: 0, slow: [] }, time: { n: 0, ms: 0 }, deps: [] };
const ANSI = /\u001b\[[0-9;]*m/g;
function durationOf(text) {
  const match = /(\d+(?:\.\d+)?)(ms|s)\b/.exec(text);
  return match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : null;
}
function observeDebug(line) {
  const text = line.replace(ANSI, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '').trim();
  const match = /^(vite:[\w-]+) (.*)$/s.exec(text);
  if (!match) return false;
  debug.n++;
  const namespace = match[1], rest = match[2].slice(0, 240), at = since(), ms = durationOf(rest);
  if (namespace === 'vite:load') { debug.load.n++; debug.load.ms += ms ?? 0; }
  else if (namespace === 'vite:transform') { debug.transform.n++; debug.transform.ms += ms ?? 0; }
  else if (namespace === 'vite:time') { debug.time.n++; debug.time.ms += ms ?? 0; }
  else if (debug.deps.length < 200) debug.deps.push({ at, ns: namespace, text: rest });
  if (debug.lines.length < LIMIT) debug.lines.push([at, namespace.slice(5), ms, rest.replace(/^\s*\d+(?:\.\d+)?m?s\s*/, '').slice(0, 160)]);
  return true;
}
attempt('stderr', () => {
  process.env.DEBUG = process.env.DEBUG ? process.env.DEBUG + ',' + DEBUG : DEBUG;
  const original = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    try {
      if (typeof chunk === 'string' && chunk.includes('vite:')) {
        const kept = chunk.split('\n').filter(line => line && !observeDebug(line));
        if (!kept.length) { const callback = rest.find(value => typeof value === 'function'); if (callback) callback(); return true; }
        chunk = kept.join('\n') + '\n';
      }
    } catch { /* observation only */ }
    return original.call(this, chunk, ...rest);
  };
});

// ---- marks -------------------------------------------------------------------------
const marks = {};
function counters() {
  const out = { mod: [modules.n, round(modules.ms), modules.nested], fs: [fsCalls.n, round(fsCalls.ms)], lag: [round(lag.total), round(lag.markMax), lag.over50, lag.over250], req: [served.n, round(served.ms)], dbg: debug.n };
  lag.markMax = 0;
  return out;
}
function mark(name, detail) {
  if (name in marks) return;
  marks[name] = since();
  emit('mark', { name, ...detail, c: counters() });
}

// ---- served HTTP requests ------------------------------------------------------
const served = { n: 0, ms: 0, bytes: 0, active: 0, maxActive: 0, arrivals: 0, recent: [] };
function pathOf(url) {
  const [path, query] = String(url || '').split('?');
  const keys = query ? [...new URLSearchParams(query).keys()].slice(0, 6).join('&') : '';
  return (path.length > 140 ? '…' + path.slice(-140) : path) + (keys ? '?' + keys : '');
}
function observeRequest(request, response) {
  const path = pathOf(request.url), started = now(), startedAt = since();
  const others = served.active++, arrivals = ++served.arrivals;
  if (served.active > served.maxActive) served.maxActive = served.active;
  let finished = false, bytes = 0, headersAt = null;
  mark('first-request', { path });
  const count = chunk => { if (typeof chunk === 'string') bytes += chunk.length; else if (chunk && typeof chunk.byteLength === 'number') bytes += chunk.byteLength; };
  const originalWrite = response.write, originalEnd = response.end, originalWriteHead = response.writeHead;
  response.writeHead = function (...args) { if (headersAt === null) headersAt = now() - started; return originalWriteHead.apply(this, args); };
  response.write = function (chunk, ...rest) { if (headersAt === null) headersAt = now() - started; count(chunk); return originalWrite.call(this, chunk, ...rest); };
  response.end = function (chunk, ...rest) { if (headersAt === null) headersAt = now() - started; if (typeof chunk !== 'function') count(chunk); return originalEnd.call(this, chunk, ...rest); };
  const done = () => {
    if (finished) return;
    finished = true; served.active--;
    const ms = now() - started;
    served.n++; served.ms += ms; served.bytes += bytes;
    // `overlap`: requests in flight at arrival plus arrivals before completion.
    if (served.recent.length < LIMIT) served.recent.push({ at: startedAt, ms: round(ms), firstByteMs: headersAt === null ? null : round(headersAt), status: response.statusCode, bytes, overlap: others + served.arrivals - arrivals, method: request.method, path });
    mark('first-response', { path, ms: round(ms), status: response.statusCode });
  };
  response.once('finish', done);
  response.once('close', done);
}
function report() {
  const body = {
    version: 1, epochStart: epoch0, perfStart: round(t0), t: since(), entry: ENTRY, argv: process.argv.slice(2), patches, marks,
    cache: { atStart: cacheAtStart, now: cacheState() },
    lag: { intervalMs: LAG_INTERVAL, total: round(lag.total), max: round(lag.max), over50: lag.over50, over250: lag.over250 },
    modules: { n: modules.n, ms: round(modules.ms), nested: modules.nested, timeline: modules.timeline },
    fs: { n: fsCalls.n, ms: round(fsCalls.ms), by: Object.fromEntries(Object.entries(fsCalls.by).map(([name, stats]) => [name, { n: stats.n, ms: round(stats.ms), failed: stats.failed }])) },
    esbuild: { loads: esbuild.loads, firstCallAt: esbuild.firstCallAt, calls: Object.fromEntries(Object.entries(esbuild.calls).map(([key, stats]) => [key, { n: stats.n, ms: round(stats.ms), max: round(stats.max), first: stats.first }])) },
    debug: { n: debug.n, load: { n: debug.load.n, ms: round(debug.load.ms) }, transform: { n: debug.transform.n, ms: round(debug.transform.ms) }, time: { n: debug.time.n, ms: round(debug.time.ms) }, deps: debug.deps, lines: debug.lines },
    served: { n: served.n, ms: round(served.ms), bytes: served.bytes, active: served.active, maxActive: served.maxActive, recent: served.recent },
    viteStartTime: typeof globalThis.__vite_start_time === 'number' ? round(globalThis.__vite_start_time - t0) : null,
  };
  // Present only under a locally instrumented runtime build (never in the pinned one):
  // what the runtime's module loader spent per module (read, transpile, compile, run).
  if (process.__vvModuleTimings) body.runtimeModules = process.__vvModuleTimings;
  if (process.__vvLoadTimings) body.runtimeLoad = process.__vvLoadTimings;
  return body;
}
attempt('http.Server', () => {
  const http = require('node:http');
  const prototype = http.Server.prototype, originalEmit = prototype.emit, originalListen = prototype.listen;
  prototype.listen = function (...args) {
    mark('listen-call', { cache: cacheState().exists });
    return originalListen.apply(this, args);
  };
  prototype.emit = function (type, ...args) {
    if (type === 'listening') mark('listening');
    else if (type === 'upgrade') mark('first-upgrade');
    else if (type === 'request') {
      const request = args[0], response = args[1];
      const path = String(request.url || '').split('?')[0];
      if (path.endsWith(DUMP_SUFFIX)) {
        const query = new URLSearchParams(String(request.url).split('?')[1] || '');
        const label = (query.get('label') || '').slice(0, 60);
        const body = report();
        body.label = label;
        if (query.get('probe') === '1') body.fsProbe = fsProbe();
        emit('dump', { label, c: counters() });
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'cross-origin' });
        response.end(JSON.stringify(body));
        return true;
      }
      try { observeRequest(request, response); } catch { /* observation only */ }
    }
    return originalEmit.call(this, type, ...args);
  };
});
attempt('console.log', () => {
  // Vite prints "ready in N ms" once the server listens and its plugins' buildStart ran.
  const original = console.log;
  console.log = function (...args) {
    if (typeof args[0] === 'string' && /ready in/.test(args[0])) mark('ready-line', { text: args[0].replace(ANSI, '').trim().slice(0, 80) });
    return original.apply(this, args);
  };
});

// ---- run the unchanged bin as the entry module -----------------------------------
const cacheAtStart = cacheState();
emit('start', { epoch: epoch0, pid: process.pid, entry: ENTRY, cache: cacheAtStart, patches });
marks.start = 0;
// Vite must see the argv and entry identity of a direct launch.
if (Array.isArray(process.argv)) process.argv[1] = ENTRY;
mark('import-start');
let started;
try { started = require('node:module').runMain(ENTRY); }
catch (error) { emit('error', { message: String(error && error.message || error).slice(0, 300) }); throw error; }
// The bin's own top level only: it starts the CLI import and does not await it.
mark('bin-sync-end');
if (started && typeof started.then === 'function') {
  started.then(() => mark('bin-settled'), error => {
    emit('error', { message: String(error && error.message || error).slice(0, 300) });
    console.error((error && error.stack) || error);
    process.exit(1);
  });
}
// A summary once the first page load has gone quiet (no request for 3 s), then stop the lag timer's lines.
let lastSeen = 0;
const idleTimer = setInterval(() => {
  if (!served.n || served.active || served.n !== lastSeen) { lastSeen = served.n; return; }
  clearInterval(idleTimer);
  emit('idle', { c: counters(), served: [served.n, round(served.ms), served.bytes, served.maxActive], transform: [debug.transform.n, round(debug.transform.ms)], load: [debug.load.n, round(debug.load.ms)],
    esbuild: Object.fromEntries(Object.entries(esbuild.calls).map(([key, stats]) => [key, [stats.n, round(stats.ms)]])), cache: cacheState().exists });
}, 3000);
if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref();
