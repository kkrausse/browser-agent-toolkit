# Independent single-kernel consolidation audit

## Verdict

**PASS for the requested runtime-worker consolidation, with bounded compatibility
qualification.** This is one runtime authority worker per runtime instance, not one
worker for all user computation. Guest programs, child processes and guest threads
remain PID-owned process workers. The browser Service Worker remains a relay.

The original plan's goal and acceptance agree with this interpretation:
`docs/experiments/2026-09-30-single-kernel-fork-plan.md:5–9,37–43`.
The user's clarification is to consolidate the workers servicing Vivari runtime
calls, while retaining independent user-space execution.

This audit distinguishes source inspection and fresh headless tests from the
previously retained Chrome evidence. It does not establish comparative performance
or a measured reduction in synchronization failures.

## Baselines and upstream status

- Canonical toolkit and `browser-agent-toolkit-upstream` both pin Vivari
  `e998de62a10e5382104b51e0b860ee9d4d7a2401`, upstream base
  `9a89ff328b87ad0fb6a180d4401ea418c180cbe7`.
- The experiment starts at `446df00f86d5d6d5d856a2e5deec0fac49f242fa`, which
  adds the filesystem completion-predicate correction to that pinned baseline.
- The audited runtime HEAD is `e35eab4af7a53ff08eb70c09df59c40b78bfdd67`;
  the audited toolkit HEAD before this report is `b6be84e`.
- Both the canonical pinned source and upstream-base kernel worker instantiate
  filesystem, fetcher and PID process workers, plus a lazy Python LSP worker.
  Neither has the experimental consolidation.
- These are real changes in the editable Vivari fork, not consumer-side mock
  implementations or generated-bundle edits. There is no evidence of upstream
  adoption in this work; the handoff explicitly claims no push or deployment.
  The experiment's own `vivari/runtime-source.json` still has the canonical pin,
  so normal default setup does not automatically select the experimental runtime.

## What actually moved

Runtime paths below are relative to
`/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel`.

| Responsibility | Audited implementation |
| --- | --- |
| VFS, FsServer, OPFS and dependency cache | `packages/core/src/workers/kernel-filesystem.ts:19,247–319`: awaited local factory, not a Worker |
| SQLite service | Same factory installs `createSqliteServer`; SQL executes in the kernel owner |
| Former fetcher | `kernel-worker.ts:1459–1462` calls local async `kernel-fetch.ts` |
| Guest synchronous filesystem | `kernel-worker.ts:1562–1568` registers the guest SAB/MessagePort with the local FsServer |
| Kernel-local filesystem | `packages/kernel-host/direct-kernel-fs.js`: direct VFS reads/shared mutation dispatch, no Atomics wait or self-RPC |
| Process supervision/HTTP | Existing Kernel remains in the same worker as the newly local services |
| User computation | Sole kernel nested Worker constructor is `kernel-worker.ts:1481`, for PID-owned process workers |
| Auxiliary runtime workers | Python editor LSP explicitly unavailable; SQLite helper-worker constructors fail-closed at library build, with supported `opfs-disable` launcher flag |

The main thread still launches/relays to the runtime worker. FsServer and Kernel
are separate modules/dispatch paths in **one thread**, not separate runtime workers.
Consolidation does not require flattening them into one class or one opcode handler.

### Synchronization implications

The kernel no longer synchronously waits on a separate filesystem worker. Kernel
filesystem housekeeping, guest filesystem servicing, fetched-body ownership and
process cleanup now share an owner/thread. This structurally removes that
cross-worker registration, message delivery and completion boundary. It also
requires deferred spawn/fetch/SQLite operations to yield rather than block the
kernel while guests need it.

Guest SAB publication/predicate waits remain. Async persistence, HTTP streaming,
cancellation and shutdown still have lifecycle ordering requirements. A single
JavaScript thread can interleave operations at awaits and is not an automatic
transaction mechanism. CPU-heavy VFS/SQL/cache work can now delay unrelated kernel
servicing; this is a risk to measure, not a demonstrated regression.

Guest global outbound `fetch()` still calls wrapped browser fetch directly
(`packages/runtime/index.js:1407–1420`); same-process loopback is also local.
Neither adds another runtime authority worker. They do mean this is not a new
complete security/egress mediation boundary, which was not the user's criterion.

### Repairs versus architectural effects

The branch also repairs newline-delimited directory-name framing, fetched-body
consumption before an oversized SAB response was accepted, ownership release on
backend boot failure, and large synchronous binary child capture/publication.
The final capture transport uses bounded inline base64 or transient raw VFS spills
read through existing chunked guest I/O, with rollback and unlink ownership receipts.
These are explicit correctness fixes; passing them cannot by itself prove that
single-kernel topology is superior. Several are potentially useful independently
of consolidation. No Rust/Wasm source redesign was necessary for this experiment.

## Fresh independent headless verification

Executed from the audited runtime checkout with host Node **24.7.0**, not the
integration's qualified Node 24.18.0; existing native artifacts were used, not
rebuilt. Runtime tracked files remained clean afterward.

