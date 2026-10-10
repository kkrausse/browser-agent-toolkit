#!/bin/sh
# The whole prototype in one command: build the Rust test guest, serve the page
# on 127.0.0.1:4797, open it in the shared Chrome through browser-control, print
# the checks and numbers, stop the server.
#
#   ./run.sh ['query', default '' = everything; 'arg=quick' checks only;
#             'warm=0&arg=cold&arg=quick' first command with no shell Worker up;
#             'spin=0&arg=worker-only' channel without spinning]
#
# Needs: wasm-term's kernel built (cd ../../web && bun run build), bat_sh.wasm
# (BAT_SH_WASM, default the bat-rust worktree `codex-shell`:
#  CARGO_TARGET_DIR=$PWD/target-codex-shell/sh-wasm sh crates/bat-sh/build-wasm.sh there),
# bun, cargo with wasm32-wasip1, the browser-control CLI with Chrome running.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
session=${SESSION:-shell-proto-run}
(cd "$here/guest" && CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-4} cargo build --release 2>&1 | tail -1)
bun "$here/web/server.ts" > /tmp/shell-proto-server.log 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; browser-control session delete "$session" >/dev/null 2>&1 || true' EXIT
sleep 1
browser-control session new "$session" >/dev/null
"$here/web/drive.sh" "${1:-}" "$session" > /tmp/shell-proto-result.json
bun -e '
const d = JSON.parse(await Bun.file("/tmp/shell-proto-result.json").text());
const v = d.value ?? d;
if (!v.result) { console.log(v.tail ?? d); process.exit(1); }
for (const c of v.result.checks) console.log(c.ok ? "ok  " : "FAIL", c.name, c.ok ? "" : c.detail);
for (const [k, x] of Object.entries(v.result.numbers)) console.log("    ", k, JSON.stringify(x));
console.log("shell Worker starts (ms):", v.workerStarts.map(s => `${s.why} ${s.ms}`).join(", "));
console.log(v.result.failed === 0 ? "all checks passed" : `${v.result.failed} FAILED`, "-", v.userAgent);
process.exit(v.result.failed === 0 ? 0 : 1);
'
