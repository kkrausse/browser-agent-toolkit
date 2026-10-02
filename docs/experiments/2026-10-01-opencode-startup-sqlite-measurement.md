# Where the guest OpenCode server's startup goes, and what SQLite costs (2026-10-01)

Measurement only; nothing here is optimized. Live numbers from Chrome 154 on one
machine (Apple M4 Pro, 12 cores, 24 GB, macOS 26.6.2), TODO example served from this
worktree with `PORT=3100 bun run editor:debug`, pinned runtime `2367a64`, OpenCode
server 2.0.3. Every sample was taken with the tab visible.

## Result in short

1. **SQLite cost is one mechanism, and it is not SQLite.** Every statement outside an
   explicit transaction, reads and PRAGMAs included, makes the kernel export the whole
   database image, write it to the VFS (which zlib-compresses every file over 4 KB on
   every write), read it back (inflate) and rewrite it in OPFS. Per statement, in an
   uncontrolled kernel: 1.5 ms at 24 KB, 3.7 ms at 475 KB, **86 ms at 6.44 MB**, and it
   is linear in size with a slope set by how well the image compresses (3.3 ms/MB for a
   repeated character, 13 ms/MB for the real database, 32 ms/MB for random text). The
   same statement inside a transaction costs 0.13–0.25 ms at any size measured (to 16.8 MB).
   At 6.44 MB the 86 ms splits: zlib in `vfs.write_file` 61 ms (70%), read-back 12 ms
   (13%), OPFS write 11 ms (13%), export 2 ms, manifest 0.8 ms, guest-side files 0.3 ms.
2. **The database is 6.44 MB because of one row.** OpenCode's model list refresh
   (`models: { fetch: true }`) stores the 5.97 MB `api.json` text in `kv`. On a fresh
   boot the database is 475 KB until that insert lands 0.4–0.7 s after activation
   (or inside it); the autocommit statement median then steps from 3.6–4.5 ms to
   85–92 ms (×20–24). This step was seen in every traced fresh boot (13).
3. **A reopen is mostly that.** Reopen with the 6.44 MB database, uncontrolled kernel,
   guest start to activation answered: 5.5 s (5.3–5.6, n = 7), of which SQLite 3.2 s
   (59%: 64 calls, 31 of them prepares; 32 of the other 33 rewrite the image and at most
   3 change anything), bundle load 1.95 s (36%), everything else 0.27 s (5%). The phases
   the host sees: listen→ready 1.12 s (98% SQLite), ready→first HTTP answer 0.37 s (97%
   SQLite), activation 1.97 s (90% SQLite). A fresh boot is 2.2–2.4 s to activation
   answered, 83% of it bundle load (3.1–3.4 s when the model list write falls inside
   activation).
4. **Bundle load is 1.9–2.0 s, about half of it the ESM-to-CJS transpile**: read 258 ms,
   transpile 1014–1079 ms, compile 279–304 ms (126–145 ms of that is the first attempt
   that always fails on top-level await), synchronous evaluation 328–336 ms. From a
   temporarily instrumented runtime, n = 3 uncontrolled.
5. **Event-loop stall is not a third cost.** The bundle load and every SQLite call are
   synchronous, so the guest cannot answer HTTP while they run. Max single stall:
   1.9–2.1 s fresh, 3.0–3.1 s reopen, 6.1–23.5 s in a slow controlled kernel. "Ready but
   not answering" is SQLite; no separate event-loop problem was found.
6. **One chat turn costs seconds of SQLite.** A one-word prompt: 270 SQLite calls,
   5.4 s of SQLite between the dumps around an 8.0 s send-to-idle. A prompt with one
   tool call: 444 calls, 7.9 s (9.4 s send-to-idle). Session list 90 ms (one read), a
   message page 178 ms (two reads); SQLite is 98–99% of both.
7. **The earlier "request latency doubles mid-run" step is the same mechanism with a
   database twice the size.** Not reproduced with the real refresh; shown with the
   probe: replacing a 6 MB row by upsert grew the file from 6.32 MB to 13.66 MB (the old
   pages are freed, not reused in that statement), and the bundle rewrites the row
   whenever the upstream catalog's digest changes (checked every 5 minutes).
8. **A kernel created in a service-worker-controlled page was 3–4× slower at all of
   this in 14 of 17 opens** (bundle load 7.0–9.8 s, 270–400 ms per statement); it is
   CPU, not I/O (transpile and zlib slow down by the same factor). Three consecutive
   controlled reopens were as fast as uncontrolled ones. Not explained.
9. Tracing changes nothing measurable: spawn→attached 6014 ms off against 5984 ms on
   (reopen, n = 3 each), 3540 against 3558 (fresh, n = 3 each).

Commits on `feat/todo-editor-diagnostics`: `40411b7` (tracing entry and plumbing),
`2017b5e` (dump carries a locally instrumented runtime's timings), and this document.

## The tracing capability

Opt-in, off by default. Add `opencodeTrace=1` to the TODO example's URL
(`http://localhost:3100/?workspaceFixture=1&opencodeTrace=1`), read in
`examples/todo-app/src/start-editor.ts` the way `?workspaceSwitch=full` is read in
`workspace-editor.tsx`. It passes `trace: true` to two existing calls:

- `installOpenCodeConfig(workspace, { …, trace: true })` writes
  `opencode-chat/src/opencode-trace-guest.cjs` (shipped as text through a Bun macro,
  like the JavaScript plugin) to `/workspace/.server/trace/opencode-trace.cjs`;
- `startOpenCode(controller, { …, trace: true })` launches
  `/bin/bun.js /workspace/.server/trace/opencode-trace.cjs` instead of
  `/bin/bun.js /app/server.js`.

Without the option the launch object is identical to before
(`.diagnostics/…/launch-equality.ts` compares it with the literal the launch test
asserts; the events log shows `args: ["/app/server.js"]` for every untraced sample).
A traced visit leaves the entry file in the workspace's `.server/trace/`; nothing reads
it unless tracing is on.

Checked in the runtime and bundle source before building:

- The bundle imports `DatabaseSync` from `node:sqlite` twice (`server.js` lines 55288 and
  522291); `bun:sqlite` is not used. In the guest, `node:sqlite` is
  `vendor/vivari/packages/runtime/builtins/sqlite.js`, one object per process, so
  prototype patches made before the bundle loads are what the bundle calls.
- OpenCode calls `native.prepare(sql)` then `statement.all(...)` for every query: two
  exchanges per statement. The first (prepare) does not persist and costs 0.2–0.3 ms.
- `/bin/bun.js` runs its file through `module.runMain`. The entry calls
  `module.runMain('/app/server.js')` itself after setting `argv[1]`, so the server is
  the process entry module exactly as in a direct launch, and its top-level-await
  promise is the one the runtime tracks.
- The host's requests reach the guest server through a loopback `http.request` made
  inside the guest; those show up in the outbound wrapper and are counted apart.

What the entry records (`opencode-trace-guest.cjs`):

| What | How |
|---|---|
| SQLite | `DatabaseSync` open, `prepare`, `exec`, statement `run`/`get`/`all`/`values`; count, time, histogram, exact median/p95/p99 per class; classes `open`, `prepare`, `read`, `write`, `txn`, and `read.tx`/`write.tx` for statements inside an explicit transaction; top statements by total time. SQL text has string literals and long numbers removed and is cut to 160 characters. Bound values are never read; only their total length is recorded. |
| Event loop | 50 ms interval timer; lateness per tick; max per window and overall, counts over 50 and 250 ms. The timer is about 5 ms late on an idle guest, so the summed "total" has a floor of about 10% of wall time and only the max and the counts are used below. |
| Outbound | `globalThis.fetch` and `node:http(s)` `request`/`get`: count, time to response headers, status, origin + path only. A guest `fetch` to a loopback address is also seen as an `http` request; the same request then appears twice. |
| Served | `http.Server` `listen`, `listening`, and every request: method, route (ids replaced), status, duration, SQLite calls and time while it was in flight, how many other requests overlapped. |
| Modules | `Module._load` for non-builtin requests: count and time. |
| Database size | `fs.statSync('/runtime-probe/opencode.sqlite').size` at every mark, in every window with SQLite activity, and around any statement over 500 ms or with over 100 KB of arguments. Observable without runtime changes because the kernel writes the image to that VFS path on every persist. |
| Marks | `start`, `import-start`, `import-sync-end`, `listen-call`, `listening`, `ready` (the `OPENCODE_SERVER_PROCESS_READY` line), `first-request`, `first-response`, `activation-start`, `activation-end`. Each carries the cumulative counters, so a phase is a difference of two marks. |

Output: one-line JSON on stdout prefixed `OPENCODE_TRACE ` (`start`, `mark`, `top`,
`win`, `req`, `out`, `big`, `dump`, `end`), bounded in count and length, carried by the
existing `guest.output` capture into `examples/todo-app/.diagnostics/editor/events.jsonl`.
On demand, `GET /__opencode_trace` on the guest server (same Basic authorization)
returns the full counters; `detail=1` adds the per-statement log;
`probe=1,2,4&fill=x|random&shape=rows|one` runs the size probe. The example exposes it
as `window.__openCodeTrace.dump(label, detail, { megabytes, fill, shape })`.

The size probe opens a scratch database beside the real one
(`/runtime-probe/opencode-trace-probe.sqlite`), grows it to each size inside a
transaction, and at each size times 5 prepares + autocommit reads, 3 autocommit writes,
3 reads and 3 writes inside a transaction and the commit. It is excluded from the
server's statistics, blocks the guest while it runs, and deletes its file.

## Method

- **Server**: `cd examples/todo-app && PORT=3100 bun run editor:debug`. Port 3000 was
  not used. Model `muse-spark-1.3` through the Zen proxy with the key in `.env.local`
  (evidence scanned for the key value: 0 hits).
- **Browser**: Browser Control CLI 0.8.2, one session, one session-owned tab.
  `window.__editorTimings` gave visibility and hidden time per operation: every sample
  below is `visible` at start and end with `hiddenMs` 0.
- **Modes**. `fresh`: this origin's OPFS, IndexedDB and caches cleared first (database
  starts empty). `reopen`: storage kept (database 6,438,912 bytes from the previous
  session). `U`: the service worker unregistered before the reload, so the kernel is
  created in an uncontrolled page. `C`: service worker kept, kernel created controlled;
  this is what an ordinary reload gives. The two letters were separated because the
  earlier runs found controlled kernels 4× slower, which would otherwise be read as a
  storage effect.
- **Each sample**: Exit the editor, clear/unregister as the mode says, reload, click
  Open editor, wait until usable, wait 10 s, fetch the dump with the statement log.
- **Host phases** come from the diagnostics events (`service.spawn.start`,
  `service.listen.ready`, the `guest.output` event carrying the ready line,
  `opencode.readiness.request.*`), so they are available with tracing off as well.
  **Guest phases** are differences of the guest's marks.
- **Load average** (1 min) was 3.9–10.2 throughout; other work was running on the machine.

### What went wrong during the run

