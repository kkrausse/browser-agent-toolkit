# Runtime fixes for SQLite persistence and module load, measured live (2026-10-01)

Three fixes from `2026-10-01-opencode-startup-sqlite-measurement.md` are implemented in
the runtime fork, pushed, pinned here, and re-measured in Chrome 154 on the same machine
and in the same session as a fresh baseline of the old pin (Apple M4 Pro, 12 cores,
macOS 26.6.2, load average 3.4 to 11 throughout; OpenCode server 2.0.3, model
`muse-spark-1.3`). Every sample was taken with the tab visible (`hiddenMs` 0).

## Result in short

Medians, uncontrolled kernel (U) unless said, old pin `2367a64` against the new pin
`f9893bd`; n in the tables below.

| | old pin | new pin |
|---|---|---|
| Reopen (6.44 MB database), `chat` spawn → attached | 6280 ms | 1476 ms |
| Reopen, guest start → activation answered | 5789 ms | 1378 ms |
| Fresh boot, spawn → attached | 3898 ms | 2155 ms |
| Reopen in a service-worker-controlled kernel, spawn → attached | 25.4 s | 7.5 s |
| Bundle load (reopen / fresh) | 2094 / 2082 ms | 769 / 1264 ms |
| SQLite time to activation answered, reopen | 3411 ms (33 image rewrites) | 352 ms (2) |
| Autocommit statement, median, 6.44 MB | 92.9 ms | 0.26 ms |
| A statement that really writes, 6.44 MB | 88 ms | 14 to 22 ms |
| One-word reply: SQLite time / image rewrites | 5629 ms / 61 | 302 ms / 15 |
| One-tool-call reply: SQLite time / image rewrites | 9208 ms / 102 | 535 ms / 25 |
| `GET /api/session` | 88 to 91 ms | 3 to 4 ms |
| `GET /api/session/:id/message` | 180 ms | 2.4 ms |
| Workspace switch, retained path | 11.1 s | 4.8 s |
| Workspace switch, full path | 18.6 s | 8.0 s |

Durability and correctness checks all pass (section 1): a session and its messages
survive a tab reload without Exit, so do a second session and a rename; a database
written by the old runtime opens with the new one and stays intact after writes;
retained and full switches end in the same sessions, order and selection.

What the model list still costs after the fixes (section 6): about 0.29 s of a 1.48 s
reopen, 0.4 s shortly after a fresh boot, 0.15 s of a one-word reply and 0.28 s of a
tool-call reply, plus one 0.13 s stall every five minutes and a database that doubles
when the upstream catalog changes (seen live in this run). It is no longer the main
cost of anything; whether it is worth a rebuild of the pinned server artifact is the
owner's call.

Commits:

- Fork `kkrausse/vivari`, branch `perf/sqlite-persist-and-module-cache`, pushed to
  `https://github.com/kkrausse/vivari.git`; `main` is untouched at `2367a64`:
  `9f7f691` (fix 1), `54c3884` (fix 3), `692ebba` (fix 4a), `f9893bd` (fix 4b and 4c).
- Toolkit, branch `feat/todo-editor-diagnostics`, not pushed: `f58a456` (pin), and this
  document.

## What was implemented

### Fix 1: persist only when the database changed (`9f7f691`)

`packages/kernel-host/sqlite-server.js`. The image is exported and mirrored only when
the connection is in autocommit **and** SQLite's pager data version
(`sqlite3_file_control(db, "main", SQLITE_FCNTL_DATA_VERSION)`) differs from the one
recorded with the last image handed to the mirror.

- Why this rule: every change to database content goes through a pager write
  transaction and committing one bumps that counter. SQLite documents it as the only
  mechanism that sees changes made by the connection itself. It needs no SQL
  classification, so DML, DDL, `PRAGMA user_version = N`, `PRAGMA application_id` and
  multi-statement `exec` strings are covered, and `total_changes`' blindness to DDL
  does not apply.
- Checked statement by statement (offline exploration, then the test): the version is
  unchanged for `SELECT`, `PRAGMA journal_mode = WAL` (a no-op on this in-memory
  database), `synchronous`, `busy_timeout`, `cache_size`, `foreign_keys`,
  `wal_checkpoint`, `user_version` read, `CREATE TABLE IF NOT EXISTS` on an existing
  table, `BEGIN`, a read-only transaction's `COMMIT`, and `ROLLBACK`. It changes for
  every statement that changes the image.
- Conservative where not exact: a write transaction that modified nothing (an `UPDATE`
  matching no row, `REINDEX`) still persists; an unreadable version always persists.
- `sqlite3_stmt_readonly` was considered and not used: it would persist for
  `journal_mode`, `wal_checkpoint` and the no-op `CREATE TABLE IF NOT EXISTS` (four
  needless rewrites per reopen), and it reports `COMMIT` as read-only, so it needs a
  separate dirty flag to be correct across transactions.
- `exec` no longer persists twice. The per-statement persist stays (a committed prefix
  must reach the mirror before a later `BEGIN` in the same string); the persist after
  the loop now finds the version it recorded. It still writes when a statement failed
  after changing data (`INSERT OR FAIL` keeps and commits the rows before the conflict).
- Opening an existing database no longer rewrites it. A new or empty file is still
  created on open.
- Transaction behaviour unchanged: nothing persists until autocommit returns, then once.

Left alone: the guest side (`runtime/builtins/sqlite.js`), the request/response file
exchange, `flushPath`, the prepare exchange, whole-image persistence itself.

### Fix 3: no zlib on the database image (`54c3884`)

`persist()` stores the image with the existing raw-body entry point
`vfs.write_file_body(path, bytes, length, 0)` instead of `vfs.write_file`, which runs
`maybe_compress` (zlib level 6) on every body of 4 KiB or more. The drain's read-back
is then a copy instead of an inflate.

- Only the database path written by the SQLite server is exempt. No Rust change, no
  native rebuild: `maybe_compress`, `set_compression`, the threshold and every other
  writer are untouched.
- **The brief's premise that OPFS holds a compressed image is not what the code does.**
  Compression exists only in the in-memory VFS; the mirror has always written plain
  bytes (`access.read` → `vfs.read_file` → inflate → OPFS). So there is nothing to
  migrate and an old database is read exactly as before (checked live, section 1).
- A body that is compressed in the VFS is still opened in place: the boot restore
  writes every restored file through `write_file`, the database included. The first
  commit replaces it with a raw one. That one compression per boot is left alone.
- Trade-off: kernel memory, not storage. Offline, for a 5.3 MB image shaped like
  OpenCode's (one row holding the model list): 5.3 MB held raw instead of 0.54 MB
  compressed, about 4.8 MB more resident. OPFS usage is unchanged.

### Fix 4a: transpile in one pass (`692ebba`)

`packages/runtime/esm.js`. `transpileEsm` decided which named imports need an eager
`const` by `source.split("")`, blanking ranges, `join("")` and one whole-source regex
per name. `wordsUsedOutside()` now walks the source once, skipping the blanked ranges,
and looks up each maximal run of `[A-Za-z0-9_$]` in the set of wanted names. Names with
other characters (non-ASCII identifiers) keep the regex over a blanked copy that is built
only when such a name exists.

- Output is byte-identical: the bundle (sha256 `da758cff…`, 27,547,604 chars) and
  28,138 `.js`/`.mjs`/`.ts` files (19,838 ESM, 399 M chars) from both repositories'
  dependency trees, `transpileEsm` and `transpileEsmLive`, old against new.
- `scanExportEdits` was also rewritten to dispatch on char codes with `indexOf` comment
  skipping; it measured no gain (74 ms either way), so it is unchanged. What remains of
  the transpile is the vendored `es-module-lexer` parse (135 ms offline) and that scan.

### Fix 4b + 4c: remember the plan and the async wrapper (`f9893bd`)

After 4a the transpile was still 377 to 386 ms live and the always-failing plain
compile 121 to 127 ms, so (b) and (c) were worth doing, as one mechanism:

- `planEsm()` returns the transpile as `{ head, edits, tail }`; `transpileEsm` applies
  it (same bytes). `packages/runtime/module-plan-cache.js` stores, for modules of 2 MiB
  or more, that plan and whether the module needed the async wrapper, as a JSON record
  under `/var/lib/vivari/module-plans` (mirrored to OPFS; 27 KB for the bundle). A later
  start hashes the source, applies the plan, and compiles once, async first.
- Not the transpiled text: reading a second 27 MB file costs about what reading the
  bundle does (250 ms), more than the 26 ms the plan takes to apply.
- Key: a 64-bit content hash of the exact text being transpiled plus a hash of the
  path; the record repeats path, length and `esmPlanVersion()`, all checked. The version
  is derived from the source text of every function a plan depends on plus the plan of
  a probe module, so a transpiler change invalidates every record with no number to
  bump. Nothing is keyed by mtime or size alone.
- "Needs async" only reorders the two compile attempts; if the async compile fails the
  ordinary sequence runs. Unparseable or out-of-range records are ignored and replaced.
  Filesystem errors make it a no-op. `VV_NO_MODULE_PLAN_CACHE=1` turns it off.
- No sound cheap detection of top-level await was found (it needs a parser; V8's own
  failing compile is that parser), hence remembering.

Two things found while measuring, both fixed before the push:

- The first hash (a second lane mixing in a shift of itself) cost 35 ms in Node but
  **144 ms cold in a Chrome worker**, which made a fresh start slower than without the
  cache. Two plain xor-multiply lanes over pairs of UTF-16 units cost 22 ms there
  (`live/hash-bench.txt`, `hash-bench2.txt`). State `A1`/`A1i` below is the build with
  the slow hash; `F`/`Fi` the final one.
- The probe module's `import … from './x.js'` text ended up in the worker bundles, and
  the toolkit's distribution packager, which scans them for chunk references, refused
  the build ("Unreceipted active runtime asset: assets/x.js"). The probe now uses bare
  specifiers.

## Method

Same method as the two earlier reports; their driver scripts were copied and retargeted
(`.diagnostics/runtime-fixes-2026-10-01/live/`).

- Server: `cd examples/todo-app && PORT=3100 bun run editor:debug`, restarted for each
  runtime build. Browser Control CLI 0.8.2, one session (`runtime-fixes-live`), one
  session-owned tab (no separate window: the extension only creates tabs).
- **Origin: every sample is from `http://localhost:3100`.** `127.0.0.1:3100` was not
  used (a stray tab from an earlier run may hold its storage lock).
- Modes as before. `fresh`: this origin's OPFS, IndexedDB and caches cleared first.
  `reopen`: storage kept; the database is the 6,438,912-byte one the preceding fresh
  boot left. `U`: service worker unregistered before the reload (kernel created in an
  uncontrolled page). `C`: service worker kept.
- Each boot sample: Exit, clear/unregister as the mode says, reload, Open editor, wait
  until usable, wait 10 s, fetch the guest trace dump with the statement log. Host
  phases from the diagnostics events, guest phases from the trace marks.
- Tracing (`?opencodeTrace=1`) was on for every sample.
- Runtime states. Each is a build of `vendor/vivari` at one commit, served after a
  server restart:

| state | runtime | what it is |
|---|---|---|
| `B0`, `B0b` | `2367a64`, clean | the old pin (before) |
| `B0i` | `2367a64` + temporary instrumentation | before, with persist counts and the load split |
| `S1i` | `9f7f691` + instrumentation | fix 1 only |
| `S2i` | `54c3884` + instrumentation | fixes 1 and 3 |
| `S3i` | `692ebba` + instrumentation | fixes 1, 3 and 4a |
| `A1`, `A1i` | `028a239` clean / instrumented | all fixes, first (slow) hash; superseded |
| `F` | `a291c6a`, clean | all fixes; same tree as the pin |
| `Fi` | `a291c6a` + instrumentation | all fixes, with persist counts and the load split |
| `P` | `f9893bd`, clean | the pin itself (same tree as `a291c6a`, final commit message) |

- The temporary instrumentation (`live/instrument.py`, never committed, reverted with
  `git checkout -- packages` before every build) is last time's patch adapted to all
  commits: it adds per-request kernel timings, the number of image rewrites and of
  persists skipped, and the bundle load split. Instrumented and clean states agree
  within their spreads (`B0` against `B0i`, `F` against `Fi`).
- The release build at the pin (`build-runtime.ts --release`: clean source at
  `f9893bd`, 40 assets, none retained) has asset hashes identical to the measured
  build `F` (`live/receipt-cmp.py`).

### Chronology (local time, PDT, 2026-10-01)

| Time | What |
|---|---|
| 18:29 to 18:50 | Baseline of the fork's and the toolkit's tests; fixes 1, 3 and 4a implemented and committed locally; plan cache written. |
| 18:53 to 19:05 | Server up on the old pin. `B0`: 5 fresh U, 5 reopen U, 3 reopen C. |
| 19:05 to 19:09 | Intended instrumented batch; the build script was not executable, so this is 3 + 3 more samples of the clean old pin (`B0b`). |
| 19:10 to 19:20 | `B0i` boots (3 + 3), then the scenario: reads, six prompts, two workspaces, six switches. This leaves an origin written by the old runtime. |
| 19:20 | First attempt to serve the new runtime: the packager refused the build (probe text, above). The old distribution was still served; a reload without Exit on it passed (`D0`). |
| 19:22 to 19:26 | New runtime (`028a239`) over the old runtime's origin: durability checks `D3`, `D`, switches `D4`. The upstream model catalog had changed at some point after 18:38, so this open rewrote the model list and the database went from 6,471,680 to 12,435,456 bytes. |
| 19:27 to 19:46 | `A1` boots (5 + 5 + 3) and scenario; `A1i` boots (3 + 3) and scenario. Found the 144 ms hash. |
| 19:48 to 20:08 | `F` boots (5 + 5 + 3) and scenario; `Fi` boots (3 + 3) and scenario. |
| 20:08 to 20:22 | `S1i`, `S2i`, `S3i` boots (3 + 3 each). |
| 20:23 to 20:28 | Branch pushed; pin moved; release build, fresh clone, `bun run setup`; toolkit and fork tests. |
| 20:29 to 20:32 | `P`: one fresh and one reopen on the pinned build, durability checks `DP`, size probes. Editor exited, own origin cleared, tab closed, session deleted, server stopped. |

## 1. Durability and correctness

All pass. Each check compares a fingerprint of the open editor (`live/26-state.js`):
workspace name and list, marker file, preview heading, the server's session list in
order with title, message count and a SHA-256 of each session's exported messages,
the chat's own list and selected session, visible message counts.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | New session, real prompt, tab reloaded **without Exit**, reopened | PASS: same sessions, same message digests, same selected session, same visible transcript | `D-1-before` → `D-1-after` (`028a239`, 12.4 MB database); `DP-1-before` → `DP-1-after` (pin, 6.44 MB) |
| 2 | Second session with a tool prompt, renamed through `POST /api/session/:id/rename` (204), reloaded without Exit, reopened | PASS: both sessions, the new title, digests and selection | `D-2-before` → `D-2-after`; `DP-2-before` → `DP-2-after` |
| 3 | Origin written by the old runtime (two workspaces, 2 and 4 sessions), opened with the new runtime | PASS: opens; all four sessions, digests, selection and workspace identical | `D3-old-runtime-final` → `D3-new-runtime-opened` |
| 3b | Then a write (checks 1 and 2 ran on that origin) and reloads | PASS: the old runtime's four sessions unchanged after two new sessions, a rename and two reloads | `D-0` → `D-1-before` → … → `D-2-after` (each compares every earlier session's digest) |
| 4 | Retained switch B → A → B | PASS: WS-B's six sessions, order, digests and selection as when left; same server pid (3) | `D-2-after` → `D4-B-retained` |
| 4b | Full switch (`?workspaceSwitch=full`) B → A → B | PASS: same for WS-A across the two paths and for WS-B; new pid each time (10, 13) | `D4-A-1` → `D4-A-2`, `D-2-after` → `D4-B-full` |
| 4c | The 6 + 6 + 6 switches of the scenarios (`F`, `Fi`, and `A1`) | PASS: session ids, order and selection per workspace stable across all, preview heading and marker the incoming workspace's | correctness list at the end of `live/tables/switch.md` |
| 5 | Persists per boot and per prompt | reads no longer persist: reopen boot 33 → 2 rewrites, fresh 32 → 5, one-word reply 61–66 → 14–16, tool-call reply 102 → 25–27 | sections 2 and 3, and the listing below |

