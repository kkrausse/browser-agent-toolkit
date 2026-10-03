# Resolution cache and the four startup fixes together: cold open 17.4 s → 9.0 s fresh, 14.6 s → 7.2 s reopen (2026-10-03)

Integrates `perf/resolution-cache` (`2026-10-03-resolution-cache.md`) and
`perf/startup-fixes` (`2026-10-03-startup-fixes.md`), runs the fixes' live checklist in
Chrome, measures the result with the baseline's method
(`2026-10-03-startup-breakdown-diesel2.md`), and fixes two faults found on the way.

Same machine and setup as the earlier documents: diesel2, Chrome 154 headed on Xvfb, TODO
example on `http://localhost:3100` served from this worktree with
`PORT=3100 bun run editor:debug`, tab visible and focused, kernel created in an
uncontrolled page (`navigator.serviceWorker.controller` null and `hiddenMs` 0 in all 69
measured opens). The demo on port 3000 and the two source worktrees were not touched.

- Worktree `/home/kkrausse/devfs/repos/kkrausse/bat-startup-combined`, toolkit branch
  `perf/startup-combined` (not pushed).
- Runtime fork `kkrausse/vivari`, branch `perf/startup-combined` (pushed, `main` not
  moved), pinned at `6c1759a`:
  - `31c6a89` merge of `perf/resolution-cache` (`b1abcc1`) and `perf/startup-fixes`
    (`484b770`), no conflicts;
  - `b47e10f` event loop: timers that came due run before file-watch events (new);
  - `6c1759a` OPFS restore finishes an interrupted delete instead of failing the boot (new).

## Result in short

1. **A cold open is 9.0 s fresh and 7.2 s reopen** (8961–9025 and 7172–7299, n = 5 each,
   untraced), against 17.4 / 14.6 s for the baseline and 14.4 / 11.6 s for the resolution
   cache alone. That is −48% and −50% against the baseline.
2. **Every fix shows its gain live, and each off-switch brings its cost back.** Per-file
   verification −1.54 s per open; delivered trees out of the mirror −1.08 s of restore on
   a reopen (plus about 0.3 s of service start); the optimizer list −1.0 s on a fresh
   open; overlap start −2.7 s fresh and −1.4 s reopen against serial.
3. **Start order: overlap stays the default.** Parallel is another 0.36 s (fresh) and
   0.48 s (reopen) faster and 0.1 s on a full switch, and it makes Vite's listen 0.37 s
   slower in every sample. The 2026-09-30 failure (Vite silent for its 30 s listen budget)
   did not occur in any order: 66 switches and 69 cold opens, slowest Vite listen 2.1 s.
4. **A workspace switch on diesel2 is 7.8 s full and 4.9 s retained** (n = 20 each).
5. **The back-to-back edit regression is found and fixed in the runtime.** The guest's
   event loop delivered a file-watch event ahead of timers that were already due, so
   chokidar's expired 50 ms throttle still stood and dropped the change. "Change never
   served": 4 of 40 before, 0 of 160 after. The other failure kind (the frame fetches the
   new module and keeps the old DOM) is client-side, exists on the baseline, and is
   unchanged: 20 of 160 with no spacing, 0 of 80 at 100 ms or more.
6. **The OPFS restore failure the fixes document warned about was provoked on the first
   try, and it leaves the origin unable to open at all.** A tab reloaded as the first
   `persist: false` delivery finished, on an origin with the old 38 MB mirror, made every
   later open fail. Fixed in the fork's restore; the origin that had been broken opened
   again with its source.

## Before and after

