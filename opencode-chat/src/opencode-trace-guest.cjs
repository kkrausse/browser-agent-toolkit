// Opt-in guest tracing entry for the pinned OpenCode server (measurement only).
//
// Launched as `/bin/bun.js <this file>` instead of `/bin/bun.js /app/server.js`.
// It installs counters and timers, then runs the unchanged server as the process
// entry module. Everything it reports is counts, durations, sizes, SQL text with
// literals removed, and URL origin + path. Bound SQL values, request and response
// bodies, headers and query strings are never read into a report.
//
// Output: one-line JSON on stdout, each prefixed with `OPENCODE_TRACE `, so the
// host's guest-output capture carries them. Full detail is served on demand at
// GET /__opencode_trace (same Basic authorization as the server).
'use strict';

const PREFIX = 'OPENCODE_TRACE ';
const SERVER = '/app/server.js';
const READY = 'OPENCODE_SERVER_PROCESS_READY';
const ACTIVATION = '/api/plugin/await-activation';
const DUMP_PATH = '/__opencode_trace';
const DATABASE = process.env.OPENCODE_DATABASE_PATH || '/runtime-probe/opencode.sqlite';
const BUCKETS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
const LOG_LIMIT = 100000, KEY_LIMIT = 2000, SERIES_LIMIT = 4000, LINE_LIMIT = 250;

const fs = require('node:fs');
const now = () => performance.now();
const t0 = now(), epoch0 = Date.now();
const since = () => Math.round((now() - t0) * 10) / 10;
const round = value => Math.round(value * 100) / 100;
const write = process.stdout.write.bind(process.stdout);
function emit(kind, data) {
  try { write(PREFIX + JSON.stringify({ k: kind, t: since(), ...data }) + '\n'); } catch { /* tracing never breaks the server */ }
}

// ---- database size -----------------------------------------------------------
let dbSize = -1, dbDirty = true;
function sampleDatabase() {
  try { dbSize = fs.statSync(DATABASE).size; } catch { dbSize = -1; }
  dbDirty = false;
  return dbSize;
}

// ---- SQLite --------------------------------------------------------------------
// Classes: open, prepare, read, write (autocommit), read.tx / write.tx (inside an
// explicit transaction), txn (BEGIN/COMMIT/...).
const classes = {};
const classNames = [];
const statements = new Map();
const keyCache = new Map();
const log = { t: [], ms: [], cls: [], db: [], key: [] };
const statementKeys = [];
let sqlTotalMs = 0, sqlTotalN = 0, transactionDepth = 0, lineCount = 0;

