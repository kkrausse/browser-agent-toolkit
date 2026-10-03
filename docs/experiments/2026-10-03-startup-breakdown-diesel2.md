# Where the editor's startup goes on diesel2: Vite preview and guest OpenCode (2026-10-03)

Measurement only; nothing is optimized and the default path is unchanged. Live numbers
from Chrome 154.0.8037.97 on diesel2 (AMD Ryzen 5 5500, 6 cores / 12 threads, 60 GB,
Ubuntu, headed on Xvfb), TODO example served from the worktree
`/home/kkrausse/devfs/repos/kkrausse/bat-startup-measure` (branch `perf/startup-breakdown`,
from `worktree-editor-tailnet-host` at `5d7490a`) with `PORT=3100 bun run editor:debug`,
pinned runtime `f9893bd`, OpenCode server 2.0.3, Vite 7.3.6, origin
`http://localhost:3100`. The demo on port 3000 was not touched.

Every sample: page reloaded first (so a new kernel worker), tab visible and focused
(`hiddenMs` 0), and, unless marked C, the service worker unregistered before the reload
(`navigator.serviceWorker.controller` null at the click and when the kernel worker was
created, recorded per sample). Load average was 1.8 to 3.5 throughout (other sessions
were working on the machine), 3 to 5 during the controlled set.

## Result in short

1. **A cold open is 17.2 s fresh and 14.5 s reopen** (17092–17579 and 14377–14585, n = 5
   each, untraced), plus 0.32 s between the click and the operation's start. Spread is
   under 3%.
2. **The Vite preview is the largest part: 8.9 s fresh, 6.5 s reopen**, then delivery
   (3.5 / 3.1 s), then OpenCode (4.5 / 3.1 s), then on a reopen the OPFS restore (1.6 s).
   Preview and OpenCode start one after the other, by design.
3. **Vite's time is mostly the guest runtime resolving module names, not reading or
   compiling them.** One preview start makes 2,429 resolutions that take 3.5 to 3.7 s in
   total (instrumented runtime), against 0.09 s reading, 0.37 s transpiling, 0.14 s
   compiling and 0.32 s running 697 modules (7.8 MB). 361 bare-specifier resolutions cost
   2.5 to 2.6 s (7 ms each); `realpath` 0.8 to 0.9 s; 1,735 of the resolutions are for a
   module that is already loaded. Behind it are about 40,000 synchronous filesystem calls,
   34,000 of them `statSync` and 26,000 of those for paths that do not exist.
   Loading `vite.config.ts` and its plugins is 2.2 s of the 3.5 s to listen, and 79% of
   it is resolution; the first `GET /` (the server-rendered shell) is 2.2 to 2.3 s, half
   of it resolution.
4. **The dependency optimizer cache persists across a reopen but is rebuilt twice on a
   fresh open** (0.9 s before the first request can be answered, then 1.2 s again when
   four dependencies the scan missed turn up, with a reload of the frame). That is the
   2.4 s difference between a fresh and a reopened preview.
5. **Delivery is 2.6 s of install on every open, fresh or reopen: 1.6 s verifying
   10,534 files one by one, 1.0 s writing them.**
6. **A reopen restores 50 MB from OPFS in 1.56 s, and 38 MB of that is the OpenCode
   bundle and the Tailwind archive, which delivery writes again 0.3 s later.**
7. **OpenCode on diesel2 is about 2.1 times the Mac numbers in every part**: reopen
   spawn → attached 3.09 s against 1.48 s; bundle read 0.53 against 0.25 s, compile 0.36
   against 0.15 s, evaluation 0.71 against 0.33 s, SQLite 0.70 against 0.35 s, model list
   0.56 against 0.29 s. The same factor everywhere reads as the machine, not a Linux
   problem. Nothing extra was found.
8. **A service-worker-controlled kernel is not slower here** (reopen 15.9 s controlled
   against 14.9 s uncontrolled, both traced, the controlled set under higher machine
   load). The Mac's 4 to 5 times did not reproduce.
9. **The fast sample quoted from the demo log (delivery 1.5 s, Vite 1.3 + 1.6 s, OpenCode
   0.95 s) is not what diesel2's own browser does.** The demo's log has two regimes: one
   equal to these measurements (Vite ready in 3.2 to 3.5 s, verify 1.6 s), one 2.5 to
   3 times faster in every stage (Vite ready in 1.05 to 1.15 s, verify 0.62 s). No sample
   here, in any mode, landed in the fast one, and within each regime a cold open and a
   switch cost the same. The log does not record the client; the likely reading is that
   the fast samples came from another device through the tailnet URL. The work runs in
   the visitor's browser, so its CPU sets the time.