```text
PASS D3-old-runtime-final -> D3-new-runtime-opened: workspace 'WS-B', 4 sessions [('E34fmE', 'Retrieving package.json name field', 4), ('gKVew2', None, 4), ('kHXmRL', None, 3), ('JdFFcd', 'OK confirmation request', 3)], selected gKVew2, visible 1 user / 2 assistant messages, db 6471680 -> 12435456 bytes, pid 20 -> 3, tab visible/visible, sw-controlled True/True
PASS D-0 -> D-1-before: workspace 'WS-B', 5 sessions [('YQIB2k', None, 3), ('E34fmE', 'Retrieving package.json name field', 4), ('gKVew2', None, 4), ('kHXmRL', None, 3), ('JdFFcd', 'OK confirmation request', 3)], selected YQIB2k, visible 1 user / 1 assistant messages, db 12435456 -> 12435456 bytes, pid 3 -> 3, tab visible/visible, sw-controlled True/True
PASS D-1-before -> D-1-after: workspace 'WS-B', 5 sessions [('YQIB2k', None, 3), ('E34fmE', 'Retrieving package.json name field', 4), ('gKVew2', None, 4), ('kHXmRL', None, 3), ('JdFFcd', 'OK confirmation request', 3)], selected YQIB2k, visible 1 user / 1 assistant messages, db 12435456 -> 12435456 bytes, pid 3 -> 3, tab visible/visible, sw-controlled True/True
PASS D-1-after -> D-2-before: workspace 'WS-B', 6 sessions [('vFlAOz', 'durability renamed D', 4), ('YQIB2k', None, 3), ('E34fmE', 'Retrieving package.json name field', 4), ('gKVew2', None, 4), ('kHXmRL', None, 3), ('JdFFcd', 'OK confirmation request', 3)], selected vFlAOz, visible 1 user / 2 assistant messages, db 12435456 -> 12435456 bytes, pid 3 -> 3, tab visible/visible, sw-controlled True/True
PASS D-2-before -> D-2-after: workspace 'WS-B', 6 sessions [('vFlAOz', 'durability renamed D', 4), ('YQIB2k', None, 3), ('E34fmE', 'Retrieving package.json name field', 4), ('gKVew2', None, 4), ('kHXmRL', None, 3), ('JdFFcd', 'OK confirmation request', 3)], selected vFlAOz, visible 1 user / 2 assistant messages, db 12435456 -> 12435456 bytes, pid 3 -> 3, tab visible/visible, sw-controlled True/True
PASS D-2-after -> D4-B-retained: workspace 'WS-B', 6 sessions [('vFlAOz', 'durability renamed D', 4), ('YQIB2k', None, 3), ('E34fmE', 'Retrieving package.json name field', 4), ('gKVew2', None, 4), ('kHXmRL', None, 3), ('JdFFcd', 'OK confirmation request', 3)], selected vFlAOz, visible 1 user / 2 assistant messages, db 12435456 -> 12435456 bytes, pid 3 -> 3, tab visible/visible, sw-controlled True/True
PASS D4-A-1 -> D4-A-2: workspace 'WS-A', 2 sessions [('E8FMT6', 'Retrieving package.json name field', 4), ('8ih8nu', 'Ok reply request', 3)], selected E8FMT6, visible 1 user / 2 assistant messages, db 12435456 -> 12435456 bytes, pid 3 -> 10, tab visible/visible, sw-controlled True/True
PASS D-2-after -> D4-B-full: workspace 'WS-B', 6 sessions [('vFlAOz', 'durability renamed D', 4), ('YQIB2k', None, 3), ('E34fmE', 'Retrieving package.json name field', 4), ('gKVew2', None, 4), ('kHXmRL', None, 3), ('JdFFcd', 'OK confirmation request', 3)], selected vFlAOz, visible 1 user / 2 assistant messages, db 12435456 -> 12435456 bytes, pid 3 -> 13, tab visible/visible, sw-controlled True/True
PASS DP-0 -> DP-1-before: workspace 'Current workspace', 1 sessions [('SsLcsD', None, 3)], selected SsLcsD, visible 1 user / 1 assistant messages, db 6438912 -> 6447104 bytes, pid 3 -> 3, tab visible/visible, sw-controlled True/True
PASS DP-1-before -> DP-1-after: workspace 'Current workspace', 1 sessions [('SsLcsD', None, 3)], selected SsLcsD, visible 1 user / 1 assistant messages, db 6447104 -> 6447104 bytes, pid 3 -> 3, tab visible/visible, sw-controlled True/True
PASS DP-1-after -> DP-2-before: workspace 'Current workspace', 2 sessions [('pD5h4D', 'durability renamed DP', 4), ('SsLcsD', None, 3)], selected pD5h4D, visible 1 user / 2 assistant messages, db 6447104 -> 6463488 bytes, pid 3 -> 3, tab visible/visible, sw-controlled True/True
PASS DP-2-before -> DP-2-after: workspace 'Current workspace', 2 sessions [('pD5h4D', 'durability renamed DP', 4), ('SsLcsD', None, 3)], selected pD5h4D, visible 1 user / 2 assistant messages, db 6463488 -> 6463488 bytes, pid 3 -> 3, tab visible/visible, sw-controlled True/True
PASS D3-old-runtime-final -> D0-old-runtime-after-reload-noexit: workspace 'WS-B', 4 sessions [('E34fmE', 'Retrieving package.json name field', 4), ('gKVew2', None, 4), ('kHXmRL', None, 3), ('JdFFcd', 'OK confirmation request', 3)], selected gKVew2, visible 1 user / 2 assistant messages, db 6471680 -> 6471680 bytes, pid 20 -> 3, tab visible/visible, sw-controlled True/True
```

The complete non-prepare statement sequence of one reopen on the final build
(`Fi-reopenU-1`): `persists` is image rewrites in that request, `skipped` is persist
calls that found the data version unchanged. The two rewrites are the two statements
that change data; the reads, the PRAGMAs, the no-op `CREATE TABLE IF NOT EXISTS`, the
open and the read-only transaction's `COMMIT` rewrite nothing.

| phase | class | exchanges | rewrote the image | persists | persists skipped (unchanged) | total ms | of which persist ms |
|---|---|---|---|---|---|---|---|
| after listening | open | 1 | 0 | 0 | 1 | 21 | 0 |
| after listening | write | 7 | 0 | 0 | 8 | 4 | 0 |
| after listening | prepare | 9 | 0 | 0 | 0 | 3 | 0 |
| after listening | read | 3 | 0 | 0 | 3 | 1 | 0 |
| after ready | prepare | 4 | 0 | 0 | 0 | 2 | 0 |
| after ready | read | 3 | 0 | 0 | 3 | 1 | 0 |
| after ready | write | 1 | 1 | 1 | 0 | 22 | 22 |
| after activation-start | prepare | 18 | 0 | 0 | 0 | 6 | 0 |
| after activation-start | read | 15 | 0 | 0 | 15 | 271 | 0 |
| after activation-start | write | 1 | 1 | 1 | 0 | 16 | 16 |
| after activation-start | txn | 2 | 0 | 0 | 1 | 0 | 0 |
| after activation-end | prepare | 4 | 0 | 0 | 0 | 2 | 0 |
| after activation-end | read | 4 | 0 | 0 | 4 | 2 | 0 |
| all | all | 72 | 2 | 2 | 35 | 349 | 37 |

| t (ms) | phase | class | ms | persists | skipped | image bytes | statement |
|---|---|---|---|---|---|---|---|
| 833 | after listening | open | 20.6 | 0 | 1 |  | `open database` |
| 836 | after listening | write | 2.2 | 0 | 2 |  | `PRAGMA journal_mode = WAL;` |
| 839 | after listening | write | 0.3 | 0 | 1 |  | `PRAGMA journal_mode = WAL` |
| 839 | after listening | write | 0.2 | 0 | 1 |  | `PRAGMA synchronous = NORMAL` |
| 840 | after listening | write | 0.3 | 0 | 1 |  | `PRAGMA busy_timeout = ?` |
| 841 | after listening | write | 0.2 | 0 | 1 |  | `PRAGMA cache_size = -?` |
| 841 | after listening | read | 0.2 | 0 | 1 |  | `PRAGMA wal_checkpoint(PASSIVE)` |
| 842 | after listening | write | 0.2 | 0 | 1 |  | `PRAGMA foreign_keys = ON` |
| 843 | after listening | read | 0.5 | 0 | 1 |  | `SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? AND substr(name, 1, 1) <> ?` |
| 843 | after listening | write | 0.2 | 0 | 1 |  | `CREATE TABLE IF NOT EXISTS "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)` |
| 844 | after listening | read | 0.4 | 0 | 1 |  | `SELECT id FROM "migration"` |
| 863 | after ready | read | 0.6 | 0 | 1 |  | `select "key", "value" from "kv" where (("kv"."key" >= ?) and ("kv"."key" < ?)) order by "kv"."key" a` |
| 864 | after ready | read | 0.2 | 0 | 1 |  | `select "id" from "session_v2" where ((("session_v2"."time_suspended" is not null)) and (("session_v2` |
| 887 | after ready | write | 22.1 | 1 | 0 | 6438912 | `update "session_v2" set "time_updated" = "session_v2"."time_updated", "time_suspended" = ?, "resume_` |
| 888 | after ready | read | 0.2 | 0 | 1 |  | `select "id" from "session_v2" where ((("session_v2"."time_suspended" is not null)) and (("session_v2` |
| 900 | after activation-start | read | 0.3 | 0 | 1 |  | `select "worktree" from "project" where "project"."id" = ?` |
| 916 | after activation-start | write | 16.0 | 1 | 0 | 6438912 | `insert into "project" ("id", "worktree", "vcs", "name", "icon_url", "icon_url_override", "icon_color` |
| 925 | after activation-start | read | 0.2 | 0 | 1 |  | `select "value" from "kv" where "kv"."key" = ?` |
| 959 | after activation-start | read | 0.3 | 0 | 1 |  | `select "value" from "kv" where "kv"."key" = ?` |
| 1100 | after activation-start | read | 139.4 | 0 | 1 |  | `select "value" from "kv" where "kv"."key" = ?` |
| 1144 | after activation-start | read | 0.3 | 0 | 1 |  | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_create` |
| 1288 | after activation-start | read | 128.2 | 0 | 1 |  | `select "value" from "kv" where "kv"."key" = ?` |
| 1308 | after activation-start | read | 0.3 | 0 | 1 |  | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_create` |
| 1311 | after activation-start | read | 0.2 | 0 | 1 |  | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_create` |
| 1323 | after activation-start | read | 0.3 | 0 | 1 |  | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_create` |
| 1324 | after activation-start | read | 0.2 | 0 | 1 |  | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_create` |
| 1326 | after activation-start | read | 0.2 | 0 | 1 |  | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_create` |
| 1326 | after activation-start | read | 0.2 | 0 | 1 |  | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_create` |
| 1328 | after activation-start | read | 0.2 | 0 | 1 |  | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_create` |
| 1338 | after activation-start | read | 0.2 | 0 | 1 |  | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_create` |
| 1374 | after activation-start | read | 0.3 | 0 | 1 |  | `select "directory", "strategy" from "worktree" where "worktree"."project_id" = ? order by "worktree"` |
| 1374 | after activation-start | txn | 0.2 | 0 | 0 |  | `begin deferred` |
| 1375 | after activation-start | txn | 0.2 | 0 | 1 |  | `commit` |
| 1382 | after activation-end | read | 0.2 | 0 | 1 |  | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_create` |
| 1400 | after activation-end | read | 0.8 | 0 | 1 |  | `select "id", "project_id", "workspace_id", "parent_id", "fork_session_id", "fork_boundary", "slug", ` |
| 1404 | after activation-end | read | 0.3 | 0 | 1 |  | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_create` |
| 1409 | after activation-end | read | 0.2 | 0 | 1 |  | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_create` |

The same boot on the old pin (`B0i-reopenU-1`), by phase:

| phase | class | exchanges | rewrote the image | persists | persists skipped (unchanged) | total ms | of which persist ms |
|---|---|---|---|---|---|---|---|
| after listening | open | 1 | 1 | 1 | 0 | 136 | 115 |
| after listening | write | 7 | 7 | 8 | 0 | 742 | 737 |
| after listening | prepare | 9 | 0 | 0 | 0 | 4 | 0 |
| after listening | read | 3 | 3 | 3 | 0 | 283 | 280 |
| after ready | prepare | 4 | 0 | 0 | 0 | 2 | 0 |
| after ready | read | 3 | 3 | 3 | 0 | 271 | 269 |
| after ready | write | 1 | 1 | 1 | 0 | 91 | 91 |
| after activation-start | prepare | 18 | 0 | 0 | 0 | 7 | 0 |
| after activation-start | read | 15 | 15 | 15 | 0 | 1620 | 1332 |
| after activation-start | write | 1 | 1 | 1 | 0 | 91 | 91 |
| after activation-start | txn | 2 | 1 | 1 | 0 | 93 | 92 |
| after activation-end | prepare | 4 | 0 | 0 | 0 | 2 | 0 |
| after activation-end | read | 4 | 4 | 4 | 0 | 355 | 353 |
| all | all | 72 | 36 | 37 | 0 | 3695 | 3359 |

A fresh boot on the final build (`Fi-freshU-1`) rewrites the image 5 times before
activation is answered, against 32 on the old pin: the open that creates the file, the
first statement after it (on a new in-memory database the pager's first read bumps the
data version once, so one 8 KB image is rewritten needlessly), the schema
transaction's commit, and two writes:

| phase | class | exchanges | rewrote the image | persists | persists skipped (unchanged) | total ms | of which persist ms |
|---|---|---|---|---|---|---|---|
| after listening | open | 1 | 1 | 1 | 0 | 12 | 8 |
| after listening | write | 6 | 1 | 1 | 6 | 3 | 2 |
| after listening | prepare | 92 | 0 | 0 | 0 | 20 | 0 |
| after listening | read | 2 | 0 | 0 | 2 | 1 | 0 |
| after listening | txn | 2 | 1 | 1 | 0 | 4 | 3 |
| after listening | write.tx | 83 | 0 | 0 | 0 | 19 | 0 |
| after first-response | prepare | 4 | 0 | 0 | 0 | 1 | 0 |
| after first-response | read | 3 | 0 | 0 | 3 | 1 | 0 |
| after first-response | write | 1 | 1 | 1 | 0 | 4 | 3 |
| after activation-start | prepare | 18 | 0 | 0 | 0 | 5 | 0 |
| after activation-start | read | 15 | 0 | 0 | 15 | 4 | 0 |
| after activation-start | write | 1 | 1 | 1 | 0 | 3 | 2 |
| after activation-start | txn | 2 | 0 | 0 | 1 | 0 | 0 |
| after activation-end | prepare | 7 | 0 | 0 | 0 | 3 | 0 |
| after activation-end | read | 6 | 0 | 0 | 6 | 141 | 0 |
| after activation-end | write | 1 | 1 | 1 | 0 | 282 | 17 |
| all | all | 244 | 6 | 6 | 33 | 500 | 35 |

## 2. Boot phases

Clean builds, medians (min–max), ms. "open total" is the whole Open editor operation
(workspace, delivery, Vite preview, then OpenCode) and is dominated by parts these
fixes do not touch. Statement statistics are over the non-prepare statements issued
before the activation answer.