function classStats(name) {
  let stats = classes[name];
  if (!stats) {
    stats = classes[name] = { index: classNames.length, n: 0, ms: 0, max: 0, hist: new Array(BUCKETS.length + 1).fill(0), samples: [], window: 0 };
    classNames.push(name);
  }
  return stats;
}
function normalize(sql) {
  let key = keyCache.get(sql);
  if (key === undefined) {
    key = String(sql).replace(/'(?:[^']|'')*'/g, '?').replace(/\b\d{4,}\b/g, '?').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (keyCache.size < KEY_LIMIT * 2) keyCache.set(sql, key);
  }
  return key;
}
function verbOf(sql) {
  const match = /^\s*(?:--[^\n]*\n\s*)*([a-z]+)/i.exec(sql);
  return match ? match[1].toLowerCase() : '';
}
function classify(operation, sql) {
  if (operation === 'prepare' || operation === 'open') return operation;
  const verb = verbOf(sql);
  if (['begin', 'commit', 'end', 'rollback', 'savepoint', 'release'].includes(verb)) return 'txn';
  let kind = 'write';
  if (verb === 'select' || verb === 'explain' || verb === 'values') kind = 'read';
  else if (verb === 'with') kind = /\b(insert|update|delete|replace)\b/i.test(sql) ? 'write' : 'read';
  else if (verb === 'pragma') kind = sql.includes('=') ? 'write' : 'read';
  return transactionDepth > 0 ? kind + '.tx' : kind;
}
function trackTransaction(sql) {
  const verb = verbOf(sql);
  if (verb === 'begin' || verb === 'savepoint') transactionDepth++;
  else if (verb === 'commit' || verb === 'end' || verb === 'release') transactionDepth = Math.max(0, transactionDepth - 1);
  else if (verb === 'rollback' && !/\bto\b/i.test(sql)) transactionDepth = 0;
}
function argumentBytes(args) {
  let bytes = 0;
  for (const value of args) {
    if (typeof value === 'string') bytes += value.length;
    else if (value && typeof value.byteLength === 'number') bytes += value.byteLength;
  }
  return bytes;
}
let suspended = false, OriginalDatabase = null;
function record(operation, sql, ms, bytes) {
  if (suspended) return;
  const name = classify(operation, sql), stats = classStats(name);
  stats.n++; stats.ms += ms; if (ms > stats.max) stats.max = ms;
  let bucket = 0; while (bucket < BUCKETS.length && ms > BUCKETS[bucket]) bucket++;
  stats.hist[bucket]++;
  if (stats.samples.length < LOG_LIMIT) stats.samples.push(ms);
  sqlTotalMs += ms; sqlTotalN++;
  const key = name + ' | ' + (operation === 'open' ? 'open database' : normalize(sql));
  let entry = statements.get(key);
  if (!entry) {
    const fresh = () => { statementKeys.push(statements.size >= KEY_LIMIT ? '(other)' : key); return { id: statementKeys.length - 1, n: 0, ms: 0, max: 0, bytes: 0 }; };
    if (statements.size >= KEY_LIMIT) { entry = statements.get('(other)'); if (!entry) statements.set('(other)', entry = fresh()); }
    else statements.set(key, entry = fresh());
  }
  entry.n++; entry.ms += ms; if (ms > entry.max) entry.max = ms; if (bytes > entry.bytes) entry.bytes = bytes;
  if (log.t.length < LOG_LIMIT) { log.t.push(since()); log.ms.push(round(ms)); log.cls.push(stats.index); log.db.push(dbSize); log.key.push(entry.id); }
  if (operation !== 'prepare') { trackTransaction(sql); dbDirty = true; }
  if (bytes >= 100000 || ms >= 500) {
    const before = dbSize, after = sampleDatabase();
    if (lineCount++ < LINE_LIMIT) emit('big', { cls: name, sql: normalize(sql).slice(0, 100), ms: round(ms), argBytes: bytes, dbBefore: before, dbAfter: after });
  }
}

const patches = {};
function attempt(name, install) {
  try { install(); patches[name] = true; } catch (error) { patches[name] = String(error && error.message || error).slice(0, 120); }
}

attempt('sqlite', () => {
  const sqlite = require('node:sqlite');
  const Original = OriginalDatabase = sqlite.DatabaseSync, prototype = Original.prototype;
  const sqlOf = new WeakMap();
  let statementPatched = false, nested = false;
  const patchStatement = statementPrototype => {
    statementPatched = true;
    for (const operation of ['run', 'get', 'all', 'values']) {
      const original = statementPrototype[operation];
      if (typeof original !== 'function') continue;
      statementPrototype[operation] = function (...args) {
        // get() is implemented on all() in this runtime: time the outer call only.
        if (nested) return original.apply(this, args);
        nested = true;
        const started = now();
        try { return original.apply(this, args); }
        finally { nested = false; record(operation, sqlOf.get(this) ?? this.sql ?? this.sourceSQL ?? '', now() - started, argumentBytes(args)); }
      };
    }
  };
  const prepare = prototype.prepare, exec = prototype.exec;
  prototype.prepare = function (sql) {
    const started = now();
    let statement;
    try { statement = prepare.call(this, sql); } finally { record('prepare', sql, now() - started, 0); }
    sqlOf.set(statement, sql);
    if (!statementPatched) patchStatement(Object.getPrototypeOf(statement));
    return statement;
  };
  prototype.exec = function (sql) {
    const started = now();
    try { return exec.call(this, sql); } finally { record('exec', sql, now() - started, 0); }
  };
  // Opening deserializes the stored image and persists once: time it as its own class.
  const Traced = function DatabaseSync(...args) {
    const started = now();
    try { return new Original(...args); } finally { record('open', '', now() - started, 0); sampleDatabase(); }
  };
  Traced.prototype = prototype;
  try { sqlite.DatabaseSync = Traced; patches.sqliteOpen = sqlite.DatabaseSync === Traced; } catch { patches.sqliteOpen = false; }
});

