# Phase2A SQLite close — targeted offline source/evidence review

2026-09-30. **Browser acceptance remains blocked; causal defect not established.**
The bounded phase2A ownership cutover is internally consistent in the reviewed
paths; no demonstrated source blocker calls for a production patch here. Recommend
holding further cutover pending **one isolated case9 observer cohort**, subject to
parent authorization. This review does not authorize phase2B or phase3.

Only this report was created. No browser, host, guest, test, build or production
execution; no pin, plan, shared distribution, old report or evidence edits. Shell
work was read-only Git/source comparison and offline parsing of retained receipts.

## Inputs and exact comparison

Read toolkit AGENTS.md and vivari/DEVELOPMENT.md, runtime AGENTS.md and normative
ARCHITECTURE.md, Effect skill/service guidance and pinned Effect source. Runtime
worktree: `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/vivari-effect-loader-pilot`
(clean at review). Compare approved phase1
`3ee918522c1233a1f8e10a9b798c09b6c3e30c81` to phase2A
`cc5a932bf4f9a1da4bf8b5d16f6c6c7e4aec573d`, not an inferred framework change.

`git diff 3ee9185 cc5a932` changes exactly six paths:

- AGENTS.md and ARCHITECTURE.md: ownership/scope documentation;
- packages/kernel-lifecycle/src/index.ts: registered PID graph, acquisition tasks,
  cleanup/publication slots, failure retention and compaction;
- packages/kernel-host/kernel.js: core-owned PID termination/subtree receipts,
  exact invocation/owner publication guards and routing projection;
- packages/core/src/workers/kernel-worker.ts: partial-resource ownership and
  exact launch/exec routing;
- scripts/lib/spike-harness.mjs: Node native termination Promise ownership.

Host SDK destroy, Workspace.close, browser harness, SQLite server, FsServer,
OPFS persistence, guest/protocol and dependency pin are **not changed** by this
runtime diff. The independent offline report also verifies identical built SDK
host (`14e5b1e…dfc87`) and workspace (`2676b568…19da7`) between these deliveries.
Effect remains exact `4.0.0-rc.118`; the new core and worker are genuinely different:
compiled core `05859327…ebed5`, worker `kernel-worker-a6UDx747.js`, SHA256
`7d21c5bf…6cea`, distribution `446021ba…6a6` (full values in linked QA reports).
The retained emitted focused client was read as well as source: its native kernel
termination is at `client/single-kernel-cases-client.js:297`.