- 00:11:27Z: during the third sample on `http://127.0.0.1:3100`, Browser Control lost
  its tab (every attached tab in the browser detached at that moment, 4 targets to 1;
  the cause is not known) and opened a new blank tab for the session. The first tab was
  not closed: it kept running the editor and kept the origin's storage owner lock
  (`vivari-vfs-owner`), and it could no longer be reached. The driver's origin guard
  stopped the remaining steps of that campaign.
- The run continued in the session's new tab on `http://localhost:3100`, which the
  example's loopback admin check also accepts and which is a separate origin with its
  own storage and lock. All samples named `L…`, `O…`, `P…`, `Q…`, `I…`, `Z…` are from
  that origin; `smoke-…` and `T1-…` are from `127.0.0.1`. From 00:11Z on the lost tab
  ran an idle second kernel in the background of the same browser.
- **The lost tab is still open** (it was still posting events at 00:57:32Z) and has to
  be closed by hand: `http://127.0.0.1:3100/?workspaceFixture=1&opencodeTrace=1`.

### Chronology (UTC, 2026-10-01 23:57 to 2026-10-02 00:58)

| Time | What |
|---|---|
| 23:57 | Server up. `smoke-01` fresh boot with the first tracing build: works. First sight of the step: `GET /api/session` 97 ms, 2 calls, after the model list insert took the database from 475 KB to 6.44 MB. |
| 23:59 | `smoke-02` reopen: 72 calls, 14.8 s of SQLite. Added the on-demand dump and the size probe. |
| 00:05–00:09 | `smoke-03` fresh, probe to 16 MB: linear, 0.15 ms inside a transaction. `smoke-04` reopen, probe with random text: 10× the cost of a repeated character at equal size. Found `maybe_compress` in the VFS. Committed the tracing (`40411b7`). |
| 00:09–00:11 | Campaign on `127.0.0.1`: `T1-freshU`, `T1-reopenC`; tab lost during `T1-reopenU`. |
| 00:16–00:26 | Campaign 1 on `localhost`, tracing on: 3 × (freshU, reopenC, reopenU), freshC, reopenC, freshC. |
| 00:27–00:36 | Campaign 2, overhead: 3 × (reopenU off, on), 3 × (freshU off, on), 3 × reopenC off. The three controlled reopens were fast. |
| 00:38–00:42 | `P1`–`P3`: controlled reopen on, off, on: all slow again; machine load rose to 10 during `P3`. |
| 00:43–00:49 | `Q1` uncontrolled reopen: session list, two prompts, message page, probes (repeated character and random text to 16 MB, single-row upsert 6 → 7 MB), and the 5-minute refresh tick at 305 s. |
| 00:49–00:55 | Temporary runtime instrumentation built; `I1-freshU`, `I1-reopenC`, `I1-reopenU`, probes, `I2-reopenC`, `I2-reopenU`. |
| 00:55–00:57 | Instrumentation reverted, runtime rebuilt at the pin, `Z1-freshU` on the restored build. |
| 00:58 | Editor exited, the `localhost` origin's storage cleared, tab closed, session deleted, server stopped. |

## 1. Boot phases

`freshU`/`reopenU`/`reopenC`/`freshC` as in Method. All times ms; cells are median
(min–max); n is per row. The raw rows follow. "open total" is the whole Open editor
operation (workspace, delivery, Vite preview, then OpenCode); the other host columns
are the `chat` service only. The fresh boot's activation is bimodal: 210–250 ms, or
about 1.0–1.1 s when the model list write lands inside it.

| mode | trace | n | open total | spawn→listen | listen→ready line | ready line→first answer | activation | connect | spawn→attached | guest import | SQLite to activation end (ms) | SQLite share of start→activation end |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| freshU | on | 8 | 26579 (24930–37764) | 2042 (1949–2173) | 90 (89–114) | 28 (27–34) | 238 (210–1124) | 1100 (365–1369) | 3453 (2469–3831) | 1928 (1835–2042) | 182 (153–964) | 8 (7–29)% |
| reopenU | on | 7 | 29350 (27999–34803) | 2070 (1993–2092) | 1119 (1068–1165) | 373 (355–394) | 1966 (1935–2064) | 3571 (3461–3702) | 5937 (5756–6067) | 1955 (1886–1983) | 3208 (3141–3370) | 59 (58–60)% |
| reopenC | on | 7 | 47865 (32302–131256) | 8218 (2001–18900) | 4149 (3124–5340) | 1490 (1288–1652) | 7723 (7282–11835) | 13657 (12182–19923) | 23134 (16750–41921) | 7690 (1888–17942) | 11927 (10057–15404) | 56 (42–79)% |
| freshC | on | 2 | 38669 (36896–40442) | 8646 (8183–9109) | 418 (414–422) | 152 (132–173) | 4591 (4454–4728) | 5526 (5382–5670) | 15350 (14745–15955) | 8064 (7627–8500) | 3766 (3648–3883) | 28 (28–28)% |

How much of each phase is SQLite (tracing on; median of the per-sample values, n as above):

| mode | n | listening→ready | SQLite in it | ready→first response | SQLite in it | activation request | SQLite in it | guest start→activation answered | SQLite | bundle load | everything else |
|---|---|---|---|---|---|---|---|---|---|---|---|
| freshU | 8 | 90 (88–114) | 75 (73–77)% | 9 (8–12) | 0 (0–0)% | 238 (210–1124) | 39 (33–77)% | 2396 (2200–3353) | 182 (153–964) = 8 (7–29)% | 1928 (1835–2042) = 83 (61–84)% | 228 (211–347) = 10 (9–11)% |
| reopenU | 7 | 1118 (1067–1165) | 98 (98–98)% | 372 (354–393) | 97 (96–97)% | 1966 (1934–2063) | 90 (88–90)% | 5495 (5311–5596) | 3208 (3141–3370) = 59 (58–60)% | 1955 (1886–1983) = 36 (35–36)% | 272 (258–320) = 5 (5–6)% |
| reopenC | 7 | 4146 (3122–5283) | 97 (96–98)% | 1484 (1290–1701) | 95 (89–96)% | 7722 (7225–11764) | 86 (74–86)% | 21211 (15101–36910) | 11927 (10057–15404) = 56 (42–79)% | 7690 (1888–17942) = 37 (13–49)% | 1665 (1341–3564) = 8 (7–10)% |
| freshC | 2 | 412 (405–419) | 72 (72–72)% | 63 (56–70) | 0 (0–0)% | 4589 (4452–4726) | 74 (74–74)% | 13446 (12858–14035) | 3766 (3648–3883) = 28 (28–28)% | 8064 (7627–8500) = 60 (59–61)% | 1617 (1582–1651) = 12 (12–12)% |

On a fresh boot the 186 calls before `ready` are the schema bootstrap: 83 writes inside
one transaction (0.2 ms each) and 92 prepares; only 10 calls persist, on a database of a
few KB. On a reopen there are 20 calls before `ready` and every non-prepare one of them
rewrites 6.44 MB. The complete sequence of one uncontrolled reopen (`L1-reopenU`), without
the prepares:

| t (ms) | phase | class | ms | statement |
|---|---|---|---|---|
| 2066 | after listening | open | 112.4 | `open database` |
| 2236 | after listening | write | 170.3 | `PRAGMA journal_mode = WAL;` |
| 2323 | after listening | write | 84.3 | `PRAGMA journal_mode = WAL` |
| 2409 | after listening | write | 85.8 | `PRAGMA synchronous = NORMAL` |
| 2493 | after listening | write | 84.1 | `PRAGMA busy_timeout = ?` |
| 2578 | after listening | write | 83.9 | `PRAGMA cache_size = -?` |
| 2662 | after listening | read | 83.8 | `PRAGMA wal_checkpoint(PASSIVE)` |
| 2744 | after listening | write | 82.1 | `PRAGMA foreign_keys = ON` |
| 2832 | after listening | read | 86.1 | `SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? AND substr(name, 1, 1) <> ?` |
| 2915 | after listening | write | 83.2 | `CREATE TABLE IF NOT EXISTS "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)` |
| 3004 | after listening | read | 88.0 | `SELECT id FROM "migration"` |
| 3107 | after ready | read | 83.6 | `select "key", "value" from "kv" where (("kv"."key" >= ?) and ("kv"."key" < ?)) order by "kv"."key" asc limit ?` |
| 3194 | after ready | read | 86.7 | `select "id" from "session_v2" where ((("session_v2"."time_suspended" is not null)) and (("session_v2"."parent_` |
| 3280 | after ready | write | 84.6 | `update "session_v2" set "time_updated" = "session_v2"."time_updated", "time_suspended" = ?, "resume_attempts" ` |
| 3368 | after ready | read | 88.1 | `select "id" from "session_v2" where ((("session_v2"."time_suspended" is not null)) and (("session_v2"."parent_` |
| 3465 | after activation-start | read | 86.3 | `select "worktree" from "project" where "project"."id" = ?` |
| 3550 | after activation-start | write | 84.5 | `insert into "project" ("id", "worktree", "vcs", "name", "icon_url", "icon_url_override", "icon_color", "time_c` |
| 3649 | after activation-start | read | 91.2 | `select "value" from "kv" where "kv"."key" = ?` |
| 3766 | after activation-start | read | 87.1 | `select "value" from "kv" where "kv"."key" = ?` |
| 3990 | after activation-start | read | 222.9 | `select "value" from "kv" where "kv"."key" = ?` |
| 4123 | after activation-start | read | 87.3 | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_created", "time_` |
| 4355 | after activation-start | read | 215.3 | `select "value" from "kv" where "kv"."key" = ?` |
| 4460 | after activation-start | read | 86.2 | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_created", "time_` |
| 4549 | after activation-start | read | 85.9 | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_created", "time_` |
| 4648 | after activation-start | read | 86.1 | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_created", "time_` |
| 4741 | after activation-start | read | 91.2 | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_created", "time_` |
| 4831 | after activation-start | read | 89.2 | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_created", "time_` |
| 4918 | after activation-start | read | 85.9 | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_created", "time_` |
| 5002 | after activation-start | read | 83.1 | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_created", "time_` |
| 5097 | after activation-start | read | 84.8 | `select "id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_created", "time_` |
| 5220 | after activation-start | read | 86.9 | `select "directory", "strategy" from "worktree" where "worktree"."project_id" = ? order by "worktree"."time_cre` |
| 5221 | after activation-start | txn | 0.2 | `begin deferred` |
| 5310 | after activation-start | txn | 89.1 | `commit` |

| phase | class | n | ms |
|---|---|---|---|
| after listening | open | 1 | 112 |
| after listening | write | 7 | 674 |
| after listening | prepare | 9 | 3 |
| after listening | read | 3 | 258 |
| after ready | prepare | 4 | 2 |
| after ready | read | 3 | 258 |
| after ready | write | 1 | 85 |
| after activation-start | prepare | 18 | 6 |
| after activation-start | read | 15 | 1570 |
| after activation-start | write | 1 | 84 |
| after activation-start | txn | 2 | 89 |

