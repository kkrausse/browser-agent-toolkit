# Post-close kernel target retention: bounded unknown

Runtime baseline: `e35eab4af7a53ff08eb70c09df59c40b78bfdd67`.
Runtime characterization/observation commit: `516ef37`. `git diff e35eab4 HEAD -- packages`
is empty: production runtime source is unchanged.
No browser was opened, existing origin/storage touched, frozen inputs changed,
model called, or census deadline enlarged during this investigation.

## Retained evidence (read-only)

Evidence directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-live-e35eab4-full-fresh-2026-09-30-independent-17ef8e3`.

- `0374.js` initiates case 1 exactly once. `0376.json` reports `completed`;
  the retained post-failure capture records its runtime assertions as passed.
- `browserCase` joins fixture work, runtime stop, the stopped diagnostics observer,
  and workspace close before returning. Workspace close awaits flush and invokes
  `Host.destroy()` in its finally block. `Host.destroy()` synchronously invokes
  `Worker.terminate()`; it has no deliberate grace period or close timer.
- Stopped diagnostics: zero procs, process workers, listeners, pending HTTP,
  fetch active/queued/inflight/pins, filesystem clients, lazy loads, and owned
  spawn spills. Kernel=1 is expected **before** workspace close.
- `0377.json` through `0410.json`: 34 census observations, same kernel target
  `9BA93CF19AC6DE002CABE4D93F10406C`, no guest target, no runtime diagnostics
  after close. First/last receipt timestamps are 14:09:51.010 / 14:10:05.889 UTC.
  The independently labelled post-failure capture still lists that target.
- Captured browser logs have no lifecycle exception: favicon 404 and two Wasm
  initialization deprecation warnings, zero dropped entries. This is not proof
  of termination; the target's `attached:true` is not proof of worker execution.

The evidence establishes a failed target-disappearance boundary. It contains no
post-close Web Lock query, worker execution/liveness sample, or explicit receipt
for the terminate call. Therefore it does **not** establish either stale CDP or a
live resource leak. Source review found no case-1-specific causal defect warranting
a runtime repair. Observer callback exceptions can interrupt `Host.destroy`, but
successful joined close and no lifecycle exception do not support that explanation
for this cohort; this investigation does not patch unrelated hypothetical failures.

## Offline characterization

New runtime test: `node scripts/test-single-kernel-close.mjs`
(`bun run test:single-kernel-close` is the same Node script).

It imports the shipped Host, endpoint and HTTP stream modules, uses real Node
MessagePorts and a real thread, and checks abort before headers, response reader
cancellation after `[0,255,128,65]`, and normal EOF. Each checks fixture channel
release, pending RPC rejection, one terminate invocation, actual thread exit,
empty host handler/pending maps, closed-host rejection and idempotent destroy.
The fixture worker is deliberately **not** Kernel/OPFS/Chrome; Node's thread exit
is not browser target destruction or Web Lock release. Its stream-release barrier
waits for a predicate rather than a fixed delay. A loader-only negative control
removing `Host.destroy`'s terminate call fails; no source file was reverted.
Final negative control fails specifically `abort-before-headers: termination
requested exactly once`, `0 !== 1`, exit 1 (not a Chrome reproduction).

Results on local Node **24.7.0** (not the qualified 24.18.0 toolchain):

| Command | Result |
| --- | --- |
| `node scripts/test-single-kernel-close.mjs` | all three lifecycle paths pass |
| `node scripts/test-single-kernel.mjs` | pass |
| `node scripts/verify-node.mjs` | `RESULT: PASS` |
| `node scripts/verify-runtime-contracts.mjs net-backpressure stream-consumers` | both pass |
| `node scripts/verify-runtime-contracts.mjs` | fails first contract: guest `markAsUncloneable is not a function`; remaining contracts not reached |

The full-contract failure is retained in this report, not erased or claimed green.
No runtime implementation changed. This test is a characterization/control, **not**
a deterministic reproduction or repair of the failed Chrome cohort.

## Required coordinated fresh browser followup (proposal to parent)

**Live acceptance/manual QA pending; no Chrome run has occurred for this candidate.**

Prepared frozen unchanged-runtime control:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-close-retention-control-2026-09-30`.
Preparation independently reverified 9,588 receipt-listed files (9,587 original
inputs plus unchanged `full-source-receipt.json`), distribution
`bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`,
runtime `e35eab4`, zero builds, zero live runs. New receipt SHA-256:
`8ab9694867547b4d7f4a16f9dd64cb50b67d51bc8303ed045b3da8aab46405f0`.
This is a control, not newly built runtime repair bytes: only tests and docs changed
in the runtime checkout. Its provenance remains e35eab4, never relabelled to the
new test commit. Frozen full app inputs are available for the full-suite followup.

