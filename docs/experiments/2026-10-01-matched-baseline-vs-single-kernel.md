# Matched baseline versus single-kernel runtime comparison (2026-10-01)

Same toolkit code, same fixture, same machine and browser, two runtimes: the
pre-consolidation runtime with separate workers (arm B) and the single-kernel
runtime (arm S). 289 recorded operations, 4 paid prompts.

**Result.** No difference attributable to the runtime was found in any measured
operation. The slowdown that run 4 attributed to "a kernel created in a page already
controlled by the service worker" appears on the baseline too, with the same size and
the same signature. In this run it tracks whether the editor's tab is the visible
foreground tab of the browser, not the runtime and not service-worker control alone:

| Tab state (checked before and after each operation) | Operation | Baseline, n, min / median / max (s) | Single kernel, n, min / median / max (s) |
| --- | --- | --- | --- |
| Foreground, kernel created controlled | reopen | 3: 17.04 / 17.16 / 17.71 | 3: 17.13 / 17.20 / 17.30 |
| Foreground, kernel created controlled | switch | 2: 17.58 / 19.38 / 21.18 | 4: 17.69 / 19.11 / 20.40 |
| Foreground, kernel created uncontrolled | reopen | 1: 16.92 | 2: 17.28 / 17.69 / 18.09 |
| Foreground, kernel created uncontrolled | switch | 2: 17.89 / 19.09 / 20.29 | 4: 17.76 / 19.07 / 20.41 |
| Background, kernel created controlled | reopen | 3: 71.60 / 73.41 / 77.60 | 4: 70.73 / 72.71 / 79.05 |
| Background, kernel created controlled | switch | 8: 70.29 / 82.04 / 91.91 | 8: 70.66 / 79.32 / 86.70 |
| Background, kernel created uncontrolled | reopen | 2: 36.23 / 36.55 / 36.88 | 1: 35.58 |
| Background, kernel created uncontrolled | switch | 4: 18.31 / 19.86 / 21.38 | 2: 18.20 / 19.40 / 20.61 |
| Background, fresh origin | boot | 3: 26.38 / 26.83 / 27.72 | 3: 25.42 / 25.52 / 27.66 |

- A controlled kernel in a background tab is 4.3× slower to reopen and 4.2× slower
  to switch on the baseline, 4.2× and 4.2× on the single kernel.
- A controlled kernel in the foreground is as fast as an uncontrolled one, in both
  arms. That includes a second kernel in the same page on the single kernel
  (reopen 17.20 s, switches 17.88 and 20.40 s).
- These rows come from the last part of the run only. For the first 75 minutes the
  real tab state was not recorded, and one matched block from that period (later
  kernels in the same page: baseline 13 s, single kernel 53–60 s) looked like a
  single-kernel defect until the baseline showed the same slowdown later. See
  "Tab state" and "What cannot be concluded".
- Reliability: no failed, hung or retried operation in either arm apart from the
  two injected checks per arm. No page errors.

## What was served

| Item | Arm B (baseline) | Arm S (single kernel) |
| --- | --- | --- |
| Runtime | `vivari-compare-baseline` `446df00f` (new worktree, scratch branch `compare/baseline-446df00`), clean | `vivari-sk-track` `2367a645`, clean, unchanged |
| Toolkit | `bat-compare-baseline` `58fe696` (new worktree, scratch branch `compare/baseline-matched` = `f40475a` + one commit) | `bat-sk-track` `f40475a`, as built for run 4, not rebuilt |
| Workers after boot (CDP targets) | 7: kernel, `fs-worker`, `fetcher-worker`, `sqlite3-opfs-async-proxy`, 3 guest process workers | 4: kernel, 3 guest process workers |
| Kernel worker | `kernel-worker-60kzmiNY.js`, sha256 `4af82cfb…1746` | `kernel-worker-DkyaMQkp.js`, sha256 `4a2b2048…4664` |
| Process worker | `process-worker-BNtwFfrJ.js`, `368aae7b…05da` | `process-worker-ZQRq3H73.js`, `ea2ac260…bad7` |
| Service worker (as delivered) | sha256 `68cb2b42…075d` | identical bytes |
| Distribution | `8fce40ed…da27`, topology policy `unrestricted` | `4a5e1fe1…79d5`, policy `single-kernel` |
| Prepared payload | 12 309 entries, image 44 164 706 bytes, bundle 42 717 670 bytes | 12 309 entries, image 44 167 199 bytes, bundle 42 724 782 bytes |
| Chat package (`opencode-chat/dist`, 64 files incl. the OpenCode application) | byte-identical to arm S | |
| Model catalog | copy of run 3's file, sha256 `7b172e30…11ad`, 28 models, default `muse-spark-1.3` | same file |
| App origin | `http://127.0.0.1:47011` (fresh) | `http://127.0.0.1:47021` (fresh) |
| Browser | Brave 154.1.96.59 (Chromium 154), Browser Control CLI 0.8.2, session `cmpb-vwzc` | same browser, session `cmps-vwzc` |