`baseline` is the pinned runtime `f9893bd` (set `B` of the resolution-cache campaign;
the first measurement's own set gave 17240 / 14501), `cache` is `b1abcc1` alone (set `F`),
`combined` is this branch at fork `b47e10f`, default flags (set `R`). Median (min–max),
ms, untraced. Three more opens of each kind on the final pin `6c1759a` (set `W`) gave
9090 (9088–9252) and 7328 (7231–7533), at a load average of 3 to 4.

| fresh | baseline (n=5) | cache (n=5) | combined (n=5) |
|---|---|---|---|
| **whole operation** | **17367 (17233–17485)** | **14397 (14345–14551)** | **8969 (8961–9025)** |
| step: start preview and OpenCode | 13304 (13178–13410) | 10392 (10295–10543) | 6525 (6513–6540) |
| Vite: spawn → application ready | 8729 (8672–8842) | 5867 (5848–5957) | 5553 (5516–5606) |
| · spawn → listening | 3487 (3393–3582) | 1730 (1717–1753) | 1666 (1629–1692) |
| · listening → connected | 3047 (2771–3066) | 2044 (2022–2104) | 3162 (2873–3204) |
| · frame attached → loaded | 2192 (2130–2241) | 2014 (2009–2047) | 628 (567–834) |
| · loaded → application ready | 76 (70–122) | 70 (70–122) | 130 (130–135) |
| OpenCode: spawn → attached | 4523 (4463–4534) | 4470 (4428–4532) | 4841 (4827–4876) |
| · spawn → listen | 2799 (2759–2830) | 2773 (2746–2814) | 2934 (2861–2962) |
| · activation | 1430 (1416–1444) | 1427 (349–1441) | 1517 (1511–1532) |
| OpenCode spawned this long after Vite | 8741 | 5880 | 1680 |
| delivery | 3547 (3517–3562) | 3510 (3481–3525) | 1928 (1904–1978) |
| · acquire / gunzip | 567 / 255 | 540 / 249 | 520 / 241 |
| · install (verify + write) | 2659 (2616–2665) | 2642 (2637–2665) | 1095 (1095–1103) |
| open local workspace | 249 (238–269) | 243 (240–266) | 250 (235–274) |
| prepared manifest; source and config | 108; 96 | 104; 96 | 111; 97 |
| click → operation start (not in the operation) | 327 | 326 | 321 |
| load average (1 min) at end | 2.25 | 2.29 | 2.79 |

| reopen | baseline (n=5) | cache (n=5) | combined (n=5) |
|---|---|---|---|
| **whole operation** | **14609 (14530–14652)** | **11645 (11544–11732)** | **7232 (7172–7299)** |
| step: start preview and OpenCode | 9659 (9545–9682) | 6664 (6566–6755) | 4868 (4845–4935) |
| Vite: spawn → application ready | 6513 (6442–6593) | 3555 (3514–3630) | 3911 (3874–3984) |
| · spawn → listening | 3553 (3447–3570) | 1743 (1733–1775) | 1611 (1574–1637) |
| · listening → connected | 2259 (2249–2279) | 1249 (1225–1276) | 1605 (1545–1611) |
| · frame attached → loaded | 659 (607–681) | 480 (473–516) | 633 (617–648) |
| · loaded → application ready | 73 (70–87) | 70 (69–76) | 79 (76–154) |
| OpenCode: spawn → attached | 3089 (3064–3129) | 3087 (3036–3101) | 3253 (3229–3288) |
| · spawn → listen | 1855 (1848–1885) | 1850 (1826–1866) | 1907 (1902–1948) |
| · activation | 1001 (994–1013) | 1003 (982–1009) | 997 (984–1022) |
| OpenCode spawned this long after Vite | 6530 | 3567 | 1623 |
| delivery | 3073 (3066–3110) | 3086 (3051–3094) | 1532 (1527–1538) |
| · acquire / gunzip | 127 / 257 | 127 / 255 | 130 / 248 |
| · install (verify + write) | 2628 (2607–2658) | 2633 (2581–2656) | 1093 (1086–1100) |
| open local workspace | 1734 (1731–1743) | 1738 (1735–1744) | 678 (644–685) |
| · OPFS restore | 1559 (1553–1565) | 1559 (1556–1564) | 484 (460–495) |
| prepared manifest; source and config | 105; 22 | 107; 22 | 108; 27 |
| click → operation start | 326 | 322 | 321 |
| load average (1 min) at end | 1.84 | 1.68 | 2.58 |

What got slower, plainly:

- **Vite and OpenCode each run slower when they overlap.** Against the serial order on
  the same build, Vite's spawn → application ready is +0.70 s fresh (4846 → 5548) and
  +0.56 s reopen (3449 → 4007); OpenCode's spawn → attached is +0.56 s fresh and +0.38 s
  reopen. OpenCode starts 3.2 s (fresh) and 1.8 s (reopen) earlier, so the open is still
  2.7 / 1.4 s shorter. This is the shared kernel thread the fixes document asked about.
- **Fresh, listening → connected is 1.1 s longer than with the cache alone** (2044 →
  3162): 0.5 s is the optimizer's one run now bundling 11 entries instead of 7 (serial
  order: 2523), the rest is the overlap. The frame's load is 1.4 s shorter in exchange.
