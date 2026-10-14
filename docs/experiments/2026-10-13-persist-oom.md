# A snapshot that could not allocate froze the tab (2026-10-13)

Branch `persist-oom`, from `chat-client` (`dc27542`; `crates/` and `runtime/` there are those
of `origin/main` `bc968bb`). The decisions are in `docs/design/decisions.md` under this date;
this is what was run and what it printed. Chrome 154 headless, launched by the check itself
through Playwright (`/opt/google/chrome/chrome`); the `browser-control` extension was not
connected on diesel2 that day. No model was called anywhere: guests are `node -e` scripts,
and the downstream page ran its scripted provider.

## 1. What happened

A downstream app (agent-studio in autoanimate) had its agent download two files of 30 and
22 MB into `/workspace/source`. The tab froze: main thread at 100% CPU, no input, for good.
The console held

```
bat kernel: out of memory: 107.3 of 255.6 MiB in use, 71.4 MiB more could not be had …
kerneld: unhandled rejection RuntimeError: unreachable
```

`persist::snapshot` took `VFS.write()` and then `Vec::with_capacity(size of every persistent
file)`. Refused, Rust aborted, the write lock stayed held. kerneld's next turn waited for it
in `persist::pending_bytes`, every process parked in its next file call, and the page, which
may not block, spun in `RwLock::slow`. kerneld calls `snapshot` when the journal passes
16 MiB at a drain, or 1 MiB after 5 s without one.

## 2. The reproduction

`bun runtime/harness/persist-check.ts` (it starts the harness server on `BAT_HARNESS_PORT`,
default 4104, and a headless Chrome; `BAT_PREPARED` names a prepared example as for
`check.sh`). Case `fold`: four processes each write a 30 MiB file under `/workspace/source`,
with the journal folded in between, then the page is reloaded and the files are compared.

Before (the build of `dc27542`, same check):

```
fold       HANG  no answer in 60 s: node /workspace/source/f3.bin 30 10
  console: bat kernel: out of memory: 114.7 of 255.6 MiB in use, 90.0 MiB more could not be had …
  console: kerneld: unhandled rejection RuntimeError: unreachable
```

After:

```
fold       ok  120 MiB folded with 162.8 MiB in use; peak 176.0 MiB -> 176.0 MiB; restored 120.0 MiB snapshot + 122 journal bytes in 119 ms
refused    ok  write refused after 11 MiB of a 64 MiB memory, guest alive, 8.0 MiB snapshot restored
crash      ok  16 crashes of the tab (CDP Page.crash, delays 0,5,10,20,35,50,80,200 ms for snapshot and journal), everything flushed intact after each
old-format ok  a 6 MiB file in one record restored (6.0 MiB, 39 ms), a journal frame across the snapshot applied from the snapshot on, folded again and restored
dead       ok  a trap under the filesystem lock: "The runtime has failed: its kernel stopped while it held a lock (RuntimeError: memory access out…"; page's next call and kerneld's fail with it, onFatal called
```

- **refused**: a 64 MiB kernel memory, a process writing 1 MiB at a time. The write that does
  not fit returns `ENOSPC` to the process, which catches it, removes nothing and goes on
  running; other processes start and read; what was written is folded and restored.
- **crash**: the renderer is killed (`Page.crash`), not reloaded: a reload lets a worker
  finish its synchronous write, and in the first attempts no snapshot was ever torn. Killed
  0 to 200 ms after a fold or a large write begins, eight times each. Torn slots were seen
  (`snap-b torn at 13795328 / 15745296 / 32523034 / 66078510 bytes`, `snap-a torn at 3276800
  bytes`: records without a header) and never chosen; files caught partly journaled (5.0 and
  15.0 MiB of 16) came back as a prefix, consistent with the journal. Everything a `flush()`
  had answered for before the kill was there after it, byte for byte.
- **old-format**: a snapshot slot written the earlier way (one node record holding a 6 MiB
  file) and a journal frame that starts before the snapshot's sequence number. Besides this
  synthetic one, a workspace written by the build of `dc27542` in the same profile (three
  10 MiB files, a note, a symlink: a 31,474,040-byte snapshot and one journal frame) was
  opened by the new build: restored in 126 ms, intact, folded again and restored again.
- **no-persist** (`no-persist ok 24 MiB under noPersist: 17523 journal bytes, 16791 snapshot
  bytes, gone after the reload, the rest kept`): the boot option, through the harness page's
  `?nopersist=`.
- **dead**: the check makes a real trap with the filesystem lock held (a harness-only call).
  The 30 s give-up of a spinning thread is not exercised.

`cargo test -p bat-kernel` (native) covers the record level: snapshot pieces of at most
1 MiB, a failing sink leaving the journal as it was, `snapshot_done`, a replay in pieces cut
anywhere, a file in one record.

## 3. Time and memory, 60 MiB overlay

`bun runtime/harness/persist-check.ts --measure`: two 30 MiB files, five folds, then a reload.
Kernel memory from `bat_mem_stats`.

| | before | after |
| --- | --- | --- |
| snapshot, five runs (ms) | 37, 41, 42, 40, 40 | 35, 38, 37, 43, 38 |
| kernel memory in use with the files written (MiB) | 79.1 | 79.1 |
| peak in use through the snapshots (MiB) | 139.1 | 107.0 (the snapshot adds 0.0) |
| restore (ms) | 76 | 60 |
| peak in use after the restore (MiB) | 122.5 | 67.0 |

The peak of 107 that remains is the writing: a file's buffer growing and its bytes in the
journal until that is drained.

`runtime/harness/check.sh`, twelve guests, Chrome 154 and Playwright's WebKit: every guest
as before (`cjs.cjs` 7), times within the noise of two runs each way. The wrapper around the
exports costs nothing that shows there.

## 4. Downstream

A temporary worktree of autoanimate at `download-stall` with that branch's mitigation
reverted, built with `BAT_DIR` at this checkout (`scripts/build-agent-studio.sh`), served,
and driven by its `scripts/download-stall.ts` with `?provider=scripted`:

| step | result |
| --- | --- |
| four 30 MiB `node -e` writes into `/workspace/source` | kernel memory in use 62, 99, 135, 171 MiB; peak 193 |
| `sleep 9` (the idle fold) | `snapshotAt` set, `unflushedBytes` 0 |
| `ls -la source` | four files |
| a fifth 30 MiB write | fails with `ENOSPC`, exit 1; `refused` 2 |
| `du -sh source && echo still-alive` | `142M source`, `still-alive` |

No step stalled; the longest main-thread task was 1 ms. The build before the change was not
run through this page again here; its hang is the one of section 2.

## 5. What is left

- Files are in the kernel memory. About 120 MiB of them fit in the default 256; more is
  `ENOSPC`. A growing file carries spare capacity (120 MiB of files, 163 to 171 MiB in use).
- The 30 s bound on a spinning thread has no test.