| state | mode | n | open total | spawn→listen | listen→ready | ready→first answer | activation | connect | spawn→attached | guest import (bundle load) | guest start→activation answered | SQLite calls | SQLite ms | statements (non-prepare) | statement median ms | statement p95 ms | autocommit statement median ms | persists | persists skipped | persist ms | max event-loop stall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 | freshU | 5 | 25614 (23574–39784) | 2208 (2040–2243) | 100 (94–110) | 34 (28–41) | 1150 (217–1207) | 1389 (366–1450) | 3898 (2498–3962) | 2082 (1932–2117) | 3412 (2313–3478) | 234 (230–234) | 971 (160–1019) | 118 (116–118) | 0.22 (0.21–0.23) | 5.18 (4.59–6.76) | 4.03 (3.69–4.42) |  |  |  | 2146 (1988–2187) |
| B0 | reopenU | 5 | 28389 (26859–34724) | 2217 (2205–2268) | 1181 (1136–1186) | 383 (372–416) | 2081 (2064–2132) | 3763 (3685–3796) | 6280 (6188–6356) | 2094 (2087–2140) | 5789 (5726–5878) | 64 (64–64) | 3411 (3345–3453) | 33 (33–33) | 92.85 (89.67–93.69) | 180.57 (178.90–193.24) | 92.85 (89.67–93.50) |  |  |  | 3271 (3227–3320) |
| B0 | reopenC | 3 | 49720 (49620–56926) | 10201 (8545–10667) | 4036 (3865–4621) | 1496 (1450–1593) | 8019 (7945–8064) | 13968 (13631–14684) | 25418 (23517–26184) | 9684 (7987–10101) | 23664 (21859–24129) | 64 (64–64) | 12275 (11987–12971) | 33 (33–33) | 350.06 (323.20–383.63) | 657.41 (646.45–795.33) | 350.06 (323.20–390.02) |  |  |  | 14249 (12272–14495) |
| B0b | freshU | 3 | 25493 (25068–25995) | 2257 (2207–2292) | 99 (96–104) | 34 (33–35) | 1188 (1143–1201) | 1427 (1376–1446) | 3995 (3880–4050) | 2130 (2080–2164) | 3496 (3396–3549) | 234 (234–234) | 1004 (967–1016) | 118 (118–118) | 0.22 (0.22–0.23) | 9.08 (5.43–9.27) | 4.26 (4.20–4.77) |  |  |  | 2191 (2138–2232) |
| B0b | reopenU | 3 | 29823 (27818–29950) | 2232 (2123–2239) | 1198 (1185–1199) | 398 (370–401) | 2113 (2082–2132) | 3822 (3736–3832) | 6366 (6148–6372) | 2109 (2013–2112) | 5868 (5692–5882) | 64 (64–64) | 3474 (3405–3480) | 33 (33–33) | 93.74 (91.04–95.23) | 191.78 (186.91–194.87) | 93.32 (90.97–95.23) |  |  |  | 3305 (3193–3307) |
| F | freshU | 5 | 27075 (25380–35264) | 1375 (1361–1382) | 84 (80–86) | 13 (13–16) | 155 (150–156) | 261 (256–790) | 2155 (1661–2182) | 1264 (1248–1267) | 1558 (1537–1562) | 230 (230–230) | 75 (73–78) | 116 (116–116) | 0.20 (0.19–0.21) | 0.68 (0.59–0.79) | 0.23 (0.22–0.24) |  |  |  | 1308 (1294–1314) |
| F | reopenU | 5 | 25992 (25510–44900) | 878 (869–891) | 50 (50–51) | 34 (33–42) | 484 (474–494) | 582 (566–585) | 1476 (1455–1501) | 769 (762–776) | 1378 (1360–1394) | 64 (64–64) | 352 (338–353) | 33 (33–33) | 0.26 (0.23–0.28) | 21.96 (20.92–30.51) | 0.26 (0.23–0.28) |  |  |  | 809 (802–817) |
| F | reopenC | 3 | 39584 (33627–45372) | 4458 (4150–5411) | 251 (225–317) | 168 (133–410) | 2586 (2501–3932) | 3054 (2954–4717) | 7538 (7368–10367) | 3919 (3651–4648) | 7101 (6929–9736) | 64 (64–64) | 1457 (1436–2063) | 33 (33–33) | 2.08 (1.64–3.43) | 79.50 (70.95–212.97) | 1.96 (1.64–3.43) |  |  |  | 4416 (4125–5345) |
| P | freshU | 1 | 26425 | 1369 | 81 | 12 | 148 | 254 | 2155 | 1258 | 1542 | 230 | 71 | 116 | 0.20 | 0.56 | 0.22 |  |  |  | 1302 |
| P | reopenU | 1 | 27554 | 844 | 47 | 32 | 467 | 554 | 1417 | 740 | 1325 | 64 | 333 | 33 | 0.28 | 20.47 | 0.28 |  |  |  | 775 |
| A1 | freshU | 5 | 24956 (24464–26075) | 1514 (1474–1560) | 83 (81–85) | 13 (13–13) | 150 (147–158) | 256 (250–268) | 2303 (2249–2365) | 1398 (1362–1440) | 1686 (1646–1730) | 230 (230–230) | 74 (71–75) | 116 (116–116) | 0.20 (0.19–0.21) | 0.62 (0.59–0.64) | 0.22 (0.21–0.24) |  |  |  | 1446 (1406–1487) |
| A1 | reopenU | 5 | 26290 (23296–44537) | 996 (976–1009) | 50 (49–52) | 34 (32–36) | 477 (472–483) | 569 (566–576) | 1589 (1567–1598) | 876 (870–901) | 1480 (1472–1502) | 64 (64–64) | 341 (336–350) | 33 (33–33) | 0.27 (0.24–0.30) | 21.69 (20.28–23.98) | 0.27 (0.24–0.30) |  |  |  | 919 (910–942) |
| A1 | reopenC | 3 | 31930 (31510–33247) | 4167 (4097–4394) | 291 (241–524) | 162 (117–175) | 2234 (2180–2366) | 2808 (2678–2968) | 7163 (7074–7235) | 3708 (3633–3897) | 6771 (6617–6829) | 64 (64–64) | 1343 (1275–1407) | 33 (33–33) | 2.21 (1.25–2.64) | 77.64 (66.33–86.10) | 2.06 (1.25–2.18) |  |  |  | 4368 (4036–4419) |

- Reopen U: spawn → listen 2217 → 878 (bundle load), listen → ready 1181 → 50,
  ready → first answer 383 → 34, activation 2081 → 484. Activation is now mostly the
  two reads that return the 6 MB model list row (128 to 139 ms each, section 6).
- Fresh U: spawn → attached 3898 → 2155. On the old pin the model list write (0.35 s)
  and the read after it landed inside activation in most samples (activation 1150 to
  1207 ms in 3 of 5, 217 to 227 ms in the others). On the new pin everything before it
  is faster, so it lands later: in the model request or the chat attach (attach 519 to
  543 ms in `P`, one of five `F` and all five `A1` samples, 12 to 15 ms otherwise).
- Reopen C: 25.4 s → 7.5 s (one sample at 10.4 s). A controlled kernel is still about
  5 times slower than an uncontrolled one (7.5 s against 1.5 s); these fixes do not
  address that.

Each fix's contribution, instrumented builds, n = 3 per cell:

| state | mode | n | spawn→listen | listen→ready | ready→first answer | activation | spawn→attached | guest import (bundle load) | guest start→activation answered | SQLite ms | statement p95 ms | persists | persists skipped | persist ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B0i | freshU | 3 | 2051 (2012–2225) | 100 (95–123) | 36 (28–39) | 261 (226–1074) | 3297 (2704–3644) | 1940 (1899–2096) | 2566 (2304–3179) | 208 (180–909) | 5.81 (4.85–6.20) | 32 (32–34) | 0 (0–0) | 131 (118–459) |
| B0i | reopenU | 3 | 2003 (1994–2220) | 1136 (1096–1186) | 360 (355–377) | 1955 (1936–2014) | 5810 (5789–6184) | 1892 (1885–2105) | 5358 (5336–5726) | 3198 (3184–3339) | 182.59 (175.00–189.03) | 33 (33–33) | 0 (0–0) | 2883 (2873–3006) |
| S1i | freshU | 3 | 2023 (1965–2079) | 83 (80–90) | 18 (17–25) | 157 (148–160) | 2811 (2367–2936) | 1908 (1861–1966) | 2222 (2144–2268) | 79 (75–91) | 0.59 (0.55–0.85) | 5 (5–5) | 27 (27–27) | 22 (21–24) |
| S1i | reopenU | 3 | 2002 (1984–2058) | 50 (49–53) | 111 (110–111) | 555 (550–565) | 2761 (2729–2804) | 1892 (1872–1948) | 2660 (2631–2702) | 495 (493–496) | 96.13 (94.84–96.54) | 2 (2–2) | 31 (31–31) | 181 (180–182) |
| S2i | freshU | 3 | 1970 (1957–2099) | 80 (79–86) | 19 (16–20) | 147 (146–158) | 2745 (2242–2950) | 1864 (1851–1986) | 2148 (2135–2286) | 75 (74–76) | 0.67 (0.66–0.68) | 5 (5–5) | 27 (27–27) | 18 (17–18) |
| S2i | reopenU | 3 | 2017 (1974–2236) | 50 (46–53) | 38 (33–45) | 503 (480–540) | 2639 (2565–2909) | 1908 (1865–2123) | 2539 (2461–2804) | 366 (349–394) | 22.17 (21.14–26.29) | 2 (2–2) | 31 (31–31) | 39 (39–47) |
| S3i | freshU | 3 | 1394 (1384–1404) | 80 (77–82) | 12 (12–15) | 152 (152–173) | 2204 (1667–2238) | 1280 (1268–1284) | 1564 (1558–1599) | 71 (69–72) | 0.66 (0.60–0.68) | 5 (5–5) | 27 (27–27) | 16 (15–16) |
| S3i | reopenU | 3 | 1324 (1324–1329) | 49 (48–51) | 32 (32–33) | 475 (458–476) | 1912 (1889–1915) | 1216 (1213–1218) | 1815 (1792–1819) | 336 (328–340) | 21.33 (20.41–21.77) | 2 (2–2) | 31 (31–31) | 34 (32–34) |
| A1i | freshU | 3 | 1498 (1482–1527) | 84 (83–87) | 13 (13–14) | 150 (148–155) | 1779 (1759–2360) | 1382 (1370–1411) | 1671 (1659–1711) | 75 (74–77) | 0.69 (0.63–1.20) | 5 (5–5) | 27 (27–27) | 18 (17–18) |
| A1i | reopenU | 3 | 990 (989–992) | 50 (48–51) | 36 (33–37) | 484 (481–487) | 1589 (1587–1590) | 882 (881–885) | 1492 (1489–1493) | 350 (346–350) | 23.46 (20.82–23.47) | 2 (2–2) | 31 (31–31) | 36 (34–40) |
| Fi | freshU | 3 | 1371 (1364–1425) | 85 (81–86) | 13 (13–13) | 151 (149–152) | 2173 (2162–2252) | 1259 (1250–1309) | 1551 (1535–1603) | 76 (73–78) | 0.72 (0.64–0.78) | 5 (5–5) | 27 (27–27) | 18 (18–19) |
| Fi | reopenU | 3 | 881 (868–881) | 50 (49–51) | 41 (35–41) | 481 (470–483) | 1481 (1457–1487) | 770 (757–770) | 1377 (1357–1384) | 346 (341–352) | 28.39 (22.15–28.39) | 2 (2–2) | 31 (31–31) | 42 (37–43) |

- Fix 1 alone removes 31 of 33 rewrites and 2.7 s of the reopen's 3.2 s of SQLite.
  The two remaining rewrites cost 90 ms each.
- Fix 3 takes those from 90 ms to about 18 ms (persist ms 181 → 39).
- Fix 4a takes 0.63 s off every start; 4b + 4c another 0.45 s off a start that finds a
  record (a fresh origin has none: fresh `S3i` and `Fi` are equal within their spread).

Bundle load split (instrumented; ms; "ESM→CJS" includes the hash and record lookup on
the last two states):

| state | mode | n | read | pre-transforms | ESM→CJS (plan lookup + plan/apply) | failed first compile | compile total | plan store | sync evaluation | sum | plan |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B0i | freshU | 3 | 263 (248–280) | 5 (4–5) | 1032 (1023–1109) | 133 (127–153) | 293 (277–319) | 0 (0–0) | 362 (330–382) | 1940 (1899–2095) |  |
| B0i | reopenU | 3 | 263 (250–275) | 5 (4–5) | 1022 (1018–1157) | 127 (126–150) | 275 (275–318) | 0 (0–0) | 333 (331–349) | 1891 (1885–2105) |  |
| S1i | freshU | 3 | 263 (247–274) | 5 (4–5) | 1022 (1018–1070) | 127 (121–137) | 277 (263–291) | 0 (0–0) | 330 (328–336) | 1908 (1860–1966) |  |
| S1i | reopenU | 3 | 251 (247–259) | 5 (5–5) | 1017 (1010–1056) | 126 (125–131) | 283 (272–287) | 0 (0–0) | 341 (332–342) | 1891 (1872–1948) |  |
| S2i | freshU | 3 | 263 (250–278) | 5 (5–5) | 1020 (1000–1060) | 124 (123–135) | 271 (265–293) | 0 (0–0) | 319 (318–349) | 1864 (1850–1985) |  |
| S2i | reopenU | 3 | 265 (256–268) | 5 (5–5) | 1017 (1005–1168) | 131 (126–155) | 288 (270–327) | 0 (0–0) | 333 (316–367) | 1908 (1864–2123) |  |
| S3i | freshU | 3 | 269 (265–276) | 5 (4–5) | 386 (383–391) | 127 (126–135) | 280 (275–285) | 0 (0–0) | 337 (330–339) | 1280 (1267–1284) |  |
| S3i | reopenU | 3 | 244 (242–250) | 5 (4–5) | 377 (371–390) | 121 (117–122) | 264 (257–271) | 0 (0–0) | 321 (316–325) | 1213 (1213–1217) |  |
| A1i | freshU | 3 | 265 (252–266) | 5 (5–5) | 516 (511–519) | 119 (119–128) | 268 (265–287) | 3 (2–3) | 332 (327–333) | 1381 (1370–1410) | miss |
| A1i | reopenU | 3 | 253 (252–259) | 5 (5–5) | 146 (145–146) | 0 (0–0) | 147 (145–148) | 0 (0–0) | 330 (330–333) | 882 (881–885) | hit |
| Fi | freshU | 3 | 254 (251–272) | 5 (4–5) | 397 (396–408) | 128 (120–129) | 276 (267–283) | 2 (2–3) | 329 (324–337) | 1258 (1249–1308) | miss |
| Fi | reopenU | 3 | 252 (250–254) | 5 (4–5) | 26 (25–27) | 0 (0–0) | 149 (149–151) | 0 (0–0) | 334 (327–335) | 766 (757–770) | hit |

What is left of the bundle load on a reopen is reading the file (252 ms), compiling
it once (149 ms) and evaluating it (334 ms).

Where one persist's time goes, by image size (instrumented; medians, ms):

