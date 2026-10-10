# Rust rewrite: consolidated summary (2026-10-10)

Branch `rewrite/rust`. This is the closing pass: one build of the final state from a fresh
clone, checked and measured as one thing, plus everything the earlier reports left open,
in one list. Design: `docs/design/rust-rewrite.md`; decisions: `docs/design/decisions.md`.

Everything in "Measured here" was taken on a build made by cloning the branch into an empty
directory and running the documented command, on diesel2 (12 cores), Chrome 154 headed on
Xvfb, driven by `browser-control`. **The machine was never idle**: another session was
compiling and benchmarking throughout, 1-minute load average 3.8–9.4. The load is given
with every number. Medians, with (min–max).

## 1. Does a clean clone work with one command?

Yes. `git clone` of the branch at `3545bef` into an empty directory, the model key copied
to `examples/todo-app/.env.local`, then:

```sh
PORT=4140 bun run editor
```

built everything, fetched the pinned OpenCode server from its release asset (no sibling
checkout was available there), prepared the example and served it. The README scenario
passed on that build at the first attempt (first-ever open of that origin included: image
downloaded, chat ready 2.74 s after the click).

| | |
| --- | --- |
| Cold setup to "Server running" | **113 s** wall, one run, load 7–8. Cargo's registry and Bun's package cache were warm (crates and npm packages were not downloaded; they were compiled and linked). With empty caches it will be longer; not measured. |
| of which | `bat-prepare` (release, oxc + zstd) 43.8 s; `bat_modules.wasm` 31.6 s; `bat_node_native.wasm` 6.8 s; `bat_sh.wasm` 6.9 s; `kernel.wasm` 2.5 s; toolkit 4.2 s; the remaining ≈ 17 s are the OpenCode download, prepare (its optimizer run 3.5 s), the example build (3.1 s) and server start, not timed separately |
| Setup again with nothing changed | about 5 s (the toolkit build is 4.2 s of it) |
| Disk after setup | `target/` 1.0 GB, `node_modules` 415 MB, `examples/todo-app/.editor` 526 MB (prepared output 307 MB, prepare's working tree 219 MB), `.runtime/` 29 MB |

What the setup needs and does not install:

- **bun** (1.4.0 used), **node 24** on `PATH` (prepare runs the app's Vite once on the build
  host), **cargo/rustc** (1.99.0 used; there is no `rust-toolchain` file) with the targets
  `wasm32-wasip1-threads` and `wasm32-unknown-unknown`, `tar`, network access.
- Optional: **bubblewrap** (`/usr/bin/bwrap`, Linux). With it the optimizer cache is
  produced at the guest's own paths; without it prepare falls back to host paths with
  recomputed hashes, a mode that was only ever run on Linux with `BAT_NO_BWRAP=1`.
  **wasm-opt**: used when on `PATH`; it is not installed on diesel2, so every Wasm file the
  setup builds here is unoptimised by Binaryen.
- Not needed: wasi-sdk, clang, the `zstd` command (prepare links the zstd crate), wasm-pack,
  the `wasm32-wasip1` target (only for rebuilding the committed oxide scanner).
- Three Wasm files are committed and not built by the setup: `runtime/src/sqlite/sqlite3.wasm`,
  `packages/guest-shims/esbuild/lib/bat_esbuild.wasm`,
  `packages/guest-shims/tailwindcss-oxide/tailwindcss-oxide.wasm`. Rebuilt here from the
  clean clone: sqlite (with `build.sh --fetch`) and the oxide scanner come out **byte for
  byte identical**; `bat_esbuild.wasm` comes out the same size (1,230,457 bytes) but with
  different bytes, because it embeds the absolute source path of the checkout it was built in.

`bun run typecheck` at the root passes (runtime, toolkit, example). No secret is in the
tree or in the branch's history (searched for the key's value; 0 files, 0 commits).

One commit of the branch does not build: `4679a38` (fixed by its successor `944f4d7`).

## 2. Budget table

Reopen: dependency image and workspace already in the browser. "Fresh": origin storage
emptied (OPFS, service worker, Cache Storage, localStorage), image served from the HTTP
cache. `preloadEditor()` runs when the button is rendered, as in the example.