Of these 33 calls, three change the database (`update "session_v2"`, `insert into
"project"`, the `commit`), and two return the 5.97 MB model list (the 215–223 ms reads).
`PRAGMA journal_mode = WAL;` costs double because it goes through `exec`, which persists
once per statement and once more at the end.

Outbound requests during boot: three local-provider probes
(`127.0.0.1:1234/api/v1/models`, `127.0.0.1:11434/api/tags`, `127.0.0.1:8000/health`),
each seen at both the fetch and the http layer, all failing, repeated every 30 s; and
`https://models.opencode.ai/api.json` (65–365 ms to response headers; body time not
measured). The 6 requests "in activation" are the three probes twice; their time
overlaps the SQLite blocking and is not additional.

### Raw rows, tracing on

**host phases (ms), from the diagnostics events**

| sample | mode | trace | visible start/end | hidden ms | kernel controlled | load avg (1 min, end) | open total | spawn→listen | listen→ready line | ready line→first HTTP answer | health attempts (ms) | activation | GET /api/model | connect | attach | spawn→attached |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| T1-freshU | freshU | on | visible/visible | 0 | False | 6.09 | 26063 | 2091 | 108 | 34 | [141] | 223 | 7 | 376 | 29 | 2508 |
| L1-freshU | freshU | on | visible/visible | 0 | False | 3.91 | 24930 | 2057 | 100 | 28 | [127] | 225 | 7 | 365 | 35 | 2469 |
| L2-freshU | freshU | on | visible/visible | 0 | False | 4.29 | 26692 | 1993 | 89 | 28 | [117] | 1028 | 91 | 1241 | 274 | 3515 |
| L3-freshU | freshU | on | visible/visible | 0 | False | 5.41 | 26086 | 2026 | 89 | 27 | [115] | 213 | 90 | 1095 | 269 | 3397 |
| O1-freshU-on | freshU | on | visible/visible | 0 | False | 4.96 | 29182 | 2173 | 114 | 31 | [145] | 1124 | 94 | 1369 | 281 | 3831 |
| O2-freshU-on | freshU | on | visible/visible | 0 | False | 4.38 | 26615 | 1949 | 89 | 28 | [117] | 210 | 94 | 1103 | 277 | 3336 |
| O3-freshU-on | freshU | on | visible/visible | 0 | False | 10.16 | 37764 | 2026 | 91 | 29 | [120] | 1038 | 91 | 1254 | 270 | 3558 |
| Z1-freshU | freshU | on | visible/visible | 0 | False | 5.04 | 26543 | 2111 | 89 | 28 | [117] | 251 | 723 | 1096 | 294 | 3509 |
| L1-reopenU | reopenU | on | visible/visible | 0 | False | 4.47 | 30468 | 2019 | 1068 | 356 | [1424] | 1936 | 95 | 3461 | 268 | 5756 |
| L2-reopenU | reopenU | on | visible/visible | 0 | False | 5.16 | 29350 | 1993 | 1127 | 373 | [1500] | 1935 | 90 | 3529 | 271 | 5802 |
| L3-reopenU | reopenU | on | visible/visible | 0 | False | 6.58 | 34803 | 2024 | 1095 | 355 | [1450] | 1959 | 90 | 3503 | 293 | 5830 |
| O1-reopenU-on | reopenU | on | visible/visible | 0 | False | 3.58 | 28064 | 2077 | 1131 | 361 | [1492] | 2000 | 90 | 3586 | 278 | 5949 |
| O2-reopenU-on | reopenU | on | visible/visible | 0 | False | 6.20 | 27999 | 2070 | 1165 | 389 | [1554] | 2046 | 97 | 3702 | 286 | 6067 |
| O3-reopenU-on | reopenU | on | visible/visible | 0 | False | 4.35 | 29106 | 2088 | 1083 | 373 | [1456] | 2064 | 90 | 3614 | 275 | 5984 |
| Q1-reopenU | reopenU | on | visible/visible | 0 | False | 6.35 | 30429 | 2092 | 1119 | 394 | [1512] | 1966 | 89 | 3571 | 266 | 5937 |
| T1-reopenC | reopenC | on | visible/visible | 0 | True | 6.15 | 56479 | 10324 | 4677 | 1553 | [3001, 3006, 10] | 9350 | 382 | 15980 | 1322 | 27680 |
| L1-reopenC | reopenC | on | visible/visible | 0 | True | 5.02 | 47205 | 8218 | 4014 | 1490 | [3003, 2371] | 7723 | 415 | 13657 | 1201 | 23134 |
| L2-reopenC | reopenC | on | visible/visible | 0 | True | 4.15 | 32302 | 2001 | 4149 | 1479 | [3004, 2518] | 7546 | 371 | 13654 | 1038 | 16750 |
| L3-reopenC | reopenC | on | visible/visible | 0 | True | 5.72 | 52143 | 9214 | 4434 | 1632 | [3002, 2961] | 8984 | 374 | 15444 | 1168 | 25885 |
| L5-reopenC | reopenC | on | visible/visible | 0 | True | 5.24 | 47865 | 7885 | 4004 | 1288 | [3004, 2185] | 7330 | 348 | 12992 | 1016 | 21939 |
| P1-reopenC-on | reopenC | on | visible/visible | 0 | True | 4.58 | 43086 | 7429 | 3124 | 1436 | [3004, 1449] | 7282 | 299 | 12182 | 1041 | 20704 |
| P3-reopenC-on | reopenC | on | visible/visible | 0 | True | 9.95 | 131256 | 18900 | 5340 | 1652 | [3033, 3006, 724] | 11835 | 910 | 19923 | 2959 | 41921 |
| L4-freshC | freshC | on | visible/visible | 0 | True | 5.67 | 36896 | 8183 | 422 | 132 | [553] | 4454 | 352 | 5382 | 1153 | 14745 |
| L6-freshC | freshC | on | visible/visible | 0 | True | 4.80 | 40442 | 9109 | 414 | 173 | [586] | 4728 | 341 | 5670 | 1137 | 15955 |

**guest phases, tracing on (ms; SQLite as statements / ms)**

| sample | mode | import (read+transpile+compile+sync eval) | import end→listening | listening→ready | SQLite | ready→first response | SQLite | activation request | SQLite | outbound in activation (n / ms) | start→activation end | SQLite | SQLite share | max event-loop stall | DB bytes at ready | DB bytes at dump |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| T1-freshU | freshU | 1980 | 38 | 107 | 186 / 78 | 12 | 0 / 0 | 223 | 36 / 76 | 6 / 59 | 2387 | 230 / 173 | 7% | 2046 | 475136 | 6438912 |
| L1-freshU | freshU | 1942 | 36 | 101 | 186 / 76 | 8 | 0 / 0 | 224 | 36 / 78 | 6 / 55 | 2335 | 230 / 172 | 7% | 2002 | 475136 | 6438912 |
| L2-freshU | freshU | 1886 | 36 | 89 | 186 / 67 | 8 | 0 / 0 | 1028 | 40 / 788 | 7 / 118 | 3071 | 234 / 872 | 28% | 1937 | 475136 | 6438912 |
| L3-freshU | freshU | 1916 | 35 | 89 | 186 / 67 | 8 | 0 / 0 | 213 | 36 / 71 | 7 / 156 | 2282 | 230 / 153 | 7% | 1965 | 475136 | 6438912 |
| O1-freshU-on | freshU | 2042 | 38 | 114 | 186 / 87 | 10 | 0 / 0 | 1124 | 40 / 859 | 7 / 134 | 3353 | 234 / 964 | 29% | 2117 | 475136 | 6438912 |
| O2-freshU-on | freshU | 1835 | 34 | 89 | 186 / 67 | 8 | 0 / 0 | 210 | 36 / 70 | 7 / 154 | 2200 | 230 / 154 | 7% | 1885 | 475136 | 6438912 |
| O3-freshU-on | freshU | 1907 | 36 | 90 | 186 / 68 | 9 | 0 / 0 | 1037 | 40 / 779 | 7 / 122 | 3105 | 234 / 865 | 28% | 1959 | 475136 | 6438912 |
| Z1-freshU | freshU | 1997 | 36 | 88 | 186 / 65 | 10 | 0 / 0 | 251 | 36 / 110 | 6 / 53 | 2405 | 230 / 191 | 8% | 2048 | 475136 | 6438912 |
| L1-reopenU | reopenU | 1912 | 35 | 1067 | 20 / 1047 | 356 | 8 / 345 | 1935 | 36 / 1749 | 6 / 543 | 5311 | 64 / 3141 | 59% | 2972 | 6438912 | 6438912 |
| L2-reopenU | reopenU | 1886 | 37 | 1127 | 20 / 1106 | 372 | 8 / 360 | 1934 | 36 / 1742 | 6 / 550 | 5361 | 64 / 3208 | 60% | 3007 | 6438912 | 6438912 |
| L3-reopenU | reopenU | 1907 | 38 | 1094 | 20 / 1073 | 354 | 8 / 342 | 1959 | 36 / 1763 | 6 / 605 | 5358 | 64 / 3178 | 59% | 2997 | 6438912 | 6438912 |
| O1-reopenU-on | reopenU | 1965 | 36 | 1130 | 20 / 1110 | 360 | 8 / 348 | 1999 | 36 / 1802 | 6 / 560 | 5495 | 64 / 3260 | 59% | 3088 | 6438912 | 6438912 |
| O2-reopenU-on | reopenU | 1955 | 37 | 1165 | 20 / 1143 | 388 | 8 / 377 | 2045 | 36 / 1850 | 6 / 566 | 5596 | 64 / 3370 | 60% | 3114 | 6438912 | 6438912 |
| O3-reopenU-on | reopenU | 1975 | 35 | 1083 | 20 / 1062 | 372 | 8 / 361 | 2063 | 36 / 1816 | 7 / 948 | 5534 | 64 / 3239 | 59% | 3051 | 6438912 | 6438912 |
| Q1-reopenU | reopenU | 1983 | 36 | 1118 | 20 / 1098 | 393 | 8 / 377 | 1966 | 36 / 1724 | 7 / 914 | 5501 | 64 / 3199 | 58% | 3099 | 6438912 | 6438912 |
| T1-reopenC | reopenC | 9781 | 255 | 4668 | 20 / 4543 | 1504 | 8 / 1440 | 9348 | 36 / 8036 | 6 / 2566 | 25630 | 64 / 14019 | 55% | 14694 | 6438912 | 6438912 |
| L1-reopenC | reopenC | 7690 | 279 | 4013 | 20 / 3906 | 1484 | 8 / 1419 | 7722 | 36 / 6602 | 6 / 2047 | 21211 | 64 / 11927 | 56% | 11967 | 6438912 | 6438912 |
| L2-reopenC | reopenC | 1888 | 35 | 4146 | 20 / 4035 | 1477 | 8 / 1389 | 7545 | 36 / 6448 | 6 / 2296 | 15101 | 64 / 11871 | 79% | 6064 | 6438912 | 6438912 |
| L3-reopenC | reopenC | 8748 | 194 | 4432 | 20 / 4320 | 1629 | 8 / 1548 | 8982 | 36 / 7720 | 6 / 2115 | 24002 | 64 / 13588 | 57% | 13369 | 6438912 | 6438912 |
| L5-reopenC | reopenC | 7418 | 231 | 3997 | 20 / 3898 | 1290 | 8 / 1222 | 7330 | 36 / 6270 | 6 / 1796 | 20288 | 64 / 11391 | 56% | 11648 | 6438912 | 6438912 |
| P1-reopenC-on | reopenC | 6954 | 168 | 3122 | 20 / 3011 | 1341 | 8 / 1242 | 7225 | 36 / 5804 | 6 / 1642 | 18972 | 64 / 10057 | 53% | 10266 | 6438912 | 6438912 |
| P3-reopenC-on | reopenC | 17942 | 205 | 5283 | 20 / 5150 | 1701 | 8 / 1510 | 11764 | 36 / 8745 | 7 / 6771 | 36910 | 64 / 15404 | 42% | 23535 | 6438912 | 6438912 |
| L4-freshC | freshC | 7627 | 212 | 419 | 186 / 303 | 70 | 0 / 0 | 4452 | 40 / 3293 | 7 / 239 | 12858 | 234 / 3648 | 28% | 8090 | 475136 | 6438912 |
| L6-freshC | freshC | 8500 | 185 | 405 | 186 / 292 | 56 | 0 / 0 | 4726 | 40 / 3506 | 7 / 193 | 14035 | 234 / 3883 | 28% | 8945 | 475136 | 6438912 |