- **Fresh, loaded → application ready is 130 ms, was 70** (in all three orders). Small;
  cause not looked at.

## Each fix, live

| fix | verified live | measured gain | with the off-switch | problem |
|---|---|---|---|---|
| 1. no per-file hashing after the image digest | yes | install 2633 → 1093 ms on every open (−1.54 s); `verifyMs` 21–36 ms, `perFileVerify: false` | `?deliveryVerify=files`: `perFileVerify: true`, `verifyMs` 1586–1644, reopen 8883 (n=3), fresh 10662 (n=1) | none |
| 2. OpenCode starts when the preview listens | yes | against `?startup=serial`: −2.69 s fresh, −1.43 s reopen, −1.83 s full switch | `?startup=serial` 11655 / 8773; `?startup=parallel` 8604 / 6860 | none seen; see start order |
| 3. delivered trees leave the OPFS mirror | yes | restore 1559 → 484 ms (−1.08 s) from the second reopen; the first open on an existing origin is unchanged and cleans up | `?managedPersist=1`: `mirrored: true`, restore 1559 again from the second reopen, reopen 8637 (median of 4, the first of which still restores 12 MB); the service step is also 0.33 s slower while 38 MB is written back | **the cleanup's delete window can break the origin** (below); fixed |
| 4. guest `optimizeDeps.include` | yes | fresh only: Vite spawn → application ready 5867 → 4846 ms in serial order (−1.0 s): frame load −1.49 s, listening → connected +0.48 s | source change, no flag | none |
| resolution cache | yes (as before) | unchanged from its own document: spawn → listening 1.7 s against 3.5 s | — | the edit flake; fixed below |

Details of the checks:

- **Editor, preview, chat, agent edit**, on a fresh open and on a reopen, on the merge
  build and again on the final pin: a prompt answered "PONG" (2.3 to 7.4 s); the agent
  created `src/agent-label.ts` and edited `src/home.tsx`, and the preview showed "Todos
  agent-file" 15.8 s (merge build) and 11.5 s (final) after the prompt; after Exit and
  reopen the session and the edit were there and a second agent edit reached the preview
  in 5.1 s.
- **Delivery.** `delivery.install.ready` reports `perFileVerify: false`, `verifyMs` 21 to
  36, `installMs` 1028 to 1085 (was 1040). `mirrored` follows `?managedPersist`.
- **OPFS, existing origin.** The origin held the resolution-cache runs' state: 50.2 MB,
  `/vv-vfs/files/app` 31.0 MB. First open: restore 1698 ms as before, and afterwards the
  census is 12.6 MB with no `/app` and no `.browser-editor-backends`. Second reopen:
  restore 652 ms traced, 484 ms untraced median. So restore time does follow bytes: 38 MB
  less is 1.08 s less.
- **What must survive, does.** After the cleanup and after a reload **without Exit**:
  workspace source (the edited heading), the chat session with its messages
  (`/workspace/.server`), Vite's cache (`Hash is consistent. Skipping.`) and the module
  plan (`/var/lib/vivari/module-plans` still in OPFS; OpenCode's bundle import 1642 to
  1686 ms, the reopen value, against 2968 fresh). "Plan hit" itself is only visible with
  the instrumented runtime, which was not built here.
- **Optimizer.** Fresh open on a new origin, traced: one "Dependencies bundled" line
  (1877 ms while OpenCode starts; 11 optimized entries in `_metadata.json`), no "new
  dependencies found", frame load 740 ms where the reload used to make it 2.2 s. A reopen
  logs `Hash is consistent`.
- **Reload during an open, current layout.** Tab reloaded from inside the page at
  `delivery.acquire.start` + 180 ms, `delivery.install.start` + 0 and + 500 ms,
  `delivery.install.ready` + 0, `service.listen.ready` + 100 ms; the next open booted
  every time (5 of 5, 7.7 to 8.0 s).

### The delete window: provoked, and it was worse than described

The fixes document noted that `restore()` fails the boot if the manifest lists a file
whose bytes are gone, and that the first delivery on an existing origin has that window
once. Recreated the old layout (`?managedPersist=1`, Exit), opened with default flags and
reloaded the tab the moment `delivery.install.ready` was recorded:

- **First attempt:** the next open failed with `OPFS restore failed for
  /app/ffi-rs.darwin-arm64-….node: NotFoundError`, shown to the user as "This workspace
  is already open in another tab or window" (`STORAGE_BUSY`). **So did the next six
  opens**: nothing repairs the manifest, the origin stays unopenable until its storage is
  cleared. OPFS held no `/app` and no backend archive; the manifest still listed 8
  entries under them.
- Repeated after the fix (where the restore reports what it found): counting the first
  attempt, a reload at +0 to +15 ms left listed-but-missing files in 3 of 4 tries that
  can be judged (+0 once yes and once no, +5, +15; one more +0 run's log was
  overwritten), and at +30, +60, +120, +250 ms in none of 4. The window is a few tens of
  milliseconds after the install answers, when the queued subtree deletes run and the
  manifest has not been rewritten.
- Every existing origin makes that delete on its first open with fix 3. Before fix 3 the
  same window existed on every delivery.

**Fixed in the fork (`6c1759a`).** The write-behind queue writes bytes before the manifest
names a file and removes bytes before the manifest forgets it, so "listed but missing"
can only be a delete that did not finish. `restore()` now forgets such an entry, warns
once, restores everything else and rewrites the manifest; other read errors still fail
the boot. The broken origin opened on the next try (source intact, manifest healed), and
the eight opens of that sweep all booted. `scripts/test-opfs-exclude.mjs` gained that boot
and fails without the change. This goes beyond what was asked; it is its own commit.

Not changed: the host still maps a restore failure to "open in another tab".

## Start order

Interleaved A/B/C on the merge build (`31c6a89`), n = 5 per cell, untraced, all 30 opens
usable. Median (min–max), ms.

| | serial `?startup=serial` | overlap (default) | parallel `?startup=parallel` |
|---|---|---|---|
| **fresh, whole operation** | 11655 (11629–11831) | 8967 (8887–9203) | 8604 (8592–8711) |
| · Vite spawn → listening | 1656 (1605–1666) | 1641 (1592–1665) | 2006 (1961–2052) |
| · Vite spawn → application ready | 4846 (4801–4979) | 5548 (5518–5603) | 6110 (6076–6243) |
| · OpenCode spawn → attached | 4315 (4308–4346) | 4877 (4823–4994) | 5329 (5263–5408) |
| **reopen, whole operation** | 8773 (8652–8914) | 7340 (7161–7365) | 6860 (6812–6910) |
| · Vite spawn → listening | 1592 (1550–1669) | 1631 (1596–1668) | 2013 (1959–2026) |
| · Vite spawn → application ready | 3449 (3345–3483) | 4007 (3872–4019) | 4473 (4462–4559) |
| · OpenCode spawn → attached | 2942 (2926–2943) | 3318 (3184–3378) | 3444 (3392–3467) |

`editor.startup-order` reported the order in every open; under overlap `service.launch`
for `chat` follows `service.listen.ready` for `vite` by 13 ms.

Workspace switches on the final-but-one build (`b47e10f`), one editor session per row,
alternating between two saved workspaces. Every switch ended usable with no alert and no
failed stage.

| | n | ok | whole switch | Vite spawn → listening (max) | Vite listening → connected | OpenCode spawn → listen |
|---|---|---|---|---|---|---|
| overlap, full (`?workspaceSwitch=full`) | 20 | 20 | 7768 (7483–8358) | 1627 (1881) | 3485 | 1932 |
| overlap, retained (default) | 20 | 20 | 4899 (4797–5415) | 1504 (1670) | 2481 | kept running |
| parallel, full | 20 | 20 | 7661 (7543–7809) | 1995 (2092) | 3044 | 2086 |
| serial, full | 6 | 6 | 9594 (9508–9694) | 1647 (1691) | 2518 | 1704 |

"New workspace" (one each): 7.9 s full overlap, 5.1 s retained, 7.9 s parallel, 9.9 s
serial. Load average was 1.8 to 4.6 during these runs (other sessions on the machine).

**Recommendation: keep overlap as the default.**

- Measured: overlap takes 88% (fresh) and 75% (reopen) of what parallel takes off a cold
  open, and 94% on a full switch. Parallel's remaining 0.1 to 0.5 s costs Vite 0.37 s more before it listens,
  every time, which is the phase whose budget ran out on 2026-09-30. Under overlap Vite
  reaches its listener exactly as fast as under serial.