| Stage | Old runtime ¹ | Budget | Native Node 24, same tree ² | **New, reopen** (n = 12, load 4.6–4.9) | Budget met |
| --- | --- | --- | --- | --- | --- |
| Runtime boot + mount (`bootRuntime`) | ~2,000 | < 100 | – | **90** (81–122) | at the median; 4 of 12 samples over |
| Vite spawn → listening | 1,600 | < 500 | 406 (377–433) · 492 (390–715) | **426** (379–554) | yes; 1 of 12 over |
| Vite spawn → app visible in the frame | 3,900 | < 1,200 | 880 (863–952) · 1,073 (846–1,475) ³ | **1,004** (865–1,268) | yes; 1 of 12 over |
| OpenCode spawn → attached | 3,200 | < 1,000 | 1,336 (1,286–1,394) · 1,384 (1,266–2,060) | **1,032** (880–1,393) | **no**: 8 of 12 over |
| Whole "Open editor", click → app visible and chat ready | 7,200 | < 1,500 | – | **1,171** (998–1,545) | yes; 1 of 12 over |

¹ From the design document, which took them from the 2026-10-03 startup reports of the old
runtime. Not re-measured.
² Two runs, n = 7 each: the startup report's at load 4.0–4.6, and one taken here against
the clean clone's prepared tree at load 6.4–7.3 (`bench/startup/out/native-final-clean.json`).
Node runs the same two programs from the same prepared tree under bubblewrap.
³ Native "app visible" is the last of the page's 31 requests answered, with no browser
rendering anything; the browser figure includes rendering and hydration.

The startup report (`2026-10-09-startup.md`) has the same table from the performance
agent's private tree at load 3.8: 62 / 360 / 1,003 / 950 / 1,102, with every budget met at
the median. To see whether the clean build is slower than that tree or only measured at a
higher load, both were served side by side and sampled alternately (n = 10 each, load
5.1–6.1, `bench/startup/out/ab-perftree-vs-clean.json`):

| | performance agent's tree | clean clone |
| --- | --- | --- |
| boot + mount | 88 (79–215) | 64 (56–77) |
| Vite spawn → listening | 401 (347–581) | 385 (351–742) |
| Vite spawn → app visible | 1,180 (1,076–1,987) | 1,176 (1,018–1,945) |
| OpenCode spawn → attached | 1,129 (1,014–1,818) | 1,199 (1,058–2,032) |
| whole open | 1,297 (1,208–2,230) | 1,327 (1,194–2,251) |

No difference beyond the spread. So: **the whole open is 1.1–1.3 s at load 4–6; three of
the five budgets hold with margin, boot + mount holds at the median, and "OpenCode
attached" is at or over its 1.0 s budget whenever the machine is not quiet.** No run on an
idle machine exists.

Other opens, same build:

| | n | load | whole open | notes |
| --- | --- | --- | --- | --- |
| Fresh, image in the HTTP cache | 5 | 4.8–6.7 | **1,554** (1,494–1,634) | boot + mount 143 (125–154), Vite listening +281, app visible +944, OpenCode attached +1,308 |
| **First-ever open**, never-seen origin, localhost | 4 | 3.8–4.4 | **2,507** (2,200–2,534) | boot 158; app visible 1,459; image fully downloaded and verified at 4,380 (4,264–4,579), in the background |
| Second open of those origins (page reloaded) | 4 | 3.8–4.6 | 2,096 (2,060–2,125) | slower than a steady reopen: Chrome has no code cache for the program scripts until the third load |
| First open of a reset workspace, as in the recording | 1 | 4.4 | 1,717 to chat ready | source installed, optimizer cache written, OpenCode creates its database |

Not re-measured on the final build: a first-ever open through the 50 Mbit/s proxy. The
first-open report has it at 5,456 (4,625–9,190), n = 4, load 11–15, against 5,314 on
localhost at load 17–23 in the same session; only bandwidth was modelled, never latency.

Result files: `bench/startup/out/final-clean.json`, `bench/first-open/out/final-clean-local.json`.

## 3. Per-call kernel numbers

Re-measured here with the kernel built from the clean clone (342,932 bytes):
`bench/run.ts --runs 6 --fresh`, two workers at once, the image of the old TODO tree
(10,415 files, 197.0 MB), load 8.3–9.4, n = 6 page loads (`bench/kernel-final.json`).
"M0" is the first report's value for the same row (n = 5, load ≈ 20, an older kernel);
"old" is the previous runtime where a comparable number exists.

