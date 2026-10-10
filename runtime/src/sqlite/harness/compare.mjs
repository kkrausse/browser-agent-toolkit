// Differential check: run the same node:sqlite script against native Node and
// against this implementation (node:fs backend) and diff what each case returns
// or throws.
//
//   node runtime/src/sqlite/harness/compare.mjs [--verbose]
//
// Exit status 0 when every case agrees.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as native from "node:sqlite";
import { loadSqlite } from "./load.mjs";

const show = (v, depth = 0) => {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "function") return `[Function ${v.name}]`;
  if (typeof v === "symbol") return String(v);
  if (v instanceof Uint8Array) return `${v.constructor.name}<${Buffer.from(v).toString("hex")}>`;
  if (v instanceof Error) {
    return `throws ${v.constructor.name} code=${v.code} message=${JSON.stringify(v.message)} errcode=${v.errcode} errstr=${JSON.stringify(v.errstr)}`;
  }
  if (depth > 6) return "…";
  if (Array.isArray(v)) return `[${v.map((e) => show(e, depth + 1)).join(", ")}]`;
  const proto = Object.getPrototypeOf(v);
  const tag = proto === null ? "null-proto " : proto === Object.prototype ? "" : `${proto.constructor?.name} `;
  return `${tag}{${Object.keys(v).map((k) => `${k}: ${show(v[k], depth + 1)}`).join(", ")}}`;
};

