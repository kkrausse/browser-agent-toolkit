# Phase 8 — matched restarted-service strategy preparation

## Outcome: tested harness, live comparison HOLD

Prepared an **example-only strategy harness and focused offline controls**. No
browser cohort was started. The concrete fresh-origin adapter and trustworthy
writer/mutation inventory are not yet established; those are prerequisites, not
assumptions authorized by this preparation. Ownership booleans in the harness are
adapter attestations, **not enforcement or proof**. No production-safe reuse,
immutable environment, library API, or performance qualification is claimed.

Exact new real-runtime counts: **0 startup attempts, 0 measured switches,
0 qualified passes, 0 runtime failures**. Offline simulated sequences are not
browser attempts. No retry, replacement cohort, budget extension, model request,
runtime/pin/distribution/IRS/archive edit, push, deployment, or retained-process
experiment occurred. Phase 7 remains startup 1/1 and service switches 12/12;
it is not a matched performance result.

## Delivered preparation

Files remain separate from library builds:

- `examples/todo-app/tests/matched-switch-strategy.ts`: fixed interleaved plan,
  complete identity comparison, explicit ownership rejection, joined shutdown and
  stopped-reader gate, reset/reopen/reinstall versus retained-tree replacement,
  separate stage/readiness spans, first-failure stop and immutable receipt copies.
- `examples/todo-app/tests/matched-switch-strategy.test.ts`: mocked orchestration
  and a host-filesystem sandbox of the existing `sourceReplacementScript(...,
  false)` generator. Neither is a runnable browser/server adapter.

Both strategies restart **both Vite and OpenCode**. Source-only starts a new runtime
wrapper but must not call the existing installed-environment reuse delivery tool.
That tool deletes `.vite-temp`/`.vite` and hashes the installed tree; silently using
it would be a different comparison. No library behavior or verification bypass was
added. The retained branch is available only behind the benchmark-specific gate.

Full reset always clears, closes/reopens, writes the source, starts the runtime
wrapper and calls normal verified managed image delivery. Every environment field
is required: runtime/distribution, managed tree, image/bundle, dependency policy,
package+lock inputs and service configuration. Identity inputs must be canonical,
verified digests, not source revision strings. Any incompatible identity selects
full reset. If this happens during the measured cohort, even a successful fallback
ends that cohort as an incompatible/failed sample, never a reuse pass or replacement.

Offline source replacement removes deleted/renamed modules and their old imports,
recreates target config and exact `[0,1,2,255]` binary bytes, and preserves sentinel
bytes in dependencies, backends, Vite optimization and temporary caches. Unsafe
managed-root paths/traversal/file-directory collisions are rejected. This is not
live Vite stale-module or fresh PDF qualification. Partial replacement failure is
not transactional; the harness stops, retains the failure receipt and starts no
incoming services. It does not implement retry recovery or snapshots.

## Ownership decision required before a live adapter

**Recommend finish the adapter and audit before running, not weaken the gate.**
Phase-7 exit/drain/process observations do not establish all possible host writers.
A persisted environment marker, matching source provenance, and absence of active
model requests alone cannot safely justify skipping installed-tree validation.
The proposed scope is narrowly bounded: two fresh exclusively owned origins, one
serial Browser Control CLI owner, no model/manual/external initiators, a verified
initial installation, frozen fixture/config/dependency inputs, and documented
writer/mutation boundaries for this particular service workload.

Concrete missing evidence:

1. Audit the delivered Vite/OpenCode/plugin/fixture paths and asynchronous work.
   Prove that immutable managed package/tool bytes cannot be changed by this
   workload; inventory every allowed cache/state writer and when it drains. The
   harness's writer and cache lists are **proposed allowlists**, not observed
   inventories. Unexpected writers or managed-byte mutations mean STOP and return
   a design decision (or explicitly choose validated reuse, not a silent bypass).
2. Cover runtime/kernel/OPFS persistence writers separately from the Vite/OpenCode
   process table. `WorkspaceController.stopRuntime()` logs some cleanup failures;
   its fulfilled promise alone is insufficient. Join actual service exits and
   stdout/stderr drains, detach preview readers, and independently observe zero
   processes/listeners/HTTP and fetch inflight/queued/active work before replacement.
3. Track mutations under `.browser-editor-cache/vite`, `node_modules/.vite-temp`,
   project OpenCode `.server` and `/runtime-probe`. Confirm actual paths against
   the proposed list. These caches/state are intentionally mutable, not immutable
   dependencies. Do not delete caches to make an inventory appear valid.
4. Check retained state outside the workspace too: normal delivery manages
   `/opencode-v2` and `/app`; normal `clearWorkspace` clears `/workspace` and
   `/.server`, not `/runtime-probe`. Specify identical server/catalog requests and
   database history in both conditions, no chat/model work, and no untracked tools.

Only after those observations may a real adapter set
`writerMutationAuditVerified`. Full-tree verification, source checks, cache
inspection and diagnostics belong outside stage timing and must remain explicit;
they must not be quietly omitted when ownership is untrusted. This harness does
not establish ownership itself, and no nested reviewer was available/requested.
Parent read-only review of the new ownership/adapter design would be appropriate;
the unchanged `b2b9c55` serial PDF verifier already has phase-7 approval.

## Predetermined live plan (not run)