| | Now | M0 | Old runtime |
| --- | --- | --- | --- |
| Mount the image (open handle + read index) | 4.6 ms (3.8–9.5) | 6.4 ms | 1.5–2 s to lay the tree down, every open |
| Page load → kernel booted, image mounted | 56 ms (48–63) | 59 ms | ~2.0 s |
| 40,000 mixed calls (1 read : 1 stat hit : 2 stat misses), warm | 1.66 µs/call (1.58–1.89), 35 ms wall | 2.8 µs | 24–60 µs per call |
| same, cold (304 OPFS chunk reads) | 2.72 µs/call (2.27–2.81) | 3.4 µs | |
| same, pooled read buffer | 1.05 µs/call (0.88–1.25) | 1.6 µs | |
| `stat`, existing file (full object) | 0.60 µs (0.51–0.72) | 1.19 µs | 24 µs |
| `stat`, missing path | 0.51 µs (0.46–0.67) | 0.92 µs | 60 µs |
| Read a 3.3 KB file into a new array | 4.8 µs (4.4–5.0) | 7.3 µs | |
| … into a caller's buffer | 1.29 µs (1.17–1.38) | 2.3 µs | |
| `realpath` | 1.30 µs (1.14–1.51) | 1.9 µs | |
| Overlay `writeFile`, 2 KB | 6.8 µs (5.5–7.9) | 9.1 µs | |
| Read the 27.7 MB file, first time / again | 46 ms (45–50) / 20 ms (19–21) | 57 / 26.5 ms | 0.5 s |
| Spawn request → first byte of the child's output (warm spare, trivial runner) | 3.3 ms (2.8–3.5) | 5.5 ms | 140–240 ms |
| Kernel compile / attach to a page | 3.9 ms / 0.6 ms | 5.7 / 0.7 ms | |
| Shared memory after the bench | 92 MB | 92 MB | |

From the other reports, not re-measured (each at the load its report states, all busy):

| | Value | Source |
| --- | --- | --- |
| `node` process, warm spare: spawn → first statement | 2.3 ms (1.9–8.0), n = 15, load 11 | node-runtime |
| … cold worker | 54 ms (45–66), n = 10 | node-runtime |
| One kernel module resolution | 12 µs; 8.8 ms for the 1,138 resolutions of a Vite config load | node-runtime |
| Page → guest HTTP request (`endpoint.fetch`), 2-byte body | 0.165 ms (0.105–p90 0.225) at load 13; 0.82 ms at load 17 | net |
| … through the service worker (preview frame) | 1.36 ms (1.07–p90 1.83) at load 13 | net |
| WebSocket round trip through the frame's replacement | 0.095 ms at load 13, n = 480 | net |
| SQLite: 1,000 inserts in one transaction / autocommit | 2.9–6.3 ms / 17.5–24 ms (ranges of medians over 4 page loads, load 20–31) | sqlite |
| SQLite: 6 MB row insert / read | 35–45 ms (154 ms in one of four loads, unexplained) / 7.7–9.7 ms; old runtime 272 / 133 ms | sqlite |
| SQLite against native `node:sqlite`, warm | 0.7–2.6× per operation; first statements of a process 59 ms cold, 4.9 ms prewarmed | sqlite |
| `execSync('echo hi')` steady / `execSync('ls src \| wc -l')` | 0.04 ms / 0.115 ms (n = 200 / 100, load 29–30) | first-open-and-shell |
| async `exec('echo hi')`, warm spare / back to back | 3.5 ms / 79 ms | first-open-and-shell |
| `rg` search of `src` as a child process | 31–145 ms | e2e |
| esbuild-shaped transform: first / warm call (Chrome worker) | 19 ms / 0.5 ms; `esbuild-wasm` 846 / 14.5 ms | tools |
| Prepare, forced rebuild of the example | 7.5–10.2 s at load 62–71 (n = 5); 6.0–7.1 s under lighter load; unchanged inputs 0.01–0.07 s | prepare |
| Dependency image | 238.9 MB, 32.2 MB as the zstd copy browsers download; 41 MB on the wire for a first open | first-open-and-shell |

## 4. What was verified end to end, and how many times

On builds from the clean clone (first `3545bef`, then `228dc34` with the fix of §5; later
commits change no runtime or toolkit code except the service-worker shim of §5):

