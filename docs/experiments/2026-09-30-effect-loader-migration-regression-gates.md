# Effect loader migration: independent regression gates

Date: 2026-09-30. **Negative controls delivered; migrated positives pending.**

Report/handoff absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-loader-migration-regression-gates.md`.

## Outcome and ownership

Finite offline regressions protect the concrete late-tsgo-install and swallowed
loader-failure seams. Acceptance assertions fail against the exact repaired
imperative baseline, not a toy Effect supervisor. One shared-interest preservation
control passes on that baseline; it is not a migration result. No implementation
agent was polled and no mutable canonical runtime was tested as the candidate.

Reviewed the complete committed plan `e2592d3`, scope `10ebbe8`, integration
`a8c8033`, unchanged lazy-loader proof, PID repair and endpoint ownership reports.
Implementation owner `ses_f0b649750ffeXKLza4tVNV3jIj` owns runtime phases 0–1.
This change owns only NEW `examples/todo-app/tests/effect-loader-*` files and this
report. No runtime/SDK/build/package/old-test/status/trace changes or push.

## Inputs and exact identity

Baseline archive and separately built consumer SDK:

- Runtime revision `33fa1359a003ca9c50cb3bc49699b99bc1a063f1`.
- Toolkit revision `d0eec346dbc749db1c0cd82dd8aad0b27c1da363`.
- Candidate `3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.
- Root: `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/kernel-egress-repair-3GsF7d`.
- Imported runtime: `<root>/runtime-source`; SDK: `<root>/candidate/sdk/host.js`.
- Owner receipt: `<root>/candidate-receipt.json`.

`effect-loader-baseline-provenance.json` freezes source/native/SDK hashes and both
archive digests. All five imported source files were compared byte-for-byte with
`git show 33fa135:<path>`. Reused Rust VFS JS/Wasm were compared byte-for-byte with
`/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean`'s verified
native artifacts. No native compilation, registry access or dependency installation.
Baseline mode enforces these hashes, revisions and archive receipt digests on every
run. It does not recreate/re-hash entire source archives or reverify all candidate
outputs; the earlier owner/integration report retains that evidence.

Runner records actual Bun/Node compatibility-version strings, exact arguments,
fixture/source/native/SDK/receipt hashes, per-case stdout/stderr/exit/signal/error,
and an explicit pending denominator. The executable's installation path is not
used to infer its version. No new library/consumer build was performed; new
implementation handoff must separately build the library/core, then its SDK/example
consumer, and freeze their matching identities.

## Actual executed scope

The fixture imports the real Kernel, `ensureRealTsgo`, protocol, FsServer,
direct-kernel-fs and Rust VFS plus matching built SDK `launch`. It sends actual
`OP_SPAWN_ASYNC` bytes through the caller's SAB and kernel syscall entrypoint.
Worker handles and host relay are controlled leaves. Vendor delivery is a tiny
synthetic gzip pack with the real framing; the real decode/batch/shim installer
runs, but the synthetic one-byte Wasm is **not executed as a compiler**.

The held-write case gates the filesystem batch adapter immediately before
forwarding to the existing real VFS batch implementation. It deliberately ignores
cancellation and then performs real Rust VFS writes. It is a controllable offline
native-adapter analogue, not browser fetch/body cancellation proof. The fixture
does not import Effect or assert fiber completion.

Deferred leaf handshakes select vendor-start, vendor-release, write-start,
write-release, install-settlement and child-spawn interleavings. A MessageChannel
acknowledgement supplies a host checkpoint, not a sleep/time-padding retry. An
unsettled sample alone proves no join: acceptance also inspects the actual successful
public receipt's installer-settlement snapshot and rejects post-receipt writes.
The subprocess deadline is only a failure watchdog; SIGTERM/timeout never passes.
No private lazy/fiber/task maps are consumer receipts or fixture cleanup mechanisms.

### Observations / per-boundary negative controls