Commits on `perf/startup-breakdown` (not pushed): `da9c2ab` (Vite tracing entry),
`8ce1b15` (filesystem counters and probe), and this document. The runtime fork was
instrumented locally for two campaigns and reverted; nothing was committed or pushed
there, and the final build's 40 assets hash the same as the first clean build's.

## Ranked: where a cold open spends its time

Untraced baseline `B`, median ms, n = 5 per column. Indented rows split the row above;
they come from the traced runs (`T`, n = 5) and the instrumented ones (`I`, n = 5) and
are scaled only by being taken from their own run, so they do not add exactly to the
untraced parent (traced Vite is about 4% slower, instrumented about 10%).

| | fresh | reopen | how measured |
|---|---|---|---|
| **Whole operation** | **17240** | **14501** | recorder |
| **Vite preview: spawn → application ready** | **8875** | **6462** | host stages |
| spawn → listening | 3546 | 3464 | host |
| · process worker boot until the entry runs | 243 | 238 | T |
| · Vite CLI and server chunk import | 350 | 354 | T |
| · `vite.config.ts` and its plugin packages | 2234 | 2215 | T; I: 79% resolution |
| · plugin setup until `listen` (React Router config through vite-node, first esbuild-wasm call 0.35 s, config bundle 0.12 to 0.17 s) | 824 | 799 | T |
| listening → connected (host's `GET /`) | 3023 | 2273 | host |
| · waiting for the optimizer's first run (blocks the event loop) | 929 | 58 | T |
| · first `GET /`: server render of the shell | 2215 | 2289 | T; I: about half resolution |
| frame attached → loaded | 2231 | 653 | host |
| · optimizer's second run, then the frame reloads | 1210 | 0 | T |
| loaded → application ready | 75 | 72 | host |
| **Delivery of 10,534 files** | **3501** | **3062** | host stages |
| acquire the 46 MB image (HTTP / Cache Storage) | 545 | 132 | host |
| gunzip to 52 MB | 260 | 260 | host |
| install: verify each file (inflate + SHA-256) | 1620 | 1600 | `delivery.install.ready` |
| install: write the tree into the VFS | 1040 | 1040 | `delivery.install.ready` |
| **OpenCode: spawn → attached** | **4484** | **3093** | host stages |
| process worker boot until the entry runs | 144 | 140 | T |
| bundle load | 2589 | 1653 | T |
| · read 27.5 MB | 504 | 527 | I |
| · ESM → CJS (fresh: transpile; reopen: apply the stored plan) | 728 | 51 | I |
| · compile (fresh includes the failed first attempt, 290) | 657 | 358 | I |
| · synchronous evaluation | 719 | 708 | I |
| import end → listening → ready line | 252 | 184 | T |
| health answered | 182 | 162 | host |
| activation | 1436 | 996 | host |
| · model list (fresh: 570 write + 270 read; reopen: two reads of 280) | 837 | 559 | T statement log |
| · other SQLite up to the activation answer | 150 | 142 | T |
| chat attach | 27 | 34 | host |
| **Open local workspace** | **240** | **1735** | host stages |
| kernel worker boot | 100 | 101 | host |
| restore from OPFS (50 MB, 98 files) | — | 1560 | host |
| **Prepared manifest (3.8 MB JSON): fetch, parse, validate** | 107 | 111 | host |
| **Install source and OpenCode config** | 101 | 29 | host |
| Outside every stage | 14 | 11 | recorder |
| Click → operation start (not in the recorder) | 320 | 325 | driver |

Fresh activation was 1425 to 1453 ms in all five untraced samples; in two of eight
traced fresh samples the model list write fell after activation (activation 330 to
345 ms) and showed up in the model request or later instead.

## What looks avoidable

Guesses of the saving are rough, are for a reopen unless said, and do not add up: the
parts overlap, and several would shrink each other.

| cost | measured | inherent or avoidable | guess |
|---|---|---|---|
| Module resolution in the guest runtime (Vite process) | 3.5 to 3.7 s per start, 3.3 to 3.4 s of it before the first response (instrumented) | Avoidable work: nothing is remembered. Each bare specifier walks every `node_modules` level with `stat` + `readFileSync` + `JSON.parse` of `package.json` and tries nine extensions; 71% of resolutions are of modules already loaded. A per-process cache of resolutions, of `package.json` reads and of `realpath` would remove most of it. | 2 to 2.5 s |
| Preview and OpenCode start serially | OpenCode's 3.1 s (4.5 fresh) waits behind the preview's 6.5 s (8.9) | Serial when it could be parallel. Deliberate today (`start-editor.ts`: cold Vite must not compete with chat for its listen budget). They are separate workers on a 12-thread machine but share one kernel thread for filesystem calls, so the overlap would not be free. | 2 to 2.5 s (3 to 4 fresh) |
| Delivery: per-file verification | 1.6 s every open | Done twice in effect: each of 10,534 files is inflated and SHA-256'd although the image itself has a digest in the manifest. Whether the image digest is checked at acquire was not read. | 1.3 to 1.5 s |
| Delivery: writing the tree | 1.0 s every open | Inherent while the dependency tree lives only in kernel memory and a new kernel starts empty. | none without a different design |
| OPFS restore of files delivery rewrites | 1.56 s restore, 75% of its bytes are `/app` (31 MB) and `.browser-editor-backends` (6.7 MB) | Done twice: restored, then overwritten by delivery. Not mirroring managed paths would also stop 38 MB being written back to OPFS after every delivery. | about 1 s, if restore time follows bytes (inferred) |
| Optimizer on a fresh open | 0.9 + 1.2 s, both blocking, plus a frame reload | Avoidable: the second run exists because the scan misses `@tanstack/react-query`, `@trpc/react-query`, `@trpc/tanstack-react-query`, `@trpc/client`; listing them (or shipping a prepared cache) removes it or both. Fresh only; a reopen already reuses `.browser-editor-cache/vite`. | 1.2 s fresh, up to 2.4 s with a prepared cache |
| Model list in OpenCode's database | 0.56 s reopen, 0.84 s fresh | Avoidable only with a change to the pinned server artifact, as the Mac report said. | 0.5 s |
| OpenCode bundle read / compile / evaluate | 0.53 / 0.36 / 0.71 s | Inherent to loading a 27.5 MB bundle in a new process on this CPU. A V8 code cache was not tried. | unknown |
| First esbuild-wasm call, React Router's config bundle | 0.35 + 0.12 s | Inherent to this toolchain in a new process. | none |
| `style.css` through Tailwind | 3 to 4 transforms, 0.8 to 1.1 s summed (0.45 s the first) | Partly repeated (server render, client, `?direct`). Sums overlap other work, so this is not all wall time. | small |
| Three simultaneous `GET /` at connect, two for the frame | 65 ms each when warm | Repeated; cause not found. | 0.1 s |
| Process worker boot | 0.24 s Vite, 0.14 s OpenCode | Not broken down. | unknown |
| The machine | 2.1× the Mac everywhere in OpenCode | Inherent to the visitor's CPU. | none |

## Method

- **Server**: `cd examples/todo-app && PORT=3100 bun run editor:debug` in tmux session
  `startup-measure`, restarted for each build. `.env.local` copied from the demo
  worktree (not printed, not committed).
- **Browser**: Browser Control CLI 0.8.3, one session, one session-owned tab in the
  existing Chrome on Xvfb. Driver scripts are the Mac runs' (`02-open.js`,
  `20-exit-reload.js`, `10-dump.js`), retargeted, plus `11-vitedump.js`.
