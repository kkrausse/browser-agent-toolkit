# Phase-5 qualification review — 2026-09-29

## Outcome

**Held before browser startup: the v2 verifier has a stale-PDF evidence gap.**
The authorized fresh actual-service cohort did **not** run. Startup attempts: **0**;
A/B switch attempts: **0**; qualified new passes: **0**. No replacement cohort,
budget extension, action retry, or runtime failure occurred. This is a harness
review blocker, not an observed failure of the clean runtime candidate.

The boundary was one fresh-origin startup plus at most 12 actual-service switches,
first runtime/verification failure stops, no repeat switch on automation errors.
The instruction to stop/report review blockers takes precedence over starting it.

## Reviewed inputs and fail-closed behavior

Read repository AGENTS, the Browser Control skill (CLI only), phase-4 review,
phase-4 qualification, and transport-completion report. Reviewed toolkit commit
`ef369240fdac3bbd1a9a907d8bafa8da3f51dd73`, particularly
`examples/todo-app/tests/reset-verifier.js`, `reset-evidence-v2.js`, preparation,
and all seven focused verifier tests.

- Switch initiation is once per unique token, not replayed on an ambiguous error.
  Its promise settles in the host page, avoiding the long CDP await that caused
  the reproduced 60-second Browser Control deadline.
- Completion reads require the settled token, API readiness, expected-generation
  hydration and an enabled input (or explicit install-only mode). Lost host state
  and runtime errors are terminal. Only the exact context-destroyed read message
  has bounded read recovery; no action/deletion recovery is present.
- The absolute observation deadline rejects a late successful read. The host URL
  is checked before observer reads and again before the complete receipt passes.
  These are source-reviewed guards; the focused suite has a late-read test but
  no explicit URL-change regression. No new live deadline/URL control was run.
- Exact source verification delegates to the existing 26-fixture byte comparison
  and outgoing A/B-only filename absence check; the returned source generation
  must match after switching. Joined service exits/drains and process/listener
  diagnostics are collected by the existing fixture, not independently asserted
  by the seven unit tests.

## Blocking PDF control

In `reset-evidence-v2.js:19–27`, clicking the PDF button is followed by a check for
generation-specific hydration and `data-bytes > 0`. The previous `data-bytes`
value is neither invalidated nor distinguished from this click's completion.
Each switch execute first verifies the outgoing generation, which already has
the nonzero PDF result from the previous successful execute. It clicks again and
can immediately accept those old bytes while the new asynchronous job remains
pending, then begin shutdown/switching.

A single **offline synthetic control**, running the actual v2 execute body, used:

- source stand-in `{files: 26, generation: 1}` and matching hydration/input;
- a PDF button with an existing `data-bytes="875"`;
- one successful click dispatch, but **zero completed new PDF jobs**;
- unchanged qualifying host URL, initial-only action, no switch API invocation.

Result: **`status: PASS`, `stage: completed`, `pdfBytes: 875`**, despite the new
job never completing. This demonstrates stale workload acceptance, not actual
fixture bytes, PDF output, or runtime behavior. A newly created incoming preview
normally has no old PDF marker; this finding does **not** invalidate phase-4's
already recorded fresh-generation PDF result or claim every post-switch check
is vulnerable. It does block the stronger promise that every click is joined to
a new completed workload before shutdown.

Focused checks run once after review:

- `bun test tests/reset-verifier.test.ts`: **7 pass, 0 fail, 25 assertions**.
- `bunx --bun tsc --noEmit` in `examples/todo-app`: **exit 0**.
- Offline stale-PDF control: **one invocation**, reproduced the false pass.

No tracked harness correction was made after identifying the blocker. Recommended
minimal correction: invalidate the previous PDF result for the verified generation
before the single click, then require a newly populated nonzero result on that
same generation under the existing deadline. Add an execute-body regression in
which old bytes exist and the new job never completes: it must fail, not pass.
Also cover fresh completion and host-URL changes. Do not alter runtime/payload
fixtures, add action retries, or weaken byte/source checks to solve this.

## Evidence inventory and preservation

Inventoried ignored directories and existing phase-1 through phase-4 recipes
before creating the distinct private evidence directory:

`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase5-service-qualification/`

It contains `review-pdf-stale.ts`, the synthetic receipt and `control.json` in
`pdf-stale-control/`, `verifier-tests.log`, and `typecheck.log`. Existing recipes,
receipts, payloads and distributions were not overwritten. Private ignored
evidence does not travel with this report's commit.

The candidate checkout is clean at
`/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean`, exact
`446df00f86d5d6d5d856a2e5deec0fac49f242fa`. No candidate or distribution edit was
made. The phase-4 distribution identity and matched phase-1/phase-3 payload are
unchanged by this work; **no new served-identity verification is claimed** because
no new server was started. Proposed origin `127.0.0.1:43225` was not opened,
allocated, or storage-qualified by this task.

No Browser Control operational command targeted any page. All retained pages
`quiet-falcon-568`, `clever-badger-501`, `calm-otter-581`, `gentle-otter-722`,
`amber-badger-702`, `lucky-walrus-901`, and `lucky-tiger-691` were untouched:
no reload, switch, close, or inspection. Pre-existing servers 43222/43223 were
untouched. No new kernel/server needed cleanup and no new runtime failure tree
exists. No runtime edits, pins, IRS/archive changes, deployments, pushes, model
calls, or promotion occurred.

## Gate and next recommendation

**Actual-service qualification remains incomplete.** The old switch 2 remains
unverified; the previous four install-only switches and OPFS passes were not
repeated. Newline framing remains a distinct expected-red unresolved gate.
OpenCode evidence remains server/config/plugin/model-catalog readiness, **not a
mounted usable chat client**. No production or switching-performance qualification
is claimed.

Fix and review the narrow PDF verifier gap first, then return for approval before
using one new fresh actual-service cohort with the unchanged predetermined budget
and served-identity requirements. Do not begin switching-performance work on the
strength of this held review; bounded reliability evidence is still owed, and
newline, Node/native-build, and baseline-contract gates remain separate.