| state | image bytes | persisting exchanges | syscall (guest side) | kernel total | export | VFS write | flushPath | read-back | OPFS write | manifest | persists per exchange |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B0i | 8192 | 24 | 1.67 | 1.64 | 0.03 | 0.03 | 1.53 | 0.02 | 0.79 | 0.70 | 1.00 |
| B0i | 475136 | 71 | 4.40 | 4.36 | 0.17 | 1.17 | 2.90 | 0.28 | 1.76 | 0.84 | 1.00 |
| B0i | 6438912 | 188 | 87.98 | 87.93 | 2.09 | 62.13 | 22.91 | 11.78 | 10.03 | 0.91 | 1.00 |
| B0i | 6447104 | 129 | 87.46 | 87.40 | 2.08 | 62.25 | 22.68 | 11.79 | 9.96 | 0.91 | 1.00 |
| B0i | 6463488 | 333 | 88.63 | 88.57 | 2.09 | 62.33 | 23.48 | 11.87 | 10.38 | 0.90 | 1.00 |
| B0i | 6471680 | 36 | 90.85 | 90.80 | 2.14 | 65.65 | 23.08 | 12.24 | 9.67 | 0.89 | 1.00 |
| Fi | 8192 | 3 | 1.88 | 1.86 | 0.03 | 0.00 | 1.42 | 0.00 | 0.77 | 0.62 | 1.00 |
| Fi | 475136 | 9 | 3.27 | 3.23 | 0.18 | 0.01 | 2.92 | 0.04 | 1.97 | 0.91 | 1.00 |
| Fi | 6438912 | 15 | 21.93 | 21.88 | 2.45 | 0.12 | 13.70 | 0.57 | 12.29 | 0.89 | 1.00 |
| Fi | 6447104 | 29 | 14.68 | 14.64 | 2.36 | 0.11 | 12.08 | 0.56 | 10.47 | 0.92 | 1.00 |
| Fi | 6463488 | 82 | 13.88 | 13.84 | 2.26 | 0.11 | 11.53 | 0.55 | 10.00 | 0.91 | 1.00 |
| Fi | 6471680 | 13 | 15.28 | 15.24 | 2.16 | 0.11 | 12.52 | 0.60 | 10.36 | 0.98 | 1.00 |

At 6.44 MB the VFS write went from 62 ms to 0.1 ms and the read-back from 11.8 to
0.6 ms. What remains is the OPFS write (10 ms, 1.6 ms/MB) and the export (2.3 ms).

### Raw rows, clean builds

| label | mode | visible | hiddenMs | controlled | load | open | spawnToListen | listenToReady | readyToAnswer | health | activation | connect | attach | spawnToAttached | import | startToActEnd | sqlCalls | sqlMs | statements | stMedian | stP95 | stMax | autoN | autoMedian | persists | skipped | persistMs | lagMax | dbAtReady | dbAtDump | ldRead | ldEsm | ldFail | ldCompile | ldStore | ldEval | ldPlan |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0-freshU-1 | freshU | visible/visible | 0 | False | 5.19 | 23574 | 2084 | 96 | 31 | [127] | 227 | 366 | 32 | 2498 | 1968 | 2364 | 230 | 167 | 116 | 0.23 | 4.59 | 13.44 | 28 | 3.93 |  |  |  | 2024 | 475136 | 6438912 |  |  |  |  |  |  |  |
| B0-freshU-2 | freshU | visible/visible | 0 | False | 6.64 | 25614 | 2040 | 94 | 28 | [122] | 217 | 1128 | 281 | 3456 | 1932 | 2313 | 230 | 160 | 116 | 0.22 | 4.59 | 12.60 | 28 | 3.69 |  |  |  | 1988 | 475136 | 6438912 |  |  |  |  |  |  |  |
| B0-freshU-3 | freshU | visible/visible | 0 | False | 9.35 | 39784 | 2208 | 100 | 37 | [136] | 1207 | 1450 | 295 | 3962 | 2083 | 3472 | 234 | 1019 | 118 | 0.21 | 5.90 | 409 | 30 | 4.42 |  |  |  | 2146 | 475136 | 6438912 |  |  |  |  |  |  |  |
| B0-freshU-4 | freshU | visible/visible | 0 | False | 6.51 | 27167 | 2211 | 100 | 34 | [134] | 1150 | 1389 | 289 | 3898 | 2082 | 3412 | 234 | 971 | 118 | 0.22 | 5.18 | 377 | 30 | 4.16 |  |  |  | 2146 | 475136 | 6438912 |  |  |  |  |  |  |  |
| B0-freshU-5 | freshU | visible/visible | 0 | False | 4.96 | 24934 | 2243 | 110 | 41 | [150] | 1167 | 1419 | 288 | 3959 | 2117 | 3478 | 234 | 1003 | 118 | 0.23 | 6.76 | 392 | 30 | 4.03 |  |  |  | 2187 | 475136 | 6438912 |  |  |  |  |  |  |  |
| B0-reopenC-1 | reopenC | visible/visible | 0 | True | 7.13 | 49620 | 10667 | 3865 | 1450 | [3007, 2202] | 7945 | 13631 | 1072 | 25418 | 10101 | 23664 | 64 | 11987 | 33 | 323 | 646 | 887 | 30 | 323 |  |  |  | 14249 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| B0-reopenC-2 | reopenC | visible/visible | 0 | True | 6.69 | 49720 | 8545 | 4036 | 1496 | [3005, 2418] | 8064 | 13968 | 964 | 23517 | 7987 | 21859 | 64 | 12275 | 33 | 350 | 657 | 845 | 30 | 350 |  |  |  | 12272 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| B0-reopenC-3 | reopenC | visible/visible | 0 | True | 8.24 | 56926 | 10201 | 4621 | 1593 | [3001, 3002, 7] | 8019 | 14684 | 1266 | 26184 | 9684 | 24129 | 64 | 12971 | 33 | 384 | 795 | 803 | 30 | 390 |  |  |  | 14495 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| B0-reopenU-1 | reopenU | visible/visible | 0 | False | 6.36 | 30178 | 2212 | 1136 | 372 | [1508] | 2081 | 3685 | 281 | 6188 | 2094 | 5726 | 64 | 3345 | 33 | 89.67 | 180 | 243 | 30 | 89.67 |  |  |  | 3227 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| B0-reopenU-2 | reopenU | visible/visible | 0 | False | 6.59 | 28389 | 2217 | 1181 | 381 | [1562] | 2079 | 3740 | 292 | 6258 | 2087 | 5774 | 64 | 3393 | 33 | 92.81 | 189 | 236 | 30 | 92.81 |  |  |  | 3266 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| B0-reopenU-3 | reopenU | visible/visible | 0 | False | 8.88 | 34724 | 2259 | 1185 | 416 | [1601] | 2095 | 3796 | 292 | 6356 | 2136 | 5878 | 64 | 3453 | 33 | 92.85 | 193 | 254 | 30 | 92.85 |  |  |  | 3320 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| B0-reopenU-4 | reopenU | visible/visible | 0 | False | 5.69 | 26859 | 2268 | 1148 | 383 | [1531] | 2132 | 3766 | 293 | 6335 | 2140 | 5846 | 64 | 3411 | 33 | 93.12 | 179 | 256 | 30 | 93.12 |  |  |  | 3283 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| B0-reopenU-5 | reopenU | visible/visible | 0 | False | 5.53 | 27715 | 2205 | 1186 | 407 | [1592] | 2064 | 3763 | 303 | 6280 | 2090 | 5789 | 64 | 3416 | 33 | 93.69 | 181 | 244 | 30 | 93.50 |  |  |  | 3271 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| B0b-freshU-1 | freshU | visible/visible | 0 | False | 5.11 | 25493 | 2292 | 104 | 33 | [138] | 1201 | 1446 | 302 | 4050 | 2164 | 3549 | 234 | 1016 | 118 | 0.22 | 9.27 | 389 | 30 | 4.77 |  |  |  | 2232 | 475136 | 6438912 |  |  |  |  |  |  |  |
| B0b-freshU-2 | freshU | visible/visible | 0 | False | 4.31 | 25995 | 2257 | 99 | 34 | [133] | 1188 | 1427 | 301 | 3995 | 2130 | 3496 | 234 | 1004 | 118 | 0.22 | 9.08 | 390 | 30 | 4.20 |  |  |  | 2191 | 475136 | 6438912 |  |  |  |  |  |  |  |
| B0b-freshU-3 | freshU | visible/visible | 0 | False | 4.33 | 25068 | 2207 | 96 | 35 | [130] | 1143 | 1376 | 287 | 3880 | 2080 | 3396 | 234 | 967 | 118 | 0.23 | 5.43 | 375 | 30 | 4.26 |  |  |  | 2138 | 475136 | 6438912 |  |  |  |  |  |  |  |
| B0b-reopenU-1 | reopenU | visible/visible | 0 | False | 4.52 | 27818 | 2239 | 1198 | 401 | [1599] | 2113 | 3822 | 303 | 6372 | 2112 | 5868 | 64 | 3474 | 33 | 95.23 | 187 | 248 | 30 | 95.23 |  |  |  | 3307 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| B0b-reopenU-2 | reopenU | visible/visible | 0 | False | 5.06 | 29823 | 2232 | 1199 | 398 | [1597] | 2132 | 3832 | 294 | 6366 | 2109 | 5882 | 64 | 3480 | 33 | 93.74 | 195 | 246 | 30 | 93.32 |  |  |  | 3305 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| B0b-reopenU-3 | reopenU | visible/visible | 0 | False | 5.66 | 29950 | 2123 | 1185 | 370 | [1555] | 2082 | 3736 | 280 | 6148 | 2013 | 5692 | 64 | 3405 | 33 | 91.04 | 192 | 270 | 30 | 90.97 |  |  |  | 3193 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| F-freshU-1 | freshU | visible/visible | 0 | False | 4.59 | 25380 | 1382 | 84 | 13 | [95] | 155 | 261 | 15 | 1670 | 1267 | 1562 | 230 | 73.45 | 116 | 0.20 | 0.70 | 12.40 | 28 | 0.23 |  |  |  | 1314 | 475136 | 6438912 |  |  |  |  |  |  |  |
| F-freshU-2 | freshU | visible/visible | 0 | False | 8.89 | 35264 | 1361 | 84 | 13 | [97] | 150 | 256 | 525 | 2155 | 1248 | 1537 | 230 | 73.74 | 116 | 0.20 | 0.59 | 12.20 | 28 | 0.22 |  |  |  | 1294 | 475136 | 6438912 |  |  |  |  |  |  |  |
| F-freshU-3 | freshU | visible/visible | 0 | False | 11.49 | 33204 | 1379 | 80 | 16 | [95] | 155 | 261 | 13 | 1661 | 1264 | 1558 | 230 | 74.78 | 116 | 0.19 | 0.79 | 11.30 | 28 | 0.24 |  |  |  | 1308 | 475136 | 6438912 |  |  |  |  |  |  |  |
| F-freshU-4 | freshU | visible/visible | 0 | False | 8.91 | 27075 | 1369 | 84 | 13 | [96] | 156 | 790 | 13 | 2179 | 1258 | 1553 | 230 | 75.47 | 116 | 0.20 | 0.65 | 12.71 | 28 | 0.24 |  |  |  | 1304 | 475136 | 6438912 |  |  |  |  |  |  |  |
| F-freshU-5 | freshU | visible/visible | 0 | False | 7.53 | 25947 | 1375 | 86 | 13 | [99] | 154 | 787 | 12 | 2182 | 1266 | 1561 | 230 | 77.60 | 116 | 0.21 | 0.68 | 12.48 | 28 | 0.23 |  |  |  | 1314 | 475136 | 6438912 |  |  |  |  |  |  |  |
| F-reopenC-1 | reopenC | visible/visible | 0 | True | 5.30 | 33627 | 4150 | 251 | 168 | [418] | 2586 | 3054 | 100 | 7368 | 3651 | 6929 | 64 | 1457 | 33 | 2.08 | 70.95 | 636 | 30 | 1.96 |  |  |  | 4125 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| F-reopenC-2 | reopenC | visible/visible | 0 | True | 9.11 | 39584 | 5411 | 317 | 410 | [726] | 3932 | 4717 | 169 | 10367 | 4648 | 9736 | 64 | 2063 | 33 | 3.43 | 213 | 736 | 30 | 3.43 |  |  |  | 5345 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| F-reopenC-3 | reopenC | visible/visible | 0 | True | 8.93 | 45372 | 4458 | 225 | 133 | [357] | 2501 | 2954 | 88 | 7538 | 3919 | 7101 | 64 | 1436 | 33 | 1.64 | 79.50 | 547 | 30 | 1.64 |  |  |  | 4416 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| F-reopenU-1 | reopenU | visible/visible | 0 | False | 6.56 | 25758 | 891 | 50 | 34 | [83] | 494 | 585 | 16 | 1501 | 776 | 1394 | 64 | 352 | 33 | 0.26 | 21.24 | 140 | 30 | 0.26 |  |  |  | 817 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| F-reopenU-2 | reopenU | visible/visible | 0 | False | 8.94 | 32385 | 878 | 51 | 33 | [83] | 484 | 575 | 13 | 1474 | 769 | 1376 | 64 | 348 | 33 | 0.23 | 20.92 | 138 | 30 | 0.23 |  |  |  | 809 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| F-reopenU-3 | reopenU | visible/visible | 0 | False | 12.68 | 44900 | 884 | 50 | 41 | [91] | 484 | 582 | 17 | 1495 | 774 | 1389 | 64 | 353 | 33 | 0.23 | 28.15 | 136 | 30 | 0.23 |  |  |  | 814 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| F-reopenU-4 | reopenU | visible/visible | 0 | False | 8.24 | 25510 | 872 | 51 | 42 | [93] | 482 | 582 | 12 | 1476 | 762 | 1378 | 64 | 353 | 33 | 0.26 | 30.51 | 135 | 30 | 0.26 |  |  |  | 803 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| F-reopenU-5 | reopenU | visible/visible | 0 | False | 7.10 | 25992 | 869 | 50 | 34 | [84] | 474 | 566 | 12 | 1455 | 762 | 1360 | 64 | 338 | 33 | 0.28 | 21.96 | 135 | 30 | 0.28 |  |  |  | 802 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| P-freshU-1 | freshU | visible/visible | 0 | False | 4.04 | 26425 | 1369 | 81 | 12 | [92] | 148 | 254 | 519 | 2155 | 1258 | 1542 | 230 | 70.67 | 116 | 0.20 | 0.56 | 11.40 | 28 | 0.22 |  |  |  | 1302 | 475136 | 6438912 |  |  |  |  |  |  |  |
| P-reopenU-1 | reopenU | visible/visible | 0 | False | 3.63 | 27554 | 844 | 47 | 32 | [79] | 467 | 554 | 11 | 1417 | 740 | 1325 | 64 | 333 | 33 | 0.28 | 20.47 | 135 | 30 | 0.28 |  |  |  | 775 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| A1-freshU-1 | freshU | visible/visible | 0 | False | 5.24 | 24694 | 1514 | 85 | 13 | [98] | 158 | 268 | 536 | 2327 | 1398 | 1700 | 230 | 74.45 | 116 | 0.21 | 0.64 | 11.21 | 28 | 0.22 |  |  |  | 1448 | 475136 | 6438912 |  |  |  |  |  |  |  |
| A1-freshU-2 | freshU | visible/visible | 0 | False | 5.23 | 24464 | 1518 | 82 | 13 | [95] | 147 | 255 | 516 | 2297 | 1401 | 1686 | 230 | 73.52 | 116 | 0.20 | 0.62 | 12 | 28 | 0.22 |  |  |  | 1446 | 475136 | 6438912 |  |  |  |  |  |  |  |
| A1-freshU-3 | freshU | visible/visible | 0 | False | 5.67 | 24964 | 1474 | 81 | 13 | [94] | 147 | 250 | 517 | 2249 | 1362 | 1646 | 230 | 71.46 | 116 | 0.19 | 0.62 | 11.87 | 28 | 0.22 |  |  |  | 1406 | 475136 | 6438912 |  |  |  |  |  |  |  |
| A1-freshU-4 | freshU | visible/visible | 0 | False | 5.61 | 24956 | 1560 | 83 | 13 | [96] | 151 | 256 | 540 | 2365 | 1440 | 1730 | 230 | 74.24 | 116 | 0.21 | 0.63 | 12.82 | 28 | 0.24 |  |  |  | 1487 | 475136 | 6438912 |  |  |  |  |  |  |  |
| A1-freshU-5 | freshU | visible/visible | 0 | False | 6.21 | 26075 | 1496 | 84 | 13 | [97] | 150 | 257 | 543 | 2303 | 1382 | 1672 | 230 | 74.54 | 116 | 0.20 | 0.59 | 11.54 | 28 | 0.21 |  |  |  | 1428 | 475136 | 6438912 |  |  |  |  |  |  |  |
| A1-reopenC-1 | reopenC | visible/visible | 0 | True | 4.97 | 31510 | 4097 | 241 | 162 | [402] | 2366 | 2808 | 121 | 7074 | 3633 | 6617 | 64 | 1343 | 33 | 1.25 | 77.64 | 544 | 30 | 1.25 |  |  |  | 4036 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| A1-reopenC-2 | reopenC | visible/visible | 0 | True | 6.77 | 31930 | 4394 | 291 | 117 | [407] | 2234 | 2678 | 59 | 7163 | 3897 | 6771 | 64 | 1275 | 33 | 2.64 | 66.33 | 503 | 30 | 2.18 |  |  |  | 4368 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| A1-reopenC-3 | reopenC | visible/visible | 0 | True | 5.53 | 33247 | 4167 | 524 | 175 | [698] | 2180 | 2968 | 60 | 7235 | 3708 | 6829 | 64 | 1407 | 33 | 2.21 | 86.10 | 517 | 30 | 2.06 |  |  |  | 4419 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| A1-reopenU-1 | reopenU | visible/visible | 0 | False | 4.35 | 24157 | 976 | 51 | 32 | [83] | 478 | 569 | 13 | 1567 | 870 | 1472 | 64 | 339 | 33 | 0.24 | 20.28 | 134 | 30 | 0.24 |  |  |  | 910 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| A1-reopenU-2 | reopenU | visible/visible | 0 | False | 5.82 | 23296 | 981 | 52 | 34 | [86] | 472 | 566 | 13 | 1568 | 874 | 1472 | 64 | 336 | 33 | 0.30 | 20.51 | 134 | 30 | 0.30 |  |  |  | 916 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| A1-reopenU-3 | reopenU | visible/visible | 0 | False | 5.65 | 26380 | 1009 | 50 | 35 | [85] | 475 | 567 | 13 | 1598 | 901 | 1502 | 64 | 344 | 33 | 0.26 | 23.18 | 137 | 30 | 0.26 |  |  |  | 942 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| A1-reopenU-4 | reopenU | visible/visible | 0 | False | 6.68 | 44537 | 999 | 50 | 34 | [84] | 477 | 569 | 13 | 1589 | 876 | 1480 | 64 | 341 | 33 | 0.27 | 21.69 | 136 | 30 | 0.27 |  |  |  | 919 | 6438912 | 6438912 |  |  |  |  |  |  |  |
| A1-reopenU-5 | reopenU | visible/visible | 0 | False | 5.78 | 26290 | 996 | 49 | 36 | [85] | 483 | 576 | 13 | 1593 | 890 | 1499 | 64 | 350 | 33 | 0.28 | 23.98 | 138 | 30 | 0.28 |  |  |  | 929 | 6438912 | 6438912 |  |  |  |  |  |  |  |