| Check | Result | Times |
| --- | --- | --- |
| README scenario (`demo/run.ts`: two todos, Open editor, the dark-theme prompt, assistant finishes, preview dark with "1 … left" in the same document, "Ship it" and a tick inside the preview) | pass; 6 `read`, 3 `edit`, 1 more `read`, 1 `runJavascript` each time | **2 of 2** (one on each build; the second is the recording) |
| Model picker | 28 options, exactly the 28 names of `model-catalog.json`, default "Muse Spark 1.3 · opencode (server default)" | 1 |
| Exit, then Open again in the same page | preview still dark, counter there, chat shows the session (1 user message, 9 assistant messages) | 1 |
| Page reload, then Open | same | 1 |
| Second tab | "This workspace is already open in another tab or window. Close the editor there, then retry." after 2.4 s; first tab unaffected, its preview answers 200 | 1 |
| Edit of `vite.config.ts` in the guest | Vite restarts, serving again after 0.35 s. **The frame did not follow** (bug, §5); after the fix the frame reloads and shows the app 1.46 s after the edit, and a CSS edit afterwards is applied in 54 ms without a reload | failed 1, then passed 1 |
| Agent-style `execSync` in the real editor: one chat turn telling the agent to run `execSync('ls src \| wc -l')` and `execSync('cat package.json \| grep name && echo ok')` through `runJavascript` | `COUNT=11 NAME=ok`; `/workspace/src` has 11 entries | 1 |
| `runtime/harness/check.sh` against the clean build | 12 of 12 as expected (`cjs.cjs` exits 7 on purpose) | 1 |
| `bench/startup` opens (no chat) | 37 of 37 recorded samples `ok` (17 + 20), plus 6 unrecorded priming opens | |
| `bench/first-open` | 8 of 8 `ok` (4 first-ever, 4 second opens) | |

Earlier, on other builds: the scenario passed 4 of 4 for the end-to-end agent after its
fixes and once for the first-open agent. **In total the scenario has passed 7 times on
this branch and has not failed since the end-to-end fixes; that is a small sample**, and
the model's edits differ from run to run.

Model use in this pass: two full scenario conversations and one single-tool turn.

## 5. What this pass fixed

1. **After a `vite.config.ts` edit the preview stayed on its old document and got no more
   hot updates** (`28c928a`). Vite's client waits for a restarted server from a blob
   `SharedWorker`, where the frame's `WebSocket` replacement does not exist; the ping went
   to the real server and never succeeded. The earlier check had only looked at the dev
   server answering again. The preview frame now has no `SharedWorker`, so the client
   pings from the page.
2. **The runtime harness could not start in a fresh clone** (`228dc34`): its server looked
   only in two agents' build directories. It serves the setup's outputs now.
3. `third_party/NOTICES.md` covered three of about a dozen embedded things (`c73018f`).
4. `runtime/src/sqlite/native/build.sh --fetch` (`c73018f`, `776a542`): downloads the three
   pinned inputs by URL and sha256 and builds; it reproduced the committed binary exactly.
   The toolchain had been left only in `/tmp`.
5. `bun run typecheck` did not include the runtime (it passes); two scratch result files
   were tracked although ignored (`776a542`).
6. New recording, READMEs, this summary.

## 6. Known gaps and unverified items, ranked

Deduplicated from all nine reports and this pass. "Source" names the report with the detail.

**A. Would be noticed by someone trying it**

1. **Chrome only.** Nothing was ever run in Firefox or Safari. The page must be
   cross-origin isolated (COOP `same-origin`, COEP `require-corp`) and needs OPFS sync
   access handles and shared Wasm memory.
2. **"OpenCode attached" misses its 1.0 s budget unless the machine is quiet** (1,032 ms
   median at load 4.8; 1,199 at load 5.6), and there is no measurement on an idle machine
   at all. Of its time, health → plugins active (357 ms, 144 ms more than native) was never
   profiled inside the guest, and 56 ms between listening and the first health answer is
   unexplained. (startup)
3. **The second and third open after a deploy are slower** (2.1–2.6 s measured here on
   second opens): Chrome gives a program script its code cache on the third load. (startup,
   node-runtime)
4. **The agent has no shell tool.** OpenCode's own shell tool is not enabled; a real shell
   exists for `child_process` (`crates/bat-sh`), and what enabling the tool would take is
   written down but not done or tried. (first-open-and-shell)
5. **No package install in the guest.** `npm install` and friends answer that they cannot.
   An agent that imports a package already in the dependency image but outside the shipped
   optimizer cache triggers a re-optimization through `esbuild-wasm`: seen working once
   (340 ms), and once the preview took 7 s to come back at load 12. (e2e)
6. **A runtime update reaches the preview frame one open late.** The service worker is
   replaced in the background; the open that discovers the new one still gets documents
   from the old one. Seen here when the fix of §5.1 was deployed. Not addressed.
