# First open, image identity, and a shell (2026-10-10)

Three gaps of the rewrite, closed on branch `rewrite/rust`. Decisions:
`docs/design/decisions.md` ("first open, image identity" and "shell"). Format and ABI:
`docs/design/image-format.md` ("Transfer copy, sums, start-up order", "Layers"),
`docs/design/kernel-abi.md` §17.

diesel2, 12 cores, Chrome 154 headed on Xvfb through `browser-control`. **The machine was
busy the whole time** (other agents' builds and browsers; 1-minute load average 11–39).
The load is given with every row; the "before" rows were taken at about twice the load of
the "after" rows, so compare each first open with the reopen measured beside it, not only
before with after.

## Gap 1: the first-ever open

### Method

`bench/first-open/run.ts` opens the TODO example's editor on an origin the browser has
never seen (`http://fo-<stamp>-<i>.localhost:<port>`): empty OPFS, no service worker,
nothing in the HTTP cache, without clearing the cache other tabs depend on. Then the same
origin is opened once more (the reopen), and its storage is removed. Times are ms after
the click on "Open editor"; "whole open" is the later of "app visible in the preview" and
"chat ready". No chat message is sent.

The 50 Mbit/s rows go through `bench/first-open/proxy.ts`, a token bucket shared by all
response bodies in front of the example server. Chrome's own throttling (CDP
`Network.emulateNetworkConditions`) was not used: it applies per target and the image is
fetched by a worker. The proxy adds no latency, so these rows model bandwidth only.

"Before" is the committed state `538ec89`; "after" is `7351bd5` or later, both built in
private copies of the worktree (`bench/first-open/sync.sh`).

### Result

| | load | n | boot | app visible | chat ready | whole open, median (min–max) | image complete | on the wire |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| localhost, first open, before | 32–39 | 3 | 11,172 | 15,765 | 20,413 | **20,413** (15,054–27,158) | with boot | 281 MB |
| localhost, reopen, before | 34–39 | 3 | 715 | 7,353 | 8,532 | 8,532 (5,759–10,984) | | |
| localhost, first open, after | 17–23 | 4 | 561 | 3,317 | 5,314 | **5,314** (5,015–5,635) | 7,632 | 41 MB |
| localhost, reopen, after | 17–21 | 4 | 203 | 2,150 | 4,027 | 4,027 (3,472–4,463) | | |
| 50 Mbit/s, first open, before | 23–32 | 3 | 40,690 | 45,154 | 50,938 | **50,938** (50,922–51,236) | with boot | 281 MB |
| 50 Mbit/s, reopen, before | 24–30 | 3 | 510 | 3,633 | 5,894 | 5,894 (5,472–6,440) | | |
| 50 Mbit/s, first open, after | 11–15 | 4 | 630 | 3,355 | 5,456 | **5,456** (4,625–9,190) | 9,017 | 41 MB |
| 50 Mbit/s, reopen, after | 11–15 | 4 | 135 | 1,483 | 2,798 | 2,798 (2,551–7,101) | | |