async function run(sqlite, dir) {
  const { DatabaseSync, StatementSync } = sqlite;
  const out = [];
  const t = async (name, fn) => {
    let r;
    try {
      r = show(await fn());
    } catch (e) {
      r = show(e instanceof Error ? e : new Error(`non-error thrown: ${String(e)}`));
    }
    out.push([name, r]);
  };
  const file = join(dir, "a.db");

  // --- module shape
  await t("module keys", () => Object.keys(sqlite).filter((k) => k !== "__bat" && k !== "default").sort());
  await t("constants", () => sqlite.constants);
  await t("DatabaseSync methods", () => Object.getOwnPropertyNames(DatabaseSync.prototype).filter((k) => !["isOpen", "isTransaction"].includes(k)).sort());
  await t("StatementSync methods", () => Object.getOwnPropertyNames(StatementSync.prototype).filter((k) => !["sourceSQL", "expandedSQL"].includes(k)).sort());
  await t("names", () => [DatabaseSync.name, StatementSync.name, typeof sqlite.backup]);

  // --- construction and argument checks
  await t("call without new", () => DatabaseSync(":memory:"));
  await t("new StatementSync", () => new StatementSync());
  await t("path number", () => new DatabaseSync(1));
  await t("path with NUL", () => new DatabaseSync("a\0b"));
  await t("options not object", () => new DatabaseSync(":memory:", 1));
  await t("options null", () => new DatabaseSync(":memory:", null));
  for (const k of ["open", "readOnly", "enableForeignKeyConstraints", "enableDoubleQuotedStringLiterals", "readBigInts", "returnArrays", "allowBareNamedParameters", "allowUnknownNamedParameters"]) {
    await t(`options.${k} wrong type`, () => new DatabaseSync(":memory:", { [k]: 1 }));
  }
  await t("options.timeout wrong type", () => new DatabaseSync(":memory:", { timeout: 1.5 }));
  await t("missing directory", () => new DatabaseSync(join(dir, "no", "such", "x.db")));
  await t("readOnly missing file", () => new DatabaseSync(join(dir, "missing.db"), { readOnly: true }));

  // --- open / close / state
  await t("open:false lifecycle", () => {
    const d = new DatabaseSync(":memory:", { open: false });
    const r = [d.isOpen];
    try { d.exec("select 1"); } catch (e) { r.push(show(e)); }
    try { d.prepare("select 1"); } catch (e) { r.push(show(e)); }
    try { d.isTransaction; } catch (e) { r.push(show(e)); }
    try { d.close(); } catch (e) { r.push(show(e)); }
    try { d.location(); } catch (e) { r.push(show(e)); }
    d.open();
    r.push(d.isOpen);
    try { d.open(); } catch (e) { r.push(show(e)); }
    d.close();
    r.push(d.isOpen);
    return r;
  });
  await t("dispose", () => {
    const d = new DatabaseSync(":memory:");
    d[Symbol.dispose]();
    d[Symbol.dispose]();
    return d.isOpen;
  });
  await t("isTransaction", () => {
    const d = new DatabaseSync(":memory:");
    const r = [d.isTransaction];
    d.exec("begin");
    r.push(d.isTransaction);
    d.exec("rollback");
    r.push(d.isTransaction);
    return r;
  });
  await t("location memory", () => new DatabaseSync(":memory:").location());
  await t("location file", () => {
    const d = new DatabaseSync(file);
    const r = [d.location() === file, d.location("main") === file, d.location("nope")];
    d.exec(`attach '${join(dir, "b.db")}' as other`);
    r.push(d.location("other") === join(dir, "b.db"));
    d.close();
    return r;
  });
  await t("location arg type", () => new DatabaseSync(":memory:").location(1));
  await t("path as Buffer and URL", () => {
    const a = new DatabaseSync(Buffer.from(join(dir, "buf.db")));
    const b = new DatabaseSync(new URL(`file://${join(dir, "url.db")}`));
    const r = [a.location() === join(dir, "buf.db"), b.location() === join(dir, "url.db")];
    a.close();
    b.close();
    return r;
  });
  await t("uri filename", () => {
    const d = new DatabaseSync(`file:${join(dir, "uri.db")}?mode=rwc`);
    d.exec("create table t(a)");
    const r = d.location() === join(dir, "uri.db");
    d.close();
    return r;
  });

  const db = new DatabaseSync(":memory:");

  // --- exec / prepare errors
  await t("exec non-string", () => db.exec(1));
  await t("exec syntax error", () => db.exec("nope"));
  await t("exec no such table", () => db.exec("select * from missing"));
  await t("exec multiple statements", () => {
    db.exec("create table m(a); insert into m values (1); insert into m values (2);");
    return db.prepare("select count(*) c from m").get();
  });
  await t("prepare non-string", () => db.prepare(1));
  await t("prepare syntax error", () => db.prepare("selec 1"));
  await t("prepare takes first statement", () => db.prepare("select 1 as a; select 2 as b").all());
  await t("prepare empty", () => {
    const s = db.prepare("");
    return [s.all(), s.get(), s.run(), s.sourceSQL, s.columns()];
  });
  await t("prepare comment", () => db.prepare("-- nothing").all());
  await t("double quoted string literal", () => db.prepare('select "nope" as x').get());
  await t("dqs enabled", () => new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: true }).prepare('select "yes" as x').get());

  // --- values out
  db.exec("create table v(id integer primary key, i integer, r real, t text, b blob, n)");
  await t("run result", () => db.prepare("insert into v(i, r, t, b, n) values (?, ?, ?, ?, ?)").run(42, 1.5, "héllo ✓ 𝄞", new Uint8Array([0, 1, 255]), null));
  await t("run result 2", () => db.prepare("insert into v(i, r, t, b, n) values (?, ?, ?, ?, ?)").run(-7, -0.25, "", new Uint8Array(0), 3));
  await t("all rows", () => db.prepare("select * from v order by id").all());
  await t("get row", () => db.prepare("select * from v where id = ?").get(1));
  await t("get none", () => db.prepare("select * from v where id = ?").get(99));
  await t("get on insert", () => db.prepare("insert into v(i) values (5)").get());
  await t("get returning", () => db.prepare("insert into v(i) values (6) returning id, i").get());
  await t("all returning", () => db.prepare("insert into v(i) values (7), (8) returning i").all());
  await t("run on select", () => db.prepare("select * from v").run());
  await t("update changes", () => db.prepare("update v set n = 1 where id <= 2").run());
  await t("delete changes", () => db.prepare("delete from v where id > 2").run());
  await t("typeof per storage class", () => db.prepare("select typeof(i) i, typeof(r) r, typeof(t) t, typeof(b) b, typeof(n) n from v order by id").all());
  await t("number bound as real", () => db.prepare("select typeof(?) a, typeof(?) b, ? c").get(1, 1.5, 3));
  await t("duplicate column names", () => db.prepare("select 1 as a, 2 as a, 3 as b").get());
  await t("row prototype", () => Object.getPrototypeOf(db.prepare("select 1 as a").get()));
  await t("empty blob", () => db.prepare("select x'' as b, zeroblob(3) as z").get());
  await t("float values", () => db.prepare("select 1e308 * 10 as inf, -1e308 * 10 as ninf, 0.1 + 0.2 as f, -0.0 as z, 1e15 as big").get());
  await t("NaN binds as null", () => db.prepare("select ? as x, typeof(?) as t").get(NaN, NaN));
  await t("Infinity binds", () => db.prepare("select ? as x").get(Infinity));
  await t("long text", () => {
    const s = "abc ü 漢字 ".repeat(20000);
    const got = db.prepare("select ? as s").get(s).s;
    return [got.length, got === s];
  });
  await t("text with NUL", () => db.prepare("select ? as s, length(?) as n").get("a\0b", "a\0b"));
  await t("lone surrogate", () => db.prepare("select ? as s").get("a\ud800b"));
  await t("typed array views", () => db.prepare("select ? a, ? b, ? c").get(new Uint16Array([1, 2]), new DataView(new ArrayBuffer(2)), Buffer.from("hi").subarray(1)));

  // --- integers
  await t("safe integer edges", () => db.prepare("select 9007199254740991 a, -9007199254740991 b").get());
  await t("unsafe integer", () => db.prepare("select 9007199254740992 a").get());
  await t("unsafe negative integer", () => db.prepare("select -9007199254740993 a").get());
  await t("unsafe integer in all", () => db.prepare("select 1 a union all select 9223372036854775807").all());
  await t("readBigInts", () => {
    const s = db.prepare("select 9223372036854775807 a, 1 b, 1.5 c, 't' d, -9223372036854775808 e");
    s.setReadBigInts(true);
    return s.get();
  });
  await t("readBigInts run", () => {
    const s = db.prepare("insert into v(i) values (1)");
    s.setReadBigInts(true);
    const r = s.run();
    return [typeof r.changes, typeof r.lastInsertRowid, r.changes];
  });
  await t("setReadBigInts type", () => db.prepare("select 1").setReadBigInts(1));
  await t("bind bigint", () => db.prepare("select ? a, typeof(?) t").get(5n, 5n));
  await t("bind bigint max", () => {
    const s = db.prepare("select ? a");
    s.setReadBigInts(true);
    return s.get(2n ** 63n - 1n);
  });
  await t("bind bigint too large", () => db.prepare("select ? a").get(2n ** 63n));
  await t("bind bigint too small", () => db.prepare("select ? a").get(-(2n ** 63n) - 1n));
  await t("db option readBigInts", () => new DatabaseSync(":memory:", { readBigInts: true }).prepare("select 1 a").get());
  await t("large integer bound as number", () => db.prepare("select ? a, typeof(?) t").get(2 ** 53, 2 ** 53));

  // --- parameters
  await t("unbindable values", () => {
    const r = [];
    for (const v of [undefined, true, Symbol("s"), () => 1, [1], new Date(0)]) {
      try { r.push(show(db.prepare("select ? a").get(v))); } catch (e) { r.push(show(e)); }
    }
    return r;
  });
  await t("unbindable second", () => db.prepare("select ?, ? a").get(1, true));
  await t("too many anonymous", () => db.prepare("select ? a").get(1, 2));
  await t("too few anonymous", () => db.prepare("select ? a, ? b").get(1));
  await t("numbered ?NNN", () => db.prepare("select ?2 a, ?1 b").get("one", "two"));
  await t("named $ : @", () => db.prepare("select $a a, :b b, @c c").get({ $a: 1, ":b": 2, "@c": 3 }));
  await t("bare named", () => db.prepare("select $a a, :b b, @c c").get({ a: 1, b: 2, c: 3 }));
  await t("bare named disabled", () => {
    const s = db.prepare("select $a a");
    s.setAllowBareNamedParameters(false);
    return s.get({ a: 1 });
  });
  await t("bare conflict", () => db.prepare("select $a, :a").get({ a: 1 }));
  await t("bare conflict with prefixed keys", () => db.prepare("select $a x, :a y").get({ $a: 1, ":a": 2 }));
  await t("unknown named", () => db.prepare("select $a a").get({ b: 1 }));
  await t("unknown named allowed", () => {
    const s = db.prepare("select $a a");
    s.setAllowUnknownNamedParameters(true);
    return s.get({ a: 1, b: 2 });
  });
  await t("named plus anonymous", () => db.prepare("select $a a, ? b, :c c, ? d").get({ a: "A", c: "C" }, "B", "D"));
  await t("named missing value", () => db.prepare("select $a a, $b b").get({ a: 1 }));
  await t("null as first argument", () => db.prepare("select ? a").get(null));
  await t("array as first argument", () => db.prepare("select ? a").get([1]));
  await t("Uint8Array as first argument", () => db.prepare("select ? a").get(new Uint8Array([9])));
  await t("bindings are cleared between calls", () => {
    const s = db.prepare("select ? a, ? b");
    s.get(1, 2);
    return s.get(3);
  });
  await t("setAllowBareNamedParameters type", () => db.prepare("select 1").setAllowBareNamedParameters("x"));
  await t("setAllowUnknownNamedParameters type", () => db.prepare("select 1").setAllowUnknownNamedParameters("x"));
  await t("setReturnArrays type", () => db.prepare("select 1").setReturnArrays("x"));

  // --- statement properties
  await t("sourceSQL / expandedSQL", () => {
    const s = db.prepare("select ? a, $b b, ? c");
    const r = [s.sourceSQL, s.expandedSQL];
    s.get({ b: "x'y" }, 1.5, new Uint8Array([1, 2]));
    r.push(s.expandedSQL);
    return r;
  });
  await t("columns", () => db.prepare("select id, i as renamed, r + 1 as expr, t, 5 from v").columns());
  await t("columns on insert", () => db.prepare("insert into v(i) values (1)").columns());
  await t("returnArrays", () => {
    const s = db.prepare("select 1 a, 'x' b, null c");
    s.setReturnArrays(true);
    return [s.get(), s.all(), [...s.iterate()]];
  });

  // --- iterate
  await t("iterate", () => {
    const it = db.prepare("select id from v where id <= 2 order by id").iterate();
    const r = [typeof it.next, typeof it.return, it[Symbol.iterator]() === it, Object.getPrototypeOf(Object.getPrototypeOf(it)) === Iterator.prototype];
    r.push(it.next(), it.next(), it.next(), it.next());
    return r;
  });
  await t("iterate return", () => {
    const it = db.prepare("select id from v order by id").iterate();
    return [it.next(), it.return(), it.next()];
  });
  await t("iterate spread and helpers", () => {
    const s = db.prepare("select id from v where id <= ? order by id");
    return [[...s.iterate(2)], s.iterate(2).map((r) => r.id * 10).toArray()];
  });
  await t("iterate result prototype", () => Object.getPrototypeOf(db.prepare("select 1 a").iterate().next()));
  await t("iterate then all on same statement", () => {
    const s = db.prepare("select id from v where id <= 2 order by id");
    const it = s.iterate();
    const first = it.next();
    const all = s.all();
    return [first, all, it.next()];
  });

  // --- constraint and runtime errors
  db.exec("create table u(a integer primary key, b text unique not null, c check (c > 0))");
  db.prepare("insert into u values (1, 'x', 1)").run();
  await t("unique violation", () => db.prepare("insert into u values (2, 'x', 1)").run());
  await t("primary key violation", () => db.prepare("insert into u values (1, 'y', 1)").run());
  await t("not null violation", () => db.prepare("insert into u values (3, null, 1)").run());
  await t("check violation", () => db.prepare("insert into u values (3, 'z', 0)").run());
  await t("statement usable after error", () => {
    const s = db.prepare("insert into u values (?, ?, 1)");
    const r = [];
    try { s.run(1, "dup"); } catch (e) { r.push(show(e)); }
    r.push(s.run(10, "ten"));
    return r;
  });
  await t("foreign keys on by default", () => {
    const d = new DatabaseSync(":memory:");
    d.exec("create table p(id integer primary key); create table c(p references p(id))");
    return [d.prepare("pragma foreign_keys").get(), (() => { try { d.prepare("insert into c values (1)").run(); } catch (e) { return show(e); } })()];
  });
  await t("foreign keys off", () => {
    const d = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    d.exec("create table p(id integer primary key); create table c(p references p(id))");
    return [d.prepare("pragma foreign_keys").get(), d.prepare("insert into c values (1)").run()];
  });
  await t("readOnly write", () => {
    const d0 = new DatabaseSync(join(dir, "ro.db"));
    d0.exec("create table t(a); insert into t values (1)");
    d0.close();
    const d = new DatabaseSync(join(dir, "ro.db"), { readOnly: true });
    const r = [d.prepare("select * from t").all()];
    try { d.exec("insert into t values (2)"); } catch (e) { r.push(show(e)); }
    d.close();
    return r;
  });
  await t("error in the middle of all()", () => db.prepare("select abs(-9223372036854775808) from v").all());
  await t("transactions", () => {
    db.exec("begin");
    db.prepare("insert into m values (100)").run();
    db.exec("rollback");
    db.exec("begin; insert into m values (200); commit");
    return db.prepare("select a from m order by a").all();
  });
  await t("savepoints", () => {
    db.exec("savepoint s1; insert into m values (300); rollback to s1; release s1");
    return db.prepare("select count(*) c from m").get();
  });

  // --- pragmas a real program sets
  await t("pragmas memory", () => [
    db.prepare("pragma journal_mode = WAL").get(),
    db.prepare("pragma synchronous = NORMAL").all(),
    db.prepare("pragma busy_timeout = 5000").get(),
    db.prepare("pragma cache_size = -64000").all(),
    db.prepare("pragma cache_size").get(),
    db.prepare("pragma foreign_keys = ON").all(),
    db.prepare("pragma table_info(u)").all(),
  ]);
  await t("pragmas file / WAL", () => {
    const d = new DatabaseSync(join(dir, "wal.db"));
    const r = [d.prepare("pragma journal_mode").get(), d.prepare("pragma journal_mode = WAL").get(), d.prepare("pragma journal_mode").get()];
    r.push(d.prepare("pragma synchronous = NORMAL").all(), d.prepare("pragma synchronous").get(), d.prepare("pragma page_size").get(), d.prepare("pragma locking_mode").get());
    d.exec("create table t(a); insert into t values (1), (2)");
    r.push(d.prepare("pragma wal_checkpoint(TRUNCATE)").get());
    r.push(d.prepare("select count(*) c from t").get());
    d.close();
    const again = new DatabaseSync(join(dir, "wal.db"));
    r.push(again.prepare("pragma journal_mode").get(), again.prepare("select count(*) c from t").get(), again.prepare("pragma integrity_check").get());
    again.close();
    return r;
  });
  await t("two connections, one file, WAL", () => {
    const a = new DatabaseSync(join(dir, "two.db"));
    a.exec("pragma journal_mode = WAL; create table t(a); insert into t values (1)");
    const b = new DatabaseSync(join(dir, "two.db"));
    const r = [b.prepare("select count(*) c from t").get()];
    a.exec("begin immediate; insert into t values (2)");
    r.push(b.prepare("select count(*) c from t").get());
    try { b.exec("begin immediate"); } catch (e) { r.push(show(e)); }
    a.exec("commit");
    r.push(b.prepare("select count(*) c from t").get());
    b.exec("insert into t values (3)");
    r.push(a.prepare("select count(*) c from t").get());
    a.close();
    b.close();
    return r;
  });
  await t("two connections, one file, rollback journal", () => {
    const a = new DatabaseSync(join(dir, "two-del.db"));
    a.exec("create table t(a); insert into t values (1)");
    const b = new DatabaseSync(join(dir, "two-del.db"));
    const r = [b.prepare("select count(*) c from t").get()];
    a.exec("begin immediate; insert into t values (2)");
    r.push(b.prepare("select count(*) c from t").get());
    try { b.exec("insert into t values (9)"); } catch (e) { r.push(show(e)); }
    a.exec("commit");
    b.exec("insert into t values (3)");
    r.push(a.prepare("select count(*) c from t").get());
    a.close();
    b.close();
    return r;
  });

  // --- user functions
  await t("function", () => {
    db.function("twice", (v) => v * 2);
    db.function("cat", { varargs: true }, (...a) => a.join("|"));
    db.function("nothing", () => undefined);
    db.function("bytes", () => new Uint8Array([7, 8]));
    db.function("big", () => 12n);
    db.function("argtypes", { varargs: true }, (...a) => a.map((v) => (v === null ? "null" : v instanceof Uint8Array ? "blob" : typeof v)).join(","));
    return db.prepare("select twice(21) a, cat('x', 2, null) b, nothing() c, bytes() d, big() e, typeof(big()) f, argtypes(1, 1.5, 't', x'00', null) g").get();
  });
  await t("function wrong arity", () => db.prepare("select twice(1, 2)").get());
  await t("function throws", () => {
    db.function("boom", () => { throw new RangeError("from js"); });
    return db.prepare("select boom()").get();
  });
  await t("function throws non-error", () => {
    db.function("boom2", () => { throw "a string"; });
    try { db.prepare("select boom2()").get(); } catch (e) { return ["thrown", e]; }
  });
  await t("function returns unsupported", () => {
    db.function("bad", () => ({}));
    return db.prepare("select bad()").get();
  });
  await t("function returns promise", () => {
    db.function("asyncfn", async () => 1);
    return db.prepare("select asyncfn()").get();
  });
  await t("function unsafe integer argument", () => db.prepare("select twice(9007199254740993)").get());
  await t("function useBigIntArguments", () => {
    db.function("bigarg", { useBigIntArguments: true }, (v) => typeof v);
    return db.prepare("select bigarg(1) a").get();
  });
  await t("function arg checks", () => {
    const r = [];
    for (const args of [[1, () => 1], ["f", 1], ["f", null, () => 1], ["f", { varargs: 1 }, () => 1], ["f", { deterministic: 1 }, () => 1], ["f", { directOnly: 1 }, () => 1], ["f", { useBigIntArguments: 1 }, () => 1]]) {
      try { db.function(...args); r.push("ok"); } catch (e) { r.push(show(e)); }
    }
    return r;
  });
  await t("function after statement prepared", () => {
    db.function("later", () => "v1");
    const s = db.prepare("select later() a");
    const r = [s.get()];
    db.function("later", () => "v2");
    r.push(s.get());
    return r;
  });
  await t("aggregate", () => {
    db.aggregate("sumsq", { start: 0, step: (acc, v) => acc + v * v });
    db.aggregate("collect", { start: () => [], step: (acc, v) => (acc.push(v), acc), result: (acc) => acc.join(",") });
    db.exec("create table g(k, v); insert into g values ('a', 1), ('a', 2), ('b', 3)");
    return [
      db.prepare("select k, sumsq(v) s, collect(v) c from g group by k order by k").all(),
      db.prepare("select sumsq(v) s, collect(v) c from g where 0").get(),
    ];
  });
  await t("aggregate window", () => {
    db.aggregate("wsum", { start: 0, step: (acc, v) => acc + v, inverse: (acc, v) => acc - v, result: (acc) => acc });
    return db.prepare("select v, wsum(v) over (order by v rows between 1 preceding and current row) w from g order by v").all();
  });
  await t("aggregate step throws", () => {
    db.aggregate("aggboom", { start: 0, step: () => { throw new Error("step failed"); } });
    return db.prepare("select aggboom(v) from g").get();
  });
  await t("aggregate arg checks", () => {
    const r = [];
    for (const args of [[1, {}], ["a", null], ["a", {}], ["a", { start: 0 }], ["a", { start: 0, step: 1 }], ["a", { start: 0, step: () => 0, inverse: 1 }]]) {
      try { db.aggregate(...args); r.push("ok"); } catch (e) { r.push(show(e)); }
    }
    return r;
  });

  // --- finalization
  await t("statement after close", () => {
    const d = new DatabaseSync(":memory:");
    const s = d.prepare("select 1 a");
    const it = s.iterate();
    d.close();
    const r = [];
    for (const f of [() => s.all(), () => s.get(), () => s.run(), () => s.iterate(), () => s.columns(), () => s.sourceSQL, () => s.expandedSQL, () => s.setReadBigInts(true), () => it.next()]) {
      try { r.push(show(f())); } catch (e) { r.push(show(e)); }
    }
    return r;
  });

  // --- serialize / deserialize / backup / tag store / authorizer
  await t("serialize + deserialize", () => {
    const d = new DatabaseSync(":memory:");
    d.exec("create table t(a); insert into t values (1), (2)");
    const bytes = d.serialize();
    const e = new DatabaseSync(":memory:");
    e.deserialize(bytes);
    return [bytes instanceof Uint8Array, bytes.length, Buffer.from(bytes.subarray(0, 15)).toString(), e.prepare("select a from t").all()];
  });
  await t("backup", async () => {
    const d = new DatabaseSync(":memory:");
    d.exec("create table t(a); insert into t values (1), (2)");
    const pages = await sqlite.backup(d, join(dir, "backup.db"));
    const e = new DatabaseSync(join(dir, "backup.db"));
    const r = [pages, e.prepare("select a from t").all()];
    e.close();
    return r;
  });
  await t("backup arg checks", async () => {
    const r = [];
    for (const args of [[1, "x"], [db, 1], [db, join(dir, "b2.db"), 1], [db, join(dir, "b2.db"), { rate: "x" }], [db, join(dir, "b2.db"), { progress: 1 }]]) {
      try { await sqlite.backup(...args); r.push("ok"); } catch (e) { r.push(show(e)); }
    }
    return r;
  });
  await t("tag store", () => {
    const d = new DatabaseSync(":memory:");
    d.exec("create table t(a, b)");
    const sql = d.createTagStore(2);
    const r = [sql.run`insert into t values (${1}, ${"x"})`, sql.get`select * from t where a = ${1}`, sql.all`select * from t`, [...sql.iterate`select a from t`]];
    r.push(sql.size, sql.capacity, sql.db === d);
    sql.clear();
    r.push(sql.size);
    return r;
  });
  await t("authorizer", () => {
    const d = new DatabaseSync(":memory:");
    d.exec("create table t(a)");
    const seen = [];
    d.setAuthorizer((...args) => (seen.push(args), sqlite.constants.SQLITE_OK));
    d.prepare("select a from t").all();
    const r = [seen];
    d.setAuthorizer((action) => (action === sqlite.constants.SQLITE_INSERT ? sqlite.constants.SQLITE_DENY : sqlite.constants.SQLITE_OK));
    try { d.prepare("insert into t values (1)"); } catch (e) { r.push(show(e)); }
    d.setAuthorizer(null);
    r.push(d.prepare("insert into t values (1)").run());
    return r;
  });
  await t("limits and misc sql", () => [
    db.prepare("select json_extract('{\"a\":[1,2]}', '$.a[1]') j, json_group_array(a) g from m").get(),
    db.prepare("select round(sqrt(2), 3) s, lower('ABC') l, date('2026-10-09', '+1 day') d, strftime('%Y', 'now') > '2000' y").get(),
    db.prepare("with recursive c(x) as (select 1 union all select x + 1 from c where x < 5) select group_concat(x) g from c").get(),
    db.prepare("select 'a' like 'A' l, 'abc' glob 'a*' g, printf('%05.1f', 3.14159) p, hex(randomblob(4)) is not null r").get(),
  ]);
  await t("persisted file re-read", () => {
    const d = new DatabaseSync(file);
    d.exec("create table if not exists keep(a, b); delete from keep");
    const ins = d.prepare("insert into keep values (?, ?)");
    d.exec("begin");
    for (let i = 0; i < 500; i++) ins.run(i, "row " + i);
    d.exec("commit");
    d.close();
    const e = new DatabaseSync(file);
    const r = [e.prepare("select count(*) c, sum(a) s from keep").get(), e.prepare("pragma integrity_check").get()];
    e.close();
    return r;
  });
  return out;
}

