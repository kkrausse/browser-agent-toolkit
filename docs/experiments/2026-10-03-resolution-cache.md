# The guest loader remembers module resolutions: Vite preview start 6.5 s → 3.6 s (2026-10-03)

Follows `2026-10-03-startup-breakdown-diesel2.md`, which found that one Vite preview start
in the guest makes about 2,400 module resolutions costing 3.5 s. Same machine and setup
(diesel2, Chrome 154 headed on Xvfb, TODO example on `http://localhost:3100` served from
this worktree with `PORT=3100 bun run editor:debug`, tab visible and focused, kernel
created in an uncontrolled page). The demo on port 3000 was not touched.

## Result in short

1. **A cold open is 3.0 s shorter: fresh 17.4 → 14.4 s, reopen 14.6 → 11.6 s** (untraced,
   n = 5 each, medians; spread under 2%).
2. **All of it is the Vite preview: spawn → application ready 8.7 → 5.9 s fresh and
   6.5 → 3.6 s reopen.** Spawn → listening halves (3.5 → 1.7 s), listening → connected
   drops by 1.0 s, the frame's load by 0.18 s.
3. **Resolution itself: 3.6 s → 0.21 s for the same 2,380 to 2,429 resolutions**
   (instrumented runtime, n = 5 each). The process's synchronous round trips to the kernel
   go from 71,000–76,000 to 20,500–24,700; those made while resolving from 53,600–54,200
   to 3,200–3,300, none of them failing (25,600 failed before).
4. **OpenCode did not move** (spawn → attached 3089 → 3087 ms reopen, 4523 → 4470 fresh).
   It uses the same loader but makes three resolutions; its start is one 27.5 MB bundle.
5. **The filesystem calls were the runtime's, not Vite's.** Of the Vite process's
   synchronous `fs` calls, 81% (32,100 of 39,500) and 84% of their time came from the
   runtime's own resolver: 87% of the `statSync` calls, 97% of the `realpathSync` calls and
   all 814 `package.json` reads. Vite's own code (its resolver, its watcher, plugins) made
   the other 6,750 calls, 0.6 s, and still does.
6. **The cost of one call was not the problem; the number was.** A `stat` round trip is
   24 µs for an existing path and 60 µs for a missing one, the same before and after. No
   batching or kernel-side resolve call was built: nothing is left for one to save.

Runtime fork `kkrausse/vivari`, branch `perf/resolution-cache`, commit `b1abcc1` (pushed;
`main` not moved). Toolkit branch `perf/resolution-cache` (not pushed): trace attribution,
the pin, and this document.

## What was changed