**SQLite classes at dump (n, total ms, median, p95, max)**

| sample | mode | dump at (ms) | statements | SQLite ms | open | prepare | read | write | read.tx | write.tx | txn |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T1-freshU | freshU | 13884 | 244 | 794 | 1, 19, 18.69, 18.69, 18.69 | 121, 28, 0.19, 0.52, 0.72 | 26, 336, 4.07, 5.52, 235.3 | 9, 385, 2.39, 361.62, 361.62 |  | 83, 18, 0.18, 0.5, 0.91 | 4, 9, 3.74, 5.1, 5.1 |
| L1-freshU | freshU | 14019 | 244 | 808 | 1, 14, 14.07, 14.07, 14.07 | 121, 30, 0.19, 0.52, 1.05 | 26, 337, 4.49, 7.29, 228.97 | 9, 398, 2.54, 377.38, 377.38 |  | 83, 19, 0.19, 0.4, 0.71 | 4, 9, 3.47, 5.12, 5.12 |
| L2-freshU | freshU | 14991 | 244 | 1310 | 1, 12, 11.69, 11.69, 11.69 | 121, 27, 0.17, 0.42, 1.24 | 26, 810, 4.23, 88.17, 219.29 | 9, 353, 2.09, 334.85, 334.85 |  | 83, 18, 0.17, 0.46, 0.72 | 4, 90, 4.77, 85.28, 85.28 |
| L3-freshU | freshU | 14981 | 244 | 1135 | 1, 12, 11.79, 11.79, 11.79 | 121, 26, 0.17, 0.38, 1.24 | 26, 716, 3.85, 87.98, 214.75 | 9, 356, 1.82, 337.11, 337.11 |  | 83, 17, 0.17, 0.36, 0.76 | 4, 8, 3.6, 4.36, 4.36 |
| O1-freshU-on | freshU | 15417 | 244 | 1411 | 1, 15, 15.01, 15.01, 15.01 | 121, 31, 0.22, 0.5, 0.85 | 26, 853, 4.84, 90.01, 239.29 | 9, 396, 2.31, 365.58, 365.58 |  | 83, 19, 0.22, 0.43, 0.77 | 4, 97, 5.21, 91.28, 91.28 |
| O2-freshU-on | freshU | 14984 | 244 | 1160 | 1, 12, 12.25, 12.25, 12.25 | 121, 26, 0.17, 0.4, 1.32 | 26, 732, 3.99, 91.38, 214.17 | 9, 364, 1.76, 345.65, 345.65 |  | 83, 17, 0.18, 0.37, 0.71 | 4, 8, 3.33, 4.63, 4.63 |
| O3-freshU-on | freshU | 15171 | 244 | 1299 | 1, 12, 11.94, 11.94, 11.94 | 121, 27, 0.17, 0.54, 0.77 | 26, 803, 4.2, 88.76, 214.24 | 9, 352, 1.73, 332.67, 332.67 |  | 83, 18, 0.18, 0.38, 0.72 | 4, 87, 4.52, 82.33, 82.33 |
| Z1-freshU | freshU | 15035 | 244 | 1154 | 1, 13, 13.45, 13.45, 13.45 | 121, 26, 0.17, 0.43, 0.71 | 26, 709, 3.82, 100.18, 226.05 | 9, 380, 1.59, 361.69, 361.69 |  | 83, 16, 0.18, 0.33, 0.79 | 4, 10, 4.4, 4.7, 4.7 |
| L1-reopenU | reopenU | 17031 | 72 | 3488 | 1, 112, 112.41, 112.41, 112.41 | 35, 12, 0.29, 0.64, 0.72 | 25, 2432, 86.32, 215.28, 222.89 | 9, 843, 84.29, 170.34, 170.34 |  |  | 2, 89, 89.1, 89.1, 89.1 |
| L2-reopenU | reopenU | 17217 | 72 | 3551 | 1, 119, 118.82, 118.82, 118.82 | 35, 15, 0.31, 0.8, 2.84 | 25, 2453, 85.92, 220.41, 220.98 | 9, 873, 85.92, 184.6, 184.6 |  |  | 2, 91, 90.63, 90.63, 90.63 |
| L3-reopenU | reopenU | 17296 | 72 | 3543 | 1, 122, 121.72, 121.72, 121.72 | 35, 14, 0.35, 0.99, 1.06 | 25, 2457, 86.78, 216.11, 220.4 | 9, 863, 85.8, 177.62, 177.62 |  |  | 2, 87, 87, 87, 87 |
| O1-reopenU-on | reopenU | 17445 | 72 | 3613 | 1, 120, 120.37, 120.37, 120.37 | 35, 14, 0.35, 0.88, 0.94 | 25, 2487, 87.91, 223.08, 237.72 | 9, 906, 88.99, 192.38, 192.38 |  |  | 2, 85, 85.29, 85.29, 85.29 |
| O2-reopenU-on | reopenU | 17504 | 72 | 3736 | 1, 127, 127.38, 127.38, 127.38 | 35, 13, 0.33, 0.71, 0.8 | 25, 2575, 91.63, 225.2, 240.25 | 9, 929, 93.47, 187.03, 187.03 |  |  | 2, 92, 91.38, 91.38, 91.38 |
| O3-reopenU-on | reopenU | 17515 | 72 | 3587 | 1, 121, 121.2, 121.2, 121.2 | 35, 12, 0.3, 0.68, 0.74 | 25, 2489, 88.4, 220.99, 228.89 | 9, 863, 86.62, 169.73, 169.73 |  |  | 2, 101, 101.14, 101.14, 101.14 |
| Q1-reopenU | reopenU | 17335 | 72 | 3537 | 1, 129, 129.02, 129.02, 129.02 | 35, 12, 0.31, 0.75, 1.03 | 25, 2396, 85.4, 216.76, 219.92 | 9, 913, 88.42, 180.32, 180.32 |  |  | 2, 87, 86.76, 86.76, 86.76 |
| T1-reopenC | reopenC | 39084 | 72 | 15588 | 1, 191, 191.15, 191.15, 191.15 | 35, 63, 1.55, 4.48, 4.65 | 25, 11018, 377.61, 1073.17, 1077.7 | 9, 3971, 399.23, 801.14, 801.14 |  |  | 2, 344, 343.44, 343.44, 343.44 |
| L1-reopenC | reopenC | 34438 | 72 | 13402 | 1, 151, 151, 151, 151 | 35, 115, 1.26, 4.57, 65.79 | 25, 9446, 337.74, 783.52, 958.86 | 9, 3328, 356.57, 643.93, 643.93 |  |  | 2, 362, 361.06, 361.06, 361.06 |
| L2-reopenC | reopenC | 28216 | 72 | 13180 | 1, 168, 168.32, 168.32, 168.32 | 35, 84, 1.53, 8.24, 22.58 | 25, 9035, 318.38, 820.82, 868.04 | 9, 3557, 366.69, 742.17, 742.17 |  |  | 2, 336, 335.26, 335.26, 335.26 |
| L3-reopenC | reopenC | 37250 | 72 | 15023 | 1, 204, 203.84, 203.84, 203.84 | 35, 104, 1.58, 15.02, 30.91 | 25, 10711, 366.25, 1017.81, 1138.09 | 9, 3681, 373.44, 728.22, 728.22 |  |  | 2, 323, 321.94, 321.94, 321.94 |
| L5-reopenC | reopenC | 33301 | 72 | 12662 | 1, 187, 187.28, 187.28, 187.28 | 35, 86, 1.38, 2.93, 36.24 | 25, 8689, 307.47, 778.12, 865.76 | 9, 3351, 320.16, 697.7, 697.7 |  |  | 2, 348, 346.59, 346.59, 346.59 |
| P1-reopenC-on | reopenC | 32008 | 72 | 11189 | 1, 172, 171.6, 171.6, 171.6 | 35, 71, 1.32, 4.76, 14.15 | 25, 7941, 266.78, 754.38, 892.67 | 9, 2732, 275.03, 578.13, 578.13 |  |  | 2, 274, 272.93, 272.93, 272.93 |
| P3-reopenC-on | reopenC | 52821 | 72 | 18293 | 1, 180, 179.79, 179.79, 179.79 | 35, 430, 2.27, 86.73, 206.54 | 25, 12458, 405.45, 1117.8, 1412.29 | 9, 4512, 470, 796.66, 796.66 |  |  | 2, 713, 708.41, 708.41, 708.41 |
| L4-freshC | freshC | 26316 | 244 | 5390 | 1, 25, 25.11, 25.11, 25.11 | 121, 167, 0.84, 3.18, 29.47 | 26, 3221, 12.93, 406.28, 877.11 | 9, 1487, 4.29, 1433.24, 1433.24 |  | 83, 93, 0.85, 3.19, 3.64 | 4, 396, 15.61, 379.22, 379.22 |
| L6-freshC | freshC | 27674 | 244 | 5631 | 1, 26, 26.48, 26.48, 26.48 | 121, 151, 0.88, 2.23, 15.55 | 26, 3331, 15.7, 374.41, 1045.1 | 9, 1651, 4.32, 1574.28, 1574.28 |  | 83, 115, 0.93, 3.5, 21.71 | 4, 356, 12.46, 341.84, 341.84 |


### Raw rows, tracing off

**host phases (ms), from the diagnostics events**