// ---- on-demand size probe --------------------------------------------------------
// A scratch database beside the real one, grown to each size in turn, timing the
// same statement shapes the server uses. Not counted in the server's statistics;
// it blocks the guest while it runs and removes its file afterwards.
// `fill`: 'x' (one repeated character) or 'random' (text that does not compress);
// `shape`: 'rows' (1 MB rows) or 'one' (a single row holding everything, like the model list).
function probe(sizesMb, fill, shape) {
  const path = DATABASE.replace(/[^/]*$/, 'opencode-trace-probe.sqlite');
  const results = [];
  const megabyteOf = () => {
    if (fill !== 'random') return 'x'.repeat(1 << 20);
    const parts = [];
    for (let length = 0; length < 1 << 20; length += 11) parts.push(Math.random().toString(36).slice(2, 13).padEnd(11, 'q'));
    return parts.join('').slice(0, 1 << 20);
  };
  const time = task => { const started = now(); task(); return round(now() - started); };
  const remove = () => { try { fs.unlinkSync(path); } catch { /* absent */ } };
  if (!OriginalDatabase) return { error: 'node:sqlite is not patched' };
  suspended = true;
  let db;
  // Index range of this probe's exchanges in the instrumented runtime's log, when there is one.
  const runtimeStart = process.__vvSqliteTimings ? process.__vvSqliteTimings.length : -1;
  try {
    remove();
    const openMs = time(() => { db = new OriginalDatabase(path); });
    db.exec('CREATE TABLE filler (id INTEGER PRIMARY KEY, value TEXT)');
    db.exec('CREATE TABLE small (id INTEGER PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO small (value) VALUES (?)').run('seed');
    let megabytes = 0;
    const measure = () => {
      const row = { bytes: fs.statSync(path).size, prepare: [], read: [], write: [], readTx: [], writeTx: [], begin: 0, commit: 0,
        runtimeIndex: process.__vvSqliteTimings ? process.__vvSqliteTimings.length : -1 };
      for (let i = 0; i < 5; i++) {
        let statement;
        row.prepare.push(time(() => { statement = db.prepare('SELECT value FROM small WHERE id = ?'); }));
        row.read.push(time(() => statement.all(1)));
      }
      for (let i = 0; i < 3; i++) {
        const statement = db.prepare('INSERT INTO small (value) VALUES (?)');
        row.write.push(time(() => statement.run('value')));
      }
      row.begin = time(() => db.exec('BEGIN'));
      for (let i = 0; i < 3; i++) {
        const select = db.prepare('SELECT value FROM small WHERE id = ?'), insert = db.prepare('INSERT INTO small (value) VALUES (?)');
        row.readTx.push(time(() => select.all(1)));
        row.writeTx.push(time(() => insert.run('value')));
      }
      row.commit = time(() => db.exec('COMMIT'));
      results.push(row);
    };
    measure();
    for (const target of sizesMb) {
      if (megabytes < target) {
        db.exec('BEGIN');
        if (shape === 'one') {
          let value = '';
          for (let i = 0; i < target; i++) value += megabyteOf();
          db.prepare('INSERT INTO filler (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value').run(value);
          megabytes = target;
        } else {
          const insert = db.prepare('INSERT INTO filler (value) VALUES (?)');
          while (megabytes < target) { insert.run(megabyteOf()); megabytes++; }
        }
        db.exec('COMMIT');
      }
      measure();
    }
    const closeMs = time(() => { db.close(); db = null; });
    return { path, fill: fill === 'random' ? 'random' : 'x', shape: shape === 'one' ? 'one' : 'rows', openMs, closeMs, sizes: results,
      runtimeRange: runtimeStart < 0 ? null : [runtimeStart, process.__vvSqliteTimings.length] };
  } catch (error) {
    return { error: String(error && error.message || error).slice(0, 300), sizes: results };
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
    remove();
    suspended = false;
  }
}