Machine: Apple M4 Pro (8 performance + 4 efficiency cores), macOS 26.6.2.

**Baseline revision.** `446df00f`, not the pinned `e998de62`. Reasons:

- It is the direct parent of the consolidation commit `e14ea7d`; the single-kernel
  branch is `446df00f` plus 14 commits. The runtime's own build note names it "Exact
  baseline".
- It is `e998de62` (the revision both toolkits pin, and the merge base with
  `integration/upstream-runtime`) plus one commit: a 7-line fix in
  `packages/kernel-host/kernel-fs.js` that re-checks the completion state after a
  wake-up. That race exists only in the separate-worker topology.
- Toolkit main's own recent baseline experiments served `446df00f`, and the baseline
  kernel built here has the same file name as theirs (`kernel-worker-60kzmiNY.js`).

The pinned `e998de62` was not measured.

**Build.** Both runtimes were built by the same script
(`vivari/scripts/receipt-single-kernel.ts`, native Wasm reused from the donor
`vivari-reset-completion-clean` at `446df00f` with the documented hashes verified,
same `package-lock.json`, same tool versions). Arm B then ran `workspace-api` build,
`distribution.ts` without `VIVARI_WORKER_TOPOLOGY`, `opencode-chat` build with
`OPENCODE_PACKAGE_DIR` pointing at arm S's built application, `prepare:editor` with
the Tailwind candidate, and `bun run build`. Servers:
`MODEL_CATALOG=<evidence>/model-config.json LOCAL_EDITOR_ADMIN=1 NODE_ENV=production PORT=<port> bun --env-file=<sibling .env.local> server.ts`.

## How matched the arms are

The toolkit head cannot run unmodified on the baseline runtime. It calls
`Host.close()` and requires `Endpoint.settled`, which only the single-kernel host SDK
has; against the baseline the editor could not expose a service or close a workspace.
Toolkit main has no workspace switching at all, so taking the baseline toolkit would
have removed the operations to be measured. Arm B therefore uses the toolkit head
plus one commit (`58fe696`, 3 files, +14 −6).

Differences between the arms other than the runtime:

