# Single-kernel first real-browser cohort

Absolute report path: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-first-live-cohort.md`.

## Outcome

**Not accepted yet.** Real-browser synchronous filesystem checks passed, including
newline names, symlink/lstat/readlink, rename, and exact 1,048,583-byte binary guest
and host readback. The next contract, guest `execSync` spawning a synchronous-FS
child, exceeded its predetermined 120-second deadline. The first failure stopped
the entire cohort; no action was retried, no old origin was targeted, and no model
request was made. Application/HTTP/storage stages later in the cohort were not run.

Actual Chrome census on the failed owned page: **one kernel worker and one guest
process worker**, zero FS/fetcher/HTTP/Python/LSP/SQLite auxiliary workers. Runtime
worker registry counters independently match: kernel=1, filesystem=0,
httpCoordinator=0, fetcher=0, other=0, process=1, processPids=[2]. Kernel diagnostics
remain responsive. The kernel URL has the valid `?opfs-disable=` flag.

## Chronology and artifact identity

- Installed a separate experiment-only dependency manifest/lock in
  `.diagnostics/single-kernel-deps`, then verified frozen Bun installation. Toolkit
  manifests/locks and canonical vendor/pins were not changed. This manifest's
  ranges resolve independently; the guest application uses its own existing
  frozen original lock, not the experiment tool dependency lock.
- At checkpoint `e14ea7d`, emitted an explicit native-reuse receipt, then paused
  before distribution/browser startup when the parent announced review edits.
  Compiled against a committed host SDK snapshot offline during that boundary.
- Rebuilt JS/core declarations from clean checkpoint
  `33e74eb31e3f135f33d8d806968067d404e05f68` after replacement authorization.
  Native reuse verifies every tracked crate/Cargo input against clean donor
  `/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean` at
  `446df00f86d5d6d5d856a2e5deec0fac49f242fa`, compares **37 output hashes**, and
  checks the documented Wasm hashes. No claim that wasm-pack ran. The receipt
  hashes **40 emitted assets** and preserves upstream/SQLite license metadata.
- Runtime worker assets are `kernel-worker-W_1uBQG1.js` and
  `process-worker-vyBhnbjL.js`. Packaged distribution version:
  `0098bfd6cbd8880ddd4d79528f8c7e3518225d03c8d7d81d846bdb5e0f0fd845`.
- Fresh app preparation contains **12,301 verified dependency/runtime entries**.
  Its frozen inputs retain the qualified unchanged UI distribution as an explicit
  read-only input, with runtime-facing workspace/browser entries replaced by
  separately source-built fork-host libraries. Published archives/qualified
  originals were never edited. An initial preparer failure (missing local library
  dist inputs in this new worktree) was preserved and repaired by a new isolated
  input snapshot, before any browser acceptance began.
- Source libraries/declarations and isolated browser consumers compiled and
  typechecked. Main acceptance driver reuses the verified serial command owner
  and filesystem lock, with an explicit Bun-backed Browser Control CLI prefix.
  Reused HTTP/process/storage test implementations use one emitted test-only
  library instance, including their private host escape hatch; they do not build
  a second kernel or mix private WeakMap ownership.

## Retained first failure and actionable runtime blocker

Artifact directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-2026-09-30T05-26-56-358Z`.

Evidence directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-live-33e74eb-attempt1`.

- App origin `http://127.0.0.1:62428/`, server PID **43768**,
  Browser Control session **single-kernel-app-3abef79d**.
- Separate contract origin `http://127.0.0.1:62427/`, server PID **43770**,
  unused reserved session **single-kernel-cases-c03b11f9**.
- `failure-census.json`: complete live page evidence + Chrome worker targets +
  runtime diagnostics. `blocked-worker-stack.json`: exact retained process stack
  and source excerpts. `result.json`: failed status and ownership state. The
  generated per-command files retain every one-shot initiation/read and CLI result.
- Browser Control debugger stack: `execSync → spawnSync → spawn → call` parked at
  `Atomics.wait(ctrl, 0, STATE_REQUEST)`. `spawn` is **opcode 20**. `execSync`
  invokes `spawnSync('sh', ['-c', 'node /workspace/sync-child.cjs'], {maxBuffer:2097152})`.
- PID **2**, ppid=0, command `/bin/node.js /workspace/parent-sync.cjs`, is booted,
  has no worker errors and reports **one syscall**. No child worker/PID exists.
  This localizes the blocker to completion/dispatch of the synchronous spawn
  syscall, before child FS or large stdout production, rather than output overflow.
- The diagnostic debugger was always resumed; its session-bound raw CDP socket
  was closed. The first unbound raw diagnostic failed scope resolution without
  pausing anything; the corrected diagnostic succeeded. Browser Control setup
  details are in the separate chronological todo report.