- **Modes**: `fresh`: this origin's OPFS and caches cleared (IndexedDB deletion was
  reported blocked while the page was open; the recorder still classed every fresh
  sample as a first boot with no stored state). `reopen`: storage kept; the database is
  the 6,463,488-byte one the preceding fresh open left. `U`: service worker unregistered
  before the reload. `C`: kept. Each sample: Exit, clear/unregister as the mode says,
  reload, click Open editor, wait until usable, settle 8 s, fetch the trace dumps.
- **Build states**:

| prefix | runtime | tracing | samples |
|---|---|---|---|
| `B` | pin, clean | off | 5 freshU + 5 reopenU |
| `T` | pin, clean | `?opencodeTrace=1&viteTrace=1` | 5 + 5 |
| `I` | pin + temporary loader instrumentation | both | 5 + 5 |
| `IF` | same | both, `viteTrace=fs` | 3 + 3 |
| `C` | pin, clean (40 current assets identical; 4 stale worker files retained by the dev build) | both | 3 freshC + 4 reopenC |
| `P`, `W` | same as `C` | off | 1 reopenU; 3 reopens without a page reload |

- **Host phases** come from the diagnostics events and `window.__editorTimings`, so they
  exist with tracing off. **Guest phases** come from the trace marks, placed on the host
  timeline by the guest's `Date.now()` at entry.