| Case | Baseline characterization | Acceptance against SAME baseline |
| --- | --- | --- |
| Original unmodified `cached-switch-lazy-loader-stop-proof.mjs` | PASS: stop/readers joined, processes 0, PID fetch active 0, lazy loads 1; release writes two late audited shims, no late child | Historical proof preserved, not relabelled positive |
| `held-vendor` / last interest | PASS characterization: successful stop while vendor AND installer unsettled; cache initially only `node.js`; later `tsc.js`/`tsgo.js` | FAIL at `successful stop escaped while underlying vendor/installer write could still run` |
| `held-write` / last interest | PASS characterization: vendor settled, real batch adapter held, installer unsettled at successful stop; later real batch + shim writes | FAIL at same join assertion, independently of download completion |
| `shared-interest` | PASS: two live SAB callers, one download; first public stop completes before held delivery; second receives RESPONSE_OK and one child with its parent PID; exact installed bytes `[1]`/`[2]`; stopped caller's SAB unchanged | PASS bounded preservation control, NOT Effect acceptance |
| `loader-failure` after installer settlement | PASS characterization: real ensure rejects `EFFECT_LOADER_VENDOR_FAILURE`; public stop/repeated stop succeed and exited has no cleanupError | FAIL at `loader failure must not be swallowed into successful public stop` |

Baseline characterization exits 0. Acceptance on baseline exits 1 with precisely
the held-vendor, held-write and loader-failure cases red; shared-interest remains
green. Later assertions in a red case are **not counted as independently proven
negative controls**. Repeated rejecting stop, exact CLEANUP_FAILED and cleanupError
text are ready assertions but have not passed on a migrated implementation.

The planted `/bin` ancestor symlink targets
`/workspace/.browser-editor-cache/vite`; it remains a symlink. Late shims retain the
real `/usr/lib/tsgo/tsgo-run.js` reference (unchanged original proof). Shared install
still follows that link while another interest is live. This is **path-security
tamper evidence, not a fixed-path-security claim or observed browser corruption**.
Joining a loader cannot establish protected roots or universal writer quiescence.

## Runnable commands

From `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`:

```sh
STAGE=/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/kernel-egress-repair-3GsF7d
bun examples/todo-app/tests/effect-loader-regression-gates.ts "$STAGE/runtime-source" "$STAGE/candidate/sdk/host.js" "$STAGE/candidate-receipt.json" "$STAGE-independent-effect-loader-baseline-new" baseline
# Expected exit 1: acceptance assertions against the known broken loader baseline.
bun examples/todo-app/tests/effect-loader-regression-gates.ts "$STAGE/runtime-source" "$STAGE/candidate/sdk/host.js" "$STAGE/candidate-receipt.json" "$STAGE-independent-effect-loader-counterfactual-new" accept
```

Evidence directory must not exist: no old cohort overwrite. Candidate invocation
uses the same positional interface, substituting the implementation owner's frozen
runtime root, separately built SDK and receipt (40-hex runtime/toolkit revisions,
`hashes["sdk/host.js"]`; optional `version`/`candidateVersion`). Runner observes
candidate source/native hashes but the owner must additionally attest them against
committed archives/build receipts. `overallPilotAccepted` stays false regardless
of individual gates until the pending public-adapter/delivery gates are completed.
The present existing `registerLazyProgram` callback shape is intentionally retained;
do not invent future private methods to make this fixture pass. Review/update only
this fixture against a documented production callback contract when handed off.

Final tested evidence (directories preserved, no cleanup):

- `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-frozen-baseline-20260930`
- `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-frozen-expected-fail-20260930`