| Difference | Could it bias a timing? |
| --- | --- |
| Arm B close path: no `Host.close()`, so Exit flushes and then destroys the host, as the toolkit did at the fork point. Arm S asks the kernel to shut down gracefully. | Exit only. The `workspace.close` stage was 0.2 ms median in B and 0.5 ms in S, so not visibly. This is really a runtime capability difference. |
| Arm B treats an endpoint's admission closure as its settlement (no cleanup receipt exists). | Service stop only. `services.stop` median 18.2 ms in B, 19.1 ms in S. |
| Arm B's declaration build tolerates type errors (`COMPARE_BASELINE_ALLOW_TYPE_ERRORS=1`). | No. Types only; the bundled JavaScript does not depend on them. |
| Arm S was built at 07:51, arm B at 08:58, same sources and lockfiles. | Not expected. `opencode-chat/dist` came out byte-identical. |
| 5 of 12 309 payload entries differ (the workspace package's bundled host SDK and its declarations); image 2 493 bytes smaller in B. | Negligible. |
| The host page's client bundle differs in 7 of 14 files (bundled host SDK). | Not expected. |
| Different origin and port; same browser profile; separate storage. | No. |
| The baseline emits no `worker.log.kernel`/`worker.log.opfs` milestones. | The "kernel restore" stage reads 0 in B; that stage is not comparable. Totals are. |
| Second tab: the baseline has no bounded owner-lock wait. | Second-tab failure time only (0.6 s against 10.5 s). Runtime difference. |
| Arms ran in separate tabs of one window, interleaved by block, not at the same instant. | **Yes, strongly, through the tab state.** See below. |

## Method

One browser, one tab per arm, operations driven with `browser-control execute`
scripts adapted from run 4. Timings come from `window.__editorTimings`, exported
before every reload; an in-page click listener and a 25 ms poll give an independent
wall clock (wall minus recorder over 280 driven operations: −31.7 to 47.8 ms, median
11.3 ms).

State was built identically in both arms: fresh boot, Save "WS-A", prompt 1 (agent
edit of the `h1` to `Todos CMP-MARK-7Q`), prompt 2 (`Reply with exactly: SECOND-OK`
in a second chat), Save, New workspace "WS-B". Both arms then held WS-A with 2
sessions (5 and 3 messages) and a pristine WS-B. Prompts used: 4 of 8.

| Phase | Time | What | Order |
| --- | --- | --- | --- |
| P1 | 09:03 | Fresh boot 1, Exit, clear storage | B, S |
| P2 | 09:04 | Fresh boot 2, state setup, 3 switches in the first kernel, Exit | S, B |
| P3 | 09:09 | Same page, no reload: 3 × (Open editor), 4 switches, Save, 3 Exits | B, S |
| P4 | 09:19 | 3 rounds: reload after Exit, with (U) or without (C) unregistering the service worker; Open, 2 switches, Exit | B S S B, S B B S, B S S B |
| P5, P6 | 09:30 | Run 4's procedure: reload with the editor open, U and C | S B B S, then S; B at 09:57 |
| P7, P8 | 09:40 | Probes: second kernel in the same page, reload, 45 s idle | S, then B at 10:02 |
| P9 | 10:18 | Reload samples with the real tab state logged, foreground or background, U or C | interleaved |
| R | 10:47 | Hung-service Exit, Force exit, second tab | B, S |
| P10 | 11:09 | Second kernel in the same page with the tab state logged | B, S (background); S, B, B (foreground) |
| P11 | 11:36 | 3 fresh boots per arm, background | B S S B B S |

Load average was mostly 3–7 (peaks 10.0 at 09:33, 12.9 at 09:49, 16.8 at 10:18). Origin storage was 94.5–94.7 MB until the first reload with
the editor open and 100.6–100.8 MB after it, in both arms.

### Tab state

The task asked for the tab to be visible and in the foreground. That could not be
held, and until 10:17 it was not even observable:

- The browser has one window with 53 tabs and the user was working in it. Each block
  began by activating the test tab; the user switched back to their own tab, often
  within seconds.
- Browser Control's pages report `visibilityState` "visible" and `hasFocus()` true
  whatever the real state, both test tabs at once. `hiddenMs` was 0 in all 289
  operations. Run 4 relied on the same signals.
- From 10:17 the real state was read with AppleScript before and after every
  operation (`active.sh`: which tab is active in the browser's front window, which
  application is frontmost, seconds since the last user input). "Foreground" below
  means the arm's tab was the active tab and the browser was the frontmost
  application at both ends of the operation. "Background" means another tab was
  active at both ends.
- A fixed loop (3 × 10⁷ iterations) was timed on the main thread and in a fresh
  dedicated worker of each page (`bench.js`). Main thread: 115–139 ms in every
  state. Worker: 109–125 ms in the foreground; 290–396 ms in the background; 2 240
  and 3 408 ms in a background tab while the other test tab was the active one.
  The kernel and all guest processes are workers.
- After the user's sustained activity made foreground samples impossible, no tab was
  activated while the user was active. Foreground samples were taken in the one
  window (11:24–11:33) when the user had been idle for a minute.

## Results

### Does the baseline show the service-worker penalty?

Yes, the same slowdown with the same size, and it is not specific to controlled
kernels in the way run 4 described.

- **Baseline, background tab, controlled kernel:** reopen 71.6–77.6 s, switch
  70.3–91.9 s, OpenCode health probe attempted 4 times in every one of 11 operations.
  Single kernel in the same state: 70.7–79.1 s and 70.7–86.7 s, 4 attempts in all 12.
- **Baseline, before the tab state was logged:** the slow state appeared in run 4's
  exact procedure (P6: unregister, reload, open, two switches, then reload with the
  editor open: reopen 74.3 s, switches 83.0 and 89.6 s) and in the middle of a
  kernel's life in P8 (reopen 17.5 s, then switches 50.8 and 93.0 s; after a reload
  76.2 s). It went away again without any unregister (P7, started 2 s after P6 ended: 16.9 s).
- **Controlled kernels are fast in the foreground**, on both runtimes: the table at
  the top, plus 9 baseline and 9 single-kernel operations in P4 (reload after Exit,
  controlled: reopen 12.9–13.5 s, switch 13.3–15.5 s) from the unlogged period.