The cohort's ownership lock remains intentionally retained at
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-browser-owner.lock`.
Do not steal/remove it or navigate the failed page to manufacture cleanup.
The new consumer includes an explicitly authorized, one-shot `retireFailure`
cleanup API for subsequent repair cohorts, but it is not present in the already
frozen first-attempt consumer and was not invoked. Retirement must preserve
failure evidence, join owned cleanup, prove zero-work/zero-worker state, and only
then release exclusive initiation ownership. Cleanup never turns failure green.

## Implemented next-cohort coverage (not passing claims)

The runnable driver initiates serial foundation contracts, startup + four A/B
switches, generation-specific hydration, a real todo write and a freshly armed
interactive PDF click for every generation, same-document Vite HMR, OpenCode
health/plugins/config/model catalog readiness and SSE handshake/abort, final
stop/drain/zero-work, close/reopen and same-origin reload persistence.

It then runs **10 selected existing HTTP/process/storage cases** on the separate
fresh origin: before-header abort, response-reader cancel, bounded producer credit
and exact stream bytes, stale endpoint, execution/runtime child cleanup + port
reuse, bulk delete/recreate, Web Lock ownership/release, concurrent writes/flush,
and SQLite ownership/rollback/reopen. Multi-step cases reload only after their
owned runtime has stopped/closed and Chrome reports no kernel/process workers.
OPFS deletion between cases is restricted to that newly verified owned origin.

Additional actual test source now covers evicted fetched-body pins via the fork's
existing `__ocfetchAsync` metadata primitive (explicit test-only runtime coupling):
hold a >1 MiB body, fill the documented 16 MiB cache to evict its accounting,
observe its surviving pin, then read exact bytes through guest `readFileSync`
EFBIG/fd fallback and prove close/exit reclamation. The server provides bounded
deterministic binary fixtures. No new runtime opcode is assumed. This newer case
was added after the first retained failure and has not been run live.

Source-mode worker URL/query semantics have a fail-closed unit test; live Chrome
census validates SQLite opt-out. A full Studio source-mode browser run remains
separate from the emitted-distribution consumer, despite the runtime owner's
source-mode Vite regression check passing.

Latest focused offline checks: **20 pass, 0 fail, 101 assertions**. Source-library
and consumer typecheck/bundle checkpoint:
`.diagnostics/single-kernel-2026-09-30T05-42-02-396Z` (offline, not served).
After the final harness additions, its generated-library consumer `tsc --noEmit`
and a separate strict receipt-script typecheck both pass; `git diff --check` is clean.

## Reproduction / repair commands

Only after the parent authorizes the next clean runtime checkpoint and retirement
of retained owned work:

```sh
export VIVARI_SOURCE=/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel
export VIVARI_WORKER_TOPOLOGY=single-kernel
bun vivari/scripts/receipt-single-kernel.ts /Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean
bun test workspace-api/scripts/runtime-assets.test.ts examples/todo-app/tests/single-kernel-contract.test.ts examples/todo-app/tests/single-kernel-driver.test.ts examples/todo-app/tests/matched-pair-driver.test.ts
bun examples/todo-app/tests/prepare-single-kernel.ts
```

That prints a new `$OUT`. Build the isolated app preparer, snapshot qualified
local UI inputs read-only, and generate a new matching-runtime app payload:

```sh
bun examples/todo-app/tests/build-single-kernel-app-preparer.ts "$OUT"
bun examples/todo-app/tests/snapshot-single-kernel-app-input.ts "$OUT" /Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit "$NEW_INPUT"
SINGLE_KERNEL_APP_ROOT="$NEW_INPUT/examples/todo-app" SINGLE_KERNEL_APP_OUTPUT="$NEW_APPS" RUNTIME_DIR="$OUT/runtime" OPENCODE_PACKAGE_DIR=/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/opencode-chat/dist/application bun "$OUT/preparation-tools/single-kernel-prepare-apps-consumer.js"
SINGLE_KERNEL_PREPARED="$NEW_APPS/prepared" bun examples/todo-app/tests/prepare-single-kernel.ts
```

Use the last printed fresh `$FULL_OUT`. Start both OS-assigned origin servers,
then invoke the fully serialized Bun Browser Control driver once:

```sh
bun examples/todo-app/tests/serve-single-kernel.ts "$FULL_OUT"
bun examples/todo-app/tests/serve-single-kernel.ts "$FULL_OUT" --contracts
SINGLE_KERNEL_AUTHORIZE_RUN=yes bun examples/todo-app/tests/single-kernel-driver.ts "$FULL_OUT" "$NEW_EVIDENCE"
```

Servers are deliberately retained parent-owned resources, with exact PIDs in the
ownership receipt. Successful driver cleanup closes owned workspaces, proves no
kernel/process targets, deletes only its new sessions, and releases its lock.
Failure retains all owned evidence/resources rather than retrying an action.
No performance comparison has started.
