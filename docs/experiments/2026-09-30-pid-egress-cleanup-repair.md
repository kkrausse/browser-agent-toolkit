# PID-owned egress cleanup repair — offline candidate

## Outcome

Public process exit/stop now joins PID-owned kernel fetch work instead of treating
worker death or abort notification as a cleanup receipt. Toolkit runtime stop
retains cleanup failures even after an execution leaves its live registry.
This is offline repair evidence, **not browser qualification**.

Repair source commits (not pushed):

- Runtime: `33fa1359a003ca9c50cb3bc49699b99bc1a063f1`.
- Toolkit: `d0eec346dbc749db1c0cd82dd8aad0b27c1da363`.

Fetch admission closes at native PID death. Queued/shared requests are cancelled
only when their last live owner exits. Public exit waits for tracked backend,
body-write, rollback and publication continuations. Native fetch/body consumption
receives abort, but abort-ignoring work must still settle; remap siblings are
joined with `Promise.allSettled`. SDK `Execution.exited` carries optional
`cleanupError`; `Execution.stop()` rejects with `CLEANUP_FAILED`. Failed toolkit
`Runtime.stop()` retains workspace attachment rather than reporting detachment.

## Counterfactual and regression evidence

Historical controlled proof returned stop with no processes but fetch active=1
and queued=1. The queued request subsequently dispatched, producing two late VFS
writes and two late pins. The new process cleanup regression fails against that
old kernel on the early-stop assertion, while passing against repaired source and
the actual built SDK.

Passing focused coverage includes held abort-ignoring backend work, dead queued
owners, duplicate SDK stop, exited-child pending joins, shared active/queued
owners, cache reader pins, joined/failed VFS rollback, native signal propagation,
ignored-abort body joins, remap sibling joins and no aborted fallback.

The built-SDK endpoint cleanup checks pass. Toolkit endpoint/execution/service
checks report **26 pass, 0 fail, 98 expect calls**. Separate library declarations,
the full-off consumer bundle and consumer typecheck also pass.

Final checks against the isolated committed runtime source:

- `node scripts/test-single-kernel-review.mjs`: PASS.
- `node scripts/test-single-kernel.mjs`: PASS.
- `node scripts/verify-node.mjs`: PASS.
- Selected `verify-runtime-contracts.mjs` contracts: PASS (`vm-import`,
  `fs-remove`, `fs-native-realpath`, `fs-permissions`, `package-self`,
  `net-backpressure`, `stream-consumers`, `node-entry`).
- Full contract invocation: FAIL at `worker-uncloneable`,
  `TypeError: markAsUncloneable is not a function`. This is the previously
  documented baseline gap, not a green full-contract claim; later contracts were
  not reached by that invocation.

Read-only egress-section comparison found identical historical sections at
`e998de62a10e5382104b51e0b860ee9d4d7a2401` and `e35eab4`.

## Candidate and provenance

Stage root (temporary local evidence; archive before removing):

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/kernel-egress-repair-3GsF7d`

Candidate directory is `<stage root>/candidate/`; version:
`3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.

`candidate-receipt.json` records source revisions, archive digests and output
hashes. Runtime/SDK workers and toolkit libraries were built from isolated
committed-source archives, with libraries and consumer built separately. Installed
dependencies were reused via symlinks. No canonical pins, shared emitted outputs
or frozen historical candidates were replaced.

Native compilation was **not rerun**. Native artifacts were reused after tracked
native inputs matched baseline `446df00f86d5d6d5d856a2e5deec0fac49f242fa` and
Wasm hashes matched `vivari-single-kernel/docs/single-kernel-build.md`. Final
verification checked every recorded candidate hash and every reused native file
against the original clean provenance checkout:
`/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean`.
That checkout remained clean. The native output manifest lives in
`toolkit-source/vivari/.runtime/patched-build.json` under the stage root.

Evidence files under the stage root:

- `command-10.json`: built SDK endpoint cleanup.
- `command-11.json`: historical late-dispatch/write/pin proof.
- `command-12.json`: expected old-kernel regression failure.
- `command-17.json`: toolkit suite.
- `comparison.json`: historical/repaired egress-section hashes.
- `final-provenance.json`: final candidate/native hash verification.
- `final-test-single-kernel-review.json`, `final-test-single-kernel.json`,
  `final-verify-node.json`: final passing headless checks.
- `final-selected-contracts.json`, `final-verify-runtime-contracts.json`:
  selected passes and full-run failure respectively.
- `stage.ts`, `consumer.ts`: completed isolated build pipelines. Do not blindly
  rerun them in this populated stage; archive directories already exist.

## Qualification boundary / next action

Receipt remains `liveQualification: false`. No real browser worker census,
persistence/reload, HTTP stream-credit or actual browser egress-stop cohort has
qualified this candidate. Use a fresh isolated origin and matching candidate
assets for that next step; preserve existing failed cohorts and ownership locks.
An abort-ignoring backend that never settles can keep stop pending indefinitely;
the repair does not manufacture a successful cleanup receipt from a timeout.

This report is separate from the already-staged endpoint-owner browser QA
preparation document, which was preserved and excluded from this report commit.
