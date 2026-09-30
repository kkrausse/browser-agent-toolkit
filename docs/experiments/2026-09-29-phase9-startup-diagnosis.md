# Phase 9 startup diagnosis — no replacement cohort

## Result and confidence

**High confidence: the listener budget expired and the adapter then killed Vite.
Not established: that Vite would eventually have become ready.** Phase 9 remains
2 cold attempts, 1 pass, 1 failure, **zero measured switches**. This diagnosis adds
**0 guest startups, 0 browser readiness tests, 0 switches, 0 model requests**.
No retry, recovery, replacement comparison, retained-process work or deadline
extension was performed on those origins.

The most actionable finding is an inadequately justified, hidden 30-second
listener cap plus insufficient pre-cleanup failure evidence. Slow startup under
shared-browser load is plausible (moderate confidence); a surviving worker
exception, stalled import/config evaluation or silent worker loss remains possible.
The evidence does **not** support selecting one of those as the historical cause.

## What the receipts actually discriminate

- Failed Vite spawn was accepted in **22 ms**. `service.listen.start` was
  `01:24:09.744Z`; `service.listen.failed` was `01:24:39.748Z`, **30,004 ms**,
  `TimeoutError: signal timed out`. The frozen controller races listener exposure
  against `execution.exited`; its failure handler calls `execution.stop()` and joins
  output drains. Both streams drained zero bytes immediately after that failure.
  The later missing PID/listener therefore cannot establish a spontaneous exit.
- No pre-timeout Vite process/module/worker-error snapshot was captured. Driver
  output has no page error and no guest exception, only the timeout and ordinary
  WASM initialization warning. This excludes a *reported* early exit as the winning
  failure, not every possible guest exception or worker fault.
- Both cold conditions perform the **same normal managed-tree delivery**, flush,
  complete audit and generation-1 source install. Reuse delivery is disabled;
  retention/replacement has not run. Both audit all **12,305 entries** successfully,
  with identical empty Vite-cache digests and only the same initial marker under
  `/runtime-probe`. Launch entry/argv/cwd/port descriptors are identical. Per-origin
  model URLs and randomized server passwords are intentional differences, not
  demonstrated config failures. No missing/corrupt immutable package is evidenced.
- OpenCode also slowed: listener **11,319 → 17,181 ms**, connect/catalog
  **3,889 → 10,885 ms**, activation **2,065 → 8,195 ms**. Both passed. This is
  evidence of a broader timing difference, not proof of its cause.
- **Order is not matched background load.** Baseline's hydrated Vite, watches/HMR
  and OpenCode remain running while the second origin installs/audits/starts. The
  later baseline cleanup snapshot still shows both PIDs, Vite's 103 watches and
  its live WebSocket. Browser scheduling, memory/GC, tab visibility and CPU were
  not recorded at the failed deadline; resource contention is a candidate, not a
  measured attribution.
- Deduplicating phase-7 event IDs gives healthy Vite listener spans of
  **1,868–28,227 ms** (13 generations). The maximum leaves only **1,773 ms** under
  the hidden cap. This is poor evidence for a universal 30-second readiness SLA;
  it is not proof that the phase-9 failure is a false timeout.

## Validation and cache audit

Initial validation takes **18,570 / 16,950 ms** and completes before either service
launch in its own origin. `installedTreeAuditTool` joins exit/output and stops its
owned execution before returning. There is no evidence that the audit process
overlapped incoming services. It does read/hash every installed file through the
guest VFS: both service starts are **post-audit**, not untouched cold read-cache
starts. Vite optimization caches are absent in both origins, but host JIT/WASM/OS
cache warmth and guest decompressed-read-cache state are not measured as equivalent.
Baseline service activity can overlap the *second origin's* full validation.
Do not subtract validation from user-visible totals or ascribe the failure to it.

## Corrections, offline only

- `workspace-api/src/service-readiness.ts` and `src/react.tsx`: explicit configurable
  listener/connect/overall budgets, budget receipts, cancellation passed into
  connect, and bounded spawn wait. Overall time does not reset between stages.
  Exit and stream/transport failures race both listener and connect, preventing
  publication of a dead service. Late accepted spawns are stopped/drained; late
  endpoints are disposed. Successful readiness does not abort published processes;
  existing ordered EOF shutdown remains intact. Cleanup failure is still reported,
  never converted into a healthy readiness result.
- `opencode-chat/src/browser.ts`: forwards the same policy and connection-stage
  signal to catalog verification; no catalog/model workload change.
- `examples/todo-app/tests/matched-readiness.ts` / `performance-client.ts`: frozen
  URL-configured budgets shared by both services and recorded per generation;
  a whole-services budget includes config, HTTP body read and hydrated preview.
  Vite exit/output errors also fail interactive readiness. First failure cancels
  outstanding readiness, not source/tree storage. No startup replay is implemented.