| Command | Observed result |
| --- | --- |
| `node scripts/test-single-kernel.mjs` | PASS: topology source guard, real guest synchronous child FS, large binary, SQLite, handler sync FS and cleanup |
| `node scripts/test-single-kernel-review.mjs` | PASS: query-safe Vite URL, durable owner gating, backend-init cleanup, EFBIG/chunked fetch-body retry/reclamation |
| `node scripts/test-single-kernel-routing.mjs` | PASS: real guest spawn modes/FS ports and bounded read-only routing diagnostics |
| `node scripts/test-sync-capture.mjs` | PASS: original binary execSync fixture, capture boundaries, failure rollback, unlink ownership consumption and cleanup |
| `node scripts/verify-node.mjs` | RESULT: PASS, including guest threads, processes, filesystem/watch, HTTP, codecs and fetched-body lifetime |
| `node scripts/verify-runtime-contracts.mjs` | FAIL at first contract: `worker-uncloneable`, `markAsUncloneable is not a function` |

The last failure matches a pre-existing documented baseline failure, not a newly
established topology regression. See
`docs/experiments/2026-09-29-reset-filesystem-transport-completion.md:102–124`.
This audit did not freshly rerun that failure on the canonical baseline and does
not claim the full contract suite passed or that the Node version caused it.
Headless SQLite prints its unsupported browser-OPFS-VFS notice; these passes do
not qualify browser persistence.

## Retained Chrome evidence and fresh todo E2E

The independent read-only evidence audit supports the handoff's **bounded
completion across two same-runtime runs**. It does not retroactively pass the
original cohort.

- Five retained active Chrome inventories show exactly one kernel and three guest
  workers, with actual worker titles matching PIDs `[1,2,3]`, `[4,5,6]`, through
  `[13,14,15]`. See original live evidence `0132.json`, `0184.json`, `0222.json`,
  `0260.json`, `0298.json` under
  `.diagnostics/single-kernel-live-e35eab4-attempt1/`.
- Original `failure-app.json` records 19 completed stages through application
  shutdown. Remaining `result.json` records 10 cases/14 passed steps. Interactive
  command receipts independently record todo hydration/submission and PDF output
  for five generations.
- Original and remaining ownership receipts identify the same runtime source,
  distribution and worker hashes. Independent rehashing of all 9,587 original and
  9,588 remaining receipt-listed files found zero mismatches.
- Remaining `0010.js` actually calls `page.reload()`. Its verification checks the
  marker, every byte of the renamed 1,048,583-byte file and deleted-file absence.
- Remaining evidence has 178 command receipts and 42 close-census observations.
  Four nonzero observations belong to one boundary; `0080.json` reaches zero
  approximately 1.7 seconds after the first (`0076.json`).

The evidence directories above and below are relative to the toolkit root:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`.
Remaining evidence is
`.diagnostics/single-kernel-live-e35eab4-remaining-attempt1/`.

### Handoff qualifications

1. Topology is **sampled**, not continuously monitored. Focused-case observer
   checkpoints have no live guests, and remaining Chrome censuses are post-close.
   Active workload topology is proved by the original app inventories plus source
   inspection, not an independent active census inside every focused case.
   Driver assertions check counts, while the actual retained worker titles also
   match PIDs. Service Workers are deliberately excluded as relays.
2. The original cohort's later zero census establishes eventual disappearance,
   not its own 15-second bound. Bounded close acceptance comes from the separately
   labelled remaining run, as the handoff correctly discloses.
3. The handoff's local serving-process shutdown language is too strong if read as
   graceful HTTP-server cleanup: `serve-single-kernel.ts` has no SIGTERM handler
   or normal-path `server.stop()`. Receipts prove SIGTERM termination/process
   joining, not a graceful server drain. This is separate from joined guest/runtime
   shutdown acceptance.
4. PDF verification establishes successful output and positive byte count (850
   bytes per recorded generation), not parsed PDF content. OPFS lease qualification
   uses an actual competing Web Lock, not two fully running competing workspaces.
   `models:0` is result metadata, not independent inference-request telemetry.
5. Reproduction is incomplete for a fresh **full** cohort: the current full driver
   differs from its frozen receipt and hardcodes a retained cohort lock. The
   remaining-only suite has its own supported preparation, but does not replace
   fresh full-suite reproduction.

These limitations do not invalidate the central consolidation or bounded working
fork claim. They do prevent reading “DONE” as continuous topology enforcement,
all-feature parity, or a presently one-command-reproducible full cohort.

### Fresh todo E2E status

The initial fresh attempt stopped at preflight, with no browser/server/session
started. It independently verified all 9,587 frozen full-app receipt entries with
zero mismatches and the advertised runtime hashes. Its evidence is
`.diagnostics/single-kernel-live-e35eab4-audit-fresh-preflight-2026-09-30T14-01-06-304Z/result.json`.

Minimal isolated-run harness support and the fresh full E2E are in progress; final
results will be appended without overwriting the original receipts, locks or runs.

## Decision boundary

The branch is a legitimate working candidate for the next comparison. Acceptance
of consolidation is not acceptance of production feature parity: Python editor
LSP is disabled, source-mode Studio is not fully qualified, kernel/guest payloads
must ship together, and the canonical release pins are unchanged.

Next-stage comparison should hold application inputs, correctness fixes and browser
conditions constant and measure mixed-workload kernel latency, startup/switch/close
time, memory, and repeated cancellation/reload/concurrency failure rates. Separate
benefits of direct kernel FS access from incidental bug fixes before attributing
improved reliability to topology.
