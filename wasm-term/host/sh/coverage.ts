// bat-rust's coverage cases for a coding agent's shell tool
// (crates/bat-sh/tests/codex-cases.tsv) run through THIS integration: the
// pinned bat_sh.wasm + wasm.ts + host.ts on wasm-term's vfs, under Bun (no
// browser: nothing here needs a Worker). Each case is compared with the
// machine's bash, and its real rg/nl/diff/..., on the same files.
//
//   bun host/sh/coverage.ts [filter-regex]        after host/sh/build.sh
//
// The cases and the fixture are the pinned commit's own (build.sh leaves its
// sources in vendor/bat-sh-src): the fixture is whatever `setup()` in
// tests/codex-coverage.sh creates. Verdicts: same / differs / missing (the
// shell said "command not found") / no-ref (the machine lacks the program too).

import { mkdtempSync, readdirSync, readFileSync, readlinkSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createVfs, type Vfs } from "../vfs";
import { createShHost } from "./host";
import { createShRunner } from "./wasm";

const root = join(import.meta.dir, "../..");
const tests = join(root, "vendor/bat-sh-src/crates/bat-sh/tests");
const filter = new RegExp(process.argv[2] ?? ".");
const module = new WebAssembly.Module(readFileSync(join(import.meta.dir, "dist/bat_sh.wasm")));
const cases = readFileSync(join(tests, "codex-cases.tsv"), "utf8").split("\n")
  .filter(line => line && !line.startsWith("#")).map(line => line.split("\t")).map(([group, label, command]) => ({ group: group!, label: label!, command: command!.replaceAll("¶", "\n") }));
// `setup() { ... }` (and its helpers, `setup_*`) out of the bash runner: one definition of the fixture for both runners.
const setup = (readFileSync(join(tests, "codex-coverage.sh"), "utf8").match(/^setup\w*\(\) \{\n[\s\S]*?\n\}/gm) ?? []).join("\n");
if (!setup.includes("setup() {")) throw new Error("no setup() in codex-coverage.sh");

const tmp = mkdtempSync("/tmp/wasm-term-sh-cov-");
const work = join(tmp, "w");
const LANG = process.env.LANG ?? "C.UTF-8";
function makeFixture(group: string): void {
  rmSync(work, { recursive: true, force: true });
  const made = Bun.spawnSync(["bash", "-c", `${setup}\nsetup "$1" "$2"`, "setup", work, group]);
  if (made.exitCode !== 0) throw new Error(`fixture setup failed: ${made.stderr}`);
}

function reference(group: string, command: string): { out: string; err: string; status: number } {
  makeFixture(group);
  const run = Bun.spawnSync(["bash", "-c", command], { cwd: work, env: { PATH: process.env.PATH!, TZ: "UTC", HOME: work, LANG }, stdin: "ignore" });
  return { out: run.stdout.toString(), err: run.stderr.toString(), status: run.exitCode };
}

/** Copies a directory of the machine into the vfs. */
function load(vfs: Vfs, from: string, to: string): void {
  vfs.mkdirp(to);
  for (const name of readdirSync(from)) {
    const stat = lstatSync(join(from, name));
    if (stat.isDirectory()) load(vfs, join(from, name), `${to}/${name}`);
    else if (stat.isSymbolicLink()) vfs.symlink(vfs.mkdirp(to), name, readlinkSync(join(from, name)));
    else vfs.writeFile(`${to}/${name}`, new Uint8Array(readFileSync(join(from, name))));
  }
}

function ours(group: string, command: string): { out: string; err: string; status: number } {
  makeFixture(group);
  const vfs = createVfs();
  const encoder = new TextEncoder();
  for (const stub of ["/bin/sh", "/bin/bash", "/usr/bin/bash", "/usr/bin/env"]) vfs.writeFile(stub, new Uint8Array(0));
  // The same absolute path as the reference run, so that `pwd` and error messages agree.
  load(vfs, work, work);
  const chunks: [Uint8Array[], Uint8Array[]] = [[], []];
  const host = createShHost(vfs, { output: (stream, data) => void chunks[stream - 1]!.push(data), stdin: () => new Uint8Array(0) });
  const deadline = performance.now() + 10_000;
  const checkpoint = () => {
    if (performance.now() > deadline) throw new Error("timeout");
  };
  const runner = createShRunner({ module, call: host.call, checkpoint, sleep: ms => (checkpoint(), Bun.sleepSync(ms)) });
  let status: number;
  try {
    status = runner.run({ argv: ["bash", "-c", command], env: ["PATH=/usr/bin:/bin", "TZ=UTC", `HOME=${work}`, `LANG=${LANG}`], cwd: work });
  } catch (thrown) {
    status = 134;
    chunks[1].push(encoder.encode(String(thrown)));
  }
  const text = (parts: Uint8Array[]) => Buffer.concat(parts).toString();
  return { out: text(chunks[0]), err: text(chunks[1]), status };
}

const count = { same: 0, differs: 0, missing: 0, "no-ref": 0 };
for (const { group, label, command } of cases) {
  if (!filter.test(`${group}/${label}`)) continue;
  const expected = reference(group, command);
  const got = ours(group, command);
  const verdict = /command not found/.test(got.err) && got.status === 127 ? "missing"
    : /command not found/.test(expected.err) ? "no-ref"
    : expected.out === got.out && expected.status === got.status ? "same" : "differs";
  count[verdict]++;
  console.log(`${verdict.padEnd(8)}${group.padEnd(10)}${label}`);
  if (verdict === "differs") console.log(`        bash ${expected.status} ${JSON.stringify(expected.out.slice(0, 110))} | here ${got.status} ${JSON.stringify(got.out.slice(0, 110))} ${JSON.stringify(got.err.slice(0, 110))}`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`same=${count.same} differs=${count.differs} missing=${count.missing} no-ref=${count["no-ref"]}`);