- Measured: no order failed here. Slowest Vite listen in any of 66 switches and 69 cold
  opens was 2.1 s against a 30 s budget.
- Inferred: 20 clean parallel switches do not show parallel is safe. With 0 failures in
  20 a true failure rate up to about 14% is still compatible, the original cause was
  never established, and it was seen on another machine. Overlap removes the competition
  in the phase that failed; parallel's safety rests only on not having seen it again.
- If the 0.4 s matters later, parallel should first get a few hundred switches on the
  Mac, where the failure happened.

## Workspace switch timing

First measurement on diesel2 (table above): **retained 4.9 s, full 7.8 s** (medians,
n = 20 each, default overlap order). A full switch is close to a reopen's service step
plus delivery; a retained one is only the preview.

In both kinds Vite's listening → connected is 2.5 s (3.5 s with OpenCode starting beside
it), against 1.26 s on a reopen in serial order. Read from the code, not measured: a
switch replaces the workspace source and keeps only `.server`, `node_modules` and
`.browser-editor-backends`, so `.browser-editor-cache` (Vite's optimizer cache) is
dropped and every switch pays the optimizer's run again. Keeping it across a switch when
the dependencies match would be worth roughly 1.2 s per switch (inferred).

## The back-to-back edit flake

**Cause, measured.** The trace entry was extended for this (temporary, not committed;
`builds/hmr-trace.diff`) to record, in the guest Vite process, every raw `fs.watch`
event under `src/`, every read of `home.tsx`, Vite's `vite:hmr` lines, and at each of
them how overdue the process's 50 ms lag timer was. 40 trials with no spacing on the
merge build: 7 failures, of two kinds.

- **4 × the change was never served.** The raw `change` event for `home.tsx` arrived, no
  `[file change] src/home.tsx` followed, nothing was read. In all four the event was
  delivered while timers were 93 to 122 ms overdue. The guest had just spent 120 to
  135 ms in one stretch transforming `style.css` (Tailwind rescans because a file was
  added) for the *previous* edit.
- **3 × the frame fetched the new module and kept the old heading.** Server side
  complete: change seen, file read with the new content, three `hot updated:
  /src/home.tsx` lines in the frame's console.

Why the first kind happens: chokidar, bundled in Vite, suppresses a path's repeated
events with timers (5 ms per raw event, 50 ms per emitted `change`) and never emits a
suppressed event later. The guest's loop (`packages/runtime/loop.js`, `drive()`) ran due
timers once per turn, at its start, and drained file-watch events at its end. A turn
that was busy for longer than 50 ms in between handed chokidar the next write's event
while the throttle entry of the previous change was still standing, although its timer
had expired long before. On Node the timers phase comes before I/O, so the expired timer
always runs first.

So of the three suspects: not a stale read through the loader's memory (the loader holds
no file contents, and every served read had the new content), not the module runner
resolving before the epoch moved, and not chokidar's 50 ms window as such: the writes
were 180 ms apart. It was the runtime letting that window outlive its timer.

Why the resolution cache made it more frequent is **inferred**: the preview shows an
edit sooner, so a writer that waits only for the heading writes again while the
stylesheet transform of the previous edit is still running. The fault is in the loop
either way, and the baseline's loop has it too.

**Fix (`b47e10f`).** `drive()` runs due timers again immediately before the watch drain.
`scripts/test-watch-after-timers.mjs` holds the order against the loop alone and fails on
the old loop. (The commit message says the lost events were 95 to 170 ms overdue; the
measured range is 93 to 122 ms.)

**After, live.** Same trial (create a file, rewrite `home.tsx` to import it, wait for
the heading, repeat at once):

| | trials | change never served | fetched, old DOM | timers overdue at a watch event |
|---|---|---|---|---|
| merge build, traced | 40 | 4 | 3 | up to 149 ms |
| with the fix, traced | 80 | 0 | 11 | 0 at all 136 events |
| final pin, untraced | 80 | 0 | 9 | |
| final pin, 100 ms after the previous update | 40 | 0 | 0 | |
| final pin, 250 ms after | 40 | 0 | 0 | |

Resolution cache alone had 7 "never served" in 80 captured trials; the baseline none in
40.

