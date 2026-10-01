# Single-kernel adoption: handoff (2026-10-01)

Goal, as set by the owner: get the TODO example working really cleanly on the
consolidated single-kernel runtime, locally, then integrate the editor into IRS
tools. CI and publishing are not goals right now; the repos stay public as they are.

## Decisions made

- **Adopt the consolidated single kernel.** A matched comparison found it equal to
  the separate-worker baseline on speed and reliability (0–4% at the median, zero
  failed operations in about 145 per arm), with 4 workers instead of 7 and cleaner
  storage teardown. See `2026-10-01-matched-baseline-vs-single-kernel.md`.
- **The Vivari fork has diverged.** `kkrausse/vivari` `main` is our runtime line, with
  no plan to merge back upstream; upstream improvements are taken selectively.
- **Everything lands on `main`** in both repos; no long-lived branches.
- **Exit no longer saves.** Exit writes only the identity file and closes (about
  50 ms, was 1.9–3.5 s). Explicit Save and workspace switch still capture fully.

## Where things are

| Repo | Location | State |
| --- | --- | --- |
| Runtime | GitHub `kkrausse/vivari` `main` = `2367a64` (default branch) | pushed |
| Runtime | `/Users/kkrausse/Documents/repos/kkrausse/vivari-sk-track` | local checkout at `2367a64` |
| Toolkit | GitHub `kkrausse/browser-agent-toolkit` `main` = `69d402a` (default branch) | pushed |
| Toolkit | `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit` (`main`, `69d402a`) | the main checkout |
| Toolkit | `/Users/kkrausse/Documents/repos/kkrausse/bat-sk-track` (`fix/sk-back-on-track`) | integration worktree, ahead of `main` by local-only commits |

Local-only commits on `fix/sk-back-on-track` (not on `main`, not pushed): everything
after `69d402a`, which is the clean build path, the editor defect fixes, a CI
exclusion commit and this handoff. A second push to `main` was blocked by the
session's permission system, so `main` must be fast-forwarded by hand:

```sh
git -C /Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit merge --ff-only fix/sk-back-on-track
```

Merged into `fix/sk-back-on-track` at the end of the session:

| Branch | Head | What |
| --- | --- | --- |
| `build/sk-default` | `66ee1c9` | Single kernel as the default build; standard runtime build; two-command setup |
| `fix/sk-editor-polish` | `321d898` | Run-4 editor defects 1–9 |

## What landed this session

- `MODEL_CATALOG` server option; the picker lists exactly the supplied models.
- Enter while a chat prepares is queued and sent once (with `Cancel send`).
- A stop inside a workspace switch fails at 10 s like Exit (was 20 s).
- One alert per distinct failure after a failed exit.
- Stage timings: the **Debug · Timings** disclosure and `window.__editorTimings`
  (`summary()`, `summary().variance`, `operations`, `json()`).
- Exit without capture (see Decisions).
- Runtime pin moved to `2367a64` on the fork's `main`.

All of the above passed live in run 4 (`2026-10-01-sk-live-run-4.md`).

## Build and run

From a clean checkout (verified from a brand-new worktree and a fresh clone of the
fork):

```sh
bun run setup      # toolkit root: about 127 s first time, 10 s after
bun run editor     # examples/todo-app: about 19 s first time, 3 s after
```

Open `http://127.0.0.1:3000` (`PORT` overrides) and choose **Open editor**. Keep the
tab in the foreground. The model key goes in a gitignored
`examples/todo-app/.env.local` as `VIVARI_MODEL_API_KEY=<key>`; without it the editor
starts and chat reports that it needs a key. The model catalog is checked in at
`examples/todo-app/model-catalog.json`; `MODEL_CATALOG` overrides it.

- Single kernel is the default topology; `VIVARI_WORKER_TOPOLOGY=unrestricted` is the
  only opt-out.
- `vivari/scripts/build-runtime.ts` now works locally. Native Wasm was rebuilt and all
  four modules match the documented hashes; the kernel worker is byte-identical to the
  one every live run served (sha256 `4a2b2048…4664`).