- **Tracing cost** (medians, ms): Vite spawn → listen 3505 untraced, 3633 traced, 3870
  instrumented; whole operation 17240 / 17648 / 18138 fresh and 14501 / 14855 / 15089
  reopen. OpenCode's phases do not move (2779 / 2822 / 2825 and 1863 / 1864 / 1856).
- **Temporary runtime instrumentation** (`instrument.py` in the evidence directory,
  never committed, reverted with `git checkout -- packages`): in
  `packages/runtime/module.js`, per module read / TypeScript strip / ESM → CJS / compile /
  body time, and per `load()` the time in `resolveFilename` and `realpath`.

### The Vite tracing entry

Opt-in, off by default: `?viteTrace=1` (or `?viteTrace=fs`) on the example's URL.
`installViteTrace(workspace)` writes `opencode-chat/src/vite-trace-guest.cjs` to
`/workspace/.server/trace/vite-trace.cjs`; `tracedPreviewLaunch(preview)` is the prepared
launch with that entry and the real one in `VITE_TRACE_ENTRY`. Untraced, the events log
shows the same `service.launch` as before
(`/workspace/node_modules/vite/bin/vite.js --configLoader native …`).

It records marks; every outermost `Module._load` of 2 ms or more, in order; esbuild
calls; Vite's own `vite:deps,optimize-deps,load,transform,time,cache,esbuild` debug
lines, kept in memory instead of printed; every served request (time to first byte,
duration, bytes, overlap); event-loop lateness; the optimizer cache's presence; with
`fs`, counts and time of the synchronous filesystem calls. `window.__viteTrace.dump(label,
probe)` returns everything; `probe` also times a few hundred filesystem calls.

## 1. The Vite preview

Traced, clean runtime (`T`), median (min–max), ms.

| | fresh (n=5) | reopen (n=5) |
|---|---|---|
| A spawn → guest entry runs | 243 (228–265) | 238 (233–249) |
| B CLI and server chunk import | 350 (340–395) | 354 (342–392) |
| C `vite.config.ts` load (plugin packages) | 2234 (2198–2542) | 2215 (2207–2376) |
| D config loaded → listen call | 824 (770–925) | 799 (789–900) |
| E listen call → listening | 27 (24–38) | 3 (2–3) |
| = host spawn → listen | 3674 (3577–4153) | 3629 (3599–3919) |
| G host connect start → request reaches guest | 929 (896–960) | 58 (52–67) |
| H first `GET /` in the guest | 2215 (2185–2363) | 2289 (2253–2426) |
| = host listen → connected | 3132 (3106–3319) | 2354 (2304–2487) |
| J frame attached → loaded | 2219 (2204–2314) | 658 (622–722) |
| K loaded → application ready | 75 (73–79) | 74 (71–79) |
| = host spawn → preview ready | 9079 (9041–9863) | 6693 (6637–7207) |
| optimizer runs / bundling ms | 2 / 2128 (906 + 1210) | 0 (`Hash is consistent. Skipping.`) |
| esbuild `transform` calls / ms / slowest | 22 / 716 / 352 | 21 / 800 / 356 |
| requests during connect / during frame load | 3 / 32 | 3 / 32 |
| bytes served to the frame | 2,665,862 | 2,665,862 |
| frame: first request → last response | 1016 (987–1031) | 677 (641–732) |
| frame: requests over 100 ms / slowest | 8 / 473 | 6 / 219 |
| `style.css` transforms: n / summed ms | 4 / 1067 | 3 / 824 |
| longest event-loop stall | 2766 | 2744 |

- The host sees the listener within 3 ms of the guest's `listening`; nothing is lost to
  polling. Vite's own "ready in" line is 3.2 to 3.4 s; the other 0.24 s is the process
  worker starting.
