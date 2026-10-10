// Workloads shared by bench.mjs (native Node) and the browser harness (real kernel).
// No Node or browser APIs here: only the node:sqlite module object passed in.
const ms = (fn) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

const big = (() => {
  // A 6 MB JSON-ish text row like the model catalog.
  const piece = JSON.stringify({ id: "provider/model-name", name: "Model Name", cost: { input: 1.25, output: 10 }, limit: { context: 200000 } });
  let s = "";
  while (s.length < 6 * 1024 * 1024) s += piece + ",";
  return s;
})();

export function scenario(sqlite, dir, n) {
  const { DatabaseSync } = sqlite;
  const r = {};
  const fresh = (name) => {
    const d = new DatabaseSync(`${dir}/${name}-${n}.db`);
    d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -64000; PRAGMA foreign_keys = ON");
    return d;
  };
  {
    const d = fresh("big");
    d.exec("create table catalog(id text primary key, data text not null)");
    const ins = d.prepare("insert into catalog values (?, ?)");
    r["6 MB row insert"] = ms(() => ins.run("models", big));
    const sel = d.prepare("select data from catalog where id = ?");
    let got;
    r["6 MB row read"] = ms(() => (got = sel.get("models").data));
    if (got !== big) throw new Error("6 MB row did not round-trip");
    d.close();
    const e = new DatabaseSync(`${dir}/big-${n}.db`);
    r["6 MB row read after reopen"] = ms(() => (got = e.prepare("select data from catalog where id = ?").get("models").data));
    if (got !== big) throw new Error("6 MB row did not round-trip after reopen");
    e.close();
  }
  {
    const d = fresh("tx");
    d.exec("create table t(id integer primary key, a text, b integer, c real)");
    const ins = d.prepare("insert into t(a, b, c) values (?, ?, ?)");
    r["1,000 inserts, one transaction"] = ms(() => {
      d.exec("begin");
      for (let i = 0; i < 1000; i++) ins.run("row number " + i, i, i / 7);
      d.exec("commit");
    });
    r["1,000 inserts, autocommit"] = ms(() => {
      for (let i = 0; i < 1000; i++) ins.run("row number " + i, i, i / 7);
    });
    const sel = d.prepare("select * from t where id = ?");
    r["1,000 point selects, one statement"] = ms(() => {
      for (let i = 1; i <= 1000; i++) sel.get(i);
    });
    r["1,000 point selects, prepare each"] = ms(() => {
      for (let i = 1; i <= 1000; i++) d.prepare("select * from t where id = ?").get(i);
    });
    let rows;
    r["all() of 2,000 rows × 4 columns"] = ms(() => (rows = d.prepare("select * from t").all()));
    if (rows.length !== 2000) throw new Error("row count");
    d.close();
  }
  {
    const d = fresh("schema");
    // 60 tables and 120 indexes in one transaction: the shape of a migration bootstrap.
    r["schema: 60 tables + 120 indexes, one transaction"] = ms(() => {
      d.exec("begin");
      for (let i = 0; i < 60; i++) {
        d.exec(`create table tbl${i}(id text primary key, parent text, created integer not null, data text not null)`);
        d.exec(`create index tbl${i}_parent on tbl${i}(parent)`);
        d.exec(`create index tbl${i}_created on tbl${i}(created)`);
      }
      d.exec("commit");
    });
    d.close();
  }
  return r;
}



/** The shape of a first boot: open, WAL, pragmas, a schema in one transaction, a select. Returns ms. */
export function firstBoot(sqlite, file, remove) {
  const t0 = performance.now();
  const db = new sqlite.DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  for (const p of ["synchronous = NORMAL", "busy_timeout = 5000", "cache_size = -64000", "foreign_keys = ON"]) db.prepare("PRAGMA " + p).all();
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'x'").all();
  db.prepare("begin").all();
  for (let i = 0; i < 20; i++) {
    db.prepare(`create table t${i}(id text primary key, a text not null, b integer, foreign key (a) references t0(id))`).all();
    db.prepare(`create index i${i} on t${i}(a)`).all();
    db.prepare(`insert into t${i} values (?, ?, ?)`).all("k", "k", 1);
  }
  db.prepare("commit").all();
  db.prepare("select * from t1 where id = ?").all("k");
  const elapsed = performance.now() - t0;
  db.close();
  for (const f of [file, `${file}-wal`, `${file}-shm`]) remove(f);
  return elapsed;
}
