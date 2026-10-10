// The codex coverage cases of bat-rust (crates/bat-sh/tests/codex-cases.tsv) run
// through the prototype's integration: bat_sh.wasm + sh-wasm.ts + sh-host.ts on
// wasm-term's vfs, under Bun (no browser: nothing here needs a Worker). Each
// case is compared with the machine's bash on the same files.
//
//   bun coverage.ts <bat-rust worktree> [filter]
//
// Verdicts: same / differs / missing (the shell said "command not found").

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createVfs } from "../../host/vfs";
import { createShHost } from "./host/sh-host";
import { createShRunner } from "./host/sh-wasm";

const batRust = process.argv[2] ?? "/home/kkrausse/devfs/repos/kkrausse/bat-rust/.claude/worktrees/codex-shell";
const filter = new RegExp(process.argv[3] ?? ".");
const module = new WebAssembly.Module(readFileSync(join(batRust, "crates/bat-sh/js/bat_sh.wasm")));
const cases = readFileSync(join(batRust, "crates/bat-sh/tests/codex-cases.tsv"), "utf8").split("\n")
  .filter(line => line && !line.startsWith("#")).map(line => line.split("\t")).map(([group, label, command]) => ({ group: group!, label: label!, command: command!.replaceAll("¶", "\n") }));

const fixture: Record<string, string> = {
  "src/main.rs": 'fn main() {\n    println!("hello");\n    let total = add(1, 2);\n}\n\nfn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n',
  "src/util/helper.rs": "pub fn helper() -> u32 {\n    42 // TODO: real value\n}\n",
  "README.md": "# Demo\n\nA small project.\n\n## Usage\n\nrun it\n",
  "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
  "package.json": '{"name":"demo","version":"1.0.0","scripts":{"test":"echo ok"}}\n',
  "list.txt": "banana\napple\ncherry\napple\n10\n9\n",
  "people.txt": "alice 30 nyc\nbob 25 sf\ncarol 35 nyc\n",
  "a.txt": "line1\nline2\nline3\n",
  "b.txt": "line1\nline2 changed\nline3\nline4\n",
  "docs/notes.md": "notes\n",
};

const tmp = mkdtempSync("/tmp/shell-proto-cov-");
function reference(command: string): { out: string; status: number } {
  const dir = join(tmp, "w");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "empty"), { recursive: true });
  for (const [path, text] of Object.entries(fixture)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const run = Bun.spawnSync(["bash", "-c", command], { cwd: dir, env: { PATH: process.env.PATH!, TZ: "UTC", HOME: dir }, stdin: "ignore" });
  return { out: run.stdout.toString(), status: run.exitCode };
}

function ours(command: string): { out: string; err: string; status: number } {
  const vfs = createVfs();
  const encoder = new TextEncoder();
  vfs.mkdirp("/w/empty");
  for (const stub of ["/bin/sh", "/bin/bash", "/usr/bin/env"]) vfs.writeFile(stub, new Uint8Array(0));
  for (const [path, text] of Object.entries(fixture)) vfs.writeFile(`/w/${path}`, encoder.encode(text));
  const chunks: [Uint8Array[], Uint8Array[]] = [[], []];
  const host = createShHost(vfs, (stream, data) => void chunks[stream - 1]!.push(data));
  const deadline = performance.now() + 5000;
  const checkpoint = () => {
    if (performance.now() > deadline) throw new Error("timeout");
  };
  const runner = createShRunner({ module, call: host.call, checkpoint, sleep: ms => Bun.sleepSync(ms) });
  let status: number;
  try {
    status = runner.run({ argv: ["bash", "-c", command], env: ["PATH=/usr/bin:/bin", "TZ=UTC", "HOME=/w"], cwd: "/w" });
  } catch (thrown) {
    status = 134;
    chunks[1].push(encoder.encode(String(thrown)));
  }
  const text = (parts: Uint8Array[]) => Buffer.concat(parts).toString();
  return { out: text(chunks[0]), err: text(chunks[1]), status };
}

const count = { same: 0, differs: 0, missing: 0 };
for (const { group, label, command } of cases) {
  if (!filter.test(`${group}/${label}`)) continue;
  const expected = reference(command);
  const got = ours(command);
  const verdict = /command not found/.test(got.err) ? "missing" : expected.out === got.out && expected.status === got.status ? "same" : "differs";
  count[verdict]++;
  console.log(`${verdict.padEnd(8)}${group.padEnd(8)}${label}`);
  if (verdict === "differs") console.log(`        bash ${expected.status} ${JSON.stringify(expected.out.slice(0, 100))} | here ${got.status} ${JSON.stringify(got.out.slice(0, 100))} ${JSON.stringify(got.err.slice(0, 100))}`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`same=${count.same} differs=${count.differs} missing=${count.missing}`);