7. **Durability.** A transaction SQLite has reported committed can be lost if the tab dies
   in the next ~250 ms (the journal is drained on a timer); two guest processes writing
   one database are not locked against each other; tab closed mid-transaction was tested
   once. (sqlite)
8. **First open on a real network is not characterised.** An interrupted image download
   starts again from zero; the path where the network drops while the image is still
   arriving (reads fail with `EIO`) and a corrupted block were written, never exercised;
   the UI does not say the image is still arriving; latency was never modelled; runtime
   files are served `no-cache`, one revalidation round trip per worker script per open.
   (first-open-and-shell, startup)
9. **`worker_threads.Worker` is missing**, so anything that needs it fails (esbuild's
   synchronous API falling back, for one). (node-runtime)
10. **The preview frame has no `SharedWorker`** (since §5.1): an app that uses one will not
    work in the preview.

**B. Robustness risks that have not bitten in the scenario**

11. **An unexplained kernel trap and a page hang**, each seen once by the net agent
    (`fd::pipe`, "operation does not support unaligned accesses"; page spinning on a lock),
    not reproduced in five repeats or a 2,400-write stress, never explained. (net)
12. **Reliability is seven scenario passes.** Never tried: permission or question cards,
    the Stop button, session export/import, two editors on one origin, a reload during a
    turn on the final build (passed once for the end-to-end agent).
13. **Memory was never measured**: a process worker, the two boot-time spares each holding
    a program script, and the image cache, which has no eviction (reading the whole tree
    holds the image size, 239 MB, in shared memory). (kernel-m0, startup)
13a. **Chrome charges the origin several times what its files hold.** After two opens the
    origin's OPFS held 255 MB in 7 files (two images, a 14.9 MB snapshot, the journal) and
    stayed there over four opens, and clearing the origin freed 243 MB on disk; but
    `navigator.storage.estimate()` and DevTools' quota figure said 688 MB after the first
    open and 1,150 MB from the second on, all of it "file system". The origin used for
    every measurement here (about 60 opens, 5 of them after wiping OPFS) was charged
    6,550 MB. Measured at the end of this pass, cause not found (candidates: the image is
    written at offsets while it arrives; each worker holds its own access handle to it).
    It is quota accounting, not disk, but quota is what eviction and `QuotaExceededError`
    go by. Also seen: both image files still carried the `.partial` name (with their
    `.ok` marker) after four opens, where the first-open report says the second open
    renames them; they are read correctly either way.
14. Networking limits: guest cookies are invisible to `document.cookie` in the frame and
    the jar is lost when the service worker restarts; `http.request` buffers a whole
    request body; no `Accept-Encoding` on the kernel path; `https.createServer` throws;
    at most 48 concurrent `endpoint.fetch` per port; after an idle restart the service
    worker can hold requests up to 4 s; a second tab waits 2.4–2.8 s for its message. (net)
15. Node surface not implemented or not verified: `vm` contexts beyond `with`-scoping,
    `fs.watchFile`, `fs.promises.watch`, `fs.cp` filters, BigInt stats, `readline` on a
    terminal, large stdin back-pressure; `AsyncLocalStorage` does not cover `for await` /
    `await using`; `util.inspect` is close to Node's, not identical; `fork` IPC is JSON
    over a loopback socket; crypto and zlib beyond what the two programs touch were checked
    natively only. (node-runtime)
16. SQLite: no FTS, R-Tree, sessions or extensions; `busy_timeout` never waits; WAL
    doubles what goes to OPFS. (sqlite)
17. Shell: pipeline stages that are builtins run one after another (`yes | head` cannot
    work), no arrays, job control, process substitution, `awk`, `diff`, `git`, `curl`,
    `tar`, `jq`; a bare `tsc` is not on the agent's `PATH` (`npx tsc` is). (first-open-and-shell)
18. esbuild shim: never downlevels or minifies; `context()`, `buildSync`, CSS loaders,
    decorators fall back to `esbuild-wasm` in a child process (893 ms first call); 15 of
    369 corpus transforms differ in shape from esbuild's. The oxide and lightningcss shims
    were compared with their native versions under Node, not in the browser runtime. (tools)
19. The models.dev reduction depends on internals of the pinned OpenCode server; other
    providers' catalog entries are dropped. (startup)

**C. Build, packaging and repository**

20. **IRS tools are not migrated to this API**, and nothing is published: the old packages
    (`workspace-api`, `opencode-chat`) do not exist on this branch.