- The 2.7 s stall is the configuration load: it is synchronous.
- **The optimizer cache** lives in `/workspace/.browser-editor-cache/vite` (the guest
  config sets `cacheDir`), which the OPFS mirror keeps: 38 files, 5.7 MB. Fresh: "removing
  old cache dir", scan, "Dependencies bundled in 906 ms" while the host's `GET /` waits;
  then after the first response "new dependencies found: @tanstack/react-query,
  @trpc/react-query, @trpc/tanstack-react-query, @trpc/client", "Dependencies bundled in
  1210 ms", and the frame's document request waits for that too.
- **The first `GET /`** (reopen, one sample's order): server build and `entry.server`
  transforms; then the app's dependencies loaded as ordinary modules by the runtime
  (`react-dom/server` 70 ms, `@tanstack/react-query` 229, `@trpc/react-query` 417,
  `@trpc/client` 75); `style.css` through Tailwind 445 ms; the optimized dependencies
  pre-transformed for the client (270 to 300 ms each, in parallel); Babel for React
  refresh loaded (about 170 ms); `style.css` again 190 ms.
- **The frame's load** is 32 requests and 2.67 MB; 22 answer in under 20 ms. The slow
  ones on a reopen are `root.tsx` and `home.tsx` (130 to 330 ms, Babel), `style.css`
  (180 to 270 ms) and the route manifest (about 300 ms).

Instrumented runtime (`I`), per phase of the preview process. Reopen is the same within
5%.

| fresh, n=5, ms | modules | source MB | read | TS strip | ESM→CJS | compile | module bodies | resolutions | resolve |
|---|---|---|---|---|---|---|---|---|---|
| before the config | 22 | 1.72 | 25 | 6 | 106 | 30 | 61 | 39 | 127 |
| `vite.config.ts` load | 496 | 4.12 | 45 | 42 | 132 | 77 | 225 | 1029 | 1971 |
| config → listening | 14 | 0.13 | 2 | 1 | 4 | 3 | 2 | 80 | 136 |
| listening → first response | 157 | 1.73 | 17 | 8 | 58 | 28 | 18 | 869 | 1202 |
| after the first response | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 412 | 265 |
| **total** | 697 | 7.80 | 90 | 61 | 308 | 139 | 316 | 2429 | 3694 |

- Resolution split: bare specifiers 361 for 2609 ms, relative 2068 for 184 ms, `realpath`
  902 ms. 1,735 resolutions found the module already in the cache afterwards.
- Filesystem calls of the whole preview process (`IF`, n = 3 fresh): 40,712 synchronous
  calls, 4.65 s including the counter's own cost; `statSync` 33,921 (26,351 failed) for
  2.97 s, `realpathSync` 2,501 for 0.90 s, `readFileSync` 1,775 for 0.43 s. These include
  Vite's own resolver, not only the runtime's.
- One call, measured in the guest 8 s after the start: `stat` of an existing path 24 µs,
  of a missing one 60 µs, `realpath` 0.3 ms, a small read 26 µs. `realpath` is ten times
  a `stat`.

## 2. OpenCode, against the Mac

Traced (`T`) for the timeline, instrumented (`I`) for the bundle split; median, ms. Mac
columns are the post-fix numbers of `2026-10-01-runtime-sqlite-and-module-load-fixes.md`
(`F`, `Fi`).

| reopen | diesel2 | Mac | ratio |
|---|---|---|---|
| spawn → attached (untraced on diesel2) | 3093 | 1476 | 2.1 |
| spawn → listen | 1863 | 878 | 2.1 |
| bundle load | 1653 | 769 | 2.1 |
| · read | 527 | 252 | 2.1 |
| · plan lookup + apply | 51 | 26 | 2.0 |
| · compile | 358 | 149 | 2.4 |
| · synchronous evaluation | 708 | 334 | 2.1 |
| listening → ready line | 104 | 50 | 2.1 |
| activation | 996 | 484 | 2.1 |
| SQLite to the activation answer (64 calls) | 706 | 352 | 2.0 |
| · model list (two reads of the 6 MB row) | 559 | about 270 | 2.1 |
| rest: process boot 140, import end → listening 80, health 162, attach 34 | | | |

| fresh | diesel2 | Mac | ratio |
|---|---|---|---|
| spawn → attached | 4484 | 2155 | 2.1 |
| bundle load | 2589 | 1264 | 2.0 |
| · read / ESM→CJS / compile (failed first attempt) / evaluation | 504 / 728 / 657 (290) / 719 | 254 / 397 / 276 (128) / 329 | 2.0 / 1.8 / 2.4 / 2.2 |
| activation | 1436 | 155 | the model list write and read land inside it here (837 ms), after it on the Mac |

The plan record is found on a reopen (`plan: hit`) and the SQLite call counts are the
Mac's (64 reopen, 230 to 234 fresh), so the fixes behave the same here.

## 3. Service-worker-controlled kernel (comparison only)

`C`: kernel created in a controlled page (`kernelCreatedSwControlled` true in every
sample), traced, load average 3 to 5.

| | controlled `C` | uncontrolled `T` |
|---|---|---|
| reopen, whole operation | 15881 (14772–16764), n = 4 | 14855 (14748–15644), n = 5 |
| fresh, whole operation | 18787 (18692–19550), n = 3 | 17648 (17602–19065), n = 5 |
| OpenCode reopen spawn → attached | 3300 (3076–3317) | 3149 (3105–3246) |
| Vite reopen spawn → preview ready | 7309 (6672–7472) | 6693 (6637–7207) |

Three reopens on the same page without a reload (`W`, controlled, untraced) were 14576,
14659 and 15468 ms: the same as a reload, because Exit ends the kernel worker.

## Measured, inferred, not measured

Measured:

- Every number in the tables, from the sources named beside them.
- That delivery's verify step is a per-file inflate and SHA-256 (read in
  `vendor/vivari/packages/kernel-host/install-tree.js`; time from its own receipt).
