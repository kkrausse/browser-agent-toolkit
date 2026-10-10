#!/bin/bash
# Write what the machine's bash prints for every case in cases.txt as JSON, for
# the in-browser comparison (runtime/harness/guests/shell.cjs).
#   crates/bat-sh/tests/expected.sh > runtime/harness/guests/shell-cases.json
here=$(cd "$(dirname "$0")" && pwd)
work=/tmp/bat-sh-expected/work
node -e '
const fs = require("fs"), cp = require("child_process")
const [file, work] = process.argv.slice(1)
const cases = fs.readFileSync(file, "utf8").split("\x01").map((c) => c.replace(/^\n/, "")).filter(Boolean)
const fixture = {
  "src/a.tsx": "export const a = 1\n", "src/b.tsx": "export const b = 2\nconsole.log(\"b\")\n", "src/sub/c.ts": "x\n",
  "package.json": "{\n  \"name\": \"demo\",\n  \"version\": \"1.0.0\",\n  \"scripts\": { \"hello\": \"echo hello $npm_lifecycle_event\" }\n}\n",
  "list.txt": "banana\napple\ncherry\napple\n10\n9\n", "words.txt": "one two three\nfour five six\n",
}
const out = []
for (const c of cases) {
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work + "/empty", { recursive: true })
  for (const [p, text] of Object.entries(fixture)) { fs.mkdirSync(require("path").dirname(work + "/" + p), { recursive: true }); fs.writeFileSync(work + "/" + p, text, { mode: 0o644 }) }
  const r = cp.spawnSync("bash", ["-c", c], { cwd: work, env: { PATH: process.env.PATH, HOME: "/home/user", TZ: "UTC" }, encoding: "utf8" })
  out.push({ script: c, stdout: r.stdout, status: r.status, stderr: r.stderr.length > 0 })
}
console.log(JSON.stringify({ fixture, cases: out }, null, 1))
' "$here/cases.txt" "$work"