- Preserve all seven retained pages and servers 43222/43223. Allocate two unused
  localhost origins (43226/43227 are suggestions, **not reserved or inventoried
  as empty storage**). Use newly owned sessions only. Inspect script-free paths
  for empty IDB, Cache Storage, SW and localStorage before app startup.
- Serve the clean `446df00f86d5d6d5d856a2e5deec0fac49f242fa` runtime and unchanged
  phase-4 distribution/payload. Reverify the packaged identities/manifest and
  original image/bundle hashes as in phase 7. Build only a separately inventoried
  experimental example client; do not overwrite the frozen phase-4 client.
- Same generation-1 source and hydrated/PDF startup for each condition. Label
  these **cold fresh-origin startup** separately; two startups are not switches.
  Warm switches run generation 2–6 (B/A/B/A/B) in each same-runtime origin.
- **Five measured transitions per condition, ten total ceiling.** Global order:
  baseline/reuse, reuse/baseline, baseline/reuse, reuse/baseline, baseline/reuse.
  No overlapping commands or initiators. First failure in either origin stops
  the entire pair/cohort: no action replay, retries, replacements or extensions.
- `Adapter.verifyGeneration` must use the unchanged reviewed serial mechanics:
  all fixture source/binary bytes, outgoing-only filename absence, generation and
  hydrated enabled title input, then one newly armed/clicked/completed PDF run on
  the same document/button/token. Verify outgoing before shutdown and incoming
  after readiness; no existing completion bytes accepted. Token is verifier-owned,
  not PDF-produced; only this exclusive serial scope supports attribution.
- Add bounded focused **non-measured controls**, not extra cohorts: dependency
  input mismatch and Vite/OpenCode config mismatch must execute the reset fallback;
  partial replacement must preserve a failed tree and stop without incoming
  services. Offline controls already cover dispatch/order and failure-stop;
  browser controls remain unperformed. No broad dependency pruning or snapshots.

## Timing contract and current limitations

The harness records shutdown/drain, clear/close/open, source install/replacement,
fresh wrapper start, dependency delivery, config install, each service launch,
hydrated interactive preview, OpenCode server readiness, and flush independently.
Cache-retention inspection and source/PDF/reader diagnostics are explicitly outside
stage timing, with separately named diagnostic spans including cache retention.
Retained dependency delivery is absent, not an invented zero-cost
installation. There is no cache cleanup on the source-only branch.

`lifecycleMilliseconds` is the sum of sequential timed spans plus the parallel
service wall span, **not the sum of overlapping service durations**, nor a clean
end-to-end wall-clock result. `elapsedMilliseconds` includes diagnostic work and
overhead; `diagnosticMilliseconds` is reported separately. Incomplete lifecycle
timing on early failure stays `null`, not a false zero. A live adapter should
also capture instrumented lifecycle wall time and clean lifecycle timing without
diagnostic gaps; do not subtract slow verification and label it user-visible
switch time. The adapter will need explicit watchdogs/absolute deadlines; this
preparation's generic hooks do not impose browser deadlines or cancel hung tasks.

OpenCode health/plugins/config/model-catalog checks are **server readiness only**.
Every receipt explicitly says `usable-mounted-chat-unqualified`; no mounted chat
or delegated model/tool workload is exercised. Consequently end-to-end chat or
delegation performance remains unqualified even if later preview timings pass.

**New timings and bottlenecks: none measured.** Phase-7 timings remain diagnostic
baseline observations, not substitute data. Reinstalled dependency delivery, Vite
optimization/hydration, and OpenCode launch/readiness are candidate bottlenecks,
not phase-8 findings. A retained-Vite experiment is **not yet warranted**: first
establish this restarted-service comparison and measure the critical path. Do not
retain OpenCode merely because preview startup dominates.

## Evidence and checks

Distinct ignored evidence directory (inventoried `.diagnostics` before creation):

`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase8-matched-strategy-20260929/`

The prior nine directories were phase1, phase2, phase3-verification, phase3,
phase4-browser-interruption-20260929, phase4-clean-completion,
phase5-service-qualification, phase6-pdf-verifier-correction-20260929, and
phase7-service-qualification-20260929. None was overwritten. Logs here are local
ignored evidence and do not travel with the commit.

Checks: `bun test tests/matched-switch-strategy.test.ts tests/reset-verifier.test.ts`
passes **26 tests, 0 failures, 215 assertions** (13 new strategy tests and the unchanged 13 verifier
tests). `bunx --bun tsc --noEmit` in `examples/todo-app` and `git diff --check`
exit 0. These are offline checks, not browser qualification. The first offline
test run exposed a test scheduling assumption (two microtasks did not reach the
mock shutdown hook). Replaced that assumption with an explicit entered-promise;
this was not a runtime attempt/retry or a verifier change.

Observational-only `browser-control status --json` reported relay 0.8.2, shim
0.0.25 and seven active targets; no Browser Control execute/navigation/reload/
session mutation occurred. Servers 43222/43223 still listen with PIDs 6885/7042.
The clean runtime checkout remains clean at `446df00...`. No page/kernel/server
resources were created, shut down or cleaned up. All retained named sessions
`quiet-falcon-568`, `clever-badger-501`, `calm-otter-581`, `gentle-otter-722`,
`amber-badger-702`, `lucky-walrus-901`, `lucky-tiger-691` were not targeted.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-29-matched-switch-phase8-preparation.md`