### Raw rows, instrumented builds

| label | mode | visible | hiddenMs | controlled | load | open | spawnToListen | listenToReady | readyToAnswer | health | activation | connect | attach | spawnToAttached | import | startToActEnd | sqlCalls | sqlMs | statements | stMedian | stP95 | stMax | autoN | autoMedian | persists | skipped | persistMs | lagMax | dbAtReady | dbAtDump | ldRead | ldEsm | ldFail | ldCompile | ldStore | ldEval | ldPlan |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0i-freshU-1 | freshU | visible/visible | 0 | False | 5.65 | 26746 | 2225 | 123 | 36 | [159] | 261 | 434 | 35 | 2704 | 2096 | 2566 | 230 | 208 | 116 | 0.23 | 6.20 | 16.24 | 28 | 4.45 | 32 | 0 | 131 | 2181 | 475136 | 6438912 | 280 | 1109 | 153 | 319 | 0 | 382 |  |
| B0i-freshU-2 | freshU | visible/visible | 0 | False | 5.10 | 25142 | 2051 | 95 | 28 | [122] | 1074 | 1295 | 289 | 3644 | 1940 | 3179 | 234 | 909 | 118 | 0.21 | 5.81 | 345 | 30 | 3.88 | 34 | 0 | 459 | 1997 | 475136 | 6438912 | 248 | 1032 | 133 | 293 | 0 | 362 |  |
| B0i-freshU-3 | freshU | visible/visible | 0 | False | 6.08 | 25186 | 2012 | 100 | 39 | [138] | 226 | 376 | 900 | 3297 | 1899 | 2304 | 230 | 180 | 116 | 0.22 | 4.85 | 13.10 | 28 | 4.24 | 32 | 0 | 118 | 1959 | 475136 | 6438912 | 263 | 1023 | 127 | 277 | 0 | 330 |  |
| B0i-reopenU-1 | reopenU | visible/visible | 0 | False | 5.40 | 29278 | 2220 | 1186 | 377 | [1563] | 2014 | 3674 | 281 | 6184 | 2105 | 5726 | 64 | 3339 | 33 | 90.65 | 189 | 235 | 30 | 90.58 | 33 | 0 | 3006 | 3289 | 6438912 | 6438912 | 275 | 1157 | 150 | 318 | 0 | 349 |  |
| B0i-reopenU-2 | reopenU | visible/visible | 0 | False | 6.45 | 29144 | 1994 | 1096 | 360 | [1455] | 1955 | 3505 | 280 | 5789 | 1885 | 5336 | 64 | 3184 | 33 | 87.18 | 175 | 220 | 30 | 86.91 | 33 | 0 | 2873 | 2974 | 6438912 | 6438912 | 250 | 1022 | 127 | 275 | 0 | 333 |  |
| B0i-reopenU-3 | reopenU | visible/visible | 0 | False | 5.82 | 27584 | 2003 | 1136 | 355 | [1491] | 1936 | 3521 | 277 | 5810 | 1892 | 5358 | 64 | 3198 | 33 | 86.82 | 183 | 224 | 30 | 86.82 | 33 | 0 | 2883 | 3019 | 6438912 | 6438912 | 263 | 1018 | 126 | 275 | 0 | 331 |  |
| S1i-freshU-1 | freshU | visible/visible | 0 | False | 10.92 | 27415 | 2079 | 83 | 18 | [101] | 160 | 268 | 12 | 2367 | 1966 | 2268 | 230 | 79.14 | 116 | 0.20 | 0.59 | 12.93 | 28 | 0.24 | 5 | 27 | 21.95 | 2010 | 475136 | 6438912 | 263 | 1070 | 137 | 291 | 0 | 336 |  |
| S1i-freshU-2 | freshU | visible/visible | 0 | False | 8.22 | 27674 | 2023 | 90 | 25 | [115] | 157 | 280 | 625 | 2936 | 1908 | 2222 | 230 | 91.22 | 116 | 0.22 | 0.85 | 12.95 | 28 | 0.26 | 5 | 27 | 24.29 | 1958 | 475136 | 6438912 | 274 | 1022 | 127 | 277 | 0 | 330 |  |
| S1i-freshU-3 | freshU | visible/visible | 0 | False | 6.13 | 26525 | 1965 | 80 | 17 | [97] | 148 | 824 | 12 | 2811 | 1861 | 2144 | 230 | 75.43 | 116 | 0.21 | 0.55 | 12.12 | 28 | 0.23 | 5 | 27 | 20.65 | 1901 | 475136 | 6438912 | 247 | 1018 | 121 | 263 | 0 | 328 |  |
| S1i-reopenU-1 | reopenU | visible/visible | 0 | False | 7.77 | 28152 | 1984 | 50 | 111 | [161] | 555 | 724 | 13 | 2729 | 1872 | 2631 | 64 | 495 | 33 | 0.27 | 96.13 | 141 | 30 | 0.27 | 2 | 31 | 181 | 1917 | 6438912 | 6438912 | 247 | 1017 | 125 | 272 | 0 | 332 |  |
| S1i-reopenU-2 | reopenU | visible/visible | 0 | False | 6.52 | 26838 | 2002 | 49 | 111 | [160] | 565 | 733 | 18 | 2761 | 1892 | 2660 | 64 | 496 | 33 | 0.28 | 96.54 | 140 | 30 | 0.28 | 2 | 31 | 180 | 1936 | 6438912 | 6438912 | 251 | 1010 | 126 | 283 | 0 | 342 |  |
| S1i-reopenU-3 | reopenU | visible/visible | 0 | False | 4.52 | 26508 | 2058 | 53 | 110 | [162] | 550 | 720 | 18 | 2804 | 1948 | 2702 | 64 | 493 | 33 | 0.30 | 94.84 | 136 | 30 | 0.30 | 2 | 31 | 182 | 1995 | 6438912 | 6438912 | 259 | 1056 | 131 | 287 | 0 | 341 |  |
| S2i-freshU-1 | freshU | visible/visible | 0 | False | 5.06 | 27114 | 1970 | 79 | 20 | [99] | 146 | 252 | 12 | 2242 | 1864 | 2148 | 230 | 74.05 | 116 | 0.20 | 0.66 | 12 | 28 | 0.23 | 5 | 27 | 17.90 | 1905 | 475136 | 6438912 | 250 | 1020 | 123 | 271 | 0 | 319 |  |
| S2i-freshU-2 | freshU | visible/visible | 0 | False | 4.19 | 26432 | 1957 | 80 | 19 | [99] | 147 | 767 | 12 | 2745 | 1851 | 2135 | 230 | 74.51 | 116 | 0.20 | 0.67 | 12.08 | 28 | 0.23 | 5 | 27 | 17.34 | 1891 | 475136 | 6438912 | 263 | 1000 | 124 | 265 | 0 | 318 |  |
| S2i-freshU-3 | freshU | visible/visible | 0 | False | 3.94 | 25120 | 2099 | 86 | 16 | [101] | 158 | 822 | 17 | 2950 | 1986 | 2286 | 230 | 75.83 | 116 | 0.22 | 0.68 | 12.96 | 28 | 0.23 | 5 | 27 | 17.54 | 2034 | 475136 | 6438912 | 278 | 1060 | 135 | 293 | 0 | 349 |  |
| S2i-reopenU-1 | reopenU | visible/visible | 0 | False | 4.17 | 27800 | 1974 | 46 | 33 | [79] | 480 | 566 | 17 | 2565 | 1865 | 2461 | 64 | 349 | 33 | 0.23 | 21.14 | 141 | 30 | 0.23 | 2 | 31 | 39.49 | 1901 | 6438912 | 6438912 | 268 | 1005 | 126 | 270 | 0 | 316 |  |
| S2i-reopenU-2 | reopenU | visible/visible | 0 | False | 4.94 | 26515 | 2017 | 50 | 38 | [88] | 503 | 599 | 14 | 2639 | 1908 | 2539 | 64 | 366 | 33 | 0.31 | 22.17 | 146 | 30 | 0.31 | 2 | 31 | 38.71 | 1951 | 6438912 | 6438912 | 265 | 1017 | 131 | 288 | 0 | 333 |  |
| S2i-reopenU-3 | reopenU | visible/visible | 0 | False | 6.65 | 28309 | 2236 | 53 | 45 | [97] | 540 | 647 | 15 | 2909 | 2123 | 2804 | 64 | 394 | 33 | 0.26 | 26.29 | 152 | 30 | 0.26 | 2 | 31 | 47.32 | 2175 | 6438912 | 6438912 | 256 | 1168 | 155 | 327 | 0 | 367 |  |
| S3i-freshU-1 | freshU | visible/visible | 0 | False | 4.18 | 25426 | 1404 | 80 | 15 | [94] | 173 | 811 | 13 | 2238 | 1284 | 1599 | 230 | 71.91 | 116 | 0.19 | 0.66 | 12.54 | 28 | 0.27 | 5 | 27 | 16.48 | 1333 | 475136 | 6438912 | 269 | 391 | 127 | 280 | 0 | 339 |  |
| S3i-freshU-2 | freshU | visible/visible | 0 | False | 4.37 | 25036 | 1394 | 77 | 12 | [88] | 152 | 252 | 12 | 1667 | 1280 | 1564 | 230 | 68.60 | 116 | 0.20 | 0.60 | 10.84 | 28 | 0.23 | 5 | 27 | 15.46 | 1322 | 475136 | 6438912 | 276 | 386 | 126 | 275 | 0 | 337 |  |
| S3i-freshU-3 | freshU | visible/visible | 0 | False | 3.98 | 24007 | 1384 | 82 | 12 | [94] | 152 | 793 | 18 | 2204 | 1268 | 1558 | 230 | 70.56 | 116 | 0.19 | 0.68 | 11.25 | 28 | 0.23 | 5 | 27 | 15.53 | 1313 | 475136 | 6438912 | 265 | 383 | 135 | 285 | 0 | 330 |  |
| S3i-reopenU-1 | reopenU | visible/visible | 0 | False | 3.63 | 26272 | 1329 | 49 | 32 | [81] | 475 | 564 | 13 | 1915 | 1218 | 1815 | 64 | 336 | 33 | 0.25 | 20.41 | 133 | 30 | 0.25 | 2 | 31 | 31.93 | 1258 | 6438912 | 6438912 | 250 | 377 | 121 | 264 | 0 | 321 |  |
| S3i-reopenU-2 | reopenU | visible/visible | 0 | False | 4.16 | 26323 | 1324 | 51 | 33 | [84] | 476 | 567 | 12 | 1912 | 1216 | 1819 | 64 | 340 | 33 | 0.25 | 21.77 | 137 | 30 | 0.25 | 2 | 31 | 33.67 | 1259 | 6438912 | 6438912 | 242 | 371 | 122 | 271 | 0 | 325 |  |
| S3i-reopenU-3 | reopenU | visible/visible | 0 | False | 3.47 | 26969 | 1324 | 48 | 32 | [80] | 458 | 545 | 12 | 1889 | 1213 | 1792 | 64 | 328 | 33 | 0.23 | 21.33 | 130 | 30 | 0.23 | 2 | 31 | 34.27 | 1252 | 6438912 | 6438912 | 244 | 390 | 117 | 257 | 0 | 316 |  |
| A1i-freshU-1 | freshU | visible/visible | 0 | False | 7.17 | 27411 | 1527 | 87 | 14 | [101] | 155 | 266 | 557 | 2360 | 1411 | 1711 | 230 | 77.06 | 116 | 0.20 | 1.20 | 11.66 | 28 | 0.22 | 5 | 27 | 17.75 | 1462 | 475136 | 6438912 | 265 | 519 | 128 | 287 | 2.55 | 333 | miss |
| A1i-freshU-2 | freshU | visible/visible | 0 | False | 7.97 | 25803 | 1498 | 84 | 13 | [97] | 148 | 255 | 17 | 1779 | 1382 | 1671 | 230 | 75.08 | 116 | 0.20 | 0.69 | 12.18 | 28 | 0.24 | 5 | 27 | 18.10 | 1429 | 475136 | 6438912 | 266 | 516 | 119 | 265 | 2.48 | 327 | miss |
| A1i-freshU-3 | freshU | visible/visible | 0 | False | 7.58 | 26227 | 1482 | 83 | 13 | [96] | 150 | 256 | 13 | 1759 | 1370 | 1659 | 230 | 74.32 | 116 | 0.20 | 0.63 | 11.75 | 28 | 0.22 | 5 | 27 | 16.95 | 1415 | 475136 | 6438912 | 252 | 511 | 119 | 268 | 2.58 | 332 | miss |
| A1i-reopenU-1 | reopenU | visible/visible | 0 | False | 7.02 | 25983 | 990 | 50 | 33 | [82] | 487 | 577 | 13 | 1589 | 882 | 1493 | 64 | 346 | 33 | 0.26 | 20.82 | 138 | 30 | 0.26 | 2 | 31 | 34.21 | 923 | 6438912 | 6438912 | 252 | 146 | 0 | 147 | 0.00 | 333 | hit |
| A1i-reopenU-2 | reopenU | visible/visible | 0 | False | 6.42 | 26844 | 989 | 48 | 37 | [84] | 484 | 576 | 13 | 1587 | 881 | 1489 | 64 | 350 | 33 | 0.27 | 23.47 | 140 | 30 | 0.27 | 2 | 31 | 36.35 | 918 | 6438912 | 6438912 | 253 | 145 | 0 | 148 | 0.01 | 330 | hit |
| A1i-reopenU-3 | reopenU | visible/visible | 0 | False | 6.24 | 26377 | 992 | 51 | 36 | [86] | 481 | 576 | 13 | 1590 | 885 | 1492 | 64 | 350 | 33 | 0.27 | 23.46 | 136 | 30 | 0.27 | 2 | 31 | 40.34 | 925 | 6438912 | 6438912 | 259 | 146 | 0 | 145 | 0.01 | 330 | hit |
| Fi-freshU-1 | freshU | visible/visible | 0 | False | 8.63 | 35475 | 1425 | 85 | 13 | [98] | 152 | 263 | 553 | 2252 | 1309 | 1603 | 230 | 75.53 | 116 | 0.20 | 0.64 | 12.33 | 28 | 0.24 | 5 | 27 | 18.52 | 1357 | 475136 | 6438912 | 272 | 408 | 128 | 283 | 2.92 | 337 | miss |
| Fi-freshU-2 | freshU | visible/visible | 0 | False | 8.36 | 45012 | 1364 | 81 | 13 | [94] | 149 | 773 | 17 | 2162 | 1250 | 1535 | 230 | 72.99 | 116 | 0.20 | 0.78 | 12.11 | 28 | 0.21 | 5 | 27 | 18.04 | 1293 | 475136 | 6438912 | 254 | 397 | 120 | 267 | 2.09 | 324 | miss |
| Fi-freshU-3 | freshU | visible/visible | 0 | False | 9.59 | 39609 | 1371 | 86 | 13 | [98] | 151 | 776 | 17 | 2173 | 1259 | 1551 | 230 | 77.60 | 116 | 0.21 | 0.72 | 12.18 | 28 | 0.24 | 5 | 27 | 18.34 | 1307 | 475136 | 6438912 | 251 | 396 | 129 | 276 | 2.38 | 329 | miss |
| Fi-reopenU-1 | reopenU | visible/visible | 0 | False | 8.77 | 46344 | 881 | 51 | 35 | [85] | 481 | 575 | 17 | 1481 | 770 | 1377 | 64 | 346 | 33 | 0.27 | 22.15 | 139 | 30 | 0.27 | 2 | 31 | 37.24 | 811 | 6438912 | 6438912 | 252 | 24.83 | 0 | 149 | 0.01 | 335 | hit |
| Fi-reopenU-2 | reopenU | visible/visible | 0 | False | 8.53 | 44614 | 881 | 50 | 41 | [91] | 483 | 581 | 17 | 1487 | 770 | 1384 | 64 | 352 | 33 | 0.27 | 28.39 | 139 | 30 | 0.27 | 2 | 31 | 43.22 | 810 | 6438912 | 6438912 | 254 | 27 | 0 | 151 | 0.01 | 334 | hit |
| Fi-reopenU-3 | reopenU | visible/visible | 0 | False | 10.50 | 28934 | 868 | 49 | 41 | [89] | 470 | 568 | 13 | 1457 | 757 | 1357 | 64 | 341 | 33 | 0.25 | 28.39 | 133 | 30 | 0.25 | 2 | 31 | 42.33 | 797 | 6438912 | 6438912 | 250 | 26.48 | 0 | 149 | 0.00 | 327 | hit |

