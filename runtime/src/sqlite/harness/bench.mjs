// Timings of this implementation (node:fs backend) against native node:sqlite
// on the same machine and directory.
//
//   node runtime/src/sqlite/harness/bench.mjs [--dir DIR] [--runs N] [--json]
//
// Each figure is the median of N runs (default 7) on a fresh database file in
// WAL mode with synchronous=NORMAL, which is what the OpenCode server sets.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";
import * as native from "node:sqlite";
import { loadSqlite, wasmPath } from "./load.mjs";
import { firstBoot as firstBootWith, scenario } from "./scenarios.mjs";

const firstBoot = (sqlite, file) => firstBootWith(sqlite, file, (f) => rmSync(f, { force: true }));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const runs = Number(arg("--runs", 7));
const base = arg("--dir", tmpdir());
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const ms = (fn) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

// ---- cold start: each figure comes from a fresh Node process -----------------
//
// V8 compiles Wasm functions lazily, on their first call, and SQLite's first
// statements run through its largest functions (parser, code generator, VDBE).
// `prewarm` runs __bat.prewarm() first: in the same thread ("same worker", what
// a warm spare process worker would do), or on the main thread before the
// compiled Module is handed to a worker ("other thread").
const coldMode = arg("--cold-child");
if (coldMode) {
  const { Worker, isMainThread, workerData, parentPort } = await import("node:worker_threads");
  const file = join(arg("--dir", tmpdir()), `bat-sqlite-cold-${process.pid}.db`);
  if (!isMainThread) {
    const { sqlite } = await loadSqlite({ module: workerData.module, build: false });
    parentPort.postMessage(firstBoot(sqlite, file));
  } else if (coldMode === "native") {
    console.log(JSON.stringify({ boot: firstBoot(native, file) }));
  } else {
    const module = new WebAssembly.Module(readFileSync(wasmPath));
    const { sqlite } = await loadSqlite({ module, build: false });
    let prewarm = 0;
    if (coldMode !== "none") prewarm = ms(() => sqlite.__bat.prewarm(coldMode.endsWith("file") ? `${file}.warm` : undefined));
    if (coldMode.startsWith("other")) {
      const w = new Worker(new URL(import.meta.url), { workerData: { module }, argv: ["--cold-child", "worker", "--dir", arg("--dir", tmpdir())] });
      w.on("message", (boot) => {
        console.log(JSON.stringify({ boot, prewarm }));
        w.terminate();
      });
    } else console.log(JSON.stringify({ boot: firstBoot(sqlite, file), prewarm }));
  }
} else {
const bytes = readFileSync(wasmPath);
const engine = {
  "Wasm size": `${(bytes.length / 1024).toFixed(0)} KiB (${(gzipSync(bytes, { level: 9 }).length / 1024).toFixed(0)} KiB gzip, ${(brotliCompressSync(bytes).length / 1024).toFixed(0)} KiB brotli)`,
};
{
  const compile = [];
  for (let i = 0; i < runs; i++) compile.push(ms(() => new WebAssembly.Module(bytes)));
  engine["compile (new WebAssembly.Module)"] = median(compile);
  // Instantiate + first open, with a precompiled module, in a fresh factory each time.
  const inst = [];
  const first = [];
  for (let i = 0; i < runs; i++) {
    const { sqlite } = await loadSqlite({ precompiled: true });
    first.push(ms(() => new sqlite.DatabaseSync(":memory:").prepare("select 1").get()));
    inst.push(sqlite.__bat.engine.instantiateMs);
  }
  engine["instantiate (new WebAssembly.Instance + init)"] = median(inst);
  engine["first open + first query, precompiled module"] = median(first);
}

const { sqlite: mine, backend } = await loadSqlite({ precompiled: true });
const results = { native: {}, ours: {} };
for (const [label, sqlite] of [["native", native], ["ours", mine]]) {
  const dir = mkdtempSync(join(base, `bat-sqlite-bench-${label}-`));
  scenario(sqlite, dir, "warm"); // one untimed pass
  const all = [];
  for (let i = 0; i < runs; i++) all.push(scenario(sqlite, dir, i));
  for (const k of Object.keys(all[0])) results[label][k] = { median: median(all.map((r) => r[k])), min: Math.min(...all.map((r) => r[k])) };
  rmSync(dir, { recursive: true, force: true });
}


const coldRuns = Number(arg("--cold-runs", 15));
const cold = {};
{
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const modes = [["native node:sqlite", "native"], ["ours, no prewarm", "none"], ["ours, after prewarm(scratch file), same worker", "same-file"], ["ours, after prewarm(:memory:), same worker", "same-memory"], ["ours, in a worker; another thread prewarmed (file)", "other-file"]];
  for (const [label, mode] of modes) {
    const boots = [];
    const warms = [];
    for (let i = 0; i < coldRuns; i++) {
      const r = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--cold-child", mode, "--dir", base], { encoding: "utf8" }));
      boots.push(r.boot);
      if (r.prewarm) warms.push(r.prewarm);
    }
    cold[label] = `${median(boots).toFixed(1)} (${Math.min(...boots).toFixed(1)})` + (warms.length ? `; the prewarm itself ${median(warms).toFixed(1)} (${Math.min(...warms).toFixed(1)})` : "");
  }
}
const load = loadavg().map((v) => v.toFixed(1)).join(" ");
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ engine, results, cold, load, runs, dir: base }, null, 2));
} else {
  console.log(`node ${process.version}, SQLite ${process.versions.sqlite} native; ${runs} runs, median; dir ${base} (${statSync(base).dev}); load average ${load}`);
  for (const [k, v] of Object.entries(engine)) console.log(`${k.padEnd(52)} ${typeof v === "number" ? v.toFixed(2) + " ms" : v}`);
  console.log(`${"ms, median (min)".padEnd(52)} ${"native".padStart(16)} ${"ours".padStart(16)}  ratio of medians`);
  const cell = (v) => `${v.median.toFixed(2)} (${v.min.toFixed(2)})`.padStart(16);
  for (const k of Object.keys(results.native)) {
    const a = results.native[k];
    const b = results.ours[k];
    console.log(`${k.padEnd(52)} ${cell(a)} ${cell(b)}  ${(b.median / a.median).toFixed(2)}x`);
  }
  console.log(`cold start: first-boot workload (open, WAL, 4 pragmas, 20 tables + 20 indexes + 20 inserts in one transaction, 1 select) in a fresh process, ${coldRuns} processes each, ms median (min):`);
  for (const [k, v] of Object.entries(cold)) console.log(`  ${k.padEnd(50)} ${v}`);
  console.log(`backend calls (ours, all runs): ${JSON.stringify(backend.stats)}`);
}
}
