# Effect process/subtree — independent offline regression gates

2026-09-30. **Prepared 17 finite process gates: frozen baseline 2 PASS / 15 FAIL /
0 unrun. All 31 preserved loader/PID-fetch/endpoint/close cases and the routing
suite PASS. Phase2A positive acceptance is PENDING matching implementation handoff.**

Absolute report:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-process-subtree-regression-gates.md`.

## Boundary and immutable admission

Independent test/evidence ownership only. Read the migration plan, the full
`8473869` phase1 review including its frozen existing/proposed interface distinction,
runtime DEVELOPMENT, production launch/finalize/spawn/thread paths, emitted Worker
acquisition, Node worker adapter and existing loader/expanded/PID-fetch/endpoint/
close/routing fixtures. No production, package, build, pin, old fixture, master-plan
or historical evidence edits. No implementation polling or source copying.

Tests import the actual Kernel, which imports its actual compiled lifecycle core,
and instantiate the verified native Rust/Wasm VFS through FsServer/direct-kernel-fs.
They use existing `launch`, `launchLoaded`, `createLaunchOwner`, `stop`, Worker
message callbacks and syscall SAB dispatch. No proposed core method names, private
future handles or shadow EffectSupervisor are assumed. Existing proc tables are
observed for residue, never manipulated to manufacture parentage. Children are
created by real OP_SPAWN_ASYNC or thread-spawn production dispatch.

Frozen baseline (read-only):
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-vendor-url-repair-l9k65fzh`.

| Identity | Verified value |
| --- | --- |
| Runtime source | `3ee918522c1233a1f8e10a9b798c09b6c3e30c81` |
| Toolkit archive | `9814c715cfca42309c581440577976833f4326e6` |
| Distribution | `bd39000ff5bbc334f836ad65a4433e627525070413f810d7169132102f49b9f9` |
| Effect | `4.0.0-rc.118` |
| Compiled core SHA256 | `211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070` |
| Candidate receipt SHA256 | `e242092e6a920b88a6a2ae7eb76654f1f61773a3bcf99ee4bcbe61f6b85ee6e6` |
| Freeze manifest SHA256 | `1cec74d220b0e035948adb7ae8330fa5174593c324b612d38345b4018fdd13a4` |

Before and after the final cohort, **107 candidate + 1,020 freeze entries** match,
plus **12 native inputs + 37 native outputs**, zero mismatches. Existing loader and
expanded fixture hashes match the independent qualified fixtures exactly. Native
reuse, not rebuild. Historical frozen5c and all earlier evidence remain untouched.

