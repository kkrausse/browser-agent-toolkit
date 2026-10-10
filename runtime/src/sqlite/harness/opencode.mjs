// The real consumer: the OpenCode 2.0.3 server bundle (27.7 MB) run natively
// through the module loader, as crates/bat-modules/harness/opencode.mjs does,
// with `node:sqlite` replaced by this implementation over the node:fs backend.
//
//   node --experimental-import-meta-resolve runtime/src/sqlite/harness/opencode.mjs [--native] [DIR_WITH_server.js]
//
// Two starts on one database file: a first boot (schema bootstrap) and a
// reopen. For each: wait for OPENCODE_SERVER_PROCESS_READY, GET /api/health,
// end stdin (the server shuts down), then check the file with native SQLite.
// Every node:sqlite call is counted and timed, with the same wrapper whichever
// implementation is underneath; `--native` runs the same thing on native
// node:sqlite for comparison.
//
// The server binds 127.0.0.1:4096 (fixed in the bundle), so only one such
// harness can run at a time on a machine.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modulesHarness = join(here, "../../../../crates/bat-modules/harness");
const useNative = process.argv.includes("--native");
const directory =
  process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ??
  "/home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit/vivari/.runtime/opencode-release-2.0.3/.runtime/opencode-bun-server";

/** Count and time every call into a node:sqlite module object. */
function instrument(sqlite) {
  const stats = {};
  const big = [];
  const note = (name, ms, sql) => {
    const s = (stats[name] ??= { calls: 0, ms: 0 });
    s.calls++;
    s.ms += ms;
    if (ms >= 5) big.push({ name, ms: +ms.toFixed(1), sql: String(sql ?? "").slice(0, 70) });
  };
  const wrap = (proto, name, label, sqlOf) => {
    const original = proto[name];
    proto[name] = function (...args) {
      const t = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        note(label, performance.now() - t, sqlOf?.(this, args));
      }
    };
  };
  const sources = new WeakMap();
  for (const name of ["exec", "close", "open"]) wrap(sqlite.DatabaseSync.prototype, name, name, (_, a) => a[0]);
  const prepare = sqlite.DatabaseSync.prototype.prepare;
  sqlite.DatabaseSync.prototype.prepare = function (sql) {
    const t = performance.now();
    try {
      const statement = prepare.call(this, sql);
      sources.set(statement, sql);
      return statement;
    } finally {
      note("prepare", performance.now() - t, sql);
    }
  };
  for (const name of ["all", "get", "run", "iterate"]) wrap(sqlite.StatementSync.prototype, name, name, (self) => sources.get(self));
  class DatabaseSync extends sqlite.DatabaseSync {
    constructor(...args) {
      const t = performance.now();
      super(...args);
      note("new DatabaseSync", performance.now() - t, args[0]);
    }
  }
  const snapshot = () => {
    const calls = Object.values(stats).reduce((n, s) => n + s.calls, 0);
    const ms = Object.values(stats).reduce((n, s) => n + s.ms, 0);
    return { calls, ms: +ms.toFixed(1), by: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, `${v.calls} / ${v.ms.toFixed(1)} ms`])), slow: [...big] };
  };
  return { module: { ...sqlite, DatabaseSync, default: undefined }, snapshot };
}