// ---- event loop lag ------------------------------------------------------------
const LAG_INTERVAL = 50;
const lag = { max: 0, total: 0, over50: 0, over250: 0, windowMax: 0, windowTotal: 0, markMax: 0 };
let lagExpected = now() + LAG_INTERVAL;
const lagTimer = setInterval(() => {
  const current = now(), late = current - lagExpected;
  lagExpected = current + LAG_INTERVAL;
  if (late <= 1) return;
  lag.total += late; lag.windowTotal += late;
  if (late > lag.max) lag.max = late;
  if (late > lag.windowMax) lag.windowMax = late;
  if (late > lag.markMax) lag.markMax = late;
  if (late >= 50) lag.over50++;
  if (late >= 250) lag.over250++;
}, LAG_INTERVAL);
if (lagTimer && typeof lagTimer.unref === 'function') lagTimer.unref();

// ---- outbound requests ---------------------------------------------------------
// The host reaches the guest server through a loopback request made inside the guest:
// those are the served requests seen from the other side, so they are counted apart.
const outbound = { n: 0, ms: 0, pending: 0, loopbackN: 0, loopbackMs: 0, byKey: new Map(), recent: [] };
let ownPort = '';
function urlKey(input) {
  try {
    const url = new URL(typeof input === 'string' ? input : input && input.url ? input.url : String(input));
    return url.origin + url.pathname;
  } catch { return '(unparsed)'; }
}
function recordOutbound(kind, key, ms, status, length) {
  if (ownPort && (key.startsWith('http://127.0.0.1:' + ownPort + '/') || key.startsWith('http://localhost:' + ownPort + '/'))) {
    outbound.loopbackN++; outbound.loopbackMs += ms;
    return;
  }
  outbound.n++; outbound.ms += ms;
  const id = kind + ' ' + key;
  let entry = outbound.byKey.get(id);
  if (!entry && outbound.byKey.size < 200) outbound.byKey.set(id, entry = { n: 0, ms: 0, max: 0 });
  if (entry) { entry.n++; entry.ms += ms; if (ms > entry.max) entry.max = ms; }
  const item = { t: since(), kind, key: key.slice(0, 160), ms: round(ms), status, len: length };
  if (outbound.recent.length < 400) outbound.recent.push(item);
  if (lineCount++ < LINE_LIMIT) emit('out', item);
}
attempt('fetch', () => {
  const original = globalThis.fetch;
  if (typeof original !== 'function') throw Error('no global fetch');
  const traced = function fetch(input, init) {
    const key = urlKey(input), started = now();
    outbound.pending++;
    return original.call(globalThis, input, init).then(response => {
      outbound.pending--;
      recordOutbound('fetch', key, now() - started, response.status, Number(response.headers.get('content-length')) || 0);
      return response;
    }, error => { outbound.pending--; recordOutbound('fetch', key, now() - started, 0, 0); throw error; });
  };
  for (const name of Object.getOwnPropertyNames(original)) {
    if (!(name in traced)) try { Object.defineProperty(traced, name, Object.getOwnPropertyDescriptor(original, name)); } catch { /* keep going */ }
  }
  globalThis.fetch = traced;
  if (globalThis.fetch !== traced) throw Error('global fetch is not writable');
});
for (const name of ['http', 'https']) attempt(name + '.request', () => {
  const library = require('node:' + name), original = library.request;
  const describe = (input, options) => {
    if (typeof input === 'string' || input instanceof URL) return urlKey(String(input));
    const target = input || options || {};
    return name + '://' + (target.hostname || target.host || 'localhost') + (target.port ? ':' + target.port : '') + String(target.path || '/').split('?')[0];
  };
  const traced = function request(...args) {
    const key = describe(args[0], args[1]), started = now();
    const outgoing = original.apply(this, args);
    let settled = false;
    const settle = (status, length) => { if (!settled) { settled = true; recordOutbound(name, key, now() - started, status, length); } };
    try {
      outgoing.once('response', response => settle(response.statusCode || 0, Number(response.headers && response.headers['content-length']) || 0));
      outgoing.once('error', () => settle(0, 0));
    } catch { /* not an emitter: count only */ settle(-1, 0); }
    return outgoing;
  };
  library.request = traced;
  library.get = function get(...args) { const outgoing = traced.apply(this, args); outgoing.end(); return outgoing; };
});