- **Run 4's uncontrolled/controlled split does reproduce, in background tabs, in both
  arms.** After unregistering the service worker and reloading, a background tab's
  open took about 36 s (B 36.2 and 36.9; S 35.6) and its switches 18–21 s, and the
  worker benchmark went from 355–388 ms before the open to 115–117 ms after it. With
  the service worker left in place the same background tab stayed slow (benchmark
  290–396 ms after). Run 4's medians (uncontrolled open 36.3 s and switch 25.9 s;
  controlled open 72.5 s and switch 106.9 s) fit a tab that was in the background
  throughout. Why a freshly registered service worker lifts the slowdown is not
  known.
- **Two unplanned transitions, both on the baseline.** In P10 the user returned
  during a foreground sample: the next operations took 59.7, 79.0 and 89.1 s. In the
  repeat the test tab stayed the active tab but another application became frontmost:
  switches took 74.4 and 66.7 s; when the browser was frontmost again the Save took
  1.39 s and the worker benchmark 112 ms. So the active tab alone is not enough; the
  window has to be the visible front one.

The cause is inferred from the benchmark and these transitions (background tabs get
slower worker threads). It was not proven at the operating-system level.

### Matched blocks before the tab state was logged

Same sequence in both arms; real tab state unknown. Times in seconds.

| Block | Operation | Baseline, n, min / median / max | Single kernel, n, min / median / max |
| --- | --- | --- | --- |
| P1, P2 fresh origin | boot | 2: 10.16 / 17.79 / 25.42 | 2: 23.65 / 24.21 / 24.78 |
| P2 first kernel | new workspace + switch | 4: 13.76 / 14.51 / 15.09 | 4: 13.50 / 14.31 / 15.05 |
| P3 later kernel, same page | reopen | 3: 12.78 / 12.91 / 12.95 | 3: 52.76 / 53.19 / 62.54 |
| P3 later kernel, same page | switch | 4: 13.63 / 14.33 / 14.90 | 4: 54.34 / 57.56 / 60.03 |
| P4 uncontrolled, reload after Exit | reopen | 3: 13.20 / 13.68 / 27.66 | 3: 13.03 / 13.04 / 13.18 |
| P4 uncontrolled, reload after Exit | switch | 6: 13.67 / 14.44 / 15.18 | 6: 13.26 / 14.72 / 14.84 |
| P4 controlled, reload after Exit | reopen | 3: 12.93 / 13.24 / 13.47 | 3: 13.01 / 13.05 / 13.37 |
| P4 controlled, reload after Exit | switch | 6: 13.69 / 14.44 / 15.48 | 6: 13.35 / 14.05 / 14.87 |
| P5, P6 reload with editor open, controlled | reopen | 2: 17.19 and 74.29 | 2: 15.24 and 16.94 |
| P5, P6 reload with editor open, controlled | switch | 4: 18.07 / 51.98 / 89.59 | 4: 17.64 / 18.88 / 20.69 |
| P5, P6 reload with editor open, unregistered | reopen | 2: 17.24 and 22.87 | 2: 17.10 and 17.57 |
| P5, P6 reload with editor open, unregistered | switch | 4: 18.16 / 19.68 / 21.25 | 4: 17.36 / 18.77 / 20.29 |
| P7 | reopen | 4: 16.89 / 17.04 / 17.18 | 4: 17.06 / 17.36 / 64.69 |
| P7 | switch | 4: 17.97 / 19.38 / 21.03 | 4: 17.86 / 19.11 / 20.50 |
| P8 | reopen | 4: 17.27 / 37.58 / 76.20 | 4: 43.48 / 61.54 / 68.24 |
| P8 | switch | 6: 18.19 / 59.60 / 93.00 | 6: 34.69 / 75.72 / 89.19 |

- The P3 row is the one that looked like a single-kernel defect: identical sequence,
  baseline 13–15 s, single kernel 53–63 s. Both blocks began by activating the
  arm's tab; nothing recorded whether it stayed active. The baseline's block lasted
  2 minutes, the single kernel's 7. With the tab state logged, the same sequence gave
  17.2 / 17.9 / 20.4 s on the single kernel in the foreground and 73.4 / 71.8 /
  85.1 s on the baseline in the background.
- Slow-state operations (30 s or more) in this period: baseline 9 (P6 and P8),
  single kernel 18 (P3, P7 and P8). The counts follow when the user took the tab
  back, which was not controlled, so they say nothing about the runtimes.
- Over the whole run, every switch of an uncontrolled kernel was under 22 s in both
  arms (19 of 19 each).

