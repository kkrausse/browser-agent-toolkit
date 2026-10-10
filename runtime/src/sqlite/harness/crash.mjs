// Crash consistency under the kernel's persistence model.
//
//   node runtime/src/sqlite/harness/crash.mjs
//
// The kernel overlay reaches OPFS through one ordered journal of whole records,
// so what survives a crash or a closed tab is the state of every file as of
// some instant between two filesystem operations. backend-kernel.ts therefore
// tells SQLite (through the device characteristics) that it need not sync to
// order its writes, and treats xSync as a hint. This harness checks that claim
// against SQLite itself: it runs workloads on an in-memory FsBackend with the
// same characteristics that logs every operation, then for EVERY prefix of the
// log materializes the files and opens them with native node:sqlite, checking
//
//   - PRAGMA integrity_check is ok;
//   - every transaction is all-or-nothing (each inserts a fixed set of rows);
//   - no transaction that had returned from COMMIT before the cut is missing,
//     and at most one that had not yet returned is present.
//
// The verifier is native SQLite on real files, not the code under test.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync as NativeDatabase } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
execFileSync("bun", ["build", join(here, "entry-node.ts"), "--target=node", "--format=esm", `--outfile=${join(here, ".build/sqlite-node.mjs")}`], { stdio: ["ignore", "ignore", "inherit"] });
const { createSqliteModule } = await import(pathToFileURL(join(here, ".build/sqlite-node.mjs")).href);
const { readFileSync } = await import("node:fs");
const wasm = new WebAssembly.Module(readFileSync(process.env.BAT_SQLITE_WASM ?? join(here, "..", "sqlite3.wasm")));

// SQLITE_IOCAP_SAFE_APPEND | SEQUENTIAL | POWERSAFE_OVERWRITE, as backend-kernel.ts
const KERNEL_CHARACTERISTICS = 0x200 | 0x400 | 0x1000;

function memoryBackend() {
  const files = new Map(); // path -> { data: Uint8Array, size }
  const fds = new Map();
  const log = [];
  let next = 3;
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return {
    log,
    files,
    deviceCharacteristics: KERNEL_CHARACTERISTICS,
    open(path, flags) {
      let f = files.get(path);
      if (!f) {
        if (!flags.create) throw enoent();
        f = { data: new Uint8Array(4096), size: 0 };
        files.set(path, f);
        log.push(["create", path]);
      } else if (flags.create && flags.exclusive) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      fds.set(next, { path, f });
      return next++;
    },
    close(fd) {
      fds.delete(fd);
    },
    read(fd, dst, pos) {
      const { f } = fds.get(fd);
      const n = Math.max(0, Math.min(dst.length, f.size - pos));
      dst.set(f.data.subarray(pos, pos + n));
      return n;
    },
    write(fd, src, pos) {
      const { f, path } = fds.get(fd);
      const end = pos + src.length;
      if (end > f.data.length) {
        const grown = new Uint8Array(Math.max(end, f.data.length * 2));
        grown.set(f.data.subarray(0, f.size));
        f.data = grown;
      }
      f.data.set(src, pos);
      if (end > f.size) f.size = end;
      log.push(["write", path, pos, src.slice()]);
    },
    truncate(fd, size) {
      const { f, path } = fds.get(fd);
      if (size < f.size) f.data.fill(0, size, f.size);
      f.size = size;
      log.push(["truncate", path, size]);
    },
    size(fd) {
      return fds.get(fd).f.size;
    },
    sync(fd) {
      log.push(["sync", fds.get(fd).path]);
    },
    delete(path) {
      if (!files.delete(path)) return false;
      log.push(["delete", path]);
      return true;
    },
    exists: (path) => files.has(path),
    writable: (path) => files.has(path),
    fullPath: (path) => (path.startsWith("/") ? path : `/${path}`),
  };
}

const ROWS_PER_TXN = 7;
const blob = (seed, n) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (seed * 31 + i * 7) & 255;
  return b;
};

/** Each transaction inserts ROWS_PER_TXN rows tagged with its number, updates a counter row and sometimes rewrites a large row. */
function workload(db, backend, pragmas, txns) {
  db.exec(pragmas);
  backend.log.push(["mark", "setup"]);
  db.exec("create table if not exists entries(id integer primary key, txn integer not null, payload blob not null)");
  db.exec("create index if not exists entries_txn on entries(txn)");
  db.exec("create table if not exists counter(k text primary key, n integer not null, big text)");
  db.exec("insert or ignore into counter values ('txns', 0, '')");
  const insert = db.prepare("insert into entries(txn, payload) values (?, ?)");
  const bump = db.prepare("update counter set n = ?, big = ? where k = 'txns'");
  const prune = db.prepare("delete from entries where txn = ? and id % 2 = 0");
  for (let t = 1; t <= txns; t++) {
    db.exec("begin");
    for (let r = 0; r < ROWS_PER_TXN; r++) insert.run(t, blob(t + r, 200 + ((t * 37 + r * 91) % 3000)));
    // A large value now and then: overflow pages, many frames in one commit.
    bump.run(t, t % 5 === 0 ? "x".repeat(60_000 + t * 1000) : "");
    if (t % 7 === 0) {
      // A rolled-back transaction in between must leave no trace.
      db.exec("commit; begin");
      backend.log.push(["commit", t]);
      insert.run(-t, blob(t, 5000));
      prune.run(t - 1);
      db.exec("rollback");
    } else {
      db.exec("commit");
      backend.log.push(["commit", t]);
    }
    if (t === Math.floor(txns / 2)) db.exec("pragma wal_checkpoint(TRUNCATE)");
  }
}