if (process.argv.includes("--child")) {
  const { createLoader } = await import(join(modulesHarness, "loader.mjs"));
  const { createNodeHost } = await import(join(modulesHarness, "node-host.mjs"));
  let sqlite;
  let engine;
  let backend;
  if (useNative) sqlite = await import("node:sqlite");
  else {
    const loaded = await (await import("./load.mjs")).loadSqlite({ precompiled: true });
    sqlite = loaded.sqlite;
    backend = loaded.backend;
    engine = () => sqlite.__bat.engine;
  }
  const counted = instrument(sqlite);
  const report = (phase) =>
    console.log(`HARNESS sqlite ${phase} ${JSON.stringify({ ...counted.snapshot(), engine: engine?.(), backend: backend?.stats })}`);
  const write = process.stdout.write.bind(process.stdout);
  let seen = false;
  process.stdout.write = (chunk, ...rest) => {
    const r = write(chunk, ...rest);
    if (!seen && String(chunk).includes("OPENCODE_SERVER_PROCESS_READY")) {
      seen = true;
      report("at-ready");
    }
    return r;
  };
  process.on("exit", () => report("at-exit"));

  const start = performance.now();
  const host = await createNodeHost();
  const builtin = host.builtin;
  host.builtin = (id, loader) => (id === "node:sqlite" ? counted.module : builtin(id, loader));
  const loader = createLoader(host);
  process.chdir(directory);
  await loader.runMain(join(directory, "server.js"));
  console.log(`HARNESS main module finished after ${(performance.now() - start).toFixed(0)} ms`);
} else {
  const portBusy = () =>
    new Promise((resolve) => {
      const s = createConnection({ port: 4096, host: "127.0.0.1" });
      s.once("connect", () => (s.destroy(), resolve(true)));
      s.once("error", () => resolve(false));
    });
  for (let i = 0; (await portBusy()) && i < 120; i++) {
    if (i === 0) console.log("port 4096 is in use (another harness?); waiting up to 120 s");
    await new Promise((r) => setTimeout(r, 1000));
  }
  const scratch = mkdtempSync(join(tmpdir(), "bat-opencode-sqlite-"));
  const database = join(scratch, "opencode.sqlite");
  const password = "harness-password";
  const startServer = (label) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--experimental-import-meta-resolve", fileURLToPath(import.meta.url), "--child", ...(useNative ? ["--native"] : []), directory], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: join(scratch, "home"),
          OPENCODE_TEST_HOME: join(scratch, "home"),
          XDG_CONFIG_HOME: join(scratch, "config"),
          XDG_STATE_HOME: join(scratch, "state"),
          XDG_DATA_HOME: join(scratch, "data"),
          XDG_CACHE_HOME: join(scratch, "cache"),
          TMPDIR: scratch,
          OPENCODE_PASSWORD: password,
          OPENCODE_DATABASE_PATH: database,
          OPENCODE_TREE_SITTER_WASM_PATH: join(directory, "tree-sitter.wasm"),
          OPENCODE_TREE_SITTER_BASH_WASM_PATH: join(directory, "tree-sitter-bash.wasm"),
          OPENCODE_TREE_SITTER_POWERSHELL_WASM_PATH: join(directory, "tree-sitter-powershell.wasm"),
          ...(process.env.BAT_SQLITE_WASM ? { BAT_SQLITE_WASM: process.env.BAT_SQLITE_WASM } : {}),
        },
      });
      const started = performance.now();
      let output = "";
      let errors = "";
      let result = "FAIL: exited before OPENCODE_SERVER_PROCESS_READY";
      let asked = false;
      const timer = setTimeout(() => {
        result = "FAIL: no OPENCODE_SERVER_PROCESS_READY within 90 s";
        child.kill("SIGKILL");
      }, 90_000);
      child.stderr.on("data", (c) => (errors += c));
      child.stdout.on("data", async (chunk) => {
        output += chunk;
        if (asked || !output.includes("OPENCODE_SERVER_PROCESS_READY")) return;
        asked = true;
        const ready = performance.now() - started;
        try {
          const response = await fetch("http://127.0.0.1:4096/api/health", {
            headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
          });
          const body = await response.text();
          result = `${response.ok ? "PASS" : "FAIL"}: ready after ${ready.toFixed(0)} ms; GET /api/health -> ${response.status} ${body.slice(0, 120)}`;
        } catch (error) {
          result = `FAIL: ready after ${ready.toFixed(0)} ms but /api/health failed: ${error}`;
        }
        child.stdin.end(); // the server shuts down when stdin ends
        setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        const lines = output.split("\n").filter((l) => l.startsWith("HARNESS sqlite"));
        resolve({ label, result, code: code ?? signal, lines, errors, output });
      });
    });

  let ok = true;
  console.log(`node:sqlite = ${useNative ? "native" : "runtime/src/sqlite (Wasm, node:fs backend)"}; load average ${loadavg().map((v) => v.toFixed(1)).join(" ")}`);
  for (const label of ["first boot", "reopen"]) {
    const r = await startServer(label);
    console.log(`\n[${label}] ${r.result} (child exit ${r.code})`);
    for (const line of r.lines) {
      const phase = line.split(" ")[2];
      const data = JSON.parse(line.slice(line.indexOf("{")));
      console.log(`  ${phase}: ${data.calls} calls, ${data.ms} ms in node:sqlite`);
      console.log(`    ${Object.entries(data.by).map(([k, v]) => `${k} ${v}`).join("; ")}`);
      if (data.engine) console.log(`    engine: compile ${data.engine.compileMs.toFixed(2)} ms, instantiate ${data.engine.instantiateMs.toFixed(2)} ms; backend ${JSON.stringify(data.backend)}`);
      for (const s of data.slow) console.log(`    slow: ${s.name} ${s.ms} ms  ${JSON.stringify(s.sql)}`);
    }
    if (!r.result.startsWith("PASS") || r.code !== 0) {
      ok = false;
      console.log(r.output.split("\n").slice(-15).join("\n"));
      console.log(r.errors.split("\n").slice(-25).join("\n"));
    }
    // What the shutdown left on disk, checked by native SQLite.
    const files = readdirSync(scratch).filter((f) => f.startsWith("opencode.sqlite")).map((f) => `${f} ${statSync(join(scratch, f)).size}`);
    let check = "missing";
    if (existsSync(database)) {
      const { DatabaseSync } = await import("node:sqlite");
      const d = new DatabaseSync(database);
      const tables = d.prepare("select count(*) c from sqlite_master where type = 'table'").get().c;
      const mode = d.prepare("pragma journal_mode").get().journal_mode;
      check = `integrity ${d.prepare("pragma integrity_check").get().integrity_check}, ${tables} tables, journal_mode ${mode}`;
      d.close();
      if (!check.startsWith("integrity ok")) ok = false;
    } else ok = false;
    console.log(`  on disk after shutdown: ${files.join(", ")}; native check: ${check}`);
  }
  rmSync(scratch, { recursive: true, force: true });
  console.log(ok ? "\nPASS" : "\nFAIL");
  process.exit(ok ? 0 : 1);
}