21. **`.github/workflows/*`, `docs/RELEASING.md`, `docs/releases/` and
    `docs/runtime-architecture.*` still describe the previous runtime.** CI would fail on
    this branch as written. Not touched beyond a note in the two documents.
22. `startup-modules.json` and `editor-startup-order.txt` in the example are recordings;
    after a dependency upgrade they go stale (costing speed, not correctness) until
    recorded again. Nothing detects that. (startup, first-open-and-shell)
23. Any dependency, lockfile or policy change rebuilds and re-downloads the whole 239 MB
    dependency image (32 MB compressed); only non-lockfile packages are in a separate
    small layer. (prepare, first-open-and-shell)
24. Prepare without bubblewrap (macOS, containers) is unverified: the optimizer cache is
    made at host paths with recomputed hashes and no page crawl. (tools)
25. The committed `bat_esbuild.wasm` is not byte-reproducible from another checkout path
    and contains the build host's source path; setup-built Wasm is unoptimised where
    `wasm-opt` is absent; there is no pinned Rust toolchain; cold setup with empty Cargo
    and Bun caches was not timed; one intermediate commit (`4679a38`) does not build.
26. Prepare keeps 44 MB of `.map`, `.md` and `.d.ts` files that are probably unused
    (`.d.ts` and `@types` are needed for the agent's `tsc`); source maps for lowered
    TypeScript are not stored; optimized dependencies are served without source maps.
    (prepare, e2e)
27. Unexplained small things: the guest's Vite logged "vite.config.ts changed, restarting
    server" twice for one write (seen here); `--verify` reads 3 entries fewer than the
    image has; one `bat-prepare deps` run failed with Bun's `EEXIST` and passed on repeat
    (a retry was added). (prepare, tools)
28. Per-change performance gains were mostly not isolated by their own A/B; fresh-open
    numbers mix two agents' work. (startup)

## 7. Where the design changed

The design document is as written on 2026-10-09; `decisions.md` records what changed.
The ones a reader of the design would trip over: the loader format is a generator function
per module, not a seven-parameter function; program scripts are loaded with `import()`,
because `importScripts` was measured to get no code cache; preview traffic goes through a
separate `netd` worker, not `kerneld`; `EventSource` is not replaced in the frame and HTTP
heads are serialised in JavaScript; ripgrep and the oxide scanner are not built against the
kernel (npm package as a `node` process; own WASI over `fs`); there is no WASI executable
format; the optimizer cache is a derived bundle beside the manifest, not in the image; the
image is verified per MiB and used while it arrives, with a second small layer for
non-lockfile packages; both programs start at once, each in its own boot-time spare.

## 8. Detail documents

| | |
| --- | --- |
| `docs/design/rust-rewrite.md` | design and budgets |
| `docs/design/decisions.md` | every decision that changed, with the measurement |
| `docs/design/image-format.md`, `kernel-abi.md`, `module-format.md` | formats and the kernel ABI |
| `docs/experiments/2026-10-09-kernel-m0.md` | kernel: shared memory, mount, per-call costs |
| `docs/experiments/2026-10-09-prepare.md` | image writer, pruning, prepare times |
| `docs/experiments/2026-10-09-node-runtime.md` | process worker, loader, builtins, code cache |
| `docs/experiments/2026-10-09-net.md` | sockets, HTTP, service worker, WebSocket |
| `docs/experiments/2026-10-09-sqlite.md` | `node:sqlite` on the kernel, durability |
| `docs/experiments/2026-10-09-tools.md` | esbuild, oxide, lightningcss shims, optimizer cache |
| `docs/experiments/2026-10-09-e2e.md` | the scenario on the real runtime, bugs found |
| `docs/experiments/2026-10-09-startup.md` | startup budgets, changes by gain, native baseline |
| `docs/experiments/2026-10-10-first-open-and-shell.md` | first-ever open, image identity, the shell |
| `bench/startup/out/`, `bench/first-open/out/`, `bench/kernel-final.json` | raw samples |

Older files in `docs/experiments/` (2026-09-29 to 2026-10-03) describe the previous runtime.

## 9. Not verified in this pass

The cause of the quota figure in 13a, and whether it grows without bound.

Firefox and Safari; an idle machine; a real or throttled network on the final build; a
reload during a turn; an agent-added dependency; the image-identity check after a toolkit
rebuild; prepare without bubblewrap; a setup with empty Cargo and Bun caches; that every
commit builds (one is known not to); session export/import, Stop, permission cards.