## 3. Chat

Six prompts per state, each in a new chat: three "Reply with exactly the single word:
ok" and three "Use the read tool on /workspace/package.json and reply with exactly the
value of its name field". SQLite columns are differences of two guest dumps taken just
before and after the prompt. Send → idle is dominated by the model (1.3 s to 60 s for
the same prompt in this run), so it is reported but the SQLite columns are the
comparison.

| state | prompt | n | send→idle ms | SQLite calls | SQLite ms | autocommit read mean ms | autocommit write mean ms | persists |
|---|---|---|---|---|---|---|---|---|
| B0i | word | 3 | 19200 (9300–19247) | 270 (270–296) | 5629 (5455–6010) | 90.22 | 86.64 | 61 (61–66) |
| B0i | tool | 3 | 33342 (17976–60291) | 492 (492–492) | 9208 (9124–9456) | 89.28 | 86.40 | 102 (102–102) |
| F | word | 3 | 1380 (1282–1790) | 286 (286–294) | 302 (279–308) | 0.28 | 21.71 |  |
| F | tool | 3 | 3254 (3145–6908) | 490 (490–516) | 535 (518–621) | 0.31 | 17.84 |  |
| Fi | word | 3 | 2030 (1385–2137) | 310 (286–320) | 318 (301–346) | 0.29 | 23.51 | 15 (14–16) |
| Fi | tool | 3 | 2968 (2805–4373) | 498 (482–508) | 517 (491–579) | 0.28 | 22.38 | 25 (25–27) |
| A1 | word | 3 | 10945 (1252–11830) | 346 (286–352) | 370 (278–394) | 0.30 | 22.62 |  |
| A1 | tool | 3 | 4107 (2117–53242) | 498 (482–814) | 570 (504–921) | 0.31 | 18.97 |  |
| A1i | word | 3 | 4831 (2047–7218) | 294 (294–320) | 314 (306–337) | 0.28 | 25.11 | 14 (14–16) |
| A1i | tool | 3 | 4598 (3384–4982) | 498 (490–498) | 549 (535–578) | 0.30 | 20.10 | 25 (25–25) |
| D | word | 1 | 9022 (9022–9022) | 294 (294–294) | 430 (430–430) | 0.30 | 31.69 |  |
| D | tool | 1 | 5640 (5640–5640) | 490 (490–490) | 786 (786–786) | 0.30 | 34.33 |  |
| DP | word | 1 | 1597 (1597–1597) | 286 (286–286) | 289 (289–289) | 0.31 | 20.83 |  |
| DP | tool | 1 | 3812 (3812–3812) | 482 (482–482) | 521 (521–521) | 0.28 | 23.76 |  |

`D` is the same pair of prompts with the 12.4 MB database (after the model list was
rewritten): reads are unchanged at 0.3 ms, each real write costs about twice as much.

| sample | prompt | visible (dumps) | send→idle ms | wall between dumps ms | SQLite calls | SQLite ms | autocommit reads n / ms / mean | autocommit writes n / ms / mean | txn (begin, commit) n / ms | in-transaction n / ms | prepares n / ms | persists | persists skipped | DB bytes before → after | answer | load |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0i-chatA1 | word | visible/visible | 19200 | 21495 | 296 | 6010 | 49 / 4421 / 90.22 | 1 / 87 / 86.64 | 32 / 1442 | 66 / 19.1 | 148 / 41 | 66 | 0 | 6438912 → 6447104 | 'oning\n\nok\n\nRun completed' | 5.1 |
| B0i-chatB1 | word | visible/visible | 19247 | 21261 | 270 | 5629 | 46 / 4208 / 91.47 | 1 / 89 / 89.33 | 28 / 1274 | 60 / 17.2 | 135 / 40 | 61 | 0 | 6463488 → 6463488 | 'oning\n\nok\n\nRun completed' | 5.0 |
| B0i-chatB3 | word | visible/visible | 9300 | 11133 | 270 | 5455 | 46 / 4069 / 88.46 | 1 / 86 / 85.7 | 28 / 1255 | 60 / 12.8 | 135 / 33 | 61 | 0 | 6463488 → 6463488 | 'oning\n\nok\n\nRun completed' | 4.6 |
| B0i-chatA2 | tool | visible/visible | 60291 | 62056 | 492 | 9124 | 73 / 6433 / 88.13 | 1 / 86 / 86.26 | 56 / 2501 | 116 / 33.6 | 246 / 70 | 102 | 0 | 6447104 → 6463488 | '-app-demo\n\nRun completed' | 4.6 |
| B0i-chatB2 | tool | visible/visible | 33342 | 35178 | 492 | 9208 | 73 / 6518 / 89.28 | 1 / 88 / 88.31 | 56 / 2507 | 116 / 27.7 | 246 / 67 | 102 | 0 | 6463488 → 6463488 | '-app-demo\n\nRun completed' | 4.2 |
| B0i-chatB4 | tool | visible/visible | 17976 | 19892 | 492 | 9456 | 73 / 6678 / 91.48 | 1 / 86 / 86.4 | 56 / 2599 | 116 / 26.9 | 246 / 65 | 102 | 0 | 6463488 → 6471680 | '-app-demo\n\nRun completed' | 4.9 |
| F-chatA1 | word | visible/visible | 1790 | 3676 | 286 | 302 | 54 / 18 / 0.34 | 1 / 21 / 21.31 | 28 / 208 | 60 / 15.6 | 143 / 40 |  |  | 6438912 → 6447104 | 'oning\n\nok\n\nRun completed' | 6.8 |
| F-chatB1 | word | visible/visible | 1380 | 3274 | 294 | 308 | 58 / 16 / 0.28 | 1 / 26 / 25.87 | 28 / 216 | 60 / 13.9 | 147 / 36 |  |  | 6463488 → 6463488 | 'oning\n\nok\n\nRun completed' | 7.0 |
| F-chatB3 | word | visible/visible | 1282 | 2981 | 286 | 279 | 54 / 15 / 0.28 | 1 / 22 / 21.71 | 28 / 198 | 60 / 12.9 | 143 / 32 |  |  | 6463488 → 6463488 | 'oning\n\nok\n\nRun completed' | 7.0 |
| F-chatA2 | tool | visible/visible | 3254 | 4943 | 490 | 518 | 82 / 26 / 0.32 | 1 / 18 / 17.84 | 52 / 382 | 110 / 29.6 | 245 / 62 |  |  | 6447104 → 6463488 | '-app-demo\n\nRun completed' | 6.7 |
| F-chatB2 | tool | visible/visible | 6908 | 8614 | 516 | 621 | 85 / 26 / 0.31 | 1 / 18 / 17.81 | 56 / 463 | 116 / 36.7 | 258 / 77 |  |  | 6463488 → 6463488 | '-app-demo\n\nRun completed' | 7.0 |
| F-chatB4 | tool | visible/visible | 3145 | 4860 | 490 | 535 | 82 / 21 / 0.26 | 1 / 19 / 19.06 | 52 / 399 | 110 / 31.8 | 245 / 64 |  |  | 6463488 → 6471680 | '-app-demo\n\nRun completed' | 6.9 |
| Fi-chatA1 | word | visible/visible | 2137 | 4008 | 286 | 301 | 54 / 16 / 0.3 | 1 / 24 / 24.31 | 28 / 207 | 60 / 15.7 | 143 / 37 | 14 | 55 | 6438912 → 6447104 | 'oning\n\nok\n\nRun completed' | 8.5 |
| Fi-chatB1 | word | visible/visible | 2030 | 3982 | 310 | 346 | 61 / 18 / 0.29 | 1 / 21 / 21.34 | 30 / 248 | 63 / 16.7 | 155 / 42 | 15 | 62 | 6463488 → 6463488 | 'oning\n\nok\n\nRun completed' | 7.6 |
| Fi-chatB3 | word | visible/visible | 1385 | 3391 | 320 | 318 | 61 / 16 / 0.27 | 1 / 24 / 23.51 | 32 / 224 | 66 / 15.7 | 160 / 38 | 16 | 62 | 6463488 → 6463488 | 'oning\n\nok\n\nRun completed' | 8.7 |
| Fi-chatA2 | tool | visible/visible | 4373 | 6056 | 498 | 517 | 86 / 26 / 0.3 | 1 / 26 / 26.17 | 52 / 372 | 110 / 28.9 | 249 / 64 | 25 | 88 | 6447104 → 6463488 | '-app-demo\n\nRun completed' | 8.1 |
| Fi-chatB2 | tool | visible/visible | 2968 | 4707 | 482 | 491 | 78 / 22 / 0.28 | 1 / 22 / 22.38 | 52 / 369 | 110 / 24.9 | 241 / 54 | 25 | 80 | 6463488 → 6463488 | '-app-demo\n\nRun completed' | 9.1 |
| Fi-chatB4 | tool | visible/visible | 2805 | 4620 | 508 | 579 | 81 / 21 / 0.26 | 1 / 20 / 19.9 | 56 / 462 | 116 / 24.6 | 254 / 52 | 27 | 83 | 6463488 → 6471680 | '-app-demo\n\nRun completed' | 8.2 |
| A1-chatA1 | word | visible/visible | 1252 | 3085 | 286 | 278 | 54 / 16 / 0.29 | 1 / 23 / 22.62 | 28 / 188 | 60 / 15.7 | 143 / 36 |  |  | 6438912 → 6447104 | 'oning\n\nok\n\nRun completed' | 5.1 |
| A1-chatB1 | word | visible/visible | 11830 | 13830 | 352 | 370 | 69 / 21 / 0.3 | 1 / 30 / 30.39 | 34 / 250 | 72 / 19.7 | 176 / 48 |  |  | 6463488 → 6463488 | 'oning\n\nok\n\nRun completed' | 5.0 |
| A1-chatB3 | word | visible/visible | 10945 | 12628 | 346 | 394 | 64 / 23 / 0.36 | 1 / 16 / 16.17 | 36 / 284 | 72 / 21.0 | 173 / 50 |  |  | 6463488 → 6463488 | 'oning\n\nok\n\nRun completed' | 4.1 |
| A1-chatA2 | tool | visible/visible | 53242 | 54978 | 814 | 921 | 144 / 55 / 0.38 | 1 / 18 / 17.45 | 86 / 646 | 176 / 61.7 | 407 / 141 |  |  | 6447104 → 6463488 | '-app-demo\n\nRun completed' | 3.5 |
| A1-chatB2 | tool | visible/visible | 4107 | 5806 | 498 | 570 | 86 / 27 / 0.31 | 1 / 21 / 20.97 | 52 / 418 | 110 / 32.2 | 249 / 72 |  |  | 6463488 → 6463488 | '-app-demo\n\nRun completed' | 4.6 |
| A1-chatB4 | tool | visible/visible | 2117 | 3808 | 482 | 504 | 78 / 24 / 0.31 | 1 / 19 / 18.97 | 52 / 376 | 110 / 28.2 | 241 / 57 |  |  | 6463488 → 6471680 | '-app-demo\n\nRun completed' | 4.1 |
| A1i-chatA1 | word | visible/visible | 2047 | 3870 | 294 | 314 | 58 / 18 / 0.31 | 1 / 26 / 25.89 | 28 / 213 | 60 / 16.5 | 147 / 41 | 14 | 59 | 6438912 → 6447104 | 'oning\n\nok\n\nRun completed' | 6.8 |
| A1i-chatB1 | word | visible/visible | 4831 | 6736 | 294 | 306 | 58 / 16 / 0.28 | 1 / 23 / 22.68 | 28 / 214 | 60 / 15.9 | 147 / 37 | 14 | 59 | 6463488 → 6463488 | 'oning\n\nok\n\nRun completed' | 7.3 |
| A1i-chatB3 | word | visible/visible | 7218 | 8958 | 320 | 337 | 61 / 15 / 0.25 | 1 / 25 / 25.11 | 32 / 237 | 66 / 18.5 | 160 / 41 | 16 | 62 | 6463488 → 6463488 | 'oning\n\nok\n\nRun completed' | 6.3 |
| A1i-chatA2 | tool | visible/visible | 3384 | 5077 | 490 | 535 | 82 / 27 / 0.32 | 1 / 22 / 21.5 | 52 / 388 | 110 / 32.9 | 245 / 66 | 25 | 84 | 6447104 → 6463488 | '-app-demo\n\nRun completed' | 6.6 |
| A1i-chatB2 | tool | visible/visible | 4598 | 6354 | 498 | 578 | 86 / 26 / 0.3 | 1 / 20 / 20.1 | 52 / 422 | 110 / 34.3 | 249 / 76 | 25 | 88 | 6463488 → 6463488 | '-app-demo\n\nRun completed' | 7.0 |
| A1i-chatB4 | tool | visible/visible | 4982 | 6782 | 498 | 549 | 86 / 26 / 0.3 | 1 / 15 / 14.85 | 52 / 413 | 110 / 30.5 | 249 / 65 | 25 | 88 | 6463488 → 6471680 | '-app-demo\n\nRun completed' | 6.2 |
| D-chat1 | word | visible/visible | 9022 | 10888 | 294 | 430 | 58 / 17 / 0.3 | 1 / 32 / 31.69 | 28 / 330 | 60 / 14.5 | 147 / 36 |  |  | 12435456 → 12435456 | 'oning\n\nok\n\nRun completed' | 5.1 |
| D-chat2 | tool | visible/visible | 5640 | 7536 | 490 | 786 | 82 / 25 / 0.3 | 1 / 34 / 34.33 | 52 / 641 | 110 / 27.2 | 245 / 60 |  |  | 12435456 → 12435456 | '-app-demo\n\nRun completed' | 4.6 |
| DP-chat1 | word | visible/visible | 1597 | 3405 | 286 | 289 | 54 / 16 / 0.31 | 1 / 21 / 20.83 | 28 / 199 | 60 / 14.4 | 143 / 39 |  |  | 6438912 → 6447104 | 'oning\n\nok\n\nRun completed' | 3.4 |
| DP-chat2 | tool | visible/visible | 3812 | 5666 | 482 | 521 | 78 / 22 / 0.28 | 1 / 24 / 23.76 | 52 / 388 | 110 / 29.0 | 241 / 59 |  |  | 6447104 → 6463488 | '-app-demo\n\nRun completed' | 6.2 |

