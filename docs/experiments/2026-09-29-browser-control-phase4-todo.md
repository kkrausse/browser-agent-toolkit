# Browser Control project todo: phase-4 execution-context interruption

- [x] Diagnose `page.evaluate: Execution context was destroyed, most likely because
  of a navigation.` with Browser Control **0.8.2** (Bun-backed CLI).

Safe context: isolated public fixture origin `http://127.0.0.1:43224`, session
`lucky-tiger-691`, no credentials/model calls. Top document URL did not move;
the preview iframe is replaced during normal A/B workspace restart.

Reproduction recipe retained at absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase4-clean-completion/`.
Original CLI/journal code and failing receipt are retained there. Do not rerun
the retained session or restart that reset cohort for diagnosis. A harmless
65-second document promise reproduces the error without any navigation; see the
review and disposable recipes linked below.

Expected: post-switch source/hydration/PDF verification completes, or a specific
readiness/runtime failure is returned. Actual: second switch returned the context
error after joined service shutdown; top page remained ready without runtime error.
One read-only follow-up and final source verification succeeded; no reset/reload,
relay restart, retry or session replacement was attempted. Healthy service kernel
was closed only after evidence capture. Cohort remains stopped/incomplete.

Review, tests and proposed new cohort, absolute:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-29-browser-control-phase4-review.md`.
The interrupted await was the switch call: original `switch.total` later completes
at 60,258 ms, beyond the driver's 60,000 ms debugger-command deadline. New harness
starts once and polls short generation-specific reads. No upstream driver fix or
new runtime qualification is claimed; the old switch remains unverified.

- [ ] Upstream diagnostic: distinguish debugger-command timeout from real context
  destruction rather than reporting both as navigation. No relay/package edit here.
- [ ] Review the separately prepared v2 harness before authorizing the proposed
   fresh cohort. Do not promote the old interrupted switch.

## 2026-09-30: large-result evidence export

- [ ] Preserve a lossless, bounded export for large result snapshots with Browser
  Control **0.8.2**. Safe context: credential-free matched fixture ports 43228/43229,
  sessions `rapid-raven-347` and `cosmic-panda-884`, now stopped/retained.
  Reproduction evidence: `ownership-fixed-pair-driver-20260930/0727.js` and
  `0727.json` under the toolkit repository's `.diagnostics/`. The script returns
  `{samples,events,resetEvidence}` after generation 6. Expected: structured samples
  or an explicit export failure. Actual: `ok: true`, `value: null`,
  `valueUnavailable: true`; textual samples omit 44 items after the first 50.
  Nine snapshots were unavailable. All ten switch/PDF verifiers passed separately.
  No recovery read, retry, relay restart, session reset or replacement was attempted.
  Do not rerun this cohort. Proposed future harness mitigation: bounded chunks or
  JSON-string export, with an explicit unavailable-value check.