### Stage breakdown

Median seconds per stage, controlled kernels, tab state logged (P9, P10).

| Stage | Switch, foreground B / S | Switch, background B / S | Reopen, foreground B / S | Reopen, background B / S |
| --- | --- | --- | --- | --- |
| n | 2 / 4 | 8 / 8 | 3 / 3 | 3 / 4 |
| `delivery.install-tree` | 1.33 / 1.37 | 1.77 / 1.70 | 1.37 / 1.38 | 1.75 / 1.70 |
| `service.listen:vite` | 1.63 / 1.69 | 9.78 / 10.38 | 1.66 / 1.70 | 9.60 / 9.94 |
| `service.connect:vite` | 1.38 / 1.51 | 8.83 / 8.88 | 1.10 / 1.12 | 6.76 / 6.86 |
| `preview.iframe.load:vite` | 1.08 / 1.10 | 2.78 / 2.77 | 0.32 / 0.32 | 1.67 / 1.70 |
| `service.listen:chat` | 1.93 / 1.99 | 8.87 / 8.90 | 1.98 / 1.98 | 9.06 / 8.87 |
| `service.connect:chat` | 6.34 / 6.26 | 24.90 / 24.38 | 6.25 / 6.22 | 26.90 / 25.70 |
| of which `/api/health` probes | 2.77 / 2.75 | 10.76 / 10.95 | 2.73 / 2.74 | 11.21 / 10.81 |
| of which `plugin/await-activation` | 3.38 / 3.34 | 13.09 / 12.55 | 3.35 / 3.30 | 14.63 / 13.84 |
| `chat.attach` | 1.25 / 1.18 | 4.50 / 5.00 | 1.86 / 1.90 | 7.88 / 8.21 |
| `app.capture.sessions` | 0.75 / 0.77 | 2.75 / 2.93 | n/a | n/a |
| `app.restore.sessions` | 2.38 / 2.27 | 9.42 / 9.69 | n/a | n/a |
| Kernel restore (`worker.log.kernel→opfs`) | n/a | n/a | not emitted / 1.12 | not emitted / 4.80 |
| **Total** | **19.38 / 19.11** | **82.04 / 79.32** | **17.16 / 17.20** | **73.41 / 72.71** |

No stage separates the runtimes in either state. The first-kernel switches of P2
(before the drift below) agree as well: total 15.05 / 14.86 s, `listen:vite`
1.67 / 1.77, `connect:chat` 3.53 / 3.46, `restore.sessions` 1.53 / 1.47.

### Boot, save, exit

| Operation | Baseline | Single kernel |
| --- | --- | --- |
| Fresh boot, tab state not logged (P1, P2) | 25.42, 10.16 s | 24.78, 23.65 s |
| Fresh boot, background tab (P11) | 26.38, 26.83, 27.72 s | 25.52, 25.42, 27.66 s |
| Save, 0 sessions | 129 ms | 126 ms |
| Save, 2 sessions (8 messages), fast state | 770, 772, 1 389 ms | 731, 1 438 ms |
| Save, 2 sessions, slow state | 5 117, 5 852 ms | 2 357, 5 445 ms |
| Exit, 0 sessions (n = 4 each) | 20 / 29 / 43 ms | 20 / 22 / 27 ms |
| Exit, 2 sessions | n = 34: 21 / 29 / 178 ms | n = 33: 21 / 35 / 317 ms |

- The baseline's 10.16 s boot is one sample: Vite listened in 1.7 s and connected in
  1.6 s instead of about 9.7 s and 8.5 s. It was not repeated in four other baseline
  boots. Without it the fresh boots are within about 1 s of each other.
- Exits over 100 ms: 3 in B (122, 108, 178 ms) and 1 in S (317 ms). All but the
  122 ms one were in the slow state; `service.stop:chat` accounts for them.

### Drift

Both arms slowed by the same step at the same point: foreground-speed switches were
13.3–15.5 s through P4 and 17.4–21.4 s from P5 on, in both arms. P5 was the first
reload with the editor open; origin storage rose from 94.7 to 100.6–100.7 MB at that
moment in both arms. Within the slower period `service.connect:chat` is 6.3 s
against 3.5 s before and `restore.sessions` 2.3 s against 1.5 s. Run 4 saw the same
6 MB step and slowdown. The cause was not investigated. It is why the foreground rows
at the top (17–21 s) are slower than P2–P4 (13–15 s).

## Reliability