Qualified executable from `71ddbe3`, absolute in parent and every Node child:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-qualified-node-toolchain-20260930/node-v24.18.0-darwin-arm64/bin/node`.
Actual version/platform/architecture asserted **v24.18.0 / darwin / arm64**; executable
SHA256 reverified `ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a`.
Official archive/HTTPS-manifest provenance remains in71ddbe3; no new download or upgrade.

## Finite denominator and baseline observations

All rows below are **offline fixtures**, not browser or statistical observations.
FAIL is the actual production-baseline contract result, not a passing acceptance
result. Fifteen selected failures reproduce concrete review risks; two already
correct controls remain passing. No claim that all baseline cases fail.

| Gate | Baseline | Observable contract / failure |
| --- | --- | --- |
| held-terminate-receipt | FAIL | `stop(pid)` has one identity, but resolves while its native termination Promise remains held. Success must join that receipt. |
| exited-child-pending | FAIL | Child exit occurs before parent stop; native child teardown remains held. Child/ancestor close must both join it after the child leaves `procs`. Baseline child receipt resolves early. |
| concurrent-subtree-stop | PASS | Child and parent stop initiated together, repeated identities retained; after explicit native release both joins complete, two workers terminated once. No self-join in this schedule. This row alone does not prove pending native joins; preceding rows test that separately. |
| terminate-throw-retained | FAIL | Synchronous termination cleanup throws; baseline swallows it and resolves stop. Required rejecting repeated receipt retains the same error and textual exit cleanupError. |
| exited-children-multiple-failures | FAIL | Two genuinely spawned children exit while existing guest-fetch writes remain held; parent stop stays pending. Both real VFS rollback leaves fail. Child exits retain `CHILD_ROLLBACK_1/2`; parent receipt/cleanupError only retains1. Required parent aggregate contains both. |
| runtime-pid-failure-retains-attachment | FAIL | Actual built Runtime/SDK starts a real Kernel PID over controlled message transport. PID termination throws; baseline Runtime stop succeeds instead of rejecting/retaining attachment. Required repeated failed stop preserves receipt/error, exit cleanupError and refused Runtime replacement. |
| launch-transfer-revoked | FAIL | Reentrant acquisition closes exact launch owner before returning worker handle. Baseline launch still succeeds. Required no proc-started publication/PID residue and exactly-once returned-handle unwind. |
| boot-before-transfer | FAIL | Actual worker-error callback fires synchronously before acquisition returns. Baseline host launch still succeeds after fatal boot. Required launch rejection, no started publication and returned-handle unwind. |
| stale-spawn-exit | FAIL | Old OP_SPAWN child exits after a newer same-opcode request occupies the SAB. Old callback changes REQUEST1 to RESPONSE_OK2. Required state and complete data window remain unchanged. |
| stale-loader-rejection | FAIL | Older actual dispatched lazy-load rejects after newer same-opcode request admission. Old failSyscall changes REQUEST1 to RESPONSE_ERR3. Required exact invocation exclusion, not merely opcode equality. |
| thread-transfer-revoked | FAIL | Thread acquisition reenters parent stop before child handle return. Baseline attempts to set `child.onExit` after child removal and throws TypeError. Required no late thread-started and both acquired handles unwind. Later assertions are unachieved, not credited. |
| late-thread-after-stop | PASS | Old worker thread-spawn/syscall callbacks invoked after parent stop create no child, no message and no SAB mutation. Already correct baseline control. |
| native-node-terminate | FAIL | Real Node Worker runs and its native terminate Promise resolves; adapter completion is still explicitly held afterward. Kernel stop is already successful. Required native adapter join, same stop receipt and one terminate. |
| node-adapter-terminate-promise | FAIL | Execute the actual committed Node spike-harness acquisition function with a real Node Worker and real FsServer; only inert worker-entry placement substituted. Returned handle's terminate discards native Promise (`undefined`). Required actual platform join return and FS registration release. |
| acquisition-constructor | FAIL | Actual emitted acquisition + controlled Worker constructor failure: launch rejects but PID1 remains. No worker/ports were acquired, so their absence is not an unwind failure. |
| acquisition-register | FAIL | Actual emitted acquisition + actual FsServer registration then injected registration throw: PID1, FS client1, worker projection1 remain; acquired worker terminate0, both port close0. |
| acquisition-postmessage | FAIL | Actual emitted acquisition + synchronous postMessage throw: same acquired PID/FS/worker/port residue. Required unwind before launch receipt settles, without proc-started. |

Partial-acquisition gaps were **source-identified, not live-observed** in the phase1
review. This report adds controlled offline reproductions, not live browser evidence.
Each records residue **before fixture cleanup**. Worker/registration/postMessage fault
leaves are deterministic injected faults. Real MessageChannel ports are used and
native close calls observed; fake browser Worker termination is synchronous, not an
invented browser worker-exit acknowledgement.

The browser adapter test parses the hashed delivered emitted worker with delivered
Acorn and evaluates ONLY its unique actual `spawnWorker` expression. Its platform
and closure leaves are supplied explicitly: Worker, MessageChannel, filesystem,
worker/memory routing projections, Kernel, codec modules and actual initTransferList.
No worker entry/boot/persistence executes. The Node adapter likewise evaluates its
actual committed expression rather than recreating its terminate implementation.

Same-opcode stale tests deliberately supersede a SAB request while an older accepted
continuation exists. This is explicit ABI fault/race injection for the frozen exact
syscall-publication standard, **not a naturally observed guest execution trace**.
The full data window is compared, not just a counter. These tests currently cover
child exit and rejected dispatch; they are not universal proof over arbitrary RPCs.

## Preserved composition gates

Unchanged existing assertions invoked directly on the same frozen delivery:

- **4/4** loader gates.
- **10/10** expanded native/loader/public SDK/Runtime gates. These include
  stop-before-PID, exact repeated launch/root/Runtime close receipt identity,
  shared interests, held write/rollback and pre-PID failed-cleanup attachment.
- **6/6** PID-egress/fetch cases.
- **8/8** endpoint cases (closed versus settled and output-reader separation retained).
- **3/3** close cases.
- **Routing suite PASS**: real guest spawnSync/execSync/async FS-port routing and
  dispatch fault/capture contracts, using its unchanged offline fixture.

**31 preserved cases, zero failed/unrun, plus one routing suite.** There are18
preserved orchestration entries because multi-case suites are not flattened into
fake independent executions. Combined orchestration denominator is35: **20 PASS /
15 FAIL / 0 unrun**. New process denominator17 is separate; do not sum orchestration
counts with contained case counts. Guest-fetch queue/body/pin ownership is not
duplicated: the new exited-child aggregate gate only composes its existing cleanup
as leaves, with actual VFS writes and injected rollback failure.

## Commands, evidence and pending acceptance

From toolkit root:

```sh
NODE=/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-qualified-node-toolchain-20260930/node-v24.18.0-darwin-arm64/bin/node
BASE=/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-vendor-url-repair-l9k65fzh
"$NODE" examples/todo-app/tests/effect-process-runner.ts "$BASE" /absolute/new-evidence-directory
# One selected offline gate:
"$NODE" examples/todo-app/tests/effect-process-fixture.ts "$BASE" stale-spawn-exit
```

Final17-case evidence:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-process-baseline-17-20260930`.
Contains provenance, exact child commands, stdout/stderr, per-gate status, summary
and postflight. All children exit normally with assertion failures/successes;
zero timeout/signal/tool failures. Runner deliberately collects the preselected
baseline negative controls; any preserved failure stops the cohort. Its30s bound
is only a **failing liveness watchdog**, never cleanup success. Per-test scheduling
uses explicit entry/release Promises and MessageChannel checkpoints: no sleeps,
retries, timer padding or fuzzing. Runner exit0 means baseline evidence collection
completed, **not process acceptance**; read summary/per-case results.