## 4. Requests

From the page through the service connection, idle editor, ms:

| state | request | response bytes | n | ms each | median ms | tab |
|---|---|---|---|---|---|---|
| B0i | GET /api/session (0 sessions) | 50 | 6 | 111.4, 93.7, 88.2, 87.7, 87, 87.5 | 88.0 | visible |
| B0i | GET /api/session (4 sessions) | 1767 | 5 | 102.8, 91.2, 90.6, 90, 90.4 | 90.6 | visible |
| B0i | GET /api/session/:sid/message (4 sessions) | 7178 | 5 | 179.6, 177.9, 176.9, 183.8, 180.6 | 179.6 | visible |
| F | GET /api/session (0 sessions) | 50 | 6 | 9.5, 4.2, 3.3, 3.5, 2.2, 2.3 | 3.4 | visible |
| F | GET /api/session (4 sessions) | 1741 | 5 | 7.7, 3.9, 2.9, 2, 3.9 | 3.9 | visible |
| F | GET /api/session/:sid/message (4 sessions) | 7163 | 5 | 4.3, 3, 2.3, 2.1, 2.4 | 2.4 | visible |
| Fi | GET /api/session (0 sessions) | 50 | 6 | 9.9, 3.9, 2.3, 3.1, 2.8, 2.5 | 3.0 | visible |
| Fi | GET /api/session (4 sessions) | 1844 | 5 | 54.3, 2, 1.3, 1.3, 1.1 | 1.3 | visible |
| Fi | GET /api/session/:sid/message (4 sessions) | 7162 | 5 | 2.5, 2, 1.9, 1.8, 2.3 | 2.0 | visible |
| A1 | GET /api/session (0 sessions) | 50 | 6 | 7.4, 2.6, 3, 2.3, 3.3, 2.8 | 2.9 | visible |
| A1 | GET /api/session (4 sessions) | 1765 | 5 | 5.3, 2.1, 1.5, 2, 2 | 2.0 | visible |
| A1 | GET /api/session/:sid/message (4 sessions) | 7163 | 5 | 3.4, 2.2, 2.1, 3.5, 2.2 | 2.2 | visible |
| A1i | GET /api/session (0 sessions) | 50 | 6 | 8.1, 3.4, 4, 3.6, 2.5, 2.8 | 3.5 | visible |
| A1i | GET /api/session (4 sessions) | 1773 | 5 | 6.5, 3.9, 6.5, 4.9, 8 | 6.5 | visible |
| A1i | GET /api/session/:sid/message (4 sessions) | 7144 | 5 | 3.1, 2.2, 2.5, 2, 1.8 | 2.2 | visible |

## 5. Workspace switches

Two workspaces with 2 (WS-A) and 4 (WS-B) sessions, three retained and three full
(`?workspaceSwitch=full`) switches per state, alternating direction. `D4` is the
durability run (WS-B with 6 sessions, 12.4 MB database).

| state | path | n | total | capture | stop | replace | start | deliver | vite | ocBoot | restore | attach | select |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0i | retained | 3 | 11096 (10657–11129) | 1267 (755–1314) | 1 (1–1) | 69 (69–102) | 9764 (9245–10202) |  | 4557 (4353–4803) |  | 3185 (3159–3896) | 1049 (1039–1114) | 667 (648–677) |
| B0i | full | 3 | 18602 (18565–18635) | 763 (760–1321) | 22 (20–24) | 151 (149–154) | 17615 (17089–17691) | 1470 (1452–1485) | 4645 (4607–4730) | 5796 (5688–5814) | 3970 (3316–3982) | 1023 (1019–1055) | 647 (638–727) |
| F | retained | 3 | 4767 (4613–4864) | 26 (21–27) | 1 (1–1) | 78 (78–83) | 4631 (4487–4740) |  | 4322 (4212–4400) |  | 265 (231–295) | 16 (15–17) | 7 (6–7) |
| F | full | 3 | 8038 (8021–8040) | 26 (20–28) | 18 (17–27) | 157 (156–163) | 7818 (7795–7824) | 1446 (1441–1460) | 4517 (4501–4528) | 1469 (1449–1475) | 263 (235–280) | 20 (19–21) | 8 (8–8) |
| Fi | retained | 3 | 4964 (4802–5006) | 22 (21–22) | 1 (1–2) | 78 (72–81) | 4832 (4684–4898) |  | 4503 (4390–4558) |  | 285 (250–295) | 17 (17–18) | 7 (7–7) |
| Fi | full | 3 | 8260 (8233–8429) | 20 (18–31) | 20 (19–20) | 150 (149–150) | 8043 (8016–8218) | 1488 (1459–1523) | 4714 (4647–4751) | 1502 (1478–1524) | 279 (243–283) | 20 (19–23) | 8 (8–9) |
| A1 | retained | 3 | 4890 (4706–4902) | 25 (22–26) | 1 (1–1) | 74 (74–82) | 4770 (4582–4770) |  | 4430 (4289–4443) |  | 282 (251–295) | 16 (16–17) | 7 (6–7) |
| A1 | full | 3 | 8312 (8196–8455) | 24 (18–27) | 23 (23–25) | 154 (146–165) | 8091 (7970–8241) | 1485 (1446–1506) | 4564 (4552–4791) | 1584 (1572–1619) | 269 (238–276) | 20 (19–20) | 8 (8–9) |
| A1i | retained | 3 | 4877 (4845–5034) | 25 (21–29) | 1 (1–1) | 80 (77–103) | 4751 (4727–4893) |  | 4466 (4434–4556) |  | 250 (239–292) | 17 (16–18) | 7 (7–7) |
| A1i | full | 3 | 8468 (8347–8669) | 23 (20–31) | 25 (20–34) | 165 (153–169) | 8221 (8106–8453) | 1449 (1443–1510) | 4747 (4638–5024) | 1593 (1580–1600) | 280 (243–286) | 20 (20–22) | 9 (8–9) |
| D4 | retained | 2 | 5147 (5142–5152) | 34 (25–42) | 2 (1–2) | 77 (74–80) | 5005 (4997–5013) |  | 4342 (4295–4390) |  | 608 (557–659) | 24 (20–29) | 9 (8–10) |
| D4 | full | 2 | 8429 (8330–8528) | 30 (21–40) | 20 (18–22) | 156 (151–162) | 8193 (8075–8311) | 1422 (1420–1425) | 4492 (4450–4533) | 1570 (1566–1575) | 580 (507–653) | 20 (19–20) | 8 (7–8) |

- Retained: 11.1 → 4.8 s. What is left is Vite's restart (4.3 s of 4.8 s).
  Session delete + re-import went from 3.2–3.9 s to 0.27 s, chat attach from 1.05 s to
  16 ms, session select from 0.67 s to 7 ms, capture from 0.76–1.3 s to 26 ms.
- Full: 18.6 → 8.0 s. OpenCode's listen + connect went from 5.8 s to 1.47 s.
- Workspace save: 780 and 1308 ms on the old pin, 40 and 48 ms on the new one.

| state | label | path | total | capture | stop | replace | start | deliver | vite | ocBoot | restore | attach | select | visible | pid | sessions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0i | B0i-sw1-R-to-A | retained | 11129 | 1267 | 1 | 69 | 9764 |  | 4803 |  | 3159 | 1114 | 667 | visible | 3 | 2 |
| B0i | B0i-sw2-R-to-B | retained | 11096 | 755 | 1 | 102 | 10202 |  | 4557 |  | 3896 | 1049 | 677 | visible | 3 | 4 |
| B0i | B0i-sw3-R-to-A | retained | 10657 | 1314 | 1 | 69 | 9245 |  | 4353 |  | 3185 | 1039 | 648 | visible | 3 | 2 |
| B0i | B0i-sw4-F-to-B | full | 18635 | 760 | 20 | 151 | 17691 | 1485 | 4645 | 5814 | 3970 | 1023 | 638 | visible | 14 | 4 |
| B0i | B0i-sw5-F-to-A | full | 18602 | 1321 | 24 | 149 | 17089 | 1470 | 4730 | 5796 | 3316 | 1019 | 647 | visible | 17 | 2 |
| B0i | B0i-sw6-F-to-B | full | 18565 | 763 | 22 | 154 | 17615 | 1452 | 4607 | 5688 | 3982 | 1055 | 727 | visible | 20 | 4 |
| F | F-sw1-R-to-A | retained | 4767 | 27 | 1 | 83 | 4631 |  | 4322 |  | 265 | 17 | 7 | visible | 3 | 2 |
| F | F-sw2-R-to-B | retained | 4864 | 21 | 1 | 78 | 4740 |  | 4400 |  | 295 | 15 | 7 | visible | 3 | 4 |
| F | F-sw3-R-to-A | retained | 4613 | 26 | 1 | 78 | 4487 |  | 4212 |  | 231 | 16 | 6 | visible | 3 | 2 |
| F | F-sw4-F-to-B | full | 8021 | 28 | 17 | 163 | 7795 | 1446 | 4501 | 1449 | 280 | 19 | 8 | visible | 14 | 4 |
| F | F-sw5-F-to-A | full | 8038 | 26 | 18 | 156 | 7824 | 1460 | 4528 | 1475 | 235 | 20 | 8 | visible | 17 | 2 |
| F | F-sw6-F-to-B | full | 8040 | 20 | 27 | 157 | 7818 | 1441 | 4517 | 1469 | 263 | 21 | 8 | visible | 20 | 4 |
| Fi | Fi-sw1-R-to-A | retained | 4802 | 21 | 1 | 78 | 4684 |  | 4390 |  | 250 | 18 | 7 | visible | 3 | 2 |
| Fi | Fi-sw2-R-to-B | retained | 5006 | 22 | 2 | 72 | 4898 |  | 4558 |  | 295 | 17 | 7 | visible | 3 | 4 |
| Fi | Fi-sw3-R-to-A | retained | 4964 | 22 | 1 | 81 | 4832 |  | 4503 |  | 285 | 17 | 7 | visible | 3 | 2 |
| Fi | Fi-sw4-F-to-B | full | 8260 | 18 | 20 | 150 | 8043 | 1488 | 4647 | 1502 | 279 | 19 | 8 | visible | 14 | 4 |
| Fi | Fi-sw5-F-to-A | full | 8233 | 31 | 19 | 150 | 8016 | 1459 | 4714 | 1478 | 243 | 20 | 8 | visible | 17 | 2 |
| Fi | Fi-sw6-F-to-B | full | 8429 | 20 | 20 | 149 | 8218 | 1523 | 4751 | 1524 | 283 | 23 | 9 | visible | 20 | 4 |
| A1 | A1-sw1-R-to-A | retained | 4902 | 26 | 1 | 82 | 4770 |  | 4443 |  | 282 | 17 | 6 | visible | 3 | 2 |
| A1 | A1-sw2-R-to-B | retained | 4890 | 22 | 1 | 74 | 4770 |  | 4430 |  | 295 | 16 | 7 | visible | 3 | 4 |
| A1 | A1-sw3-R-to-A | retained | 4706 | 25 | 1 | 74 | 4582 |  | 4289 |  | 251 | 16 | 7 | visible | 3 | 2 |
| A1 | A1-sw4-F-to-B | full | 8312 | 18 | 23 | 165 | 8091 | 1506 | 4564 | 1619 | 276 | 19 | 9 | visible | 14 | 4 |
| A1 | A1-sw5-F-to-A | full | 8455 | 27 | 23 | 146 | 8241 | 1485 | 4791 | 1584 | 238 | 20 | 8 | visible | 17 | 2 |
| A1 | A1-sw6-F-to-B | full | 8196 | 24 | 25 | 154 | 7970 | 1446 | 4552 | 1572 | 269 | 20 | 8 | visible | 20 | 4 |
| A1i | A1i-sw1-R-to-A | retained | 4877 | 29 | 1 | 80 | 4751 |  | 4466 |  | 239 | 18 | 7 | visible | 3 | 2 |
| A1i | A1i-sw2-R-to-B | retained | 5034 | 21 | 1 | 103 | 4893 |  | 4556 |  | 292 | 17 | 7 | visible | 3 | 4 |
| A1i | A1i-sw3-R-to-A | retained | 4845 | 25 | 1 | 77 | 4727 |  | 4434 |  | 250 | 16 | 7 | visible | 3 | 2 |
| A1i | A1i-sw4-F-to-B | full | 8347 | 20 | 34 | 169 | 8106 | 1449 | 4638 | 1600 | 286 | 22 | 9 | visible | 14 | 4 |
| A1i | A1i-sw5-F-to-A | full | 8468 | 31 | 20 | 165 | 8221 | 1510 | 4747 | 1593 | 243 | 20 | 8 | visible | 17 | 2 |
| A1i | A1i-sw6-F-to-B | full | 8669 | 23 | 25 | 153 | 8453 | 1443 | 5024 | 1580 | 280 | 20 | 9 | visible | 20 | 4 |
| D4 | D4-sw1-R-to-A | retained | 5152 | 42 | 2 | 74 | 4997 |  | 4390 |  | 557 | 20 | 8 | visible | 3 | 2 |
| D4 | D4-sw2-R-to-B | retained | 5142 | 25 | 1 | 80 | 5013 |  | 4295 |  | 659 | 29 | 10 | visible | 3 | 6 |
| D4 | D4-sw3-F-to-A | full | 8330 | 40 | 22 | 162 | 8075 | 1420 | 4450 | 1566 | 507 | 19 | 7 | visible | 10 | 2 |
| D4 | D4-sw4-F-to-B | full | 8528 | 21 | 18 | 151 | 8311 | 1425 | 4533 | 1575 | 653 | 20 | 8 | visible | 13 | 6 |

## 6. Does the model list in the database still cost anything worth fixing?

Yes, something; no longer much. Per-statement cost at the two sizes, final build:

| | 475 KB (fresh, before the list lands) | 6.44 MB (after) | old pin at 6.44 MB |
|---|---|---|---|
| autocommit read | 0.2 ms | 0.26 ms | 88 ms |
| statement that writes (one image rewrite) | 3.3 ms | 13.9 to 15.3 ms (21.9 for the two at boot) | 88 ms |
| statement inside a transaction | 0.2 ms | 0.2 to 0.3 ms | 0.2 to 0.3 ms |