// ---- module loads ----------------------------------------------------------------
const modules = { n: 0, ms: 0, byRequest: new Map() };
attempt('module', () => {
  const Module = require('node:module');
  const original = Module._load;
  if (typeof original !== 'function') throw Error('no Module._load');
  let depth = 0;
  Module._load = function _load(request, parent, isMain) {
    if (depth > 0 || typeof request !== 'string' || request.startsWith('node:')) return original.call(this, request, parent, isMain);
    depth++;
    const started = now();
    try { return original.call(this, request, parent, isMain); }
    finally {
      depth--;
      const ms = now() - started;
      modules.n++; modules.ms += ms;
      if (ms >= 1) {
        const key = request.slice(-120);
        let entry = modules.byRequest.get(key);
        if (!entry && modules.byRequest.size < 400) modules.byRequest.set(key, entry = { n: 0, ms: 0 });
        if (entry) { entry.n++; entry.ms += ms; }
      }
    }
  };
});

// ---- marks and counters --------------------------------------------------------
const marks = {};
function counters() {
  const out = { sq: [sqlTotalN, round(sqlTotalMs)] };
  for (const name of classNames) out[name] = [classes[name].n, round(classes[name].ms)];
  out.lag = [round(lag.total), round(lag.markMax), lag.over50, lag.over250];
  out.out = [outbound.n, round(outbound.ms)];
  out.mod = [modules.n, round(modules.ms)];
  out.req = [served.n, round(served.ms)];
  lag.markMax = 0;
  return out;
}
function mark(name, detail) {
  if (name in marks) return;
  marks[name] = since();
  emit('mark', { name, db: sampleDatabase(), ...detail, c: counters() });
}
function percentile(sorted, fraction) {
  return sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]) : 0;
}
function topStatements(limit, width) {
  return [...statements.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, limit)
    .map(([key, entry]) => ({ sql: key.slice(0, width), n: entry.n, ms: round(entry.ms), max: round(entry.max), argBytes: entry.bytes }));
}

