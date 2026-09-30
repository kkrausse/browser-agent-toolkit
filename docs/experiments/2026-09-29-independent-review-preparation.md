# Independent-review blockers — corrected offline preparation

## Outcome

Corrected source, tested actual consumer control flow, and froze a newly built
isolated client for parent independent review. **No live comparison or guest
startup ran; 0 new cold starts, 0 switches, 0 re-arms, 0 model requests.** Phase 9
remains 2 cold attempts / 1 pass / 1 failure / 0 measured switches.

## Concrete corrections

- `workspace-api/src/react.tsx` retains launch ownership through late accepted
  spawn stop/output settlement. Listener/connect cancellation joins the underlying
  tasks before launch rejection returns. Teardown joins pending launches and
  detached-but-not-yet-drained services. Cleanup failures block runtime teardown
  with **quiescence unproven**, rather than being logged as successful shutdown.
  Separate cleanup-start/settled diagnostics expose an unresolved join.
  Immediate terminal output observation is separate from all-settled output
  draining: one failing stream cannot bypass joining the still-running sibling.
- Published exit and output failures remain terminal after individual readiness.
  The example monitors controller errors throughout aggregate qualification and
  checks the controller snapshot before publishing `api.ready`. Terminal errors
  subsequently invalidate `api.ready` as well.
- `matched-readiness.ts` cancels on the first sibling failure and joins siblings.
  Bounded observation has a separate 10s cleanup-observation deadline. If owned
  work remains unresolved it is retained in the pending registry, reports
  **quiescence unproven**, and teardown/replacement must still join it; the 10s
  receipt is not permission to abandon work. Uncooperative work can therefore
  leave cleanup pending indefinitely. No replacement or reset follows that state.
- HTTP body settlement checks cancellation before attaching a preview. Both the
  real example branch and a deliberately late body-completion control prove that
  a cancelled sibling cannot attach afterward.
- Audit invalidity, audit exceptions, missing digests, and post-replacement digest
  mismatch use the mandatory full-reset fallback. Fallback also stops its new
  runtime wrapper and always ends the cohort without incoming service launch.
  A **source-replacement exception remains different**: retain the partially
  replaced failed tree, stop the cohort, and do not reset or launch incoming work.
- `editorPerformanceExperiment.stopServices()` cancels outstanding service
  qualification, joins readiness ownership, service exits/output, preview detach,
  and zero-process/listener/HTTP/fetch diagnostics without closing the workspace.
  `rearm()` starts the **same generation**, records `measured:false`, and stops
  the cohort on failure. `stop()` also joins pending readiness before close.

## Frozen prospective budgets (identical conditions)

| Boundary | Milliseconds |
| --- | ---: |
| Listener | 60,000 |
| Connect/catalog | 45,000 |
| HTTP body + hydration | 60,000 |
| Whole services, including config | 90,000 |
| Switch observation | **180,000** |
| Hydration/PDF verifier read | 30,000 |
| Separate cleanup observation | 10,000 |
| Outer driver watchdog | **300,000** |

The 90s services ceiling does not reset between stages. Two prospective 38s
audits plus services account for 166s, leaving 14s under switch observation for
other work; this is a bounded qualification proposal, **not proof of a passing
timing SLA**. Observation + two verifier reads + cleanup observation accounts for
250s under the 300s watchdog. First failure ends the pair, with no extensions or
replacement cohort. Stop/drain the first cold-qualified origin before the second
cold startup; predeclare one non-measured same-generation re-arm per origin.

Compatibility defaults remain unchanged for old consumers. The new launch gate
requires the explicit frozen URL policy, rejecting omitted or unequal budgets.
The unchanged `b2b9c55` verifier supports the 180s switch observation through its
existing options; its source and exclusive serial action mechanism are untouched.
`driver-policy.json` freezes the required options before any future start.

## Packaging and identity

New ignored preparation directory (final successful output):

`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/reviewed-client-prep-2026-09-30T02-18-55-527Z/`

`prepare-reviewed-client.ts` builds the four workspace browser entrypoints needed
by this consumer and the chat browser entrypoint in isolated directories, emits
separate declarations, relocates pinned host declarations, copies licenses and
provenance, then typechecks **the actual `performance-client.ts` against those
new packaged declarations** and separately bundles that consumer. Existing
workspace/chat `dist` directories are neither read for these libraries nor changed.

The host source is an explicitly selected clean detached worktree at
`446df00f86d5d6d5d856a2e5deec0fac49f242fa`, **not vendor's e998de checkout**.
No runtime assets were rebuilt. Frozen runtime distribution remains
`4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a`.
Preparation rehashed all 13 non-client served identities, **10,526 managed file
blobs**, and both original image/bundle payloads (10,528 payload checks).

- Client: **472,969 bytes**, SHA-256
  `ee4ffaa596884dac60169a35fce682a998ca58217b7681774c53de8aa6bb7aec`.
- Unchanged serial verifier: **5,742 bytes**, SHA-256
  `d267e74b20bcf505082a70729723aa74776f58525261d9255c0ac1f6ad3cdf5b`.
- `receipt.json` freezes source hashes, 50 packaged JS/declaration hashes,
  served identities, parsed delivered policy, and consumer/verifier identities.
- `commands.log` records pinned source checks and four successful TypeScript
  invocations (host, workspace, chat, actual consumer), each exit 0/no diagnostics.

`matched-switch-live.ts` no longer builds from stale `dist`. It requires a
reviewed `MATCHED_CLIENT_PREPARATION`, a new `MATCHED_EVIDENCE_DIRECTORY`, checks
the client hash/frozen runtime identities/exact policy, and rejects URLs omitting
the expected condition and identical budgets. Its prospective ports are
43228/43229. **The launcher was not executed; no server was started.**

Earlier isolated preparation attempts are retained in their own distinct ignored
directories. They exposed an initial dev-JSX resolver omission and a wrong blob
directory assumption; neither touched old evidence. Both issues are corrected in
the final preparation. Clean pinned worktrees are retained for review.

## Checks and remaining gates

**95 tests pass, 0 fail, 507 assertions across 19 files**, with umask 022;
`git diff --check` passes. Tests include late accepted spawn teardown exclusion,
late detached output settlement, terminal post-readiness process/stream failure,
same-turn endpoint acceptance/exit ownership,
single-stream failure observation with joined delayed sibling drain,
joined cancellation/unresolved cleanup, budget accounting, late HTTP attachment,
and unchanged audit/strategy/serial-verifier controls. New VM controls execute
the **actual bundled consumer** with host-only adapter doubles to exercise
before/after audit failures, exceptions, digest mismatch, full-reset-and-stop,
partial replacement preservation, same-generation re-arm, and death during
aggregate qualification. They are **not browser/runtime samples**.
The final preparation directory also retains `tests.log` with the test output.

Parent independent review must still approve the frozen preparation and wire the
new driver policy into the exclusively serial driver before authorizing any new
origin. Actual browser cold-start/background-load matching, stopped-kernel
diagnostics, live fallback/partial-replacement controls and re-arm qualification
remain future live gates. No production-safe immutability, persistent-byte
equivalence, mounted chat qualification, or retained Vite claim is made.

No existing pages or servers were targeted. Old evidence was not overwritten;
no runtime/pin/IRS/archive edits, dependency installation, push, deployment, or
model calls occurred. Only this task's source/tests/report are committed.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-29-independent-review-preparation.md`