- Prerequisites: Bun 1.4.0, Rust 1.93.0 with `wasm32-unknown-unknown` and
  `wasm32-wasip1`, `wasm-pack` 0.13.1 (installed this session), and Rust 1.95.0 with
  `wasm32-wasip1-threads` for the Tailwind backend. Setup downloads Node 24.13.0 into
  the gitignored `vivari/.runtime/`.

Rough edges:

- A worktree whose `vendor/vivari` is a symlink (such as `bat-sk-track`) must set
  `VIVARI_SOURCE` to the real checkout, or packaging fails with "Runtime source differs
  from build receipt". A checkout set up by `bun run setup` has a real clone and does
  not need it.
- The main checkout's `vendor/vivari` symlink still points at the baseline runtime
  (`browser-agent-toolkit-upstream/vendor/vivari`, `e998de6`), and its local OpenCode
  artifact is an older one. Remove the symlink and run `bun run setup` there after
  fast-forwarding `main`.
- The Tailwind backend takes 80 s of first setup and is not byte-reproducible. Every
  setup changes the distribution version, so the next prepare regenerates (14 s).
- No real model prompt has been sent on the new build path.

## Editor defects from run 4

Fixed on `fix/sk-editor-polish`, verified offline only (none seen in a browser yet):

| # | Defect | Fix |
| --- | --- | --- |
| 1 | Transcript flicker during a long answer | History refreshes no longer replace streamed text or re-follow the cursor. OpenCode persists text only when a part ends, so each refresh was resetting the answer to empty. |
| 2 | Composer Ready before the answer is drawn | Idle is published only after the final refresh lands. |
| 3 | Session selection lost on reload or tab close | The identity file is written when the selection changes and chat is idle. A rename is still persisted only by Exit, Save or switch. |
| 4 | Renamed Exit paid the full save | Exit rewrites only the catalog entry's name. |
| 5 | Name field showed "Current workspace" | Filled from the catalog as soon as it is read. |
| 6 | Empty sessions from New chat | An unsent empty session is reused. At most one per editor open can still be left behind. |
| 7 | Session ids and order changed on switch | Sessions are re-imported under their saved ids in list order. |
| 8 | Force exit recorded as `ok` | Recorded as `unproven` with the failed stage. |
| 9 | Timing output gaps | `service.cleanup.late` names the service; `window.__editorTimings` exists before first open. |

The live checks for each are in the hand-back summarized in the branch's commit
messages; the essential ones: streamed text length never decreases while running;
the first Ready sample already contains the answer; select a session, reload without
Exit, and it is still selected; ids and order are identical after switching away and
back.

Findings without a code change:

- **The 32 s with no text in run 4 was the model reasoning**, not the flicker.
- **Shell request, 125 s, no permission prompt.** The editor removes the shell tool on
  purpose (the guest has no OS shell) and allows `read`, `edit`, `grep`, `glob` and
  `runJavascript` outright, so no prompt can appear. The tool ran in 2.0 s; two gaps of
  about 51 s were time to the first stream event of a model request, and the evidence
  cannot split that between guest, proxy and provider. Enable host editor diagnostics
  (`model.request` / `model.response`) on the next run to separate them.
- **`/api/model` returning an empty list** was the probe script omitting the location
  query, not an editor race.

Never seen live: a permission prompt, a hang from a real guest process (only an
injected one), "Retry interrupted switch" on the current head.

## Performance: where the time goes and what could be won

Reference numbers, tab in the foreground: reopen about 17 s, switch about 19 s,
fresh boot about 25–31 s, save 0.7–1.4 s with two sessions, exit about 50 ms.
Stage shares below come from run 4's uncontrolled samples, which are the closest to
foreground conditions; they should be re-measured (see caveat).

