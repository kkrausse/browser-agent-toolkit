# Editor startup on diesel2: what was measured, fixed and left (2026-10-03)

One document for the whole day's startup work on the TODO example. It gathers the
results of four detailed write-ups and says where their evidence now lives. Read this
first; go to a detail document for raw tables and method.

| Detail document | What it holds |
| --- | --- |
| `2026-10-03-startup-breakdown-diesel2.md` | Where a cold open's time goes, before any fix |
| `2026-10-03-resolution-cache.md` | The runtime's module resolution memory and its invalidation rule |
| `2026-10-03-startup-fixes.md` | The four toolkit fixes, their safety arguments and off-switches |
| `2026-10-03-startup-combined.md` | Everything together, verified live; start order; switches; two runtime faults |

All numbers are from headed Chrome 154 on Xvfb on diesel2, tab visible and focused,
page not service-worker controlled, medians of n = 5 unless said. The runtime runs in
the visiting browser, so these are diesel2's numbers, not those of another device
opening the tailnet URL.

## Result

| Whole "Open editor" operation | Baseline | Resolution cache alone | All fixes |
| --- | --- | --- | --- |
| Fresh | 17.4 s | 14.4 s | 9.0 s (8961–9025 ms) |
| Reopen | 14.6 s | 11.6 s | 7.2 s (7172–7299 ms) |

Workspace switch, first measured on diesel2 with all fixes (n = 20 each): 4.9 s on the
retained path (OpenCode keeps running), 7.8 s on the full path.

State: fork `kkrausse/vivari` `main` is `6c1759a` (pushed); toolkit `main` carries the
pin and every change below (not pushed to GitHub).

## Where the time went before (baseline, median ms)

