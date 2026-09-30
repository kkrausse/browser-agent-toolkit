# Final offline preparation: audit join and runnable serial pair

## Outcome

The single review blocker is fixed and the concrete driver is frozen. **No live
cohort, browser action, server, runtime build, model request or measured run was
started. No speedup claim.** Next review should focus only on the audit cleanup
join and driver exclusivity/orchestration, not re-qualify unchanged architecture.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-29-final-pair-driver-preparation.md`

## Audit correction

`examples/todo-app/tests/installed-tree-audit.ts` retains stdout, stderr and exit
promises, starts stop promptly on the first failure, and joins **stop + exit +
both drains** before returning/rethrowing. An unresolved sibling keeps ownership
and the audit promise pending; mandatory fallback cannot start in that state.
The regression drives the actual tool through `auditFence`: failed stdout starts
stop, delayed stderr blocks fallback, then delayed exit still blocks fallback.
Only after both releases does fallback begin. No verifier source changed.

## Exact prospective pair and ownership

`examples/todo-app/tests/matched-pair-driver.ts` is a runnable Bun CLI driver:

- Atomic repository-wide directory lock
  `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/matched-pair-initiator.lock`.
  A second process fails rather than stealing ownership; tokens are not the lock.
- One awaited initiation at a time across both origins. Page requests reject any
  pending sibling even with a different token. Long promises live in the page or
  retained Browser Control `state`; CLI v2 `execute --json --session ... --file ...`
  initiates once, then uses short read-only polls. Ambiguous commands are never
  retried or killed. No browser session reset/delete is used.
- Two cold startups, baseline first. Each startup verifies exact source and fresh
  hydrated/PDF completion; then service stop joins readiness, exit/output and
  requires zero processes/listeners/pending HTTP/fetch inflight/queued/active.
  The first stop completes before the second cold startup; the second also stops.
- Exactly one explicitly **non-measured generation-1 re-arm per origin**, serially,
  each verified with a new exclusive PDF token. Both services then remain live
  during the interleaved transitions; no extra between-switch re-arms are inserted.
- Five measured transitions each, generations 2–6. Frozen order:
  baseline/reuse, reuse/baseline, baseline/reuse, reuse/baseline, baseline/reuse.
  Every generation/action has its own armed, clicked-once, awaited PDF run. Source,
  hydration/document/token-specific PDF and switch checks use the unchanged verifier.
- First failure ends the entire plan: no retry, replacement origin, extension,
  further transition or re-arm. Only safe serial stop/zero-work cleanup may follow.
  Unresolved action/command or expired deadline prevents further browser commands;
  ownership, pages and lock are retained with **quiescence unproven**. On a failure
  the lock is conservatively retained even if subsequent cleanup succeeds.
  Successful final stops/zero-work checks release the lock, retaining pages/kernels.

Frozen budgets (milliseconds): listen **60000**, connect **45000**, HTTP/hydration
**60000**, whole services **90000**, switch observation **180000**, verifier read
**30000**, separate cleanup observation **10000**, per-step outer watchdog **300000**.
Expiry is not proof of settlement and never permits reset/re-arm. Startup
diagnostics have a separate 10s boundary and non-measured receipt. Initial audit,
installed-tree/cache validation and compatibility remain separate named client
samples, included in totals rather than subtracted to manufacture a speedup.

## Frozen identity and checks

New successful preparation, never overwriting existing evidence:

`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/reviewed-client-prep-2026-09-30T02-30-20-204Z/`

- Corrected consumer: **473383 bytes**, SHA-256
  `c51eb5b8afcc87a0c98ba7a2610d08816819337999b4002ced655db76f55bb93`.
- Driver: **12275 bytes**, SHA-256
  `f58094caec3d0e6a28d8d9a28de587b77ff95905550f365bf74ce81d94afc91d`.
- Byte-identical `b2b9c55` verifier: **5742 bytes**, SHA-256
  `d267e74b20bcf505082a70729723aa74776f58525261d9255c0ac1f6ad3cdf5b`.
- Clean detached runtime source **446df00f86d5d6d5d856a2e5deec0fac49f242fa**;
  unchanged runtime distribution
  **4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a**.
  No runtime rebuild/pin edits. All **13** non-client identities, **10528** payload
  checks (10526 managed file blobs plus original image/bundle), and **50** isolated
  packaged JS/declaration hashes verified. Libraries and actual consumer rebuilt
  separately; existing `dist` not used or modified.
- **106 tests pass, 0 fail, 569 assertions, 21 files**:
  `bun test workspace-api/tests examples/todo-app/tests opencode-chat/test/opencode-launch.test.ts`.
  Focused regressions cover drain/exit fallback exclusion, atomic global lock,
  pending-request exclusion, serial cold-stop gating, frozen order and first-failure
  termination. Four isolated TypeScript invocations passed (host, workspace, chat,
  actual consumer **plus driver and new regression tests**). `git diff --check` passes.
  `commands.log`, `tests.log`, `receipt.json` and `driver-policy.json` retain evidence.

## Invocation after focused review and explicit live authorization

From repository root, first launch the frozen server (not executed in this task):

```sh
MATCHED_CLIENT_PREPARATION="$PWD/.diagnostics/reviewed-client-prep-2026-09-30T02-30-20-204Z" \
MATCHED_EVIDENCE_DIRECTORY="$PWD/.diagnostics/final-pair-server-20260930" \
bun examples/todo-app/tests/matched-switch-live.ts
```

With two **fresh owned** Browser Control session IDs, run the driver once:

```sh
MATCHED_AUTHORIZE_PAIR=yes \
MATCHED_CLIENT_PREPARATION="$PWD/.diagnostics/reviewed-client-prep-2026-09-30T02-30-20-204Z" \
MATCHED_DRIVER_EVIDENCE="$PWD/.diagnostics/final-pair-driver-20260930" \
MATCHED_BASELINE_SESSION='<fresh-baseline-session>' \
MATCHED_REUSE_SESSION='<fresh-reuse-session>' \
bun examples/todo-app/tests/matched-pair-driver.ts
```

Both evidence paths must be new. Script-free inspection rejects populated origin
storage without clearing it. The launcher checks frozen consumer/assets; the
driver checks its own frozen hash, verifier/runtime identities and exact budgets.
No pushes, deployments, IRS/archive edits, existing-page/server cleanup, or broad
new qualification occurred. Earlier preparation attempts remain retained separately.