So a first open is now about 1.3 s (localhost) to 2.7 s (50 Mbit/s) slower than a reopen
at the same load, instead of 12 s and 45 s. What is left in that difference: 41 MB still
have to arrive before everything is local (the start-up needs about 9 MB of them: the
image's first 13.5 MB, two program scripts, the runtime), the program scripts are compiled
without a V8 code cache, the workspace is installed and OpenCode creates its database.
The rows are small samples on a loaded machine; the 9.2 s and 7.1 s maxima in the last two
rows are one pair taken together.

Raw samples: `bench/first-open/out/{before,after}-{local,50mbit}.json`.

### What changed, and what each step bought

Single trial runs while building, load 24–30, 50 Mbit/s first open unless said:

| Step | whole open | on the wire |
| --- | --- | --- |
| before | 50.9 s | 281 MB |
| zstd copy of the image, block sums checked with WebCrypto, mount when the head is in (localhost: 9.5 s, both programs waited for the image to finish at 5.0 s) | not run | |
| + start-up order in the image (localhost: 6.9 s; app visible before the image is complete) | 15.0 s | 70.6 MB |
| + program script, derived bundle, runtime files compressed | 10.4 s | 41.7 MB |
| + image remainder held back until the programs are up; toolkit's runtime copy out of the layer | 5.7 s | 39.7 MB |

- **Transport.** `bat-prepare` writes `<image>.zst` (zstd level 9: 238.9 → 32.2 MB;
  `--zstd-level 19`: 29.0 MB, 47 s instead of 2 s to compress on the busy machine) and the
  handler, which already knew how, answers with `Content-Encoding: zstd`. Chrome 154 has
  no `DecompressionStream('zstd')` (nor `'brotli'`; checked in the browser), so the
  network stack decodes. Brotli was compared for size and build time only (decisions.md);
  a Wasm decoder was not built, and the browser's decode speed was not measured in
  isolation: with everything else running, 239 MB were decoded, hashed and written in
  4.3–5.1 s on localhost at load 25–30.
- **Integrity: what is verified, and when.** Prepare writes the SHA-256 of every MiB of
  the image to `<image>.sums`; the manifest (fetched `no-store` from the origin) carries
  the hash of that file. The browser checks the sums file, then hashes each MiB of the
  decoded stream with WebCrypto and compares **before writing the block**; the total
  length is checked at the end. Nothing unverified is ever in the file, which is what
  allows using it early. Not verified: that OPFS returns what was written (it was not
  before either), and the whole-file SHA-256 is no longer recomputed in the browser. A
  prepared directory without sums falls back to the old whole-file Wasm hash and is not
  used early.
- **Usable before complete.** The image is mounted when its head (2.5 MB) is in the file;
  the kernel waits in reads of ranges that have not arrived. `bat-prepare app --order`
  lays out what a start-up reads directly after the head: `bench/first-open/trace.ts`
  records the kernel's image reads during a real first open (946 reads, 758 files,
  11.0 MB) and `bat-prepare order` turns them into
  `examples/todo-app/editor-startup-order.txt`. Checked by tracing the ordered image
  again: every read of a start-up ends below 13.5 MB of 238.9 MB. The browser stops
  reading the image there until the toolkit reports the programs up, then fetches the
  other 225 MB in the background (complete 2–4 s after chat ready).
- **Measured benefit of the "usable before complete" part**: on localhost 9.5 s → 6.9 s
  (single runs, same load); at 50 Mbit/s it is most of the gain, since the compressed
  image alone is 5.2 s of link time and the editor is ready about when it would have
  finished downloading.

### Verified in Chrome

- First opens on never-seen origins, n = 4 each at localhost and 50 Mbit/s, all `ok`
  (preview shows the app, chat handshake done), `crossOriginIsolated`.
- The bytes on the wire per path (proxy counters): image 32.2 MB, OpenCode program
  4.1 MB, start-up program 1.2 MB, layer 0.12 MB, runtime files under 0.5 MB each.
- After the reopen the origin's OPFS holds exactly `image-<hash>.batimg` for both images
  (the `.partial` files were renamed by the second open).
- One failure found this way and fixed: a small image finished and was renamed between
  the announcement of its `.partial` file and the mount ("file not found").
- The README scenario (`examples/todo-app/demo/run.ts`, one model conversation) passes
  on the final state: 6 `read`, 3 `edit`, `runJavascript`, preview dark without reload.
- `runtime/harness/check.sh`: 12 of 12 as expected on the new kernel, with a prepared
  directory that has a layer.

### Not done, not verified

- A download that is interrupted restarts from the beginning (the server supports
  ranges, a zstd frame cannot be resumed mid-way without independent frames).
- The failure path while in use (network drops after the editor started: reads of the
  missing ranges fail with `EIO`, the error goes to the console) was written, not
  exercised. Nor was a corrupted block.
