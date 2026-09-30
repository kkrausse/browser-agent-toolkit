# Browser Control project todo: phase-4 execution-context interruption

- [ ] Diagnose `page.evaluate: Execution context was destroyed, most likely because
  of a navigation.` with Browser Control **0.8.2** (Bun-backed CLI).

Safe context: isolated public fixture origin `http://127.0.0.1:43224`, session
`lucky-tiger-691`, no credentials/model calls. Top document URL did not move;
the preview iframe is replaced during normal A/B workspace restart.

Reproduction recipe retained at absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase4-clean-completion/`.
Start its isolated server, use a **fresh origin/session**, run the fixture startup
then `run.js` with `state.action='switch'`, capped at two switches. Do not rerun
the retained session or presume this nondeterministic interruption will reproduce.
Original CLI/journal code and failing receipt are retained there.

Expected: post-switch source/hydration/PDF verification completes, or a specific
readiness/runtime failure is returned. Actual: second switch returned the context
error after joined service shutdown; top page remained ready without runtime error.
One read-only follow-up and final source verification succeeded; no reset/reload,
relay restart, retry or session replacement was attempted. Healthy service kernel
was closed only after evidence capture. Cohort remains stopped/incomplete.

Determine which awaited action/frame context failed and whether this is page
timing or driver behavior before changing the harness. No driver-fix claim exists.