| sample | mode | trace | visible start/end | hidden ms | kernel controlled | load avg (1 min, end) | open total | spawn→listen | listen→ready line | ready line→first HTTP answer | health attempts (ms) | activation | GET /api/model | connect | attach | spawn→attached |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| O1-freshU-off | freshU | off | visible/visible | 0 | False | 3.95 | 25724 | 2046 | 104 | 28 | [132] | 1080 | 97 | 1313 | 279 | 3647 |
| O2-freshU-off | freshU | off | visible/visible | 0 | False | 4.16 | 27315 | 1994 | 89 | 27 | [116] | 1046 | 100 | 1266 | 272 | 3540 |
| O3-freshU-off | freshU | off | visible/visible | 0 | False | 9.50 | 30177 | 1995 | 93 | 27 | [120] | 215 | 90 | 1106 | 274 | 3384 |
| O1-reopenU-off | reopenU | off | visible/visible | 0 | False | 2.85 | 31511 | 1987 | 1122 | 354 | [1476] | 1961 | 109 | 3551 | 288 | 5836 |
| O2-reopenU-off | reopenU | off | visible/visible | 0 | False | 5.07 | 28403 | 2100 | 1166 | 382 | [1548] | 2030 | 94 | 3677 | 290 | 6075 |
| O3-reopenU-off | reopenU | off | visible/visible | 0 | False | 4.74 | 29270 | 2060 | 1117 | 373 | [1490] | 2042 | 102 | 3638 | 308 | 6014 |
| O1-reopenC-off | reopenC | off | visible/visible | 0 | True | 8.25 | 11426 | 1954 | 1103 | 362 | [1465] | 1924 | 90 | 3482 | 268 | 5714 |
| O2-reopenC-off | reopenC | off | visible/visible | 0 | True | 6.63 | 11396 | 1961 | 1073 | 353 | [1425] | 1941 | 89 | 3459 | 270 | 5698 |
| O3-reopenC-off | reopenC | off | visible/visible | 0 | True | 5.47 | 11500 | 1957 | 1097 | 369 | [1466] | 1930 | 90 | 3490 | 284 | 5738 |
| P2-reopenC-off | reopenC | off | visible/visible | 0 | True | 6.19 | 46009 | 8631 | 3262 | 1210 | [3003, 1365] | 6541 | 280 | 11307 | 1003 | 21021 |


## 2. Database size and per-statement cost

The model list lands (fresh boots). Per-statement cost by class and by the database size
at the time (size is sampled at marks and windows, so the 8,192 rows are the bootstrap
before the first sample at 475,136):

| sample | class | DB bytes when issued | n | median ms | p95 ms | max ms | total ms |
|---|---|---|---|---|---|---|---|
| L1-freshU | open | -1 | 1 | 14.07 | 14.07 | 14.07 | 14 |
| L1-freshU | prepare | 8192 | 92 | 0.18 | 0.42 | 0.75 | 20 |
| L1-freshU | prepare | 475136 | 28 | 0.31 | 0.62 | 1.05 | 10 |
| L1-freshU | prepare | 6438912 | 1 | 0.32 | 0.32 | 0.32 | 0 |
| L1-freshU | read | 8192 | 2 | 1.99 | 2.55 | 2.55 | 4 |
| L1-freshU | read | 475136 | 23 | 4.49 | 5.94 | 7.29 | 105 |
| L1-freshU | read | 6438912 | 1 | 228.97 | 228.97 | 228.97 | 229 |
| L1-freshU | txn | 8192 | 2 | 2.65 | 5.12 | 5.12 | 5 |
| L1-freshU | txn | 475136 | 2 | 1.82 | 3.47 | 3.47 | 4 |
| L1-freshU | write | 8192 | 6 | 2.12 | 3.81 | 3.81 | 14 |
| L1-freshU | write | 475136 | 3 | 3.69 | 377.38 | 377.38 | 385 |
| L1-freshU | write.tx | 8192 | 83 | 0.19 | 0.40 | 0.71 | 19 |
| L2-freshU | open | -1 | 1 | 11.69 | 11.69 | 11.69 | 12 |
| L2-freshU | prepare | 8192 | 92 | 0.16 | 0.31 | 1.24 | 18 |
| L2-freshU | prepare | 475136 | 20 | 0.27 | 0.58 | 0.58 | 6 |
| L2-freshU | prepare | 6438912 | 9 | 0.28 | 0.57 | 0.57 | 3 |
| L2-freshU | read | 8192 | 2 | 1.48 | 1.49 | 1.49 | 3 |
| L2-freshU | read | 475136 | 17 | 3.58 | 4.67 | 4.67 | 65 |
| L2-freshU | read | 6438912 | 7 | 87.32 | 219.29 | 219.29 | 742 |
| L2-freshU | txn | 8192 | 2 | 2.47 | 4.77 | 4.77 | 5 |
| L2-freshU | txn | 6438912 | 2 | 42.74 | 85.28 | 85.28 | 85 |
| L2-freshU | write | 8192 | 6 | 1.59 | 3.58 | 3.58 | 12 |
| L2-freshU | write | 475136 | 3 | 3.60 | 334.85 | 334.85 | 342 |
| L2-freshU | write.tx | 8192 | 83 | 0.17 | 0.46 | 0.72 | 17 |
| L3-freshU | open | -1 | 1 | 11.79 | 11.79 | 11.79 | 12 |
| L3-freshU | prepare | 8192 | 92 | 0.16 | 0.30 | 1.24 | 18 |
| L3-freshU | prepare | 475136 | 23 | 0.26 | 0.40 | 0.58 | 6 |
| L3-freshU | prepare | 6438912 | 6 | 0.32 | 0.38 | 0.38 | 2 |
| L3-freshU | read | 8192 | 2 | 1.61 | 1.70 | 1.70 | 3 |
| L3-freshU | read | 475136 | 18 | 3.73 | 5.35 | 5.35 | 70 |
| L3-freshU | read | 6438912 | 6 | 86.25 | 214.75 | 214.75 | 643 |
| L3-freshU | txn | 8192 | 2 | 2.26 | 4.36 | 4.36 | 5 |
| L3-freshU | txn | 475136 | 2 | 1.89 | 3.60 | 3.60 | 4 |
| L3-freshU | write | 8192 | 6 | 1.69 | 3.45 | 3.45 | 12 |
| L3-freshU | write | 475136 | 3 | 3.47 | 337.11 | 337.11 | 344 |
| L3-freshU | write.tx | 8192 | 83 | 0.17 | 0.36 | 0.76 | 17 |
| L4-freshC | open | -1 | 1 | 25.11 | 25.11 | 25.11 | 25 |
| L4-freshC | prepare | 8192 | 92 | 0.78 | 3.64 | 29.47 | 133 |
| L4-freshC | prepare | 475136 | 20 | 1.04 | 3.07 | 3.07 | 25 |
| L4-freshC | prepare | 6438912 | 9 | 0.98 | 1.86 | 1.86 | 10 |
| L4-freshC | read | 8192 | 2 | 4.04 | 4.05 | 4.05 | 8 |
| L4-freshC | read | 475136 | 17 | 10.83 | 35.05 | 35.05 | 194 |
| L4-freshC | read | 6438912 | 7 | 343.25 | 877.11 | 877.11 | 3019 |
| L4-freshC | txn | 8192 | 2 | 8.14 | 15.61 | 15.61 | 16 |
| L4-freshC | txn | 6438912 | 2 | 189.92 | 379.22 | 379.22 | 380 |
| L4-freshC | write | 8192 | 6 | 4.13 | 7.41 | 7.41 | 27 |
| L4-freshC | write | 475136 | 3 | 14.94 | 1433.24 | 1433.24 | 1460 |
| L4-freshC | write.tx | 8192 | 83 | 0.85 | 3.19 | 3.64 | 93 |
| L1-reopenU | open | 6438912 | 1 | 112.41 | 112.41 | 112.41 | 112 |
| L1-reopenU | prepare | 6438912 | 35 | 0.29 | 0.64 | 0.72 | 12 |
| L1-reopenU | read | 6438912 | 25 | 86.32 | 215.28 | 222.89 | 2432 |
| L1-reopenU | txn | 6438912 | 2 | 44.64 | 89.10 | 89.10 | 89 |
| L1-reopenU | write | 6438912 | 9 | 84.29 | 170.34 | 170.34 | 843 |
| L1-reopenC | open | 6438912 | 1 | 151.00 | 151.00 | 151.00 | 151 |
| L1-reopenC | prepare | 6438912 | 35 | 1.26 | 4.57 | 65.79 | 115 |
| L1-reopenC | read | 6438912 | 25 | 337.74 | 783.52 | 958.86 | 9446 |
| L1-reopenC | txn | 6438912 | 2 | 180.83 | 361.06 | 361.06 | 362 |
| L1-reopenC | write | 6438912 | 9 | 356.57 | 643.93 | 643.93 | 3328 |