| # | Opportunity | Affects | Evidence | Size if it holds |
| --- | --- | --- | --- | --- |
| 1 | Keep OpenCode running across a switch | switch | OpenCode start, health, plugin activation and session restore are about 13 s of a 19 s switch. Baseline measured 22.3 → 8.4 s with retention. | Largest for switch: roughly 19 s → 6–8 s |
| 2 | Stop re-importing sessions on switch | switch | `app.restore.sessions` is about 5 s (20–21%) and is also why session ids and order change. | About 5 s; overlaps with 1 |
| 3 | Stop Vite starting cold on every boot and reopen | boot, reopen | Vite listen + first response are 78% of a fresh boot (24 of 31 s) and about 47% of a reopen. `node_modules` is not mirrored to OPFS, so dependencies are redelivered and Vite's cache does not survive. Baseline measured 32.2 → 15.5 s with retained dependencies and cache. | Largest for boot and reopen: roughly halves them |
| 4 | Background-tab slowdown | everything | 4× slower when the tab is not the visible foreground tab, on both runtimes. A fixed worker benchmark took 109–125 ms in the foreground and 290–3,408 ms in the background. Unregistering the service worker lifted it in background tabs; mechanism unknown. | 4× in that situation only |
| 5 | SQLite rewrites the whole database image after every statement, including reads | OpenCode start, session export, save | Code reading only (`packages/kernel-host/sqlite-server.js` in the runtime); never measured. | Unknown; small diff, measure first |
| 6 | Save re-exports every session every time | save, switch | `app.capture.sessions` is 97–98% of a save. No change detection. | Most of save time; grows with sessions |
| 7 | OpenCode health probe has a 3 s timeout quantum | boot, reopen, switch | One attempt in the foreground, up to four in slow states. | 0–9 s in slow states |
| 8 | Kernel restore from stored state | reopen | 2.8–5.3 s (about 12%), growing with store size. | A few seconds |

Blockers recorded earlier for 1 and 3: retention needs a remote admission and drain
design and has a host-retention defect; retained dependencies are paused on the
lazy-loader cache-admission blocker. Both were measured on the baseline runtime only.

Unexplained: both runtimes step about 30% slower after the first reload with the
editor open (13–15 s to 17–21 s).

**Caveat on every timing so far.** Runs 3 and 4 and most of the comparison ran in the
owner's active browser window, and background tabs are 2–4× slower. Only 5 baseline
and 7 single-kernel operations were verified foreground. Before optimizing, do one
timing run in a browser window nobody is using, logging the real active tab with
every sample.

## Suggested order

1. Fast-forward `main`; replace the main checkout's `vendor/vivari` symlink and run
   `bun run setup` there.
2. One live run in a dedicated browser window: check the nine editor fixes, send real
   prompts on the new build path, and collect clean foreground stage timings.
3. IRS tools integration (worktrees `irs-tools-browser-editor`,
   `irs-tools-editor-draft` exist; not examined this session).
4. Performance, in the order of the table: 1 with 2, then 3.

## Housekeeping

- Scratch worktrees from the comparison, safe to delete:
  `/Users/kkrausse/Documents/repos/kkrausse/bat-compare-baseline`,
  `/Users/kkrausse/Documents/repos/kkrausse/vivari-compare-baseline`.
- A server was listening on port 46941 during this session that none of the runs
  started.
- Browser automation must use the Bun-backed `browser-control` CLI, in its own window.
- Evidence: `.diagnostics/sk-live-2026-10-01-run4-ukhj/`,
  `.diagnostics/compare-2026-10-01-vwzc/` (gitignored, in `bat-sk-track`).

## Final state

`fix/sk-back-on-track` builds and passes its checks with both branches merged:
`workspace-api` 94 pass, `vivari` 4 pass, todo-app 181 pass and 19 skipped,
`opencode-chat` 155 pass with the one known failure
(`test/opencode-launch.test.ts` cannot resolve `@opencode/schema/config/provider`).
Typecheck is clean in `workspace-api`, `opencode-chat` and the todo-app's `src/`; the
todo-app has 23 errors under `experiments/` and `tests/`.