| | Baseline | Single kernel |
| --- | --- | --- |
| Operations recorded | 146 | 143 |
| Failed, hung or retried, outside the injected checks | 0 | 0 |
| Page errors | 0 | 0 |
| Console | deprecated-parameters warning ×87, `style.css` preload warning ×107, favicon 404 ×1, React hydration attribute mismatch ×2 | ×86, ×104, ×1, ×2 |
| Prompts | 2 sent, 2 completed (15.8 s, 5.8 s) | 2 sent, 2 completed (17.1 s, 5.7 s) |
| Hung-service Exit (injected at the chat execution handle) | failed after 10 007 ms (`waitedMs` 10 000), one alert with Retry exit / Force exit, lock held | failed after 10 021 ms (`waitedMs` 10 008), same alert |
| Force exit | 255.9 ms, lock free, workers gone | 255.8 ms, lock free, workers gone |
| Reopen after force exit | 18.0 s, edit and both sessions present | 18.5 s, edit and both sessions present |
| Second tab while page 1 owns the workspace | failed after 0.59 s, one footer alert "This workspace is already open in another tab or window…", page 1 undisturbed | failed after 10.5 s (owner-lock wait), same alert, page 1 undisturbed |
| "Retry editing" after page 1 exits | worked (73.2 s, background tab) | worked (75.7 s, background tab) |
| State after every block | marker in source and preview, 2 sessions, names | same |

Other observations:

- Right after Exit the baseline still listed 1 kernel and 1–2 process targets plus 2
  other workers; the single kernel listed 1 kernel and 1–2 process targets. Both were
  0 at the next check, with the lock free.
- Three of five storage clears on the baseline reported the IndexedDB delete as
  "blocked"; it completed once the page navigated. None of five did on the single
  kernel.
- Each check ran once per arm. The hang was injected at the handle, as in runs 2–4.

## What cannot be concluded

- **Foreground performance rests on few logged samples**: 5 baseline and 7
  single-kernel reopens and switches of controlled kernels, taken in one 9-minute
  window. The larger fast sets (P2, P4, P5–P7) have no recorded tab state.
- **A second kernel in the same page, verified foreground, exists only for the single
  kernel** (one reopen, two switches). Both baseline attempts were interrupted. The
  baseline's unlogged P3 and P7 samples of that case were fast.
- **Why the uncontrolled case escapes the background slowdown** is unknown, and so is
  the operating-system mechanism of the slowdown itself.
- **Run 4's interpretation is not supported as stated**, but run 4 was not rerun.
  Its numbers match the background-tab rows here; it recorded nothing that could
  confirm or exclude that.
- **The pinned baseline `e998de62` was not measured**; `446df00f` differs by one fix.
- **Small differences are below this sample's resolution.** Within a state the arms
  differ by 0–4% at the median, with 2–8 samples per cell and ranges of 10–25%.
- **Reliability counts are one session per arm**, about 145 operations each, with no
  long-running agent work, no real guest hang, no crash recovery, no quota pressure.
- **Chat latency was not compared** beyond the four prompts.
- **The 30% drift** after the first reload with the editor open is unexplained.

For any further timing run: use a browser window the user is not working in, and log
the real active tab and frontmost application with every sample.

## Evidence and cleanup

Evidence: `/Users/kkrausse/Documents/repos/kkrausse/bat-sk-track/.diagnostics/compare-2026-10-01-vwzc/`
(`journal.md`, `analysis.txt`, `analysis-rows.json`, `analyze.py`, `active-log.txt`,
`timings-*.json` exports, per-operation JSON, text and screenshots, `*bench*.json`,
`console-B.json`, `console-S.json`, driver scripts, `build-logs/`, server logs). The
screenshot of the baseline's hung-Exit alert was viewed and matches.

Left in place, committed and not pushed: toolkit worktree
`/Users/kkrausse/Documents/repos/kkrausse/bat-compare-baseline` (`compare/baseline-matched`,
`58fe696`) and runtime worktree
`/Users/kkrausse/Documents/repos/kkrausse/vivari-compare-baseline`
(`compare/baseline-446df00`, no commits of its own; ignored build output only).
`fix/sk-back-on-track`, toolkit main and the existing runtime branches were not
modified.

Both origins' storage was cleared after confirming the owner lock was free and no
workers remained (OPFS, IndexedDB, CacheStorage, service worker), and checked empty
from a fresh load. Sessions deleted, both servers stopped, ports 47011 and 47021
free. The evidence directory, both generated manifests and the baseline client build
were scanned for the provider key's value: 1 235 files, 0 hits.
