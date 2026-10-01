# Workspace switch that keeps the OpenCode server running (2026-10-01)

A TODO-example workspace switch now keeps the runtime, the delivered dependencies
and the guest OpenCode process when that is safe, and falls back to the unchanged
stop / clear / restart path otherwise. Live result, one run, Chrome 154: on the
retained path the OpenCode process is the same one before and after (same guest
pid, no `chat` launch, no plugin loading), the agent reads the incoming workspace's
file, sessions and preview are the incoming workspace's, and a switch takes
8.6 s instead of 16.3 s (median, uncontrolled kernel, 1 to 2 sessions). Both
fallbacks (ineligible, and a failure injected after the files were replaced) ended
in a correct state through the full path.

Code: `7f888f9` (workspace-api `clearWorkspaceSource`), `530175c` (opencode-chat
`detachChat`), `b913c7a` (todo-app retained path). Branch `feat/todo-editor-diagnostics`.

## What the switch does now

Unchanged up to the journal: hold chat, capture the outgoing workspace, write the
catalog journal naming the incoming image. Then, still before anything is disposed
or removed, the path is chosen once (`switch.eligibility`):

Retained only if all hold, otherwise full with the reason recorded:

- not a retry of an interrupted switch, and no `?workspaceSwitch=full` on the URL;
- runtime, `vite` and `chat` services are up and the preview launch is known;
- chat admission is held (the hold the switch itself took);
- outgoing and incoming source images have equal `package.json` dependency sections
  (`dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`,
  `overrides`, `resolutions`, `patchedDependencies`, `trustedDependencies`,
  `workspaces`; key order ignored) and byte-identical lockfiles and prepared lock
  inputs (`bun.lock`, `bun.lockb`, `package-lock.json`, `npm-shrinkwrap.json`,
  `yarn.lock`, `pnpm-lock.yaml`, `.browser-editor/runtime-package.json`,
  `.browser-editor/runtime-bun.lock`); a file present in only one image, or a
  `package.json` that does not parse, is a difference;
- the OpenCode execution has not exited, `GET /api/health` answers 200, and
  `GET /api/session/active` reports no running session;
- a check that throws is itself a reason for the full path.