- The editor UI does not say that the image is still arriving; an agent tool that needs
  a file from the remainder in those seconds (TypeScript's 9 MB, say) waits for it.
- Latency was not modelled, only bandwidth; no real network, no other browser.
- No measurement on an idle machine.

## Gap 2: image identity

**Cause, confirmed.** Two guest trees prepared from the same lockfile, one with the
committed toolkit and one with a rebuilt one, differed only inside
`.bun/@kkrausse+browser-agent-toolkit@workspace` (its `dist`, including a 4.4 MB copy of
the runtime): the example links the toolkit as a workspace member. A second cause turned
up while checking stability: Bun's isolated linker sometimes leaves out a dependency's
`.bin` link (one of four installs), which also changes the hash.

**Fix.** Store entries that are not from the lockfile move to `node_modules/.linked` and
are packed as a second image mounted there (`manifest.layers`, 0.88 MB, 116 KB
compressed, once the runtime copy is pruned). Prepare completes the `.bin` links itself.

**Proof** (`bench/first-open/identity.ts`, Chrome, through the byte-counting proxy; two
consecutive toolkit source changes, each followed by toolkit build, prepare, server
restart and a reopen on the same origin):

| | dependency image | layer | image bytes downloaded on that open |
| --- | --- | --- | --- |
| first open | `image-5ac8e77d1366c361` | `image-9dd1abc2d0f9d3ff` | 32,232,366 + 115,927 |
| after rebuild 1 | `image-5ac8e77d1366c361` | `image-f31ec47f14e4e139` | 115,981 (plus the 1.2 MB start-up program, which contains the toolkit's Vite plugin) |
| after rebuild 2 | `image-5ac8e77d1366c361` | `image-c6ab5414ea524527` | 115,995 (same) |

The dependency image also had the same hash in three forced rebuilds in a row and in two
different checkouts. Each reopen rendered the app in the preview, i.e. the guest's Vite
loaded the toolkit plugin from the layer.

**Collection of old images.** After each reopen the origin's OPFS held only the two
current images; the previous layer was gone. With the editor left open in one tab and
rebuild 2 deployed, a second tab was refused ("already open in another tab"), the first
tab's preview still answered (200) and its images were still there; after closing the
first tab the second opened and the old layer was removed. The first version of the
check found the old layer left behind when the collector ran while the closed editor's
workers still held it; it now retries once after 5 s.

Not verified: an app with a `file:` dependency in standalone mode (the same code path
moves `…@file+…` entries, exercised only by the workspace case).

## Gap 3: a shell for `child_process`

`crates/bat-sh` (about 8,000 lines of Rust, one dependency: `regex-lite`) is a
POSIX-style shell with the coreutils built in, compiled to its own Wasm module
(`bat_sh.wasm`, 521 KiB, 214 KiB gzip, 24 host imports mapped onto the calling process's
kernel binding by `runtime/src/process/sh.ts`). The kernel is unchanged; WASI executables
were not needed.

- **Synchronous calls** (`execSync`, `spawnSync`/`execFileSync` of a shell, script or
  coreutil, `{ shell: true }`) run the shell inside the calling worker: no spawn.
- **Asynchronous calls** (`exec`, `spawn('sh', …)`) start a kernel process whose
  executable is `/bin/sh`, in the warm spare worker.
- Only `node`, JS files, node-shebang scripts and `.bin` entries become kernel children; a
  child that is a pipeline stage gets a kernel pipe and runs alongside the next stage.
- Language: quoting, `$VAR`/`${VAR}`, `$(…)`, `$?`, globs, pipes, `&&`/`||`/`;`,
  redirections with `2>&1`, here-docs and here-strings, `if`/`for`/`while`/`until`/`case`,
  functions, `[[ ]]`, `(( ))`, `set -e/-u/-x/-o pipefail`, `trap … EXIT`.
- Commands: `echo cat ls pwd mkdir rm cp mv touch head tail wc grep find sed sort uniq
  which env true false sleep date basename dirname xargs node`, plus `printf tr cut tee seq
  ln chmod mktemp du stat read getopts`; `npm run`, `yarn`/`pnpm`/`bun run <script>`,
  `npx`/`bunx` for what is in `node_modules/.bin`. `grep` and `sed` run in-process.

### Numbers (harness, Chrome 154, load 29–30)

| | n | min | median | p90 | max |
| --- | --- | --- | --- | --- | --- |
| `execSync('echo hi')`, first call in a process | 1 | | 9.4 ms | | |
| `execSync('echo hi')`, second call | 1 | | 0.82 ms | | |
| `execSync('echo hi')`, steady | 200 | 0.03 | **0.04 ms** | 0.09 | 4.4 |
| `execSync('ls src \| wc -l')` | 100 | 0.08 | **0.115 ms** | 1.26 | 13.0 |
| `execSync('cat package.json \| grep name && echo ok > /tmp/x; cat /tmp/x')` | 50 | 0.14 | 0.165 ms | 0.93 | 4.6 |
| `execSync('grep -rn "export" src \| sort \| head -5')` | 50 | 1.08 | 1.47 ms | 7.9 | 22.9 |
| async `exec('echo hi')`, warm spare | 20 | 2.5 | **3.5 ms** | 4.7 | 5.1 |
| async `exec('echo hi')`, back to back (cold worker) | 20 | 49 | 79 ms | 121 | 124 |
| `execSync('node -e "console.log(1)" \| wc -l')`, warm spare | 12 | 15.3 | **23 ms** | 50 | 81 |
| same, back to back | 12 | 65 | 126 ms | 176 | 179 |
| reference: `spawnSync(node, ['-e', 'console.log(1)'])`, warm spare | 12 | 5.3 | 14 ms | 30 | 31 |

Before, every row except the reference was `ENOENT`.

### Verified in Chrome (runtime harness)

- `runtime/harness/guests/shell.cjs` is part of `runtime/harness/check.sh` (12 of 12).
  It covers the five scripts of the brief: `execSync('ls src | wc -l')`; the `exec` line
  with `&&`, `;` and a redirect; `spawn('sh', ['-c', 'for f in src/*.tsx; …'])`;
  `NODE_ENV=production node -e …`; a failing command (sync: status 1 with
  `cat: /nope/missing.txt: No such file or directory` on stderr; async: code 7 with stdout
  and stderr apart; unknown program: 127).
- Other shapes: `spawnSync` of a coreutil, `execFileSync('/bin/bash', …)`,
  `{ shell: true }`, `input`, a node child in a pipeline, `env`/`cwd`, `stdio: 'inherit'`,
  `npm run` passing and failing, `npx`, a `#!/usr/bin/env bash` script, `timeout`
  (ETIMEDOUT, child killed), `child.kill()`, `process.kill(-pid)` on a detached shell,
  stdin streamed into `while read`.
- Differential against bash: 128 command lines (`crates/bat-sh/tests/cases.txt`); native
  build 128 of 128 equal to host bash, in Chrome 127 of 127 equal to bash's recorded
  output (one skipped: `ls -l` modes follow the host umask).
- By hand: `npx tsc --noEmit` (2.8 s, exit code passed through), `rg` in a pipeline
  (141 ms), a here-doc with `$(…)`.

### Unverified or left

- In the real editor the module is fetched (`bat_sh.wasm` appears in the first-open wire
  counts) and the README scenario still passes, but no agent script calling `execSync`
  was run there.
- No concurrency between builtin stages (`yes | head` cannot work); a script is parsed
  whole before it runs; signals are noticed only at host calls; an `execSync` timeout
  returns no partial output.
- Missing: arrays, `select`, process substitution, job control, traps other than `EXIT`,
  `awk`, `diff`, `git`, `curl`, `tar`, `jq`; `npm install` and friends say so.
- Back-to-back async shells and node children pay 49–124 ms each for a cold worker.
- The agent's `PATH` is `/app/node_modules/.bin:/bin`: a bare `tsc` from the agent is
  not found (`npx tsc` and `npm run` are).

### Re-enabling OpenCode's shell tool (not done)

In the 2.0.3 bundle the tool resolves `$SHELL`, else `bash` on `PATH`, else `/bin/sh`,
and runs `spawn(shell, ['-c', command], { stdin: 'ignore', detached: true })` with output
piped to a file, no PTY, a 2-minute default timeout, and stops a command with
`process.kill(-pid, signal)`, repeated after 3 s. All of that exists now. It would take:
allowing the `shell` action in `agentConfig` (`packages/toolkit/src/opencode.ts`),
`SHELL=/bin/bash` and `/workspace/node_modules/.bin` on the agent's `PATH`, and one real
model turn to check the permission flow (it parses the command with tree-sitter-bash),
output streaming, timeout and abort, and back-to-back commands. Whether OpenCode's
`which` accepts the stub `/bin/bash` file was not checked.