- What OPFS holds after an open (`opfs-census.json`, `opfs-detail.json`): `/app` 31.0 MB
  in 5 files, `/workspace/.browser-editor-backends` 6.7 MB, the optimizer cache 5.7 MB,
  the database 6.5 MB, source and config under 0.5 MB; no `node_modules`.
- The two regimes in the demo's log (read only).

Inferred:

- That resolution is avoidable work and what a cache would save. No cache was built.
  The instrumented runs are about 10% slower in Vite's phases, so the 3.5 s is an upper
  estimate of what resolution costs untraced.
- That the OPFS restore's time follows bytes, so not mirroring managed files would save
  about 1 s. Restore was not timed per file.
- That running the preview and OpenCode in parallel would save 2 to 2.5 s. Not tried;
  contention on the kernel thread is unknown.
- That diesel2's factor of 2.1 over the Mac is the CPU. No benchmark was run on both.
- That the demo log's fast samples came from another device. The log has no client
  information.

Not measured:

- Inside the process worker's 0.14 to 0.24 s boot, the kernel worker's 0.1 s boot, and
  the 0.32 s between the click and the operation's start.
- Inside the 1.0 s tree write and the 1.56 s OPFS restore.
- Module bodies that continue after a top-level await (the instrumentation times the
  synchronous part), and how much of the 40,000 filesystem calls belong to Vite's own
  resolver rather than the runtime's.
- Why the connect check's `GET /` arrives three times and the frame's twice.
- A workspace switch (kernel already running), which the quoted demo sample was (the
  17:54:53Z "New workspace"). In the demo's log a client's switches and its cold opens
  show the same Vite and delivery times (slow client: Vite ready in 3.2 s on an open and
  on two switches; fast client: 1.1 s on both), so a running kernel does not seem to
  change them. Read from the log, not measured here.
- Anything on a second machine or browser.

## Reproduce

```sh
cd /home/kkrausse/devfs/repos/kkrausse/bat-startup-measure
bun run setup                                   # once, about 3 min
cd examples/todo-app && PORT=3100 bun run editor:debug
# traced open:  http://localhost:3100/?opencodeTrace=1&viteTrace=1   (viteTrace=fs adds filesystem counters)
# in the page, once the editor is ready:
#   await window.__viteTrace.dump('label', true)       // marks, module timeline, requests, optimizer lines, fs probe
#   await window.__openCodeTrace.dump('label', true)   // as before
```

Evidence (gitignored): `.diagnostics/startup-breakdown-2026-10-03/` in this worktree:
per-sample `<label>.json` (operation stages), `dump-<label>.json`, `vitedump-<label>.json`,
`summary-<label>.json`, `events-all.jsonl`, the drivers, `instrument.py` and
`builds/instrumentation.diff`, the table scripts (`stages.py`, `vite-table.py`,
`oc-table.py`, `boot-table.py`) and their outputs (`table-*.md`).