Initial development failures are retained too: `effect-loader-baseline-20260930`
timed out because the fixture read `info.programPath` instead of the actual
`info.spec.programPath`; `effect-loader-baseline-final-20260930` then exposed use of
text `readFile` instead of `readFileBytes`. Corrected fixture uses actual worker spec
and exact binary bytes. These were fixture defects, not runtime regressions or
retried-to-green kernel timing. Pre-cleanup observations are emitted before leaf
release/cleanup; parent logs timeout separately if the fixture cannot reach finally.
Evidence archive includes these failures before any cleanup:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-regression-evidence-20260930.tar.gz`.

## Required public adapters / remaining acceptance denominator

These are seam-agnostic observable requirements, **not invented callable APIs**:

1. **Native cancellation:** the supported real tsgo registration/download adapter
   must deliver an AbortSignal and expose abort-request/underlying-settlement through
   controllable leaf handshakes. Last interest closes admission and requests abort;
   ignored-abort continuation leaves public stop pending until its writes/rollback
   settle. The current callback yields no signal: recorded `abortSignalObserved`
   and `abortRequested` are false. Present gates prove erroneous early success, not
   positive cancellation propagation. No retained implicit root lease.
2. **Pre-PID production host launch:** expose/import the actual worker host-launch
   orchestration or provide its offline worker-message adapter. Hold vendor delivery
   before PID assignment, send existing launch-close/kill admission, release bytes;
   no worker/PID allocation, proc-started or late transfer. Join launch failure/close
   once, including duplicate close. Current SDK launch always posts `/bin/node.js`;
   this fixture's host relay calls synchronous `Kernel.launch`, so it deliberately
   does NOT pretend to test the production worker's pre-PID `spawnProcess` path.
3. **Rollback failure:** provide the real migrated loader's staging/rollback adapter
   and supported outcome wire mapping. Inject a real VFS commit failure after staging,
   hold actual rollback unlink, then fail unlink for that generation. Success must
   not precede rollback; `Execution.exited.cleanupError`, idempotent rejecting
   `Execution.stop()` (`CLEANUP_FAILED`), and rejecting attached `Runtime.stop()`
   must retain the original install AND rollback failures after live-map removal.
   No destructive replacement/fallback/new runtime wrapper. No fake rollback was
   added to the old installer, which has no joined rollback contract.
4. **Delivery identity:** exact Effect v4 pin; committed source archive + compiled
   core paths/hashes/import format; Node and browser worker build receipts consuming
   that SAME core; bundle size before/after. No test-only Effect sidecar. Consumer
   acceptance uses independently built workspace library/SDK artifacts, not source
   aliases. A unique external runtime worktree is valid; canonical edits are not
   assumed. These checks belong to parent pairing with implementation handoff.

Required acceptance fields: source/toolkit/Effect versions, archive and compiled
core hashes, Node/browser delivery identity, admission/abort/native-settlement
ordering, interested caller identities, single download count, exact installed
bytes, stopped/live SAB publication, worker/PID allocation count, stop/exited/error
outcomes, rollback settlement, repeated receipt stability and retained runtime
attachment. Missing/unproven fields stay pending rather than disappear.

## Preserved suites and limits

Reuse read-only `<runtime archive>/scripts/test-process-egress-cleanup.mjs`
and `scripts/test-endpoint-cleanup.mjs` with the
matching built SDK; keep every existing assertion. PID-egress and endpoint reports
remain their provenance/command authorities, not substituted by these lazy gates.
Ready commands (not rerun here):

```sh
node "$STAGE/runtime-source/scripts/test-process-egress-cleanup.mjs" "$STAGE/runtime-source/packages/kernel-host/kernel.js" "$STAGE/candidate/sdk/host.js"
node "$STAGE/runtime-source/scripts/test-endpoint-cleanup.mjs" "$STAGE/candidate/sdk/host.js"
```

The earlier integration retains eight endpoint cases and toolkit **26 pass / 0
fail / 98 assertions**, PID/backend/body/pins/shared/rollback cases and all 111
candidate hashes verified. They were not rerun here.

Preserve master-status comparison evidence: app **19 stages / five generations**,
focused **10 cases / 14 steps**. No app/editor/close cohorts were rerun. Existing
editor-save/retained-target observations and `markAsUncloneable` full-contract gap
remain limits. No browser, guest, host/guest server, network, OPFS or inference was
launched. These controlled Kernel/Rust-VFS results do not qualify platform worker
termination, persistence, cached switching, performance or the whole Effect rewrite.
