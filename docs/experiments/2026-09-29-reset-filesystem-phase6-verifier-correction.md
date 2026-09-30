# Fresh PDF verifier correction — 2026-09-29

## Outcome and gate

**Correction and offline regression pass; browser qualification is HOLD.**
The required independent review could not be spawned: the harness returned
`Subagent depth limit reached (1)`. No independent review success is claimed.
The conditional authorization therefore did not unlock browser runs.

Exact new runtime counts: **0 startup attempts, 0 A/B switch attempts,
0 qualified service passes**. No replacement cohort, action/runtime/deletion
retry, browser operational command, or budget extension occurred. This is a
zero-run verifier correction, **not actual-service qualification**.

## Narrow correction

Changed only `examples/todo-app/tests/reset-verifier.js`, its declaration,
`reset-evidence-v2.js`, and focused regression tests:

- Before the single PDF click, arm a unique run against the exact hydrated
  generation, preview document and button; remove the previous `data-bytes`.
- Keep a host-side pending-run record and button token. Require fresh positive
  finite bytes on that exact document/button/token with matching generation
  hydration and enabled input. The unchanged matched fixture writes bytes only
  after `await runPdfWorkload()` finishes. Record the completed token, generation
  and variable byte length in the receipt; no fixed PDF size assertion.
- Pending runs block another arm; timeouts leave them pending. Lost run/document,
  changed marker, API errors and host URL changes fail closed. Observation uses
  the existing absolute-deadline bounded read policy, never click/action retries.

The token identifies the harness-owned run, not an embedded PDF-content marker.
This assumes the unchanged fixture's sole workload initiator is the verifier on
the proposed fresh owned page. An arbitrary externally initiated older async
job cannot be attributed by this fixture's bytes-only DOM API. Independent
review must assess that scope before qualifying the fresh cohort; no broader
concurrency or exact PDF-content proof is claimed.

## Checks

- `bun test tests/reset-verifier.test.ts`: **13 pass, 0 fail, 45 assertions**.
- `bunx --bun tsc --noEmit` in `examples/todo-app`: **exit 0** after adding the
  helper declarations. The initial typecheck exposed missing declarations and
  was corrected before the final checks.
- `git diff --check`: **exit 0**.

The actual v2 execute body is run offline twice: old `875` bytes plus one click
and **zero new completed jobs** now produces `FAILED / pdf.read`; a newly
completed variable-length job produces `PASS / completed`. These are synthetic
DOM/source stand-ins, not real PDF/runtime/source qualification. Additional
regressions cover pending-run timeout/no re-arm, fresh lengths 874/876/1001,
stale-generation hydration, terminal runtime error, lost run/marker, and URL
change. Existing absolute timeout, initiation non-replay and switch tests remain.

## Inventory and preservation

Inventoried `.diagnostics` before creating a distinct ignored evidence directory:

`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase6-pdf-verifier-correction-20260929/`

Final test/typecheck logs are retained there. No old private recipe, receipt,
distribution or payload was overwritten; ignored logs do not travel with commit.
The existing clean candidate worktree remains clean at
`/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean`.
The proposed clean `446df00f86d5d6d5d856a2e5deec0fac49f242fa` runtime and phase-4
distribution/matched payload were not modified or served anew. No new delivered
identity, manifest, source/binary, deletion, hydration, server/config/catalog,
drain or process/listener proof is claimed.

All retained pages `quiet-falcon-568`, `clever-badger-501`, `calm-otter-581`,
`gentle-otter-722`, `amber-badger-702`, `lucky-walrus-901`, `lucky-tiger-691`
and servers 43222/43223 were untouched. No new browser/kernel/server resources
were created or cleaned up. No runtime, production-pin, IRS/archive edits,
push, deployment or model requests occurred.

## Next recommendation

Have the parent session obtain an **independent review of this correction**
before any browser startup. If it passes, use only the conditionally authorized
one fresh cohort: startup plus at most 12 service A/B switches; first failure
stops, no replacement/extension/retries. Re-verify the phase-4 served identities
and correct manifest runtime identity before startup, and collect each exact
generation's source/binary, outgoing absence, hydration and newly completed PDF
plus joined shutdown/process diagnostics. No-service/OPFS evidence need not repeat.

Newline framing remains **separate expected-red**, old switch 2 remains
unverified, OpenCode remains **chat-not-mounted**, and this candidate remains
**speed-not-qualified**. Node/native-build and baseline-contract gates remain
separate. Do not infer production or performance qualification from these checks.