Primary report: [phase2A browser QA](2026-09-30-effect-process-subtree-browser-full-app-qa.md),
commit `c3672ee`. Raw evidence root (`E` below):
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-process-browser-independent-qa-20260930`.

## What the original evidence actually proves

The full workload passed **19/19 stages, five generations, reload and both normal
closes**. Actual app topology was one kernel/three process workers; separate CDP
receipts `0301` and `0354` establish zero targets after the two full closes.
Focused cases0–8 qualified **nine complete cases/12 steps**. Case9 step0's public
action passed, its target-absence gate failed; step1 was unrun. Offline **17 new +
31 preserved cases**, routing and sync-capture are supporting offline results,
not substitutes for this missing browser gate.

Offline parsing inspected all **528 numbered command receipts and their code**.
All CLI exits are0, all envelopes `ok:true/isError:false`, no stderr or envelope
warnings. This does not imply acceptance PASS: the driver, not the CLI, rejects
the repeated `closed:false` results. Raw envelopes include `text`, `value`,
`valueUnavailable`, `logs`, `warnings`, `aftermath` and `session`, in addition to
the outer stdout/stderr/exit. No native terminate counter or acknowledgement,
worker-running state, teardown trace, lock timeline or post-close kernel activity
receipt is present in those fields. Some earlier commands have log entries;
none of the 34 failing census commands does.

| Original observation | Receipt / time (UTC) |
| --- | --- |
| Fresh case9 document reload / API ready | `0488` / `0489` |
| Single public `run(9,0)` accepted | `0490`, session updatedAt `03:23:45.838` |
| Public action completed | `0494`, `03:23:47.478` |
| First nonempty close census | `0495`, `03:23:47.759` |
| Last nonempty close census | `0528`, `03:24:02.472` |
| Passive postfailure capture | `focused-postfailure-passive.json`, `03:25:20.856` |
| Zero workers after focused session deletion | `retirement-census.json`, `03:26:05.204` |

These dates are **2026-10-01 UTC** (the experiment's local date is September30).
Session timestamps are transport receipt timestamps, not exact native call times.
The 34 census timestamps span14.713s; the source's original `closedTargets()`
poll budget is15,000ms, unchanged. No extra deadline or later absence qualifies it.

All `0495`–`0528` target arrays are byte-equivalent after JSON serialization:

```text
targetId: 7B193E3154B0819F86B73B0690C9D0BC
type: worker
title: Workspace storage supervisor
url: http://127.0.0.1:62942/runtime/assets/kernel-worker-a6UDx747.js?opfs-disable=&vivari-asset-base=http%3A%2F%2F127.0.0.1%3A62942%2Fruntime%2F
attached: true
canAccessOpener: false
browserContextId: 814638BC1C450A0CF99051C28DFA04B4
parentFrameId: 8AFB8307782D9A5E46B47507764806F8
```

Each census returns origin62942, `runtimeWorkers:null`, `closed:false`; aftermath
has identical start/end page URL, no navigation, console/page errors or handoffs.
Each creates a page CDP session, sends `Target.getTargets`, filters the owned
origin/descendants, then detaches. It does **not** execute code in that worker.
`attached:true` is not proof of live JavaScript or an explanation of retention.
No process/auxiliary worker remains. The URL flags correctly disable SQLite's
optional proxy worker; the retained target is the outer kernel, not that proxy.

`result.json` retains driver failure, `expired:true`, `actionPending:false`,
`commandPending:false`. No `case-9-0.json` was written because retention follows
target absence. The later passive capture independently preserves the original
token `f23c2463-484e-4ee9-9aef-26136b1bfaf7` as completed/step passed, the same
kernel ID, and **held0/pending0 Web Locks**. This lock query occurred about93s
after the completed-action receipt, not inside the acceptance window.

Its stopped diagnostic was sampled **before Workspace close** at
`1790825027111` (03:23:47.111 UTC), following started `1790825026300`:
procs/listeners/FS clients empty; process workers0; HTTP pending0;
fetch active/queued/inflight/cache/pins0; spills0; loader operations/failures/
failedOwners0, owners1, retainedPids3, nextPid4. Kernel1/root owner1 there is
expected before outer teardown, not a final kernel liveness test. The retained
64-event ring covers sequence803–866, all PID3 filesystem work, including SQLite
response-ok at822/850 and final fs-unregister866. It contains no outer kernel
terminate event. The SQLite PRIMARYKEY warning is the deliberate rollback negative
case; deprecated WASM initializers/favicon404 are retained, not causal findings.
Later page/session retirement proves cleanup, not orderly close or spontaneous
target disappearance; no attribution to Browser Control follows.

## Exact public SQLite/close path

`workspace-api/tests/browser/storage-cases.ts:263–319` first checks real database
header/OPFS-byte equality, same-process and competing-PID `SQLITE_BUSY`, then
natural owner exit without db.close, pathname reacquisition, rollback/constraint
handling, explicit database closes, integrity_check and flush. Three PIDs are
allocated. Step1 would check persisted rows after a new document; it did not run.

`browserCase` (`harness.ts:68–91`, emitted client1356+) awaits the step, then
Runtime.stop, the stopped diagnostic observer, and **Workspace.close**; errors
aggregate and reject the public action. Therefore completed step0 includes a
returned Workspace.close, not merely a successful SQL body.

Runtime.stop (`workspace-api/src/runtime.ts:89–102`) joins pending launches,
execution stops and endpoint settlements, retains failures by refusing detach,
then clears attachment on success. It does not terminate the outer kernel or
invoke `closeLoaderOperations()` as a workspace/storage barrier.

Workspace.close (`workspace.ts:160–170`) closes admission, flushes, then in
finally removes subscriptions/watches and calls Host.destroy. Host.destroy
(`packages/core/src/host-sdk/host.ts:164–172`) tests `dead`, sets it, synchronously
notifies handlers, calls **this.worker.terminate() at168**, then rejects pending
requests and clears handlers/relay cleanup. The emitted client preserves this
ordering exactly. Browser terminate returns synchronously; neither public close
nor Effect Scope.close is a native exit acknowledgement.

Consequently, successful public close strongly supports reaching normal destroy,
but does not independently record native termination: an earlier destroy may
already have set `dead`. The pre-terminate handler loop could throw on an earlier
destroy, leaving `dead` true and a later destroy a no-op. That is an **unchanged
possible failure shape**, not an observed cause: this cohort has no such error
receipt/stack and no terminate-call ledger. It is not grounds to patch it here.

SQLite's connections/pathname authority remains in `sqlite-server.js`. FS
unregister calls `sqlite.release(pid)` (`fs-server.js:156–165`), which closes
that PID's connections and deletes pathname owners (`sqlite-server.js:35–44`).
SQL persist exports VFS bytes, queues OPFS and awaits persistence.flush before
the SAB reply. OPFS's Web Lock is held by an unresolved ownership promise
(`opfs-persistence.js:41–59`); successful initialization retains it for kernel
lifetime, while initialization failure explicitly releases it. Flush is not
releaseOwnership. None of these authorities moved into Effect in phase2A.
The later empty locks are consistent with a stopped kernel; they do not prove
native termination timing or distinguish a live kernel that lost its lease.

## Bounded phase2A ownership audit

Reviewed core close/acquire/registration and Kernel finalization, with particular
attention to the three natural-exit SQLite PIDs:

- Core `registerProcess` transfers the exact launch owner before construction and
  owns parent/child edges; parentPid is a core-backed getter/setter. `procs`,
  procWorkers and exec maps project routing, not termination receipts.
- Kernel registers `_finalizeProcess`, afterClose publication, transferred-port
  cleanup and an acquisition barrier before spawnWorker. Acquisition accepts a
  task before native invocation; late `own` resources unwind rather than escaping
  a reentrant close. Browser registers terminate immediately after construction,
  then map cleanup, both ports and FS unregister before register/postMessage.
  `owned:true` prevents the compatibility handle from being a second close
  authority. Node adapter returns/joins the actual terminate Promise.
- Close freezes admission and memoizes the receipt before callbacks. Accepted
  cleanup leaves are invoked in registration order under individual exception
  capture, then descendants are closed and all native/tasks/lease joins drain.
  `_finalizeProcess` precedes native termination; it records child exit specs,
  removes routing/listeners and joins existing egress leaves. FS unregister later
  releases the SQLite pathname. Public exit publication is after these joins.
- A child removed from procs still has its pending receipt/parent edge in the
  core. Failed descendants remain authoritative; successful settled children
  detach. Root close also retains settled failures. Cleanup arrays/publication
  closures/tasks/leases compact only at settlement, without erasing PID outcomes.
- afterClose publication catches synchronous callback exceptions; Kernel also
  attempts both onExit/onError and onProcExit independently and annotates
  cleanupError. Callback throws join the rejecting owner receipt rather than
  skipping the remaining accepted cleanup leaves. The sync no-join branch
  preserves boot/exit timing; acquired native work takes the joined branch.
  No retained case9 evidence identifies a throwing callback or pending descendant.
- Exact owner/proc/syscall-invocation guards block stale publication, while the
  browser execution route's onProcExit uses identity (not open admission) so a
  closing owner can still publish its joined exit.

**Decision:** source/scope review is favorable for the bounded registered-PID and
loader migration; **overall phase2A acceptance is not approved** while the original
SQLite kernel-absence gate is unresolved. No proven blocking production defect
was found in this precise path. The only blocking finding here is missing native
termination/target-retirement evidence behind an actual failed acceptance gate,
not a generic style criticism. Parent owns the final decision.

`closeLoaderOperations()` intentionally now closes the loader/**registered-process
root**, not storage, persistence, every HTTP reader or all writers. Long-lived roots
retain **O(total allocated PIDs)** identity/outcome metadata; no count-bounded
retention, heap measurement or general all-writer guarantee is implied. Do not
expand this investigation into a blanket Effect persistence rewrite.

## Smallest proposed next action — one observer cohort, not authorized here

Root cause remains unknown; no minimal causal production fix can honestly be
selected. Propose **one fresh-origin, isolated unchanged case9, steps0 then1 only**
on the same frozen phase2A delivery. No full19/five-generation run, no cases0–8,
no retries, no timeout increase, no inference. Preserve every stage assertion,
including original15s post-public-action target absence; stop immediately on its
first failure, leaving step1 explicitly unrun if step0 fails.

Before execution, parent should approve a narrow QA-only observer (new owned
files, no candidate changes):

1. Timestamp Workspace close and Host.destroy entry/return/throw/dead-before plus
   the **actual outer Worker handle's native terminate call/return/throw**. A
   transparent instance-level observer must call the saved native method with its
   original receiver exactly once and preserve return/exception behavior. No fake
   Worker, promise/ack, extra terminate, cleanup retry, or wait inserted into the
   action. This is instrumentation, not existing passive proof, and must be
   explicitly admitted as such; a counter alone cannot certify worker exit.
2. Keep bounded in-memory ledger writes synchronous; collect them after the
   original action, without awaiting observer transport on its path. Record
   flush/Runtime stop boundaries and handler failures; retain exact originals.
3. Observe raw native target creation/destruction info and getTargets for the
   **same ID**, URL/title/type plus timestamps, through a verified independent
   transport as well as the existing CLI census. Attach only a non-pausing
   collector; no debugger pauses, resume commands, target close, worker evaluate,
   diagnostic pings or heartbeat stimulus to manufacture liveness. First verify
   that the independent transport truly reaches native browser CDP rather than
   the same cached adapter; otherwise label its evidence unavailable.
4. Passively snapshot held/pending Web Locks near returned close and at the15s
   endpoint; preserve normal pre-close diagnostics/SQLite receipts and any
   naturally emitted post-close worker messages. No lock contention/acquisition,
   second kernel or storage mutation beyond the unchanged case. Buffer trace/log
   events without ordering acceptance behind their delivery.

Interpretation must remain conditional:

- No actual terminate invocation despite returned close, with complete observer
  coverage and dead-before/handler evidence: narrows a missed-destroy/termination
  path; then fix only the demonstrated exception/order issue and add its exact
  regression (throwing handler must not suppress native terminate/remaining
  cleanup, with error retained). This is a contingent fix, not today's diagnosis.
- Native terminate recorded, independent native target destruction/absence while
  CLI retains the ID: transport/census visibility divergence. Preserve original
  failure; fix only the proven observation boundary, never extend the deadline.
- Native terminate recorded and both censuses retain the ID, with locks absent
  and no execution evidence: termination/target-retirement cause **still unknown**.
  Neither unsupported probes nor silence prove kernel death or life.
- Naturally timestamped continued kernel work or retained owner lock after close
  gives additional activity/resource evidence; tie it to the exact worker/client
  and time. Lock ownership alone is not a JS execution receipt. A failed observer
  is unavailable evidence, not a product PASS/FAIL substitute.

An isolated PASS establishes only that cohort; it cannot erase c3672ee or prove
statistical reliability. A non-reproducing result must remain non-reproducing,
not start an open-ended rerun loop. Parent decides the next disposition from the
original failure plus this one diagnostic observation.

## Historical denominators preserved

- Phase1 [integrated follow-up](2026-09-30-effect-loader-integrated-acceptance-followup.md)
  `8593093`, exact runtime3ee9185: one unchanged combined PASS, including both
  SQLite steps and every original15s close census. Its earlier failed combined
  fetch cohort remains failed. No causal claim that phase2A necessarily caused
  the current retention follows from one old PASS/one new FAIL.
- [Phase1 URL-repaired offline QA](2026-09-30-effect-loader-url-repaired-independent-qa.md)
  is31 preserved cases plus a URL gate, not live SQLite/OPFS coverage.
- [Phase2A independent offline QA](2026-09-30-effect-process-subtree-independent-qa.md)
  is17+31 with routing/sync-capture; its controlled browser adapter leaves are
  not executed Chrome teardown coverage.
- [e35 attempt1](2026-09-30-single-kernel-e35eab4-attempt1.md) failed an immediate
  census, then a later passive read found no workers. That earlier transient is
  not an explanation for this target surviving the full15s and passive read.
- [Conservative editor cohort](2026-09-30-conservative-editor-switch-recovery-live-qa.md)
  failed Save and later retained a same-ID kernel roughly32.5s after public Exit,
  with empty locks. Different runtime33fa135/consumer; neither erased nor treated
  as proof of this cohort's cause. Editor busy-close/save limitations remain open.

No release/pin promotion, loader scope beyond registered processes, persistence
cutover, all-writer acceptance or phase2B/3 authorization is supplied by this report.