`packages/runtime/module.js` (the guest's CommonJS/ESM loader) now remembers, per process:

- **the names in a directory**, so a path whose name is not listed is known to be missing
  without asking the kernel, and so is everything under a directory that is missing itself
  (this is what removes the 25,600 failed probes: nine extensions, a `package.json` and an
  index at every `node_modules` level);
- **whether a path is a file** (one `stat` per path that exists);
- **a `package.json`'s parsed contents**;
- **a path's real path**, worked out per path component, so a directory is walked once
  where `fs.realpathSync` did a dozen `lstat`s per file every time;
- **what a request resolved to from a directory**, so the 70% of resolutions that are of
  an already loaded module are a map lookup.

Conditions are fixed in this loader (`node`, `require`, `default`, `import`), so the
resolution key is (request, directory). Builtins and `Bun.plugin` hooks are still decided
on every call, before the lookup. Failed resolutions are not remembered. `require.cache`
identity is unchanged: the loader still keys modules by real path, and the resolution
algorithm (exports/imports conditions, self-reference, extension order, `node_modules`
walk) is the same code, only fed from memory.

### The invalidation rule

**Everything remembered is valid for exactly one filesystem epoch.** The kernel's
`FsServer` owns one shared word and replaces it, in the same synchronous step as the
change, whenever anything creates, removes or renames a file, directory or link or writes
a file's contents. The loader reads the word before every use (one atomic load) and drops
all of it when the word moved.

Why this is safe:

- The mutating methods are wrapped **on the VFS instance** (`write_file`,
  `write_file_body`, `mkdir`, `unlink`, `rmdir`, `rename`, `symlink`, `link`, `fd_write`,
  `ftruncate`, and `open` with `O_CREAT` or `O_TRUNC`), not at the call sites. Guest
  syscalls, host writes through the workspace API, the dependency tree install, the
  dependency-cache and OPFS restores and the SQLite image all call that one object, so
  none of them can forget.
- The kernel services every filesystem call on one thread. The epoch is replaced after
  the change and before anything else is answered, so no process can read the new epoch
  and then be shown the old state. Reading the old epoch and then the new state only
  causes a needless drop.
- There is no per-path bookkeeping and no expiry, so there is no path that can be missed:
  an agent's edit, an install, a new file, a changed `package.json`, a retargeted symlink
  all take effect on the next lookup, in every process.
- Only `chmod`/`utimes` do not move the epoch. Resolution reads neither mode nor times.

Nothing is remembered when the kernel publishes no epoch (an embedder with another
filesystem, an older kernel), or **once the guest has replaced an `fs` function the loader
uses** (`statSync`, `lstatSync`, `readdirSync`, `readlinkSync`, `readFileSync`,
`realpathSync`): a tracer, graceful-fs, a virtual filesystem patch. The loader then calls
the guest's functions every time, as before.

The cost of the rule is that any write anywhere drops everything. During a Vite start
that happened 4 times (reopen) and 8 times (fresh, the optimizer writing its cache); the
resolution-heavy phases make no writes. A narrower rule (only names and `package.json`
contents) was considered and not built: it needs the kernel to know whether a write
created the file and whether another hard link names the same inode, and the measured
cost of the simple rule is a few dozen milliseconds.

The epoch word has its own 4-byte `SharedArrayBuffer`, handed to each process in its spawn
spec (as stdio credits already are). The syscall buffer's layout and the distribution ABI
(`workspace-v2-sab6-sqlite39`) are unchanged.

## Before and after

`B` is the pinned runtime before (`f9893bd`), `F` the release build of `b1abcc1`. Median
(min–max), ms.

| fresh | before `B` (n=5) | after `F` (n=5) | change |
|---|---|---|---|
| whole operation | 17367 (17233–17485) | 14397 (14345–14551) | −2970 (−17%) |
| Vite: spawn → application ready | 8728 (8672–8842) | 5867 (5847–5956) | −2861 (−33%) |
| · spawn → listening | 3487 (3393–3582) | 1730 (1717–1753) | −1758 (−50%) |
| · listening → connected | 3047 (2771–3066) | 2044 (2022–2104) | −1003 (−33%) |
| · frame attached → loaded | 2192 (2130–2241) | 2014 (2009–2047) | −178 (−8%) |
| · loaded → application ready | 76 (70–122) | 70 (70–122) | −6 |
| OpenCode: spawn → attached | 4523 (4463–4534) | 4470 (4428–4532) | −53 (−1%) |
| · spawn → listen | 2799 (2759–2830) | 2773 (2746–2814) | −26 |
| · activation | 1430 (1416–1444) | 1427 (349–1441) | −3 |
| delivery | 3547 (3517–3562) | 3510 (3481–3525) | −37 |
| open local workspace | 249 (238–269) | 243 (240–266) | −6 |

| reopen | before `B` (n=5) | after `F` (n=5) | change |
|---|---|---|---|
| whole operation | 14609 (14530–14652) | 11645 (11544–11732) | −2964 (−20%) |
| Vite: spawn → application ready | 6512 (6442–6592) | 3554 (3514–3630) | −2958 (−45%) |
| · spawn → listening | 3553 (3447–3570) | 1743 (1733–1775) | −1810 (−51%) |
| · listening → connected | 2259 (2249–2279) | 1249 (1225–1276) | −1010 (−45%) |
| · frame attached → loaded | 659 (607–681) | 480 (473–516) | −178 (−27%) |
| · loaded → application ready | 73 (70–87) | 70 (69–76) | −2 |
| OpenCode: spawn → attached | 3089 (3064–3129) | 3087 (3036–3101) | −2 |
| · spawn → listen | 1855 (1848–1885) | 1850 (1826–1866) | −5 |
| · activation | 1001 (994–1013) | 1003 (982–1009) | +2 |
| delivery | 3073 (3066–3110) | 3086 (3051–3094) | +13 |
| open local workspace | 1734 (1731–1743) | 1738 (1735–1744) | +4 |

Load average at the end of a sample was 1.5 to 2.7 in both sets. One fresh sample in each
"after" set had the short activation (349 ms) the earlier document describes (the model
list write landing after activation). A second untraced set of the same code before a
comment-only amend (`A`, n = 5 + 5) gave 14360 and 11614 ms.

Instrumented runtime, traced (`?opencodeTrace=1&viteTrace=1`), the Vite preview process.
`I0` is `f9893bd` plus the temporary instrumentation, `I1` the change plus the same
instrumentation. Reopen; fresh is the same within 5% except where noted.

| reopen | before `I0` (n=5) | after `I1` (n=5) |
|---|---|---|
| resolutions (not builtin) | 2380 | 2380 |
| **resolution time** | **3592 (3523–3650)** | **206 (187–240)** |
| · bare specifiers, 360 | 2576 (2544–2665) | 83 (76–98) |
| · relative, 2020 | 163 (159–165) | 53 (46–62) |
| · realpath | 811 (798–885) | 73 (65–80) |
| resolutions of an already loaded module | 1686 | 1686 |
| modules loaded | 697 | 697 |
| read + TS strip + ESM→CJS + compile + module bodies | 910 (883–924) | 863 (828–886) |
| **kernel round trips, whole process** | **70906** | **20466** |
| · time in them | 4193 (4096–4222) | 1845 (1817–1972) |
| · made while resolving | 53575, 2528 ms | 3199, 137 ms |
| · of those, failed | 25574 | 0 |
| · `stat` | 34871 (27283 failed), 2059 ms | 6230 (1318 failed), 248 ms |
| · `lstat` | 29437, 825 ms | 7747, 268 ms |
| · `readdir` | 479, 54 ms | 1208, 73 ms |
| · whole-file reads | 1779, 125 ms | 1132, 127 ms |
| resolutions answered from memory / looked up | | 1489 / 907 |
| times the memory was dropped | | 4 |
| fresh: resolution time | 3619 (3565–3668) | 224 (220–297) |
| fresh: kernel round trips | 75654 | 24665 |
| fresh: times the memory was dropped | | 8 |
| OpenCode process: resolutions / round trips while resolving | 3 / 89 | 3 / 37 |
| OpenCode process: kernel round trips | 2930 (2895–2970) | 2885 (2816–2969) |

Phases of the preview's start, same runs, reopen (fresh differs only by the optimizer):

| reopen | before `I0` | after `I1` |
|---|---|---|
| spawn → guest entry runs | 244 (232–260) | 236 (228–240) |
| Vite CLI and server chunk import | 382 (354–410) | 233 (225–234) |
| `vite.config.ts` and its plugin packages | 2483 (2421–2526) | 583 (561–654) |
| · of it, resolution (1030 resolutions) | 1969 (1925–2019) | 118 (107–149) |
| config loaded → listen call | 820 (762–874) | 720 (699–847) |
| first `GET /` in the guest | 2365 (2341–2394) | 1262 (1214–1321) |
| · of it, resolution (872 resolutions) | 1193 (1157–1224) | 50 (44–56) |
| frame attached → loaded | 668 (603–675) | 490 (468–529) |
| = host spawn → preview ready | 7083 (6978–7163) | 3705 (3636–3759) |

### Whose filesystem calls they were (the open question of the earlier document)

Baseline plus instrumentation, `?viteTrace=fs` (`IF0`, 1 fresh + 2 reopen; counts are
identical between the two reopens). The trace's counters now say whether a call was made
while the runtime's loader was resolving a name, reading a module's source, or neither
(guest JavaScript).

| reopen, Vite process | all | runtime: resolving | runtime: reading source | guest JavaScript |
|---|---|---|---|---|
| synchronous `fs` calls | 39541 | 32098 (81%) | 689 | 6754 |
| time in them, ms | 4332 | 3628 (84%) | 85 | 619 |
| `statSync` | 33348 (26284 failed) | 28894 (25574 failed) | | 4454 |
| `realpathSync` | 2452 | 2390 | | 62 |
| `readFileSync` | 1684 | 814 (`package.json`) | 689 | 181 |
| `lstatSync`, `existsSync`, `readdirSync`, `readlinkSync`, `accessSync` | 2057 | 0 | | 2057 |
| kernel round trips | 71031 | 53575 | 697 | 16759 |

One `realpathSync` is about twelve `lstat` round trips, which is why round trips outnumber
calls. The 16,800 round trips that are not the loader's are unchanged by this work
(16,570 after): Vite's own resolver and watcher, and about 2,600 non-blocking `accept`
polls of the event loop.

## Verification

Offline, in the fork (Node 24.18.0), before (`f9893bd`) and after, same list both times
(`offline-before.txt`, `offline-after2.txt`):

- 15 runtime contracts, one process each: 11 pass, 4 fail (`worker-uncloneable`, `brotli`,
  `shell-quoting`, `process-warning`) before and after: the four the fixes document lists.
- `test-single-kernel`, `-review`, `-close`, `-lifecycle`, `-routing`, `test-sync-capture`,
  `test-kernel-fs-completion`, `test-kernel-fetch-join`, `test-endpoint-cleanup`,
  `test-process-egress-cleanup`, `test-sqlite-persist`, `test-module-plan-cache`,
  `verify-node`, `spike-compress`, `install-tree.test`, `spike-esm`, `spike-cmd-shim`,
  `spike-fs-errors`, `spike-fs-metadata`, `spike-fs-cp`, core `tsc --noEmit`: pass before
  and after.
- `spike-bun-offline` (known), `spike-node-cli` and `spike-dotenv` fail before and after,
  identically.
- New: `scripts/test-resolution-memo.mjs` (`test:resolution-memo`), a real kernel and
  guest worker. It holds the rule: a change by the guest, by the host through the kernel,
  or by a direct VFS writer is seen by the next resolution (new file, a `.js` shadowing a
  remembered `.json`, a nearer package installed and removed, `package.json` created,
  rewritten and edited through an open descriptor, rename, unlink, a retargeted directory
  symlink with `require.cache` identity by real path); **a write made underneath the
  wrapper is not seen until the epoch moves**, which is what shows the memory is in use
  at all; a guest that replaces `fs.statSync` sees even that write at once; and the epoch
  moves for exactly the mutating operations and never becomes 0.

Toolkit suites on this branch: `workspace-api` 96 pass; `vivari` 4 pass; `examples/todo-app`
182 pass, 17 skip, 2 fail, 1 error (as the fixes document records); `opencode-chat` 154 pass,
2 skip, 3 fail, 1 error. The third `opencode-chat` failure (`javascript.test.ts`, "fresh
modules support relative imports…") runs host Bun, not the guest runtime, and fails the
same way with this branch's changes stashed.

Live in Chrome, release build of `b1abcc1`:

- The editor opened and the preview rendered in all 15 opens of that build (and the 10 of
  `A` and 10 of `I1`, the same code).
- A chat prompt answered ("PONG"), on `A` and on `F`.
- The agent created `src/agent-label.ts` and edited `src/home.tsx` to import it; the
  preview showed "Todos agent-file" 21 s after the prompt (`A`: 23 s). These are writes
  from the guest OpenCode process, seen by the Vite process.
- Host edits through the workspace API (`live-check.sh`, `v4-live.js`): an edit to
  `src/home.tsx` reached the preview in about 0.1 s; a file that did not exist was created
  and imported; **a package that did not exist when the preview process started** was
  written into `node_modules` and imported by `root.tsx`, and the server-rendered shell
  contained its value, which is the runtime loader of the long-lived Vite process
  resolving through a `node_modules` listing it had remembered before the package existed.
  This passed in every run (4 on the change, 4 on the baseline).

### A flake that exists before and after: edits written back to back

When a file is created and `home.tsx` rewritten **within about 100 ms of the previous hot
update**, the preview sometimes stays on the previous content until the next write to the
file. This happens on the baseline too, and the next write always recovered it (51 of 51).

| new file + edit, repeated in one open editor | baseline `f9893bd` | change `b1abcc1` |
|---|---|---|
| 400 ms after the previous update | 12 / 12 | 12 / 12 |
| 200 ms after | | 40 / 40 |
| 100 ms after | | 38 / 40 |
| immediately after | 57 / 60, then 29 / 40 with response capture | 35 / 42, then 52 / 80 with response capture |

With responses captured, all 11 baseline failures and 21 of the 28 on the change were the
frame fetching the new module and still showing the old heading (client-side, overlapping
hot updates). The other 7 on the change were a hot update that served the previous content
and no later update for the file; that kind did not occur in the baseline's 40 captured
trials. It was not seen at 100 ms or more. Vite's bundled chokidar drops a second `change`
for a path within 50 ms of the previous one, and with resolution out of the way the
preview answers a change sooner (median 110 ms against 161 ms over 12 paced trials each),
so a writer that waits only for the update lands in that window more often; that this is
the cause was not established. The same
overlap is why the first of the `v4-live.js` steps that follows another at once timed out
in 1 of 4 runs on the baseline and 2 of 4 on the change.

## What behaves differently

- **`?viteTrace=fs` now turns the memory off in the traced process**, because its counters
  replace `fs` functions the loader uses. Its numbers are therefore the uncached ones. The
  after-numbers above come from `?viteTrace=1` and the temporary instrumentation's count
  of kernel round trips instead.
- A relative directory given to `require.resolve(request, { paths })` is made absolute
  against the cwd before resolving (it was resolved against the cwd one probe at a time,
  to the same files).
- Any write anywhere in the VFS (another process's log line, a SQLite commit) makes the
  next resolution in every process start from an empty memory. It is then as slow as
  before, not slower: nothing got slower in any measured stage.
- The preview answers a file change sooner (median 110 ms against 161 ms, 12 paced trials
  each), and edits written within 100 ms of the previous update fail to show more often
  than before (section above).

## Not done, not verified

- Vite's own resolver and watcher (6,750 calls, 0.6 s, 16,800 kernel round trips) are
  guest JavaScript and unchanged. A `stat` memory under the same epoch at the `fs` binding
  would reach them, but `stat` results carry sizes and times, so it would need its own
  argument; not attempted.
- No negative resolution memory, no narrower epoch (names and `package.json` only), no
  kernel-side resolve call: the measurement did not call for them.
- A workspace switch, a controlled (service-worker) kernel, another browser or machine.
- `npm install`/`bun install` inside the guest while a dev server runs (only the offline
  test's install-like sequence and the live single-package write).
- Guests that patch `fs` globally: only that the memory is off (offline test). Their speed
  is the old speed.
- The epoch wrapping to 1 after 2^31 changes is tested; a process that sleeps through
  exactly 2^31 − 1 changes and compares equal is not guarded against.
- The cause of the back-to-back edit flake, on either build.
- Whether the extra failure kind in back-to-back edits is only timing. An agent's edits
  are seconds apart; a script writing files in a tight loop is the case to watch.

## Reproduce

```sh
cd /home/kkrausse/devfs/repos/kkrausse/bat-startup-measure          # branch perf/resolution-cache
(cd vendor/vivari && node scripts/test-resolution-memo.mjs)          # the rule
bun vivari/scripts/build-runtime.ts --release && bun run build:example
cd examples/todo-app && PORT=3100 bun run editor:debug
```

Evidence (gitignored): `.diagnostics/resolution-cache-2026-10-03/` in this worktree. The
drivers are the earlier run's, plus `rebuild.sh`, `offline.sh`, `live-check.sh`,
`v4-live.js` (host edits), `v5-chat.js`, `v6-newfile.js` (back-to-back trials),
`compare.py`, `split.py`, `classify.py`, and `instrument.py` (the temporary runtime
instrumentation: never committed, reverted with `git checkout -- packages`; it now also
counts every kernel round trip and marks the ones made while resolving). Sample prefixes:
`B`/`F` untraced before/after, `A` an earlier untraced after, `I0`/`I1` instrumented
before/after, `IF0` baseline with `?viteTrace=fs`. Tables: `table-compare-untraced.md`,
`table-compare-instrumented.md`, `table-vite.md`, `table-stages.md`.