**What is left.** The second kind is unchanged at about 1 in 8 when the next write lands
within 100 ms of the previous hot update, and was 11 of 40 on the baseline with response
capture. Everything the server does is correct and complete there; the frame applies
three overlapping updates for `home.tsx` and its DOM keeps the previous heading until
the next write (which recovered it every time, 20 of 20). That is in the client's hot
update handling (React Router's dev runtime and React Refresh), not in the runtime or
the toolkit. Not investigated further. Finding it would take recording the frame's
socket messages and the route-module update order in the page.

The trials write from the host. An agent's own edits (guest writes, seconds apart) were
checked only as the three agent edits above, all of which reached the preview.

## Offline

Toolkit suites on this branch: `workspace-api` 97 pass; `opencode-chat` 154 pass, 2 skip,
3 fail, 1 error; `examples/todo-app` 191 pass, 17 skip, 1 fail; `vivari` 4 pass;
typecheck 23 errors. The failures are the ones both documents record (`readiness-lab-bundle`,
`opencode-launch`, `javascript.test.ts`; the XFS `readdirSync` order one). The fixes
document counts `workspace-api` as 102 and the resolution-cache one as 96; here it is 97,
which is the resolution-cache branch's 96 plus the one test the fixes add. The 102 was
not reproduced.

Fork (Node 24.18.0), the resolution-cache document's list plus `test-opfs-exclude` and
the new `test-watch-after-timers`: 35 pass; the same seven fail as before
(`worker-uncloneable`, `brotli`, `shell-quoting`, `process-warning` contracts,
`spike-bun-offline`, `spike-node-cli`, `spike-dotenv`).

Integration check asked for: the `persist: false` install path removes and writes
through `vfs.mkdir`, `rmdir`, `unlink`, `symlink`, `write_file` and `write_file_body` on
`server.vfs`, all of which `FsServer` wraps on that instance, so each moves the
filesystem epoch; `exclude()` touches only the mirror. The OPFS restore writes to the VFS
before `FsServer` is constructed and wraps it, when no process exists and the epoch is
at its initial value, so nothing can have remembered anything.

## Measured, inferred, not checked

Measured: every number in the tables; the off-switch runs; the OPFS censuses and
manifest contents; the lost watch events and their timer lateness; the restore failure
and its repair.

Inferred:

- Why the resolution cache raised the rate of lost changes (timing).
- That parallel start is not shown safe by 20 switches.
- That keeping Vite's cache across a switch would save about 1.2 s.
- Per-fix gains are differences between sets measured at different times of one evening;
  the machine's load varied from 1.7 to 4.6.

Not checked:

- A service-worker-controlled kernel, another browser, another machine (the Mac, where
  the serial order was introduced).
- "Plan hit" by its own counter (needs the instrumented runtime).
- The client-side update race beyond counting it.
- Timers before the other drains of a turn (network requests, child and thread events):
  only the watch drain was changed, because only that was seen to lose something.
- `bun run verify` in the fork.
- A reload during a delete of workspace source (the restore fix covers it by the same
  argument and by the offline test; live only the managed roots were hit).

## Reproduce

```sh
cd /home/kkrausse/devfs/repos/kkrausse/bat-startup-combined      # branch perf/startup-combined
bun run setup
(cd vendor/vivari && node scripts/test-watch-after-timers.mjs && node scripts/test-opfs-exclude.mjs)
cd examples/todo-app && PORT=3100 bun run editor:debug
# flags: ?startup=serial|parallel  ?deliveryVerify=files  ?managedPersist=1  ?workspaceSwitch=full
```

Evidence (gitignored): `.diagnostics/startup-combined-2026-10-03/` in this worktree. The
earlier runs' drivers plus `abc.sh` (start-order sets `S`/`O`/`P`), `switches.sh` and
`sw.py` (`XF`/`XR`/`XP`/`XS`), `midopen.sh` and `31-midopen.js` (reload during an open:
`MO-*` current layout, `ML-*` old layout before the restore fix, `MF-*` after),
`30-reload-noexit.js`, `v7-hmrdump.js` and `hmr.py` (the watcher trace:
`newfile-E0-*` before the loop fix, `E1-*` after, `W-*` final pin), `table.py` and its
outputs `table-final.md`, `table-order.md`, `table-switches-off.md`, `offline.sh`.
Sample prefixes: `M` migration opens, `V` traced checks, `R` final default, `DV`
`?deliveryVerify=files`, `MP` `?managedPersist=1`, `Z` back to default, `W` final pin.