- **Compatibility listener default stays 30,000 ms.** No longer a hardcoded,
  unconfigurable policy; changing it for a future pair requires freezing equal
  `readiness.listenMs`, `readiness.connectMs`, `readiness.hydrationMs` and
  `readiness.overallMs` parameters before either origin starts. Nothing has been
  extended until it passes, and these changes were not served into phase 9.

Source checks: **43 workspace tests + 32 focused example tests pass**,
**416 assertions** total. Three source-aware TypeScript checks and `git diff
--check` pass. New regressions cover exit during connect, output failure, listener
and connect deadlines, non-resetting overall deadline, late spawn/listener cleanup,
published-process survival, matched policy equality and cancellation. Existing
audit/fallback/partial-replacement/PDF verifier controls remain green.

The first broad test invocation had one unrelated executable-mode assertion fail
under shell umask **077** (requested 0755 becomes 0700); the complete suite passes
with explicitly set **022**, without changing that test. Initial isolated
typecheck configs lacked absolute Bun/Vite type-library paths; corrected configs
pass. No dependency installation or generated library/runtime overwrite was needed.
Packaged-consumer rebuild and live correction qualification remain future gates.

## Next fixed comparison proposal (not run or authorized here)

After parent review, freeze a **new** pair: one cold generation-1 startup each,
then five restarted-service transitions each, the phase-9 interleaved order and
first-failure stop. Same runtime/payload/27 fixtures and unchanged serial PDF verifier.
Suggested prospective policy: **60s listener, 45s connect, 60s HTTP+hydration,
90s whole-services wall budget** in both conditions; the original 120s observation,
30s verifier reads and 240s outer watchdog remain unchanged. These ceilings are
an explicit bounded qualification policy, not a prediction of passing or a new SLA.
The first failing stage or overall budget ends the whole pair without replacement.

For cold-startup comparability, stop/drain the first origin's services after its
startup qualification, then start/qualify the second with the same background
service count. If both pass, one explicitly labelled, non-measured restarted-service
re-arm per origin is needed before outgoing generation-1 verification and the fixed
switch plan; stop the entire pair if either re-arm fails. Predeclare those two extra
re-arms, do not silently count them as cold startups or measured switches. If parent
instead retains phase-9 startup ordering, document the load/order confound and do
not claim matched cold performance. Do not close existing failure pages to reduce load.

Before another live attempt, rebuild only the new isolated client from the intended
workspace/chat sources, freeze its hash, and independently review its unchanged
verifier plus failure cancellation. Capture bounded per-process diagnostics during
startup (e.g. 10s/20s and immediately before cleanup), including booted/modules/
workerErrors/firstWorkerError, last output, listeners and exit/cleanup receipts.
Do not infer death from zero kernel syscalls: filesystem traffic uses the FS worker.

Mandatory outstanding gates: joined service exits/output/preview detach and zero
process/listener/HTTP/fetch work; full stopped-tree validation; compatible dependency,
lock and Vite/router/TypeScript inputs; pre/post cache digest identity; actual
post-service mutable state inventories; browser incompatibility-reset and partial
replacement controls. Kernel/OPFS writer boundaries and persisted-byte equivalence
are still not proven by service exit alone. Mounted chat and production-safe/lifetime
immutability claims remain unqualified. No retained Vite work is warranted yet.

## Identity, evidence and preservation

Distinct evidence directory (old files never overwritten):
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase9-startup-diagnosis-20260929/`

`analysis-final/` contains the final deduplicated analysis, prior file hash inventory,
all 14 frozen served artifact checks, rehashes of **10,526 managed file blobs** and
the unchanged original image/bundle. Frozen distribution identifies runtime
`446df00f86d5d6d5d856a2e5deec0fac49f242fa` and distribution `4ef513e7bb62…`.
Image: 44,123,335 bytes, `434336bf…`; bundle: 42,664,752 bytes, `4593820a…`.
The old phase-9 client remains 458,184 bytes, `f626edec…`.

**Current vendor checkout is a clean `e998de62…`, not the qualified runtime pin.**
It was not changed. Pinned execution source was inspected via `git show 446df00…`,
not inferred from this newer checkout. A future build must deliberately select a
separate clean 446df00 source or verified matching host artifacts; do not rebuild
the qualified runtime from the current default checkout or update production pins.

Only observational Bun Browser Control CLI inventory calls occurred: eight existing
targets were not targeted/navigated/reloaded/closed; their complete records match
phase-9 cleanup and all 24 prior evidence files remain hash-identical. Servers 43222/43223 retain PIDs
6885/7042. Prior failure storage was not reopened, cleared or inspected through a
guest. No new origin/server/session, push, deployment, runtime/pin/IRS/archive edit
or model call occurred.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-29-phase9-startup-diagnosis.md`