| sample | t (ms since guest start) | statement | ms | arg bytes | DB before | DB after | statements around it (t, class, ms) |
|---|---|---|---|---|---|---|---|
| L1-freshU | 3061 | write | insert into "kv" ("key", "value", "time_created", "t | 377 | 11936838 | 475136 | 6438912 | 2379 read 5.5; 2392 read 7.3; 2417 read 5.4; 3061 write 377.4; 3291 read 229.0 |
| L2-freshU | 2627 | write | insert into "kv" ("key", "value", "time_created", "t | 335 | 11936838 | 475136 | 6438912 | 2191 read 3.3; 2196 read 3.4; 2207 read 3.4; 2627 write 334.9; 2848 read 219.3; 2984 read 86.5; 2985 txn 0.2; 3070 txn 85.3 |
| L3-freshU | 2698 | write | insert into "kv" ("key", "value", "time_created", "t | 337 | 11936838 | 475136 | 6438912 | 2277 read 4.9; 2278 txn 0.2; 2281 txn 3.6; 2698 write 337.1; 2913 read 214.8; 3046 read 85.9; 3144 read 84.2; 3235 read 88.0 |
| L4-freshC | 10773 | write | insert into "kv" ("key", "value", "time_created", "t | 1433 | 11936838 | 475136 | 6438912 | 9029 read 4.7; 9035 read 4.1; 9048 read 4.3; 10773 write 1433.2; 11658 read 877.1; 12475 read 406.3; 12476 txn 0.6; 12857 txn 379.2 |

Size probe on a scratch database, medians of 5 reads / 3 writes per size:

| probe | kernel | fill | shape | DB bytes | prepare | read, autocommit (min–max) | write, autocommit | read in transaction | write in transaction | COMMIT via exec |
|---|---|---|---|---|---|---|---|---|---|---|
| Q1-probe-x-rows | uncontrolled | x | rows | 24576 | 0.15 | 1.47 (1.4–1.5) | 1.36 | 0.17 | 0.17 | 3.28 |
| Q1-probe-x-rows | uncontrolled | x | rows | 1073152 | 0.18 | 5.18 (4.7–6.9) | 5.02 | 0.14 | 0.13 | 8.56 |
| Q1-probe-x-rows | uncontrolled | x | rows | 2121728 | 0.16 | 8.06 (6.9–10.7) | 8.48 | 0.15 | 0.14 | 13.87 |
| Q1-probe-x-rows | uncontrolled | x | rows | 4218880 | 0.19 | 14.07 (13.4–14.4) | 14.32 | 0.17 | 0.16 | 33.09 |
| Q1-probe-x-rows | uncontrolled | x | rows | 8413184 | 0.24 | 27.27 (26.0–32.6) | 28.98 | 0.16 | 0.18 | 58.32 |
| Q1-probe-x-rows | uncontrolled | x | rows | 16818176 | 0.23 | 57.73 (49.7–71.1) | 53.72 | 0.14 | 0.13 | 112.39 |
| Q1-probe-random-rows | uncontrolled | random | rows | 24576 | 0.21 | 1.90 (1.6–2.2) | 1.59 | 0.17 | 0.17 | 3.40 |
| Q1-probe-random-rows | uncontrolled | random | rows | 1073152 | 0.20 | 34.88 (34.6–35.7) | 34.29 | 0.13 | 0.13 | 69.13 |
| Q1-probe-random-rows | uncontrolled | random | rows | 2121728 | 0.21 | 68.70 (67.9–71.5) | 67.81 | 0.15 | 0.14 | 136.20 |
| Q1-probe-random-rows | uncontrolled | random | rows | 4218880 | 0.22 | 135.10 (133.0–135.5) | 135.40 | 0.14 | 0.13 | 270.93 |
| Q1-probe-random-rows | uncontrolled | random | rows | 8413184 | 0.26 | 273.01 (268.5–277.2) | 270.31 | 0.15 | 0.14 | 549.05 |
| Q1-probe-random-rows | uncontrolled | random | rows | 16818176 | 0.23 | 543.33 (541.9–549.1) | 544.14 | 0.14 | 0.13 | 1091.30 |
| Q1-probe-x-one | uncontrolled | x | one | 24576 | 0.13 | 1.55 (1.4–1.8) | 1.36 | 0.18 | 0.17 | 3.14 |
| Q1-probe-x-one | uncontrolled | x | one | 6316032 | 0.23 | 24.02 (21.5–25.4) | 21.67 | 0.23 | 0.20 | 56.21 |
| Q1-probe-x-one | uncontrolled | x | one | 13656064 | 0.20 | 43.41 (41.7–46.7) | 43.11 | 0.15 | 0.13 | 87.71 |
| Q1-probe-random-one | uncontrolled | random | one | 24576 | 0.14 | 1.56 (1.4–1.7) | 1.85 | 0.16 | 0.15 | 3.05 |
| Q1-probe-random-one | uncontrolled | random | one | 6316032 | 0.23 | 215.84 (213.0–217.2) | 213.37 | 0.13 | 0.13 | 427.27 |
| Q1-probe-random-one | uncontrolled | random | one | 13656064 | 0.22 | 441.71 (438.2–448.0) | 440.60 | 0.14 | 0.14 | 883.24 |
| smoke-03-probe | uncontrolled | x | rows | 24576 | 0.19 | 2.52 (1.5–3.6) | 1.75 | 0.20 | 0.18 | 3.65 |
| smoke-03-probe | uncontrolled | x | rows | 1073152 | 0.18 | 4.39 (4.0–6.3) | 4.37 | 0.15 | 0.14 | 8.84 |
| smoke-03-probe | uncontrolled | x | rows | 2121728 | 0.20 | 7.03 (6.9–8.6) | 6.96 | 0.14 | 0.14 | 13.94 |
| smoke-03-probe | uncontrolled | x | rows | 4218880 | 0.25 | 14.21 (13.3–15.8) | 18.53 | 0.24 | 0.30 | 47.19 |
| smoke-03-probe | uncontrolled | x | rows | 8413184 | 0.30 | 27.30 (26.1–28.7) | 25.10 | 0.22 | 0.18 | 53.04 |
| smoke-03-probe | uncontrolled | x | rows | 16818176 | 0.20 | 49.14 (48.1–50.3) | 56.17 | 0.16 | 0.14 | 121.95 |
| smoke-04-probe-x-rows | controlled, slow | x | rows | 24576 | 0.81 | 3.40 (2.6–6.0) | 4.10 | 0.89 | 0.83 | 9.03 |
| smoke-04-probe-x-rows | controlled, slow | x | rows | 6316032 | 0.98 | 68.52 (63.9–78.7) | 72.90 | 0.75 | 0.96 | 153.21 |
| smoke-04-probe-random-rows | controlled, slow | random | rows | 24576 | 0.76 | 4.35 (2.5–4.5) | 2.65 | 0.82 | 0.88 | 9.16 |
| smoke-04-probe-random-rows | controlled, slow | random | rows | 6316032 | 0.63 | 748.33 (744.1–827.3) | 711.42 | 0.81 | 0.93 | 1771.04 |
| smoke-04-probe-x-one | controlled, slow | x | one | 24576 | 0.40 | 2.67 (2.3–3.1) | 2.86 | 0.53 | 0.61 | 7.26 |
| smoke-04-probe-x-one | controlled, slow | x | one | 6316032 | 1.30 | 81.61 (73.4–87.5) | 76.98 | 0.86 | 0.69 | 144.94 |
| smoke-04-probe-random-one | controlled, slow | random | one | 24576 | 0.73 | 3.91 (2.8–4.3) | 3.81 | 0.73 | 0.67 | 7.60 |
| smoke-04-probe-random-one | controlled, slow | random | one | 6316032 | 1.02 | 822.86 (691.4–931.9) | 765.58 | 0.73 | 0.81 | 1606.49 |

What these show:

- Autocommit cost is linear in the image size: `x` rows 1.5 ms + 3.3 ms/MB; random text
  1.9 ms + 32.3 ms/MB (34.9, 68.7, 135, 273, 543 ms at 1.07, 2.12, 4.22, 8.41, 16.8 MB).
  The real 6.44 MB database sits between at 13 ms/MB (86 ms).
- Reads cost what writes cost. Statements inside a transaction cost 0.13–0.25 ms at
  every size. `COMMIT` through `exec` costs two persists.
- A single 6 MB row costs what 6 one-megabyte rows cost.
- Replacing the single row by upsert with a 7 MB value took the file from 6,316,032 to
  13,656,064 bytes, for both fills.
- In the slow controlled kernel the same probe is 3–4× slower (68.5 ms and 748 ms
  at 6.3 MB against about 21 and 204 ms interpolated).

Where the time goes inside one persisting request, from the temporarily instrumented
runtime (section 5; medians, ms; kernel columns are inside the blocking syscall):

| sample | kind | n | DB bytes | guest: write req | syscall | read resp | unlink | kernel: total | export | vfs.write_file | flushPath | queue wait | read-back | OPFS write | manifest | manifest bytes | persists per request |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| I1-freshU | execute, in transaction (no persist) | 85 | 0 | 0.06 | 0.05 | 0.02 | 0.06 | 0.04 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0 | 0 |
| I1-freshU | execute, persisted | 8 | 8192 | 0.05 | 1.51 | 0.03 | 0.07 | 1.49 | 0.02 | 0.02 | 1.38 | 0.03 | 0.02 | 0.74 | 0.60 | 8434 | 1 |
| I1-freshU | execute, persisted | 20 | 475136 | 0.06 | 3.73 | 0.03 | 0.07 | 3.71 | 0.18 | 1.08 | 2.32 | 0.08 | 0.28 | 1.32 | 0.64 | 8538 | 1 |
| I1-freshU | execute, persisted | 9 | 6438912 | 0.09 | 90.22 | 0.07 | 0.10 | 90.14 | 2.17 | 61.57 | 23.91 | 0.00 | 11.66 | 11.48 | 0.88 | 8538 | 1 |
| I1-freshU | open | 1 | 8192 | 0.22 | 11.62 | 0.06 | 0.14 | 11.41 | 2.67 | 0.02 | 4.98 | 2.45 | 0.02 | 1.42 | 1.08 | 8434 | 1 |
| I1-freshU | prepare | 121 | 0 | 0.06 | 0.05 | 0.02 | 0.06 | 0.03 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0 | 0 |
| I1-reopenU | execute, persisted | 35 | 6438912 | 0.06 | 85.82 | 0.07 | 0.09 | 85.77 | 2.02 | 60.58 | 23.02 | 0.00 | 11.60 | 10.72 | 0.77 | 8595 | 1 |
| I1-reopenU | open | 1 | 6438912 | 0.25 | 116.09 | 0.08 | 0.13 | 115.85 | 8.62 | 60.36 | 26.74 | 2.71 | 11.45 | 11.70 | 0.88 | 8595 | 1 |
| I1-reopenU | prepare | 35 | 0 | 0.10 | 0.12 | 0.03 | 0.07 | 0.10 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0 | 0 |
| I2-reopenU | execute, persisted | 35 | 6438912 | 0.07 | 86.46 | 0.07 | 0.10 | 86.41 | 2.09 | 60.61 | 23.78 | 0.27 | 11.63 | 11.12 | 0.76 | 8595 | 1 |
| I2-reopenU | open | 1 | 6438912 | 0.45 | 121.11 | 0.09 | 0.16 | 120.87 | 9.17 | 60.54 | 31.29 | 2.78 | 11.48 | 16.32 | 0.70 | 8595 | 1 |
| I2-reopenU | prepare | 35 | 0 | 0.10 | 0.13 | 0.03 | 0.08 | 0.10 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0 | 0 |
| I1-reopenC | execute, persisted | 35 | 6438912 | 0.21 | 324.17 | 0.20 | 0.30 | 323.96 | 6.06 | 234.69 | 72.50 | 3.38 | 41.93 | 25.48 | 1.70 | 8595 | 1 |
| I1-reopenC | open | 1 | 6438912 | 1.40 | 189.92 | 0.27 | 0.82 | 189.23 | 12.46 | 67.28 | 73.84 | 3.37 | 55.04 | 14.14 | 1.28 | 8595 | 1 |
| I1-reopenC | prepare | 35 | 0 | 0.37 | 0.47 | 0.10 | 0.25 | 0.35 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0 | 0 |
| I2-reopenC | execute, persisted | 35 | 6438912 | 0.15 | 284.22 | 0.13 | 0.26 | 284.11 | 5.28 | 203.76 | 60.09 | 3.55 | 36.70 | 18.51 | 1.33 | 8595 | 1 |
| I2-reopenC | open | 1 | 6438912 | 0.56 | 185.27 | 1.60 | 0.91 | 184.55 | 11.64 | 67.39 | 73.24 | 2.41 | 47.43 | 22.25 | 1.15 | 8595 | 1 |
| I2-reopenC | prepare | 35 | 0 | 0.20 | 0.21 | 0.07 | 0.13 | 0.17 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0 | 0 |
| I1-probe-U-random-d | probe execute, persisted | 12 | 24576 | 0.06 | 1.84 | 0.03 | 0.06 | 1.81 | 0.02 | 0.05 | 1.57 | 0.03 | 0.03 | 0.80 | 0.72 | 8663 | 1 |
| I1-probe-U-random-d | probe execute, persisted | 10 | 1073152 | 0.07 | 34.75 | 0.06 | 0.08 | 34.71 | 0.34 | 26.88 | 7.33 | 0.05 | 3.93 | 2.57 | 0.78 | 8663 | 1 |
| I1-probe-U-random-d | probe execute, persisted | 10 | 4218880 | 0.06 | 133.62 | 0.06 | 0.09 | 133.57 | 1.33 | 109.00 | 23.07 | 0.00 | 15.44 | 6.84 | 0.84 | 8663 | 1 |
| I1-probe-U-random-d | probe execute, persisted | 10 | 8413184 | 0.05 | 269.06 | 0.07 | 0.09 | 269.00 | 2.76 | 219.60 | 44.47 | 0.03 | 30.89 | 12.72 | 0.83 | 8663 | 1 |
| I1-probe-U-x-d | probe execute, persisted | 12 | 24576 | 0.05 | 1.66 | 0.03 | 0.07 | 1.63 | 0.02 | 0.05 | 1.47 | 0.08 | 0.03 | 0.72 | 0.64 | 8663 | 1 |
| I1-probe-U-x-d | probe execute, persisted | 10 | 1073152 | 0.05 | 4.67 | 0.03 | 0.07 | 4.65 | 0.39 | 1.23 | 2.92 | 0.00 | 0.50 | 1.82 | 0.66 | 8663 | 1 |
| I1-probe-U-x-d | probe execute, persisted | 10 | 4218880 | 0.06 | 14.92 | 0.05 | 0.08 | 14.88 | 1.38 | 4.55 | 8.66 | 0.00 | 1.81 | 6.17 | 0.76 | 8663 | 1 |
| I1-probe-U-x-d | probe execute, persisted | 10 | 8413184 | 0.06 | 27.50 | 0.05 | 0.08 | 27.46 | 2.79 | 9.10 | 15.61 | 0.15 | 3.56 | 11.12 | 0.77 | 8663 | 1 |

The `vfs.write_file` column is the cost of `maybe_compress`
(`vendor/vivari/packages/vfs/src/lib.rs`: zlib level 6 on every write of a file of 4,096
bytes or more, kept if it saves 5%). Read-back is the OPFS drain asking the VFS for the
file it was just given, which inflates it again. The manifest is 8.6 KB and costs
0.8 ms; the queue wait behind other paths was 0. The guest side (request file, response
file, unlink) is 0.3 ms.

The 5-minute refresh, observed once (`Q1`, 305 s after start, uncontrolled): two reads,
128 ms and 244 ms (the second returns the model list), max stall 267 ms, then a new
download of `api.json`; no write because the digest was unchanged. The bundle
(`server.js` 538221–538289) repeats this every 5 minutes and rewrites the row when the
digest differs; `updatedAt` is not advanced when it does not, so every tick downloads
again.

**The "latency doubles" step.** Reproduced: the step at the first insert, in every fresh
boot. Not reproduced: a second step in a running session, because no refresh found a
changed digest during these sessions. The probe shows the mechanism that would produce
exactly the earlier observation (database-backed requests 2× slower from one moment on,
VFS and origin usage up by 6.0 MB and then flat): the upsert of a new 6 MB value leaves
the file at about twice its size, and per-statement cost is proportional to file size.
That it was this in the earlier run is an inference.

## 3. Steady state

One uncontrolled reopened session (`Q1`, database 6.44 MB), tab visible.

| step (uncontrolled kernel, DB 6.44 MB) | visible | wall between dumps (ms) | UI send→idle (ms) | SQLite calls | SQLite ms | autocommit reads (n, ms, mean) | autocommit writes | commits etc. (txn) | in-transaction reads + writes (n, ms) | prepares (n, ms) | DB bytes before → after |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 6 × GET /api/session (0 sessions) | visible/visible | 1765 |  | 12 | 536 | 6, 532, 88.75 |  |  | 0, 0 | 6, 3 | 6438912 → 6438912 |
| prompt 1: new chat, "Reply with exactly the single word: ok" | visible/visible | 18125 | 8002 | 270 | 5422 | 46, 4028, 87.57 | 1, 88, 88.12 | 28, 1256, 44.86 | 60, 14 | 135, 35 | 6438912 → 6447104 |
| prompt 2: same chat, read tool on /workspace/package.json | visible/visible | 21892 | 9420 | 444 | 7909 | 62, 5477, 88.33 |  | 52, 2353, 45.25 | 108, 25 | 222, 55 | 6447104 → 6463488 |
| 5 × GET /api/session (1 session) + 5 × GET /api/session/:id/message?order=desc&limit=50 | visible/visible | 2658 |  | 30 | 1360 | 15, 1355, 90.32 |  |  | 0, 0 | 15, 5 | 6463488 → 6463488 |

| step | route | requests | total ms | SQLite calls while in flight | SQLite ms while in flight |
|---|---|---|---|---|---|
| 6 × GET /api/session (0 sessions) | GET /api/session | 6 | 540 | 12 | 536 |
| prompt 1: new chat, "Reply with exactl | POST /api/session | 1 | 482 | 18 | 477 |
| prompt 1: new chat, "Reply with exactl | GET /api/session/:id/message | 3 | 1056 | 24 | 1041 |
| prompt 1: new chat, "Reply with exactl | GET /api/session/:id/permission | 3 | 525 | 12 | 520 |
| prompt 1: new chat, "Reply with exactl | GET /api/session/:id/form | 3 | 262 | 6 | 260 |
| prompt 1: new chat, "Reply with exactl | GET /api/session/active | 3 | 1 | 0 | 0 |
| prompt 1: new chat, "Reply with exactl | POST /api/session/:id/prompt | 1 | 620 | 26 | 615 |
| prompt 2: same chat, read tool on /wor | GET /api/session/:id/message | 4 | 1171 | 26 | 1162 |
| prompt 2: same chat, read tool on /wor | GET /api/session/:id/permission | 4 | 619 | 14 | 614 |
| prompt 2: same chat, read tool on /wor | GET /api/session/:id/form | 4 | 358 | 8 | 355 |
| prompt 2: same chat, read tool on /wor | GET /api/session/active | 4 | 1 | 0 | 0 |
| prompt 2: same chat, read tool on /wor | POST /api/session/:id/prompt | 1 | 646 | 26 | 641 |
| 5 × GET /api/session (1 session) + 5 × | GET /api/session | 5 | 479 | 10 | 475 |
| 5 × GET /api/session (1 session) + 5 × | GET /api/session/:id/message | 5 | 890 | 20 | 885 |

| request from the page (idle) | n | ms each |
|---|---|---|
| Q1-list-1: GET /api/session (50 bytes; visible visible) | 6 | 108.4, 87.8, 88.6, 87.2, 89, 86.7 |
| Q1-list-2: GET /api/session (735 bytes; visible visible) | 5 | 119.2, 93, 90.4, 91.5, 90.9 |
| Q1-list-2: GET /api/session/:sid/message (9503 bytes; visible visible) | 5 | 176.8, 179.5, 178.1, 180.8, 180.5 |
| smoke-04-idle: GET /api/session (50 bytes; visible visible) | 6 | 344.9, 354.9, 369.1, 357.2, 354.8, 353.7 |

- Session list: one prepare (0.5 ms) and one read (88–90 ms). Message page: two of each.
- The first prompt's 5.4 s of SQLite is 46 autocommit reads (4.0 s), 14 commits (1.25 s)
  and one write; its 60 in-transaction statements cost 14 ms and its 135 prepares
  35 ms. The model request answered in 1.1 and 2.7 s (two requests, time to headers,
  overlapping the blocked loop).
- "wall between dumps" includes the driver's own waits and the chat UI's follow-up
  requests after idle, so the SQLite total is for that window, not for the send-to-idle
  interval alone.
- `smoke-04-idle` is the same session list in a slow controlled kernel: 345–369 ms.

## 4. Tracing overhead

| mode | tracing | n | samples | spawn→listen | listen→ready line | ready line→first answer | activation | connect | spawn→attached |
|---|---|---|---|---|---|---|---|---|---|
| freshU | off | 3 | O1-freshU-off, O2-freshU-off, O3-freshU-off | 1995 (1994–2046) | 93 (89–104) | 27 (27–28) | 1046 (215–1080) | 1266 (1106–1313) | 3540 (3384–3647) |
| freshU | on | 3 | O1-freshU-on, O2-freshU-on, O3-freshU-on | 2026 (1949–2173) | 91 (89–114) | 29 (28–31) | 1038 (210–1124) | 1254 (1103–1369) | 3558 (3336–3831) |
| reopenU | off | 3 | O1-reopenU-off, O2-reopenU-off, O3-reopenU-off | 2060 (1987–2100) | 1122 (1117–1166) | 373 (354–382) | 2030 (1961–2042) | 3638 (3551–3677) | 6014 (5836–6075) |
| reopenU | on | 3 | O1-reopenU-on, O2-reopenU-on, O3-reopenU-on | 2077 (2070–2088) | 1131 (1083–1165) | 373 (361–389) | 2046 (2000–2064) | 3614 (3586–3702) | 5984 (5949–6067) |
| reopenC (fast regime) | off | 3 | O1-reopenC-off, O2-reopenC-off, O3-reopenC-off | 1957 (1954–1961) | 1097 (1073–1103) | 362 (353–369) | 1930 (1924–1941) | 3482 (3459–3490) | 5714 (5698–5738) |
| reopenC (slow regime) | off | 1 | P2-reopenC-off | 8631 (8631–8631) | 3262 (3262–3262) | 1210 (1210–1210) | 6541 (6541–6541) | 11307 (11307–11307) | 21021 (21021–21021) |
| reopenC (slow regime) | on | 2 | P1-reopenC-on, P3-reopenC-on | 13164 (7429–18900) | 4232 (3124–5340) | 1544 (1436–1652) | 9558 (7282–11835) | 16052 (12182–19923) | 31312 (20704–41921) |

In the two modes with tight spreads the difference between off and on is smaller than
the spread within either (reopenU spawn→attached 6014 against 5984; freshU 3540 against
3558). In the controlled mode the kernel was in a fast regime for the three untraced
samples and a slow one for the rest, so those rows say nothing about tracing; `P2` (off)
between `P1` and `P3` (on) is the only like-for-like controlled comparison and is
inside their range.

## 5. Bundle load split (temporary runtime edit, reverted)

The entry's own measurement is `import-start` to `import-sync-end`: 1835–2046 ms
uncontrolled (n = 20), 6954–9781 ms in the slow controlled kernel (n = 11), with one
controlled sample at 1888 ms and one at 17942 ms under load.

Finer than that needed timers inside the runtime's loader and the kernel's SQLite
server. That was done as a temporary, uncommitted edit of `vendor/vivari`
(`packages/runtime/module.js`, `packages/runtime/builtins/sqlite.js`,
`packages/kernel-host/sqlite-server.js`, `packages/kernel-host/opfs-persistence.js`;
47 lines, kept as `.diagnostics/…/runtime-state/temp-runtime-instrumentation.patch`),
built, measured, then reverted with `git checkout`, the two instrumented worker files
removed from the build's retained assets, and the runtime rebuilt. Afterwards the fork
is clean at `2367a645`, and the packaged distribution's 1,776 recorded values (every
source file hash and every asset hash) equal the ones saved before the edit; only
`builtAt`, `native.rebuilt` and the two hashes derived from them differ. The pin did
not move.

| sample | file | chars | read | pre-transforms | ESM→CJS transpile | compile (first attempt, fails on top-level await) | compile total (both attempts) | sync evaluation | sum |
|---|---|---|---|---|---|---|---|---|---|
| I1-freshU | /app/server.js | 27536442 | 257 | 5 | 1079 | 145 | 304 | 336 | 1981 |
| I1-reopenU | /app/server.js | 27536442 | 259 | 4 | 1014 | 129 | 285 | 328 | 1891 |
| I2-reopenU | /app/server.js | 27536442 | 258 | 5 | 1014 | 126 | 279 | 332 | 1889 |
| I1-reopenC | /app/server.js | 27536442 | 941 | 14 | 3546 | 572 | 1295 | 1565 | 7362 |
| I2-reopenC | /app/server.js | 27536442 | 1000 | 11 | 3875 | 627 | 1360 | 1637 | 7884 |

`/app/server.js` is 27.5 M characters. The first compile attempt fails on the bundle's
top-level await every time and is repeated as an async function. In the slow controlled
kernel every part is 3.4–4.8× slower, as is every kernel-side part of a persist: the
slowdown is CPU in both the process worker and the kernel worker, in JavaScript and in
WebAssembly alike. In `L2-reopenC` the bundle load was fast (1888 ms) while the same
page's kernel was slow, so it is per worker.

## Attribution

Guest start to the activation request answered (instrumented split applied to the
bundle load):

| | fresh, uncontrolled, n = 8 | reopen 6.44 MB, uncontrolled, n = 7 | reopen, controlled kernel in the slow regime, n = 7 |
|---|---|---|---|
| total | 2.20–2.41 s in 5 samples (3.07–3.35 s in the 3 where the model list write fell inside activation) | 5.50 s (5.31–5.60) | 21.2 s (15.1–36.9) |
| SQLite | 0.15–0.19 s, 7–8% (0.87–0.96 s, 28–29%) | 3.21 s, 59% | 11.9 s, 56% |
| bundle load | 1.93 s, 83% | 1.96 s, 36% | 7.7 s, 37% |
| of which read | 0.26 s | 0.26 s | 0.94–1.00 s |
| of which ESM-to-CJS transpile | 1.08 s | 1.01 s | 3.5–3.9 s |
| of which compile | 0.30 s (0.15 s the failed first attempt) | 0.28 s (0.13 s) | 1.3–1.4 s |
| of which synchronous evaluation | 0.34 s | 0.33 s | 1.6 s |
| not attributed | 0.23 s, 10% | 0.27 s, 5% | 1.7 s, 8% |

Event-loop stall is the same time seen from outside: the longest single stall is the
bundle load plus the SQLite calls that follow it before the first yield.

Not attributed: 0.2–0.3 s between the marks that is neither SQLite nor bundle load
(listen, the server's asynchronous start, plugin activation's own work, HTTP handling).
Plugin activation without its SQLite is about 0.2 s on a reopen and 0.15 s on a fresh boot.

The numbers this task started from (spawn→listen 2.5 s, listen→ready 2.9 s, 0.95 s
before the first answer, activation 4.7–5.6 s) are about 2.5× the uncontrolled reopen
here in the three SQLite phases (1.12, 0.37, 1.97 s) and well under the slow controlled
one. They fit an uncontrolled kernel with a database around 2.5× this one's persist
cost; that reading is an inference, the captured opens were not re-examined.

## What each measurement supports

Savings are for an uncontrolled kernel and a 6.44 MB database unless said; in the slow
controlled regime multiply by 3–4. None of this was implemented or tested.

| # | Change | Supported by | Implied saving |
|---|---|---|---|
| 1 | Persist only when the database changed (no export on reads, PRAGMAs, no-op statements) | Sequence table: 33 persists per reopen boot (32 statements, one twice), at most 3 statements changing anything. Probe: reads cost what writes cost; in-transaction statements 0.2 ms | Reopen boot: about 30 × 86 ms = 2.6 s of 3.2 s. Prompt 1: 46 reads = 4.0 s of 5.4 s. Session list 90 → about 2 ms, message page 178 → about 3 ms |
| 2 | Keep the model list out of the database (do not fetch, or cache it elsewhere) | Fresh boots: 3.7 ms per statement at 475 KB against 86 ms at 6.44 MB. Sequence: two 215–223 ms reads of the row. 5-minute tick. Upsert doubling | Every persisting statement 86 → about 4 ms (reopen boot SQLite 3.2 s → about 0.15 s; prompt 1 5.4 s → about 0.3 s). Removes the 335–380 ms insert, the two 0.2 s reads per boot, a 0.37 s stall and a 6 MB download every 5 minutes, and the doubling. Alone it gives most of what 1 gives; sessions grow the database again, so 1 is still needed |
| 3 | Do not zlib the database image on every VFS write | Kernel split: `vfs.write_file` 61 of 86 ms; random text 26 ms/MB of zlib | About 70% of every remaining persist, plus most of the read-back (which becomes a copy): 86 → roughly 15 ms. Matters for the writes that survive 1 and 2 |
| 4 | Cache the ESM-to-CJS transpile of the bundle (and remember it needs the async wrapper) | Load split: transpile 1014–1079 ms, failed first compile 126–145 ms, of 1.9–2.0 s | About 1.15 s per start, fresh or reopen (about 4.3 s slow controlled). The largest item on a fresh boot |
| 5 | Persist increments instead of the whole image | Cost linear in image size for real writes after 1–3: export 0.33 ms/MB, OPFS write 1.4–1.7 ms/MB, read-back | The remaining size-proportional part of each real write (about 15 ms at 6.44 MB after 3). Lower priority |
| 6 | `exec` persists once, not once per statement plus once at the end | `PRAGMA journal_mode = WAL;` 170 ms against 84–86 ms for its neighbours; probe COMMIT via exec = 2× | One persist per boot (86 ms); nothing after 1 |
| 7 | Skip the prepare exchange | Prepare is 0.2–0.3 ms; 31 per reopen boot = 10 ms; 135 per prompt = 35 ms | Not worth doing |
| 8 | Guest event loop during boot | Stall = bundle load + SQLite; first health probe waits 1.4–1.5 s on reopen, times out at 3 s in a slow controlled kernel (2–3 attempts) | Nothing of its own; follows from 1–4 |

Order: 1 and 2 remove the same seconds from a reopen and from every chat turn; 2 is a
configuration change on the toolkit side, 1 a small kernel change; 4 is the only item
that helps a fresh boot; 3 matters for write-heavy work once 1 is in.

The controlled-kernel slowdown is larger than any of these when it occurs (a reopen
goes from 5.5 s to 15–37 s to activation answered) and is not addressed by them.

## Measured, inferred, not measured

Measured live (this run): every number in the tables; the linear size relationship; the
equality of read and write cost; the 0.13–0.25 ms in-transaction cost; the file doubling
on upsert; the step at the first model list insert; the kernel-side split and the bundle
load split (instrumented runtime, n as in the tables); tracing overhead in the
uncontrolled modes.

Read from source, consistent with the measurements but not separately measured: that
the `vfs.write_file` time is zlib (`maybe_compress`); that read-back is an inflate; that
`exec` persists twice; that persist is skipped only when not in autocommit; the 5-minute
refresh logic and the digest comparison; that the model list is one `kv` row holding
the response text.

Inferred: that the earlier run's doubling was a refresh that found a changed digest;
that the numbers this task started from were an uncontrolled kernel with a larger
database; that the saving of each change is the time of what it removes.

Not measured, or not possible here:

- Why a controlled kernel is slow, and why three consecutive controlled reopens were
  not. Only its shape: CPU, per worker, 3–4×.
- A refresh-triggered doubling in a live session.
- Steady-state chat cost in a controlled kernel, with another model, or with a long
  session; n = 2 prompts.
- The effect of sessions on database size beyond two prompts (6,438,912 → 6,463,488 bytes).
- Anything with the tab hidden or throttled.
- Outbound response body time (time to headers only); the size of `api.json` on the wire.
- Memory and garbage collection during the transpile (the split/join over 27.5 M characters).
- Plugin activation's internal order or per-plugin time.
- Tracing overhead in the controlled regime.
- The influence of the lost tab's idle kernel on the samples after 00:11Z.
- Any optimization's actual effect.
- The `opencode-chat` launch test: it cannot load in this worktree
  (`@opencode/schema/config/provider` is not installed; same failure before these
  changes). `tsc` is clean for `opencode-chat` and for the example's `src/`.

## Reproduce

```sh
# build and serve (from the worktree root, then the example)
bun run build:example
cd examples/todo-app && PORT=3100 bun run editor:debug

# trace lines as they arrive
bun run editor:logs --follow --event guest.output | grep OPENCODE_TRACE

# traced open: add opencodeTrace=1
#   http://localhost:3100/?workspaceFixture=1&opencodeTrace=1
# in the page, after the editor is ready:
#   await window.__openCodeTrace.dump('label', true)                       // counters + per-statement log
#   await window.__openCodeTrace.dump('probe', false, { megabytes: [1, 2, 4, 8, 16], fill: 'random', shape: 'rows' })
#   await window.__openCodeTrace.dump('upsert', false, { megabytes: [6, 7], fill: 'x', shape: 'one' })
```

Driver and analysis, in `.diagnostics/opencode-startup-sqlite-2026-10-01/` (gitignored),
run with the Browser Control CLI session `opencode-trace-meas`:

```sh
./run.sh 00-setup.js && ./run.sh 01-helpers.js
./cycle.sh <label> <freshU|freshC|reopenU|reopenC> <on|off> 10   # exit, clear/unregister, reload, open, dump, summarize
./campaign-1.sh        # section 1          ./campaign-2.sh        # section 4
./run.sh 30-reads.js "state.cfg = { label: 'x', n: 6, paths: ['/api/session?directory=%2Fworkspace&limit=100'] }"
./run.sh 06-chat.js  "state.cfg = { label: 'x', newChat: true, text: '…', enters: 1, wait: 'idle' }"
./probe.sh <label> 1,2,4,8,16 <x|random> <rows|one>
python3 tables.py <labels…>; python3 step.py <labels…>; python3 sequence.py <label>; python3 delta.py <before> <after>
python3 runtime-split.py <labels…>                                 # instrumented runtime only
python3 runtime-state/make-temp-instrumentation.py                 # the temporary runtime edit (never commit; revert with git checkout)
python3 runtime-state/compare-distribution.py runtime-state/distribution.before.json runtime-state/distribution.after-revert.json
python3 build-doc.py                                               # this document from doc-template.txt and the tables
```

Evidence there: `events-all.jsonl` (every diagnostics event of the run, across log
rotations), per-sample `<label>.json` (page timings, UI state), `dump-<label>.json`
(guest counters and statement log), `summary-<label>.json`, `delta-*.json`,
`reads-*.json`, the `tables-*.md` included above, `attempt-1/` (the steps that ran
after the tab was lost), `runtime-state/` (receipts before and after the temporary
edit, the patch), `pre-existing/` (the events log that was in place before this run).