const verbose = process.argv.includes("--verbose");
const { sqlite: mine } = await loadSqlite();
const dirA = mkdtempSync(join(tmpdir(), "bat-sqlite-native-"));
const dirB = mkdtempSync(join(tmpdir(), "bat-sqlite-wasm-"));
const a = await run(native, dirA);
const b = await run(mine, dirB);
// Files written by one implementation must be readable by the other.
const cross = [];
for (const [label, sqlite, dir] of [["native reads ours", native, dirB], ["ours reads native", mine, dirA]]) {
  for (const name of ["a.db", "wal.db", "two.db", "backup.db"]) {
    try {
      const d = new sqlite.DatabaseSync(join(dir, name));
      const ok = d.prepare("pragma integrity_check").get().integrity_check;
      const tables = d.prepare("select count(*) c from sqlite_master").get().c;
      d.close();
      cross.push(`${label} ${name}: ${ok}, ${tables} schema rows`);
    } catch (e) {
      cross.push(`${label} ${name}: FAILED ${e.message}`);
    }
  }
}
rmSync(dirA, { recursive: true, force: true });
rmSync(dirB, { recursive: true, force: true });

let differ = 0;
for (let i = 0; i < a.length; i++) {
  const same = a[i][1] === b[i][1];
  if (!same) differ++;
  if (!same || verbose) {
    console.log(`${same ? "same" : "DIFF"}  ${a[i][0]}`);
    console.log(`      native: ${a[i][1]}`);
    if (!same) console.log(`      ours:   ${b[i][1]}`);
  }
}
for (const line of cross) console.log(line);
const crossFailed = cross.filter((l) => !/: ok, /.test(l)).length;
console.log(`${a.length} cases, ${differ} differ; cross-read ${cross.length - crossFailed}/${cross.length} ok (native ${process.version}, SQLite ${process.versions.sqlite})`);
process.exit(differ || crossFailed ? 1 : 0);