| | Fresh | Reopen |
| --- | --- | --- |
| **Whole operation** | **17240** | **14501** |
| Vite preview, spawn → app ready | 8875 | 6462 |
| · `vite.config.ts` and plugin packages (79% module resolution) | 2234 | 2215 |
| · plugin setup until listen | 824 | 799 |
| · first `GET /`, the server-rendered shell | 2215 | 2289 |
| · frame load (fresh includes the optimizer's second run) | 2231 | 653 |
| Delivery of 10,534 files | 3501 | 3062 |
| · verify each file (inflate + SHA-256) | 1620 | 1600 |
| · write the tree into the VFS | 1040 | 1040 |
| OpenCode, spawn → attached | 4484 | 3093 |
| · bundle load (read / plan / compile / evaluation) | 2589 | 1653 |
| · activation (model list 837 / 559) | 1436 | 996 |
| Open workspace (reopen: OPFS restore 1560) | 240 | 1735 |

Findings about the environment:

- **diesel2 is a uniform 2.0–2.4× the Mac** in every part of an OpenCode reopen (3093
  against 1476 ms spawn → attached). Nothing machine-specific was found; the earlier
  SQLite and module-plan fixes behave the same here.
- **A service-worker-controlled page was not slower here** (reopen 15.9 s controlled,
  n = 4, against 14.9 s uncontrolled, both traced). The Mac's 4–5× did not reproduce.
- The demo's event log holds two speed regimes, one 2.5–3× faster in every stage. The
  fast samples are most likely another device using the tailnet URL; the log does not
  record the client, so this is inferred.

## What was changed, and what each change bought

| Change | Where | Gain (measured live) | Off-switch |
| --- | --- | --- | --- |
| Module resolution remembered per process | fork `packages/runtime/module.js`, `FsServer` epoch | about 3.0 s on every open, all in Vite | none (disabled when the guest patches `fs`, e.g. `?viteTrace=fs`) |
| OpenCode starts when the preview listens ("overlap") | `examples/todo-app/src/start-editor.ts` | 2.7 s fresh, 1.4 s reopen, 1.8 s full switch, against serial | `?startup=serial`, `?startup=parallel` |
| Per-file verification skipped after the image digest passed | `workspace-api` delivery, fork `install-tree.js` | 1.54 s on every open | `?deliveryVerify=files` |
| Delivered trees leave the OPFS mirror | fork `install-tree.js`, `opfs-persistence.js` | 1.08 s of restore from the second reopen | `?managedPersist=1` |
| Guest optimizer includes the four missed packages | `examples/todo-app/vite.config.ts` | about 1.0 s, fresh open only | source change |

### Resolution cache

- One preview start made 2,429 resolutions costing about 3.6 s; reading, transpiling,
  compiling and running the 697 modules cost 0.9 s. 81% of the Vite process's
  synchronous filesystem calls came from the runtime's own resolver, not Vite's.
- After: resolution time 3619 → 224 ms (fresh), 3592 → 206 ms (reopen); kernel round
  trips for the process 75,654 → 24,665 and 70,906 → 20,466; failed probes 25,638 → 0.
- A `stat` round trip is 24 µs (60 µs for a missing path) before and after, so per-call
  cost was not the problem and nothing was batched.
- **Invalidation rule.** Everything remembered (directory listings, file-ness, parsed
  `package.json`, real paths, resolved request/directory pairs) is valid for one
  filesystem epoch: a shared word the kernel's `FsServer` replaces, in the same
  synchronous step as the change, whenever anything creates, removes, renames or writes.
  The loader reads it before every use and drops everything when it moved. `chmod` and
  `utimes` do not move it. Failed resolutions are not remembered.
- OpenCode did not move (3 resolutions).

### Start order

| Whole operation, median ms | Serial | Overlap (default) | Parallel |
| --- | --- | --- | --- |
| Fresh (n = 5) | 11655 | 8967 | 8604 |
| Reopen (n = 5) | 8773 | 7340 | 6860 |
| Full switch | 9594 (n = 6) | 7768 (n = 20) | 7661 (n = 20) |
| Vite spawn → listening | 1.6 s | 1.6 s | 2.0 s |

Startup had been parallel until `98c91a6` (2026-09-30), when a workspace switch twice
left Vite silent for its 30 s listen budget while chat started; the cause was never
found. Overlap keeps Vite alone until it listens. That failure did not occur in any
order here: 66 switches and 69 cold opens, slowest Vite listen 2.1 s. Twenty clean runs
still allow a true failure rate of roughly 14%, and the original was seen on the Mac,
so overlap stays the default.

### Delivery verification

The image digest is checked at acquire on both the cache hit and the download. The
manifest is the single source of the image digest and the per-file digests, and the
image is built from the same asset list, so hashing each file again was redundant. The
bundle path (no image) still hashes every file.

### OPFS mirror

38 of the 50 MB restored on a reopen was `/app` (the 27.7 MB OpenCode bundle plus wasm)
and the Tailwind archive, which delivery rewrote right after. Those roots are no longer
mirrored. An existing origin cleans itself on its first open (50 MB → 12.6 MB). Source,
sessions under `/workspace/.server`, Vite's cache and the module-plan file survive a
reload without Exit.

## Two runtime faults found on the way, both fixed

- **A lost file-watch event (`b47e10f`).** The guest event loop ran due timers at the
  start of a turn and delivered watch events at the end. After a 120–135 ms transform
  for the previous edit, the next write's event reached chokidar while its expired 50 ms
  throttle entry still stood, and chokidar dropped it. All 4 lost events arrived with
  timers 93–122 ms overdue (the commit message says 95–170 ms; the measured range is
  this one). "Change never served": 4 of 40 before, 0 of 160 after. The baseline loop
  had the same fault; the resolution cache only made it likelier by changing timing.
- **An origin that could not open again (`6c1759a`).** A tab reloaded within about
  15 ms of the first `persist: false` delivery finishing, on an origin with the old
  38 MB mirror, made every later open fail with `OPFS restore failed … NotFoundError`
  (shown as "already open in another tab"). Provoked on the first try. Restore now
  treats a listed-but-missing file as an interrupted delete, forgets it and boots; the
  broken origin opened again with its source.

## Also landed the same day

- A workspace created by an older editor build no longer forces a full switch
  (`5d7490a`): the retained switch compared build-stamped files byte for byte, so a
  script edit in the todo app's `package.json` made old and new workspaces mismatch.
- An editor chat with no session opens on a new one (`9eb6b93`), so the prompt box works
  without first choosing New session. Checked live on a new workspace.
- Opt-in tracing: `?viteTrace=1`, `?viteTrace=fs` (the latter disables the resolution
  memory in the traced process, so it reports uncached numbers).

## What is left

Costs still in a 7.2 s reopen (combined build, median ms): Vite spawn → app ready 3911,
OpenCode spawn → attached 3253 (overlapping), delivery 1532 (install 1093), OPFS
restore 484.

- **OpenCode's bundle read, compile and evaluation** (about 0.5 / 0.4 / 0.7 s) look
  inherent on this CPU.
- **Model list in OpenCode's database**, 0.56 s reopen / 0.84 s fresh. Needs a rebuild
  of the pinned server artifact. Deliberately set aside.
- **A switch drops `.browser-editor-cache`**, so the optimizer reruns on every switch;
  keeping it would save roughly 1.2 s. Inferred from code, not measured.
- **Vite still restarts on a retained switch**, and session re-import scales with the
  session count.
- **Vite's own resolver and watcher**: about 16,800 kernel round trips, 0.6 s, unchanged.
- **An agent-installed dependency still forces a full switch**, because delivery lays
  down all managed roots as one unit; a per-root delivery would let OpenCode keep
  running. An agent-installed package also does not survive a switch at all, since saved
  workspaces do not include `node_modules`.
- **Client-side hot-update race**: with no spacing between edits the frame fetches the
  new module and keeps the old DOM, 20 of 160; 0 of 80 at 100 ms or more. The baseline
  had it at 11 of 40. The next write always recovers it. Not investigated.

Not checked: a service-worker-controlled kernel with the fixes; another browser or
machine; agent (guest) edits beyond four successful ones (the edit trials wrote from the
host); `bun run verify` in the fork; a real package install in the guest while the dev
server runs. Per-fix gains are differences between sets taken over one evening at load
average 1.7–4.6.

## Tests against the known baseline

No new failures. Toolkit: workspace-api 97 pass; opencode-chat 154 pass, 3 fail,
1 error; todo-app 191 pass, 1 fail (the XFS `readdirSync` order); vivari 4 pass;
typecheck 23 errors, all under `experiments/` and test drivers. One opencode-chat
failure is not in the 10-02 handoff's list (`test/javascript.test.ts`, "fresh modules
support relative imports…"); it fails identically without any of this work.

## Evidence

Gitignored, gathered into the main checkout
(`/home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit/.diagnostics/`). The detail
documents cite these directories relative to the worktrees they were written in
(`bat-startup-measure`, `bat-startup-combined`); the copies below are complete.

| Directory | From | Holds |
| --- | --- | --- |
| `startup-breakdown-2026-10-03/` | baseline measurement | drivers, per-sample JSON, the runtime instrumentation patch (`builds/instrumentation.diff`, `instrument.py`) |
| `resolution-cache-2026-10-03/` | resolution cache | before/after samples, fs attribution, edit-spacing trials |
| `startup-combined-2026-10-03/` | combined pass | start-order sets, switch runs, mid-open reloads, the watcher trace, `table-final.md`, `table-order.md` |
| `editor-events-2026-10-03/` | the servers' event logs | `demo-before-fixes` (the demo, including the two speed regimes and the 17:54Z full switches), `measure-worktree`, `combined-and-demo-after-fixes` |

## Reproduce

```sh
cd /home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit
bun run setup
bun run build:example      # the example consumes built packages; a package edit needs this
cd examples/todo-app && PORT=3100 bun run editor:debug
# ?startup=serial|parallel  ?deliveryVerify=files  ?managedPersist=1  ?workspaceSwitch=full
# ?viteTrace=1|fs  ?opencodeTrace=1
```