Two earlier preparation cohorts remain at `effect-process-baseline-20260930`
(14 cases) and `effect-process-baseline-final-20260930` (16 cases). The initial
concurrent schedule redundantly asserted pending termination (already tested by
two other rows); refined it into a distinct no-self-join control, which passes the
unchanged baseline. Added actual Node-adapter/thread and Runtime-PID contracts.
No production changes, assertion retry-to-green, or replacement of those retained
preparation outcomes. Final denominator17 is fixed for handoff.

**Positive2A: 0 executed / 17 pending** (preserved positive composition also pending
on that new revision). The baseline runner intentionally pins the old receipt and
refuses arbitrary new assets. Once implementation owner supplies committed source,
compiled core, matching emitted Worker/SDK/workspace delivery and native reuse
receipts, add a NEW explicit admission adapter for those exact revisions/hashes.
Do not modify old receipts or old regression assertions. If extraction free bindings
or packaging legitimately change, adapt only the new test harness after inspecting
the actual handed-off production path; do not invent an API or copy implementation.
Parent pairs frozen core/test source for independent acceptance and reviews errors.

Limit: no browser/host/guest server, inference, network/dependency upgrade,
phase2B installer migration, phase3 fetch migration, persistence/OPFS guarantees,
universal all-writer drain, performance or integrated app rerun. Synchronous unused-
owner boot-fault compatibility remains a handoff requirement; a future asynchronous
receipt must not silently change the existing synchronous error boundary. Native
markAsUncloneable guest gap and older historical failures remain outside these
bounded gates and are not relabelled green.