Prepared browser observation fixture (runtime-owned test source):
`/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel/scripts/fixtures/single-kernel-close-observer.js`.
Fixture SHA-256: `f1fe47126b2acd6e676c16be6d5fc002a5bad57131b4498e7ddf66338dfc6799`.
Parent's CLI owner can install these exact bytes with Playwright `page.addInitScript`
before navigating the new owned page. It wraps only same-origin kernel worker
instances, forwards construction/terminate unchanged, records actual native
terminate invocation/return and worker error events, and exposes a bounded,
read-only `singleKernelCloseObserver.sample(label)` Web Lock query. A ready-message
sample labels the live-ownership observation; query timing is not transactional.
Zero dropped entries and zero query failures are required for usable evidence.
The offline test also exercises its forwarding and exactly-once observations,
but its empty mocked Web Lock query does not qualify actual ownership.

Reproducible preparation command already completed (no server/browser started):

```sh
bun examples/todo-app/tests/prepare-single-kernel-full.ts .diagnostics/single-kernel-e35eab4-full-attempt1 .diagnostics/single-kernel-close-retention-control-2026-09-30
```

Parent's next command from toolkit root, after siblings and single CLI-owner
coordination: `bun examples/todo-app/tests/serve-single-kernel.ts .diagnostics/single-kernel-close-retention-control-2026-09-30 --contracts`.
It exclusively writes its new origin receipt and binds an OS-assigned port. Use a
new owned browser profile/session, visit `/inspect-empty`, verify no OPFS entries,
IndexedDB databases, Service Worker registrations or held/pending owner locks, then
navigate `/` with the observer installed. Initiate
`singleKernelCases.run(1,0)` **once**, observe its settled action without retries,
and sample lock+census until both native target absence and owner-lock absence
hold within the original 15 seconds. Retain rendered case result/manual QA,
observer entries, receipt verification, stopped registry, logs, target identity,
all 15-second samples and separately labelled post-failure capture. Use another
exclusive preparation directory/new port/profile for the abort-before-header
control; do not erase/clear the just-tested origin to simulate freshness.

Keep the original failed acceptance and original 15-second census. Prepare a new
owned isolated origin/profile; no existing browser sessions or OPFS. Parent owns
toolkit harness changes and browser initiation; none were made here.

1. Before boot, wrap the owned page's Worker constructor/terminate method only for
   the exact new kernel instance. Record creation and terminate call timestamps,
   identity and call count, forwarding the native method unchanged. The observation
   must not retry termination or replace kernel behavior.
2. Observe the new origin's `navigator.locks.query()` before boot, during ownership,
   immediately after joined close and alongside every existing bounded target
   census. Retain held/pending `vivari-vfs-owner` and client IDs. Query is read-only;
   do not acquire/steal a lock to make it disappear.
3. Retain natural guest exit, empty stopped registries, flush outcome, exact joined
   close outcome and worker error events independently of target disappearance.
4. If the target survives, separately labelled bounded diagnostic attachment may
   test whether its execution context answers a read-only evaluation. Do not treat
   failure to attach as proof of death; attachment can affect lifecycle and must be
   labelled separately from acceptance. No page destruction as a substitute for close.
5. Repeat fresh isolated cohorts for both abort-before-headers and reader cancel,
   preserving each failure. If lock is held after actual terminate, investigate
   live browser resource retention; if lock releases but target remains, investigate
   target lifecycle/execution before declaring observation lag. Explicit cooperative
   ownership release is a possible future design, not a proven fix here.

Cleanup evidence must identify only this new server's exact command/PID and only
this new browser session, preserve acceptance and post-failure evidence first,
join server exit, and verify absence. If close failed, destroying the owned page
is failure cleanup, never orderly shutdown acceptance. No broad storage resets,
existing-user-origin access, inference calls, or concurrent performance stress.

After discrimination and any justified runtime repair, parent must rebuild a new
committed-source matched runtime+consumer distribution and prepare a separate
exclusive frozen candidate; this control may not be presented as repair proof.
Live/manual QA of that candidate must precede claims of repair. Full followup is
the original 19 application stages/five fresh generations/reloads plus all focused
cases 0–9 and each post-close census. The existing full driver cannot provide the
additional lock/native-termination observations by itself; parent must integrate
the observer into its owned driver path or run an explicitly labelled diagnostic
cohort before the unmodified full acceptance, preserving each result separately.

Cases 2–9 and full browser acceptance remain unqualified. Offline success does not
supersede the original failure, qualify performance, or authorize canonical pins.