// ---- served HTTP requests ------------------------------------------------------
const served = { n: 0, ms: 0, active: 0, arrivals: 0, byRoute: new Map(), recent: [] };
function routeOf(path) {
  return path.split('/').map(part => /^[a-z]{2,5}_[\w-]{8,}$/i.test(part) || part.length >= 20 || /^\d+$/.test(part) ? ':id' : part).join('/');
}
function authorized(request) {
  const password = process.env.OPENCODE_PASSWORD;
  return !!password && request.headers.authorization === 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
}
function observeRequest(request, response) {
  const path = String(request.url || '').split('?')[0], route = request.method + ' ' + routeOf(path);
  const started = now(), startedAt = since(), baseN = sqlTotalN, baseMs = sqlTotalMs;
  // Requests in flight at arrival; arrivals during this request are added at completion.
  const others = served.active++, arrivals = ++served.arrivals;
  let finished = false;
  mark('first-request', { route });
  if (path === ACTIVATION) mark('activation-start');
  const done = () => {
    if (finished) return;
    finished = true; served.active--;
    const ms = now() - started;
    served.n++; served.ms += ms;
    let entry = served.byRoute.get(route);
    if (!entry && served.byRoute.size < 200) served.byRoute.set(route, entry = { n: 0, ms: 0, max: 0, sqlN: 0, sqlMs: 0 });
    if (entry) { entry.n++; entry.ms += ms; if (ms > entry.max) entry.max = ms; entry.sqlN += sqlTotalN - baseN; entry.sqlMs += sqlTotalMs - baseMs; }
    // SQL counted between arrival and completion; `overlap` other requests shared that interval.
    const item = { at: startedAt, route, status: response.statusCode, ms: round(ms), sqlN: sqlTotalN - baseN, sqlMs: round(sqlTotalMs - baseMs), overlap: others + served.arrivals - arrivals, db: dbSize };
    if (served.recent.length < 2000) served.recent.push(item);
    if (lineCount++ < LINE_LIMIT) emit('req', item);
    mark('first-response', { route });
    if (path === ACTIVATION) { mark('activation-end'); emit('top', { at: 'activation-end', top: topStatements(6, 110) }); }
  };
  response.once('finish', done);
  response.once('close', done);
}
function report(detail) {
  const classReport = {};
  for (const name of classNames) {
    const stats = classes[name], sorted = stats.samples.slice().sort((a, b) => a - b);
    classReport[name] = { n: stats.n, ms: round(stats.ms), max: round(stats.max), p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), hist: stats.hist };
  }
  const body = {
    version: 1, epochStart: epoch0, perfStart: round(t0), t: since(), database: { path: DATABASE, bytes: sampleDatabase() }, patches, marks,
    sqlite: { n: sqlTotalN, ms: round(sqlTotalMs), buckets: BUCKETS, classes: classReport, statementKeys: statements.size, top: topStatements(60, 200) },
    lag: { intervalMs: LAG_INTERVAL, total: round(lag.total), max: round(lag.max), over50: lag.over50, over250: lag.over250 },
    outbound: { n: outbound.n, ms: round(outbound.ms), pending: outbound.pending, loopback: [outbound.loopbackN, round(outbound.loopbackMs)],
      byKey: [...outbound.byKey.entries()].map(([key, entry]) => ({ key, n: entry.n, ms: round(entry.ms), max: round(entry.max) })), recent: outbound.recent },
    modules: { n: modules.n, ms: round(modules.ms),
      top: [...modules.byRequest.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 40).map(([request, entry]) => ({ request, n: entry.n, ms: round(entry.ms) })) },
    served: { n: served.n, ms: round(served.ms), active: served.active,
      byRoute: [...served.byRoute.entries()].map(([route, entry]) => ({ route, n: entry.n, ms: round(entry.ms), max: round(entry.max), sqlN: entry.sqlN, sqlMs: round(entry.sqlMs) })),
      recent: served.recent },
    series,
  };
  if (detail) body.log = { classes: classNames, keys: statementKeys, t: log.t, ms: log.ms, cls: log.cls, db: log.db, key: log.key };
  // Present only under a locally instrumented runtime build (never in the pinned one):
  // finer load and SQLite exchange timings it leaves on the process object.
  if (process.__vvLoadTimings) body.runtimeLoad = process.__vvLoadTimings;
  if (process.__vvModuleTimings) body.runtimeModules = detail ? process.__vvModuleTimings : { total: process.__vvModuleTimings.total, resolve: process.__vvModuleTimings.resolve };
  if (detail && process.__vvSqliteTimings) body.runtimeSqlite = process.__vvSqliteTimings;
  if (process.__vvSys) body.sys = process.__vvSys;
  return body;
}
attempt('http.Server', () => {
  const http = require('node:http');
  const prototype = http.Server.prototype, originalEmit = prototype.emit, originalListen = prototype.listen;
  prototype.listen = function (...args) {
    const port = typeof args[0] === 'number' ? args[0] : args[0] && typeof args[0] === 'object' ? args[0].port : undefined;
    if (port && !ownPort) ownPort = String(port);
    mark('listen-call');
    return originalListen.apply(this, args);
  };
  prototype.emit = function (type, ...args) {
    if (type === 'listening') mark('listening');
    else if (type === 'request') {
      const request = args[0], response = args[1];
      if (String(request.url || '').split('?')[0] === DUMP_PATH) {
        if (!authorized(request)) { response.writeHead(401); response.end(); return true; }
        const query = new URLSearchParams(String(request.url).split('?')[1] || '');
        const label = (query.get('label') || '').slice(0, 60);
        const body = report(query.get('detail') === '1');
        body.label = label;
        const sizes = (query.get('probe') || '').split(',').map(Number).filter(size => size > 0 && size <= 64).sort((a, b) => a - b);
        if (sizes.length) body.probe = probe(sizes, query.get('fill'), query.get('shape'));
        emit('dump', { label, db: body.database.bytes, c: counters() });
        emit('top', { at: 'dump:' + label, top: topStatements(6, 110) });
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify(body));
        return true;
      }
      try { observeRequest(request, response); } catch { /* observation only */ }
    }
    return originalEmit.call(this, type, ...args);
  };
});