function verifyPrefixes(name, log, dbPath, quiet) {
  const dir = mkdtempSync(join(tmpdir(), "bat-sqlite-crash-"));
  const state = new Map(); // path -> { data, size }
  const onDisk = (p) => join(dir, p.replaceAll("/", "_"));
  const dirty = new Set();
  let committed = 0;
  let checked = 0;
  let failures = 0;
  let setupDone = false;
  const fail = (k, why) => {
    failures++;
    if (failures <= 5 && !quiet) console.log(`  ${name}: FAIL after operation ${k} (${log[k]?.[0]} ${log[k]?.[1]}): ${why}`);
  };
  for (let k = 0; k < log.length; k++) {
    const [op, path, a, b] = log[k];
    if (op === "mark") {
      setupDone = true;
      continue;
    }
    if (op === "commit") {
      committed = path;
      continue;
    }
    if (op === "sync") continue;
    if (op === "create") state.set(path, { data: new Uint8Array(1 << 16), size: 0 });
    else if (op === "delete") state.delete(path);
    else if (op === "truncate") {
      const f = state.get(path);
      if (a < f.size) f.data.fill(0, a, f.size);
      f.size = a;
    } else if (op === "write") {
      const f = state.get(path);
      const end = a + b.length;
      if (end > f.data.length) {
        const grown = new Uint8Array(Math.max(end, f.data.length * 2));
        grown.set(f.data.subarray(0, f.size));
        f.data = grown;
      }
      f.data.set(b, a);
      if (end > f.size) f.size = end;
    }
    dirty.add(path);
    // Materialize what a crash right after operation k would leave, and open it natively.
    for (const p of dirty) {
      const f = state.get(p);
      if (f) writeFileSync(onDisk(p), f.data.subarray(0, f.size));
      else rmSync(onDisk(p), { force: true });
    }
    dirty.clear();
    // Native SQLite must not see a stale -shm; there never is one (the WAL index is process memory).
    let db;
    try {
      db = new NativeDatabase(onDisk(dbPath));
      const ok = db.prepare("pragma integrity_check").get().integrity_check;
      if (ok !== "ok") fail(k, `integrity_check: ${ok}`);
      if (setupDone && db.prepare("select count(*) c from sqlite_master where name = 'counter'").get().c === 1) {
        const n = db.prepare("select n from counter where k = 'txns'").get()?.n ?? 0;
        if (n < committed) fail(k, `transaction ${committed} had committed but the file shows ${n}`);
        if (n > committed + 1) fail(k, `file shows transaction ${n}, only ${committed} (+1 in flight) were started`);
        const bad = db.prepare("select txn, count(*) c from entries group by txn having txn < 0 or txn > ? or c <> ?").all(n, ROWS_PER_TXN);
        if (bad.length) fail(k, `partial or rolled-back rows visible: ${JSON.stringify(bad.slice(0, 3))}`);
        const present = db.prepare("select count(distinct txn) c from entries").get().c;
        if (present !== n) fail(k, `${present} transactions have rows, counter says ${n}`);
      }
      checked++;
    } catch (e) {
      fail(k, `native open/check threw: ${e.message}`);
    } finally {
      try {
        db?.close();
      } catch {}
    }
    // The verifier may itself have recovered or checkpointed: rewrite everything next round.
    for (const p of state.keys()) dirty.add(p);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-journal`, `${dbPath}-shm`]) if (!state.has(p)) rmSync(onDisk(p), { force: true });
  }
  rmSync(dir, { recursive: true, force: true });
  return { checked, failures };
}

const cases = [
  ["WAL, synchronous=NORMAL (what OpenCode sets)", "pragma journal_mode = WAL; pragma synchronous = NORMAL; pragma wal_autocheckpoint = 40", 40],
  ["WAL, synchronous=FULL", "pragma journal_mode = WAL; pragma wal_autocheckpoint = 25", 30],
  ["rollback journal (default mode)", "pragma journal_mode = DELETE", 30],
  ["rollback journal, synchronous=OFF", "pragma journal_mode = DELETE; pragma synchronous = OFF", 20],
  // Negative control: with the rollback journal held in memory a crash inside a
  // commit cannot be undone, so this case must find bad crash points. If it
  // finds none the harness is not looking.
  ["CONTROL journal_mode=MEMORY (must fail)", "pragma journal_mode = MEMORY", 20],
];
let failed = 0;
for (const [name, pragmas, txns] of cases) {
  const backend = memoryBackend();
  const sqlite = createSqliteModule(backend, { wasm });
  const db = new sqlite.DatabaseSync("/data/app.db");
  workload(db, backend, pragmas, txns);
  db.close();
  // A second session on the same files: reopen, more transactions, close.
  const again = new sqlite.DatabaseSync("/data/app.db");
  const base = again.prepare("select n from counter").get().n;
  if (base !== txns) throw new Error(`reopen lost data: ${base}`);
  again.close();
  const ops = backend.log.filter((o) => !["mark", "commit", "sync"].includes(o[0])).length;
  const syncs = backend.log.filter((o) => o[0] === "sync").length;
  const t = performance.now();
  const control = name.startsWith("CONTROL");
  const r = verifyPrefixes(name, backend.log, "/data/app.db", control);
  const bad = control ? r.failures === 0 : r.failures > 0;
  if (bad) failed++;
  console.log(`${bad ? "FAIL" : "ok  "} ${name}: ${txns} transactions, ${ops} file operations, ${syncs} xSync calls; ${r.checked} crash points checked, ${r.failures} bad (${((performance.now() - t) / 1000).toFixed(1)} s)`);
}
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