Reads no longer depend on size at all. A real write is still linear in the image size
because the whole image is exported and rewritten in OPFS. The size probe on the pinned
build (scratch database; medians; ms), now the same for compressible and random fill:

```text
P-probe-x-rows: fill=x shape=rows visible=visible open=5.95 error=None
  bytes      prepare  read(autocommit)  write(autocommit)  read.tx  write.tx  commit
      24576    0.22      0.28 [0.2-0.3]      1.53      0.17    0.21     1.62
    1073152    0.19      0.15 [0.1-0.2]      3.91      0.18    0.16     3.11
    1073152    0.16      0.16 [0.1-0.2]      3.18      0.15    0.13     2.93
    2121728    0.13      0.14 [0.1-0.2]      4.63      0.13    0.13     4.44
    4218880    0.16      0.16 [0.1-0.2]      7.64      0.15    0.14     8.91
    6316032    0.13      0.14 [0.1-0.2]     10.63      0.13    0.13    17.09
    8413184    0.14      0.17 [0.1-0.2]     17.34      0.20    0.13    17.45
   12623872    0.15      0.13 [0.1-0.2]     24.88      0.13    0.13    22.57
   16818176    0.15      0.16 [0.1-0.2]     39.15      0.15    0.15    29.44
P-probe-random-rows: fill=random shape=rows visible=visible open=7.85 error=None
  bytes      prepare  read(autocommit)  write(autocommit)  read.tx  write.tx  commit
      24576    0.22      0.24 [0.1-0.3]      1.95      0.20    0.18     1.60
    1073152    0.17      0.18 [0.1-0.2]      3.02      0.14    0.26     2.98
    1073152    0.13      0.18 [0.1-0.3]      2.97      0.14    0.13     3.15
    2121728    0.17      0.15 [0.1-0.2]      4.40      0.14    0.14     4.43
    4218880    0.15      0.18 [0.1-0.2]      7.13      0.13    0.13     8.59
    6316032    0.18      0.17 [0.2-0.2]     10.30      0.13    0.13    10.14
    8413184    0.15      0.16 [0.1-0.2]     13.61      0.14    0.13    15.90
   12623872    0.16      0.16 [0.1-0.2]     23.01      0.13    0.14    23.44
   16818176    0.13      0.14 [0.1-0.2]     31.97      0.14    0.13    26.33
P-probe-x-one: fill=x shape=one visible=visible open=7.55 error=None
  bytes      prepare  read(autocommit)  write(autocommit)  read.tx  write.tx  commit
      24576    0.21      0.23 [0.2-0.3]      1.63      0.18    0.17     1.51
    6316032    0.14      0.14 [0.1-0.2]     10.72      0.13    0.15    11.18
   13656064    0.13      0.13 [0.1-0.2]     23.48      0.15    0.14    22.33
```

That is about 1.5 ms + 1.6 to 2.2 ms/MB per write (before: 1.5 ms + 3.3 to 32 ms/MB
depending on compressibility, and the same for every read).

What the list still costs, and so what `models: { fetch: false }` would still save:

| Where | Cost with the list (measured) | Without it (estimate) | Saving |
|---|---|---|---|
| Reopen boot | two reads of the 6 MB row inside activation, 133 ms each (126–139, n = 11); 2 rewrites at 14–22 ms instead of 3 ms | activation about 484 → 200 ms | about 0.29 s of 1.48 s spawn → attached (20%) |
| Fresh boot | the insert, 272 ms (268–282, n = 3), then one read of it, 133 ms; lands in the chat attach | attach about 520 → 20 ms | about 0.4 s of 2.16 s (not on the path to the first answer) |
| One-word reply | 14–16 rewrites at about 14.5 ms | at about 3.3 ms | about 0.16 s of 0.30 s of SQLite (send → idle was 1.3 to 2.1 s) |
| One-tool-call reply | 25–27 rewrites | | about 0.28 s of 0.52 s of SQLite (send → idle 2.8 to 6.9 s) |
| Every 5 minutes | one read of the row (a 0.13 s stall) and a download of the catalog | none | not re-measured in this run |
| When the upstream catalog changes | the row is rewritten and the file doubles: 6,471,680 → 12,435,456 bytes, **observed live at 19:22** (catalog 5,289,702 → 5,291,987 bytes between 18:38 and 19:23). Rewrites then cost 24 to 34 ms: one-word reply 430 ms of SQLite instead of 300, tool-call 786 instead of 520 | no doubling | grows with each change until SQLite reuses the freed pages |

The estimates are the measured rewrite counts times the measured per-rewrite
difference between the two sizes, and the measured duration of the statements that
carry the row; a chat at 475 KB could not be measured because the list lands within a
second of every boot.

Why the read of the row still costs 133 ms when it no longer persists: 10 ms is in the
kernel's SQLite; the rest is the exchange itself (the row as JSON in a response file,
which the kernel writes through the compressing `vfs.write_file`, then read, inflated
and parsed by the guest). That is a runtime cost that could be reduced without touching
OpenCode.

What changing the setting would require (not done):

- `models: { fetch: true }` is in `vivari/experiments/opencode-release-server/server.ts`,
  which is a recorded input of the server bundle: its hash is in the build receipt's
  `recipe`. Changing it means rebuilding the 27.7 MB `server.js` (`bun run build` there),
  whose bytes and SHA-256 are pinned as the qualification identity in
  `opencode-chat/src/opencode-application.ts` and whose packaged archive is pinned by URL
  and SHA-256 in `vivari/opencode-input.json` (a GitHub release asset,
  `opencode-input-2.0.3/opencode-2.0.3-live-catalog-qualified.tgz`). So: rebuild,
  publish a new release asset, update both pins, and re-qualify in the browser. Yes, it
  is a rebuild of a pinned, hash-verified artifact.
- It also reverses a deliberate choice: the source comment says "Refresh the official
  catalog; embedded free-model IDs can be retired", and the archive is named
  "live-catalog-qualified". With fetch off the server uses its bundled snapshot.

## Offline

Fork (`vendor/vivari`, Node 24.13.0), before any edit and at `f9893bd`
(`.diagnostics/runtime-fixes-2026-10-01/offline/baseline/`, `final-f9893bd/`):

| | before | after |
|---|---|---|
| 15 runtime contracts, one process each | 11 pass, 4 fail (`worker-uncloneable`, `brotli`, `shell-quoting`, `process-warning`) | same 11 / same 4 |
| `test-single-kernel`, `-review`, `-close`, `-lifecycle`, `-routing`, `test-sync-capture`, `test-kernel-fs-completion`, `test-kernel-fetch-join`, `test-endpoint-cleanup`, `test-process-egress-cleanup`, `verify-node` (165 checks), `spike-compress`, `install-tree.test`, core `tsc --noEmit` | all pass | all pass |
| `spike-esm` | pass, 22 checks | pass, 31 checks (9 added) |
| `spike-bun-offline` | fails (1144 pass, then `bun:sqlite is registered as a bun:* module` throws) | same |
| `test-sqlite-persist` (new) | | pass |
| `test-module-plan-cache` (new) | | pass |

- `test-sqlite-persist`: real SQLite server, Rust VFS and write-behind mirror over an
  in-memory OPFS twin. Holds that outside a transaction the mirror equals the live
  database after each of 47 statement kinds (exec and prepared, new and reloaded
  database), and the rewrite counts (reads, prepares, connection PRAGMAs, rollbacks: 0;
  each committed change: 1; survives a restart). It fails against a `total_changes`
  rule (at the first `CREATE TABLE`) and against the old always-persist behaviour.
- `test-module-plan-cache`: real kernel and guest workers. A record is applied only to
  the exact source, path and transpiler; damaged records are replaced; errors and
  results match an uncached load.
- Transpile of the real bundle in Node 24: 1081 to 1149 ms → 284 to 292 ms, identical
  bytes (`offline/esm-bench*.json`, `esm-corpus*.json`).

Toolkit, before and after the pin move (`offline/toolkit-baseline/`, `toolkit-after/`):

| Package | typecheck | tests before | tests after |
|---|---|---|---|
| `workspace-api` | clean | 96 pass | 96 pass |
| `opencode-chat` | clean | 155 pass, 2 skip, 2 fail, 1 error | 155 pass, 2 skip, 2 fail, 1 error (three consecutive runs; the first run after the move, made while other suites ran, had two more timing-dependent failures that did not recur) |
| `examples/todo-app` | 23 errors, all in `experiments/` and `tests/` | 182 pass, 17 skip, 2 fail, 1 error | same |
| `vivari` | | 4 pass | 4 pass |

The `todo-app` baseline in this worktree is not the 186 / 1 fail it was briefed as:
`tests/start-editor.test.ts` has failed to load since the tracing commit (`40411b7`)
because its module mock has no `openCodeTrace` export. Before and after are identical.

Pin procedure (DEVELOPMENT.md): `runtime-source.json` now records `f9893bd` and the
branch that carries it. `bun vivari/scripts/build-runtime.ts --release` passed (clean
source at the recorded revision); `setup-runtime.ts` cloned the fork at that revision
into a scratch directory; `bun run setup` passed. No native input changed: the native
build did not re-run and the four Wasm hashes equal the fork's
`docs/single-kernel-build.md`. Licenses, provenance fields and receipt verification
are untouched.

## Slower, or behaving differently

- On a fresh boot the model list write now lands after activation, in some samples in
  the chat attach (0.5 s there instead of 0.03 to 0.3 s; section 2). Spawn → attached is
  lower in every sample.
- A start that finds no plan record pays the hash and the record write: +11 ms on the
  transpile (386 → 397 ms, `S3i` → `Fi`, within the spread).
- The kernel holds the database image raw in VFS memory: about 4.8 MB more for this
  database (offline figure; not measured live).
- A small JSON record per very large module appears under `/var/lib/vivari/module-plans`
  in the VFS and its OPFS mirror (27 KB for the bundle; the directory is emptied at 32).
- Opening an existing database no longer writes to OPFS, so an OPFS failure on that file
  is reported at the first write instead of at open.
- `ROLLBACK`, a read-only `COMMIT`, connection PRAGMAs and reads no longer touch OPFS.
  Nothing a guest can observe through `node:sqlite` changes.
- The first statement on a newly created database rewrites its (8 KB) image once more
  than needed (above); every later read is free.

## Not verified

- The five-minute refresh tick after the fixes (one refresh-triggered rewrite was seen,
  at a reopen, not the periodic tick).
- Chat or boot at 475 KB with the list absent: estimated, not measured.
- Chat, requests and switches in a controlled kernel. Reopen C is n = 3 per state.
- Anything with the tab hidden; any browser but Chrome 154; a second machine.
- OPFS failure, quota and Web Locks paths, and a kernel killed in the middle of a
  persist, live: headless tests only (the lifecycle and persist tests). The live check
  is a tab reload without Exit after the request had returned.
- The extra kernel memory of the raw image, live.
- Plan-cache eviction and its filesystem-error path, live (test and code only). That a
  record survives a reopen and is used is measured (`plan: hit` on every reopen).
- The intermediate states are n = 3, instrumented. "Before" size probes are last
  report's, not re-run.
- `bun run setup` ran against the existing checkout (it skips the clone when
  `vendor/vivari` exists); the clone at the new pin was verified separately and not
  built.

## Existing problems noticed and left alone

- `VACUUM` is refused by the SQLite server (`SQLITE_AUTH`): its authorizer denies
  `ATTACH`, which `VACUUM` uses. So the doubled database cannot be shrunk by a guest.
- The model list upsert doubles the database file (above).
- Request and response files of the SQLite exchange go through the compressing
  `vfs.write_file`; a 6 MB row costs 133 ms to read and 272 ms to insert because of it.
- The boot restore compresses the database image once per boot (about 60 ms at
  6.44 MB) and the open inflates it again.
- Reading the 27.7 MB bundle is 0.25 s per start and its evaluation 0.33 s; with the
  compile (0.15 s) that is all of the remaining bundle load.
- A kernel created in a service-worker-controlled page is still about 5 times slower.
- Vite's restart (4.3 s) is now 90% of a retained switch.
- `vivari/scripts/sqlite-headless-fs.mjs` passes a persistence object without
  `flushPath`, which the SQLite server has required since fork commit `d363959`.
- `examples/todo-app/tests/start-editor.test.ts` fails to load (above); the fork's four
  contracts and `spike-bun-offline` fail before and after.
- DEVELOPMENT.md points at a `FORK.md` in the fork that does not exist.
- The stray tab on `http://127.0.0.1:3100/?workspaceFixture=1&opencodeTrace=1` from
  the earlier run was not touched and may still be open.

## What each claim rests on

- **Live measurement (this run):** every number in sections 1 to 6 except those marked
  as estimates; the durability results; the persist counts and the load split
  (instrumented builds); the catalog change and the doubling; the hash cost in Chrome.
- **Tests:** the persistence invariant across 47 statement kinds and both request
  shapes; restart durability over the in-memory OPFS twin; the failing-statement and
  committed-prefix cases; plan-cache hit and miss rules; byte-identical transpiler
  output over the bundle and 28,138 files.
- **Code reading:** that OPFS always held plain bytes; that the remaining 123 ms of the
  model list read is the exchange path; what turning the model fetch off requires; that
  the data version covers WAL and checkpoint cases on a real file (here the database is
  in memory and those PRAGMAs are no-ops, which is what was measured).
- **Estimates:** the "without it" column of section 6; the 4.8 MB memory figure.

## Reproduce

```sh
# runtime: fork tests (from vendor/vivari, Node 24)
node scripts/test-sqlite-persist.mjs
node scripts/test-module-plan-cache.mjs
node scripts/spike-esm.mjs
node scripts/test-single-kernel-lifecycle.mjs && node scripts/test-single-kernel-close.mjs
node scripts/verify-node.mjs && node scripts/verify-runtime-contracts.mjs vm-import node-entry esm-export-comments

# pin: from the toolkit worktree root
bun vivari/scripts/build-runtime.ts --release      # clean source at runtime-source.json's revision
bun run setup
bun run build:example
cd examples/todo-app && PORT=3100 bun run editor:debug
#   http://localhost:3100/?workspaceFixture=1&opencodeTrace=1
#   await window.__openCodeTrace.dump('label', true)
```

Driver and analysis, `.diagnostics/runtime-fixes-2026-10-01/` (gitignored):

```sh
offline/fork-tests.sh <label>            # the fork's tests one by one, exit codes
offline/toolkit-tests.sh <label>         # toolkit typecheck and tests with counts
offline/mutation-check.sh                # the persist test against two wrong rules
node offline/esm-bench.mjs 5             # bundle transpile, old against new, sha256 of both
node offline/esm-corpus.mjs out.json <dirs…>   # byte-identity over a file tree
node offline/image-bench.mjs             # compressed against raw image in the VFS
node offline/dataversion-explore.mjs     # data version and stmt_readonly per statement

live/build-state.sh <label> <ref> <clean|instr>   # check out a fork commit, optionally instrument, build
live/server.sh start|stop
live/campaign.sh <prefix> <mode>…        # one traced open per mode (freshU|reopenU|reopenC)
live/scenario.sh <prefix> all            # reads, six prompts, two workspaces, six switches
live/durability.sh <prefix>              # checks 1 and 2 (reload without Exit)
live/switch-check.sh <prefix> <state>    # check 4
live/probe.sh <label> 0.5,1,2,4,6,8,12,16 <x|random> <rows|one>
live/make-tables.sh                      # every table in this document
python3 build-doc.py                     # this document from doc-template.md
```

Evidence there: `live/events-all.jsonl` (every diagnostics event of the run),
per-sample `<label>.json`/`.txt`/`.png`, `dump-<label>.json` (guest counters and the
statement log), `summary-<label>.json`, `state-<label>.json` (durability fingerprints),
`live/builds/` (a build log and receipt per state, the release receipt), `offline/`
(test logs before and after, commit messages, benches), `live/pre-existing/` (the
events log that was in place before this run). Scanned for the model key value: 0 hits.