// ---- periodic windows ----------------------------------------------------------
// One series point and at most one stdout line per window with activity.
const series = [];
let windowStart = now(), windowBase = { outN: 0, outMs: 0, reqN: 0, reqMs: 0, modN: 0, modMs: 0, sqlN: 0 };
function closeWindow() {
  const elapsed = now() - windowStart;
  const active = sqlTotalN !== windowBase.sqlN || outbound.n !== windowBase.outN || served.n !== windowBase.reqN || lag.windowMax >= 100;
  if (active) {
    const point = { t: since(), dt: Math.round(elapsed), db: dbDirty ? sampleDatabase() : dbSize, lag: [round(lag.windowMax), round(lag.windowTotal)], sq: {} };
    for (const name of classNames) {
      const stats = classes[name], fresh = stats.samples.slice(stats.window);
      if (!fresh.length) continue;
      stats.window = stats.samples.length;
      let ms = 0; for (const value of fresh) ms += value;
      fresh.sort((a, b) => a - b);
      point.sq[name] = [fresh.length, round(ms), percentile(fresh, 0.5), percentile(fresh, 0.95)];
    }
    if (outbound.n !== windowBase.outN) point.out = [outbound.n - windowBase.outN, round(outbound.ms - windowBase.outMs)];
    if (served.n !== windowBase.reqN) point.req = [served.n - windowBase.reqN, round(served.ms - windowBase.reqMs)];
    if (modules.n !== windowBase.modN) point.mod = [modules.n - windowBase.modN, round(modules.ms - windowBase.modMs)];
    if (series.length < SERIES_LIMIT) series.push(point);
    if (lineCount++ < LINE_LIMIT * 4) emit('win', point);
  }
  windowStart = now(); lag.windowMax = 0; lag.windowTotal = 0;
  windowBase = { outN: outbound.n, outMs: outbound.ms, reqN: served.n, reqMs: served.ms, modN: modules.n, modMs: modules.ms, sqlN: sqlTotalN };
}
// 2 s windows through boot, 10 s afterwards.
let ticks = 0;
const windowTimer = setInterval(() => { ticks++; if (ticks <= 60 ? ticks % 2 === 0 : ticks % 10 === 0) closeWindow(); }, 1000);
if (windowTimer && typeof windowTimer.unref === 'function') windowTimer.unref();

attempt('console.log', () => {
  const original = console.log;
  console.log = function (...args) {
    if (args[0] === READY) { mark('ready'); emit('top', { at: 'ready', top: topStatements(6, 110) }); }
    return original.apply(this, args);
  };
});

// ---- run the unchanged server as the entry module ------------------------------
function finish(reason) {
  closeWindow();
  emit('end', { reason, db: sampleDatabase(), c: counters() });
  clearInterval(lagTimer); clearInterval(windowTimer);
}
emit('start', { epoch: epoch0, pid: process.pid, db: sampleDatabase(), patches });
marks.start = 0;
// The server must see the argv and entry identity of a direct launch.
if (Array.isArray(process.argv)) process.argv[1] = SERVER;
mark('import-start');
let started;
try { started = require('node:module').runMain(SERVER); }
catch (error) { emit('error', { message: String(error && error.message || error).slice(0, 300) }); throw error; }
// Read, ESM-to-CJS transpile, compile, and the synchronous part of evaluation up to the first await.
mark('import-sync-end');
if (started && typeof started.then === 'function') {
  started.then(() => finish('exit'), error => {
    finish('error');
    // Same reporting as /bin/bun.js gives a failing top-level-await entry.
    console.error('bun: ' + ((error && error.stack) || error));
    process.exit(1);
  });
}