Retained path: dispose and forget the chat controller (`detachChat`), stop only the
`vite` service, `clearWorkspaceSource` keeping `.server`, `node_modules` and
`.browser-editor-backends` (the two `/workspace` roots managed delivery installs,
plus OpenCode's own state), restore source and identity, relaunch Vite and wait for
the preview, delete and re-import sessions as before, mount a fresh chat controller
on the same service, select the saved session. No config or plugin rewrite, no
delivery, no `startOpenCode`, no location eviction.

If any retained step throws, the switch disposes chat again and runs the full
path's stop / clear / start for the incoming workspace in the same operation. The
journal is committed only after one of the two paths finished. If the full path
fails as well, the pending journal remains and **Retry interrupted switch** works
as before (a retry always takes the full path).

Timings: `switch.eligibility`, `switch.stop-preview`, `switch.replace-source`,
`switch.resume` (with `switch.start-preview` nested); the full path keeps
`switch.stop`, `switch.replace`, `switch.start`. The controller diagnostic
`switch.path {path, reason?}` is in the events log and in the operation's events.

## Offline

| Package | typecheck | tests before | tests after |
| --- | --- | --- | --- |
| `examples/todo-app` | 23 errors, all in `experiments/` and `tests/`, before and after; `src/` and `server.ts` clean | 182 pass, 17 skip, 1 fail | 186 pass, 17 skip, 1 fail |
| `workspace-api` (`bun run test`) | clean | 94 pass | 96 pass |
| `opencode-chat` | clean | 154 pass, 2 skip, 2 fail, 1 error | 155 pass, 2 skip, 2 fail, 1 error |

The failures are the same before and after. In `todo-app` it is
`tests/reuse-pilot-contract.test.ts` "pinned HttpApi schemas…" (`registerHooks` is
not exported by this Bun's `node:module`); the briefed baseline of 181 pass / 19
skip did not match this worktree. Added: 4 switch tests (ordering, fallback,
retry, dependency comparison), 2 `clearWorkspaceSource` tests, 1 `detachChat` test.

## Live run

Served from this worktree at `b913c7a` with `PORT=3100 bun run editor:debug`
(fresh origin `http://127.0.0.1:3100`), default catalog, model `muse-spark-1.3`.
Browser Control CLI 0.8.2, one session `retained-switch-live`, one session-owned
tab. Six prompts were sent. Evidence (driver scripts, per-step JSON, timing
exports, both halves of the rotated events log):
`.diagnostics/retained-switch-2026-10-01/` at the worktree root (gitignored; scanned for the model key value: 0 hits).

**Not as briefed: the tab was not in its own window.** The Browser Control
extension only creates tabs (`chrome.tabs.create`), CDP `Browser.getWindowForTarget`
is unavailable through it, and `window.open` with popup features opened a
background tab in the same window (closed again). The run used the session-owned
tab; it was never brought to the front by script. Every operation below recorded
`visible` at start and end and `hiddenMs` 0. Other agents' relay tabs were open in
the same browser; load average was 4 to 7 throughout.

Chronology (local time):

1. 16:13 first boot 25.4 s. WS-A: `src/marker.txt` = `MARKER-ALPHA-copper-lantern-7141`
   and `<h1>Todos ALPHA workspace</h1>` written through the `workspaceFixture`
   hook, one prompt (agent read the marker), saved as WS-A.
2. New workspace WS-B: first retained switch, 6.2 s. Marker
   `MARKER-BRAVO-violet-anchor-2907`, `<h1>Todos BRAVO workspace</h1>`, two prompts
   (two sessions), saved.
3. 16:15 S-01..S-03 retained B→A→B→A, then S-04 with `?workspaceSwitch=full`
   (toggled with `history.replaceState`, no reload).
4. Tried also keeping `.browser-editor-cache` (Vite's guest `cacheDir`). After the
   rebuild the page was reloaded and its kernel was created under service-worker
   control, where everything is about 4× slower (known from live run 4). In that
   kernel, preview start with the cache kept was 21.6 / 22.2 / 16.5 / 18.6 s and
   with it removed just before the switch 22.1 / 19.3 s: no clear gain, so the kept
   set went back to the three roots above. These six retained switches (32 to 40 s,
   all correct) are not in the table: different build.
5. 16:24 final build (`b913c7a`), service worker unregistered, reload, reopen
   31.1 s. U-01..U-08: R F F R R F F R, alternating direction.
6. 16:27 Q: prompt in B, retained to A, prompt, retained to B, prompt.
7. 16:29 V-01..V-08: R R R R F F R R.
8. 16:33 D: `left-pad` added to WS-B's `package.json` dependencies; switch to A
   and back with the flag off. Then removed again.
9. 16:35 X: one injected rejection of the next `vite` launch (page-side patch of
   `controller.launch`, test only), then a switch with the flag off.
10. 16:37 C: reload without unregistering (controlled kernel), reopen 69.6 s,
    R F F R.
11. Exit (96 ms), own origin's storage cleared, session deleted, port 3100 stopped.
    The other server on port 3000 was listening at 16:22 and was not at 16:44; this
    run sent it no signal and made no request to it, but did rebuild the `build/`
    and `.editor/` output it serves three times. Why it stopped is not known.

### 1. Process kept on the retained path, restarted on the full path

From the events log, per switch `runId` (`log-summary.json`), and the page:

| | retained (18 switches incl. new-workspace) | full (11, and X-01's fallback) |
| --- | --- | --- |
| `service.launch` / `service.spawn.start` names | `vite` only | `chat`, `vite` |
| `service.stop.start` names | `vite` only | `chat`, `vite` |
| `runtime.start` | 0 | 1 |
| `… exited` activity lines | `vite exited` (SIGTERM) only | `vite exited`, `chat exited: exitCode 0` |
| `GET /api/health` pid after vs before | unchanged every time (3 across three; 11 across two; 21 across seven consecutive, with three prompts in between; 41 across two) | new every time (3 → 14; 3 → 8 → 11; 11 → 18 → 21; 21 → 38 → 41; 41 → 48 → 51) |
| chat `Service` object in the controller | same object | new object |
| `service.execution.exited` | unsettled | (new execution) |

### 2. Plugin activation

Not re-run on the retained path, as observed in OpenCode's own output (captured as
`guest.output`): during a retained switch the `chat` process logs exactly one
line, the interrupted event stream of the disposed client (`InterruptError: All
fibers interrupted`). During a full switch it logs `OPENCODE_SERVER_PROCESS_READY`,
`location services booted`, three `loading plugin` lines (the three editor
plugins) and the `agent.updated` / `command.updated` / `catalog.updated` events.
The app's readiness `POST /api/plugin/await-activation` occurs once per full switch
and never on a retained one. `GET /api/plugin` lists the same 87 plugins, all
`active`, before and after. The fresh chat client does call `await-activation`
when it lists models; that waits and loads nothing (no `loading plugin` line).

### 3. No stale file state

Within one OpenCode process (pid 21), with a new chat each time and the prompt
"Use the read tool on /workspace/src/marker.txt and reply with exactly the file
contents": in WS-B → `MARKER-BRAVO-violet-anchor-2907`; retained switch to WS-A →
`MARKER-ALPHA-copper-lantern-7141`; retained switch to WS-B →
`MARKER-BRAVO-violet-anchor-2907`. The prompt after the very first retained switch
(new WS-B, pid 3, which had read ALPHA before) also returned BRAVO.

### 4. Session ids and order

After every one of the 35 probed switches (the six of step 4 included) the chat list, the server's list and the
selected session matched what that workspace had when it was left
(`sessions.py`). WS-A: `[…H14nug]`, later `[…b0cdzC, …H14nug]`; WS-B:
`[…94XEaW, …w76szj]`, later `[…IwJgKZ, …94XEaW, …w76szj]`, then
`[…F2dUyS, …IwJgKZ, …94XEaW, …w76szj]`. Same ids, same order, same selection,
on both paths and after A → B → A on the retained path.

### 5. Preview

After every switch the preview frame's `<h1>` was the incoming workspace's
(`Todos ALPHA workspace` / `Todos BRAVO workspace`), as were `src/home.tsx` and
`src/marker.txt` read back through the fixture, and the identity file.

### 6. Timings

Milliseconds from `window.__editorTimings`. `start` is `switch.resume` or
`switch.start`; `vite` is listen + connect + first frame load; `ocBoot` is OpenCode
listen + connect. Tab foreground (`visible`, `hiddenMs` 0) in every row.

| sample | path | total | capture | stop | replace | start | deliver | vite | ocBoot | restore | attach | select | pid | sessions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S-01 →A | retained | 8323 | 727 | 9 | 82 | 7481 | | 4297 | | 1607 | 953 | 602 | 3 | 1 |
| S-02 →B | retained | 8995 | 489 | 2 | 82 | 8398 | | 4658 | | 1975 | 1054 | 687 | 3 | 2 |
| S-03 →A | retained | 8549 | 728 | 1 | 76 | 7727 | | 4463 | | 1607 | 1000 | 636 | 3 | 1 |
| S-04 →B | full | 16215 | 467 | 24 | 148 | 15562 | 1457 | 4404 | 5668 | 2147 | 1092 | 677 | 14 | 2 |
| U-01 →A | retained | 8602 | 747 | 2 | 71 | 7761 | | 4446 | | 1647 | 995 | 651 | 3 | 1 |
| U-02 →B | full | 17016 | 471 | 44 | 148 | 16329 | 1492 | 5142 | 5800 | 2142 | 992 | 641 | 8 | 2 |
| U-03 →A | full | 16285 | 754 | 25 | 168 | 15319 | 1548 | 4620 | 5796 | 1620 | 982 | 629 | 11 | 1 |
| U-04 →B | retained | 8901 | 488 | 1 | 69 | 8322 | | 4578 | | 2033 | 1019 | 668 | 11 | 2 |
| U-05 →A | retained | 8645 | 792 | 1 | 75 | 7757 | | 4346 | | 1658 | 1105 | 628 | 11 | 1 |
| U-06 →B | full | 20659 | 458 | 17 | 151 | 20005 | 1497 | 4526 | 6769 | 3921 | 1948 | 1228 | 18 | 2 |
| U-07 →A | full | 23325 | 1434 | 22 | 151 | 21689 | 1470 | 4760 | 8648 | 3159 | 2106 | 1419 | 21 | 1 |
| U-08 →B | retained | 12745 | 891 | 2 | 93 | 11730 | | 4548 | | 3966 | 1935 | 1247 | 21 | 2 |
| Q-02 →A | retained | 15138 | 2916 | 2 | 93 | 12093 | | 4800 | | 3986 | 1948 | 1335 | 21 | 1 |
| Q-04 →B | retained | 14974 | 1399 | 2 | 71 | 13475 | | 4396 | | 5923 | 1929 | 1204 | 21 | 3 |
| V-01 →A | retained | 16521 | 2431 | 3 | 84 | 13968 | | 4537 | | 6105 | 1940 | 1362 | 21 | 2 |
| V-02 →B | retained | 16933 | 1438 | 1 | 72 | 15393 | | 4659 | | 7454 | 1985 | 1270 | 21 | 4 |
| V-03 →A | retained | 16263 | 2452 | 1 | 72 | 13717 | | 4303 | | 6047 | 2029 | 1313 | 21 | 2 |
| V-04 →B | retained | 17470 | 1411 | 1 | 65 | 15969 | | 4750 | | 7883 | 1985 | 1325 | 21 | 4 |
| V-05 →A | full | 28596 | 2558 | 25 | 173 | 25821 | 1622 | 4673 | 9906 | 6219 | 2006 | 1268 | 38 | 2 |
| V-06 →B | full | 28400 | 1528 | 32 | 177 | 26643 | 1568 | 4799 | 9166 | 7740 | 1970 | 1269 | 41 | 4 |
| V-07 →A | retained | 16260 | 2544 | 1 | 75 | 13602 | | 4342 | | 6024 | 1956 | 1256 | 41 | 2 |
| V-08 →B | retained | 16887 | 1517 | 1 | 73 | 15272 | | 4548 | | 7475 | 1963 | 1263 | 41 | 4 |
| D-01 →A | full (deps) | 26569 | 2423 | 25 | 160 | 23943 | 1499 | 4562 | 8460 | 6064 | 1976 | 1273 | 48 | 2 |
| D-02 →B | full (deps) | 27142 | 1475 | 21 | 162 | 25464 | 1506 | 4593 | 8510 | 7522 | 1974 | 1236 | 51 | 4 |
| X-01 →A | retained, then full | 26572 | 2471 | 13 | 152 | 23843 | 1472 | 4438 | 8673 | 6011 | 1918 | 1212 | 54 | 2 |
| C-01 →B | retained | 70004 | 5235 | 5 | 533 | 64193 | | 21910 | | 29185 | 7764 | 5248 | 3 | 4 |
| C-02 →A | full | 96616 | 9467 | 113 | 323 | 86688 | 1875 | 20068 | 30410 | 22481 | 7146 | 4414 | 8 | 2 |
| C-03 →B | full | 104317 | 5727 | 55 | 385 | 98126 | 1824 | 21214 | 32428 | 29154 | 7383 | 5632 | 11 | 4 |
| C-04 →A | retained | 76336 | 9973 | 4 | 388 | 65929 | | 25605 | | 27855 | 7599 | 4798 | 11 | 2 |

The new-workspace switch (step 2, retained, 0 incoming sessions) took 6185 ms:
capture 451, replace-source 71, start-preview 4731, restore.sessions 562, attach 271.

The samples are not one population. At U-06 every OpenCode request that touches
the session database became 2× slower and stayed so, on both paths and across
fresh processes (see Observations), and the Q prompts then added sessions. Medians
are therefore per condition:

| condition | path | n | total | start | vite | ocBoot | restore | attach | select |
|---|---|---|---|---|---|---|---|---|---|
| uncontrolled kernel, before the step (A 1 / B 2 sessions) | retained | 6 | 8624 | 7759 | 4454 | | 1652 | 1010 | 644 |
| | full | 3 | 16285 | 15562 | 4620 | 5796 | 2142 | 992 | 641 |
| uncontrolled, after the step, same sessions | retained | 1 | 12745 | 11730 | 4548 | | 3966 | 1935 | 1247 |
| | full | 2 | 21992 | 20847 | 4643 | 7708 | 3540 | 2027 | 1324 |
| uncontrolled, after the step (A 2 / B 4 sessions) | retained | 6 | 16704 | 14620 | 4542 | | 6780 | 1974 | 1292 |
| | full | 4 | 27771 | 25642 | 4633 | 8838 | 6870 | 1975 | 1268 |
| controlled kernel (A 2 / B 4 sessions) | retained | 2 | 73170 | 65061 | 23758 | | 28520 | 7682 | 5023 |
| | full | 2 | 100466 | 92407 | 20641 | 31419 | 25818 | 7264 | 5023 |

Saved per switch: 7.7 s (47 %), 9.2 s (42 %), 11.1 s (40 %), 27.3 s (27 %). What is
removed is delivery (about 1.5 s) and OpenCode's listen + readiness (5.8 to 9.9 s;
31 s in a controlled kernel). What is left is Vite's restart (about 4.5 s) and the
session delete + re-import, chat attach and session select, which are the same on
both paths and now dominate: 3.3 s of 8.6 s with one or two sessions, 10 s of
16.7 s with two and four.

### 7. Forced fallbacks

- **Ineligible.** With `left-pad` added to WS-B's `package.json` and the flag off:
  D-01 B→A and D-02 A→B both recorded
  `switch.path {path: "full", reason: "package.json dependencies differ"}`,
  launched `chat` and `vite`, got a new pid (48, 51) and ended with the right
  preview, marker, sessions and selection. After removing it the next switch was
  retained again.
- **Failure after the files were replaced.** X-01: `switch.path` was
  `{path: "retained"}` then
  `{path: "full", reason: "retained path failed: injected preview launch failure"}`.
  Stages: `switch.replace-source` 75 ms ok, `switch.resume` failed after 1 ms,
  then `switch.replace` 152 ms and `switch.start` 23.8 s. Operation `ok`, no
  alert, no pending journal, WS-A correct, new pid 54.

## Observations outside the change

- **Request latency doubles and stays doubled.** From U-06 on (16:25:55) the
  database-backed OpenCode requests took 2× as long (model list 95 → 185 ms,
  session list 270 → 540 ms, session open 620 → 1240 ms; `restore.sessions`
  2.1 → 3.9 s), while Vite start and non-database requests did not change. It
  persisted across four later fresh OpenCode processes, so it is not the retained
  process ageing. At the same operation the kernel's VFS logical size and the
  origin's storage usage grew by 6.0 MB and then stayed flat. Not investigated;
  the global session database growing under repeated delete + re-import is a
  guess.
- **Controlled kernel.** As in live run 4, a kernel created in a service-worker
  controlled page is about 4× slower at everything; the retained path does not
  change that, it only removes the OpenCode boot from it.
- **Session re-import is now the largest part of a switch** and scales with the
  session count (7.5 s for four sessions, 28 s in a controlled kernel).
- The events log rotates at 1 MB keeping one predecessor; a run of this length
  loses its early events unless `events.jsonl.1` is copied in time (done here).

## Not verified

- A retained switch while another session is running, a dead or unhealthy
  OpenCode, or a throwing eligibility check: covered by unit tests of the ordering
  only, not provoked live.
- A failure of `switch.stop-preview` or of the session re-import on the retained
  path (only a preview launch failure was injected live).
- The full path failing after a failed retained path, and the Retry button after
  it: unit test only.
- Whether the retained dependency tree is right when the workspaces' dependencies
  differ: by construction that case takes the full path, and the full path installs
  the same prepared image whatever the workspace's `package.json` says.
- More than one run; n is 1 to 6 per cell.
