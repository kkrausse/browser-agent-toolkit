# Phase-4 Browser Control interruption review

## Outcome

**The evidence supports a 60-second debugger-command timeout, not a destroyed
host document.** A narrow, separately prepared harness avoids awaiting a long
switch promise over CDP. It passes disposable browser regressions. No runtime
change or reset/service qualification cohort ran. The old second switch remains
**unverified** (one qualified pass from two attempts).

## Causal evidence

Browser Control **0.8.2**, relay build `2026-09-20T05:32:28.650Z`, extension
**0.0.25**, Bun **1.4.0**; no relay restart or extension change.

- Original journal line 6 lasts **60,074 ms**. Its receipt has generation-2
  pre-switch verification only; generation-3 `preview.ready`, `switch.flush`,
  and `switch.total` completion samples are absent. The error therefore occurred
  while awaiting `page.evaluate(switchWorkspace())`, before the second verifier,
  rather than being established as a post-switch `verifySource()` error.
- The existing final observation subsequently records generation-3
  `preview.ready = 49,159.57 ms`, **`switch.total = 60,258.15 ms`**, flush complete,
  exact 26-file source verification, and no API error. The operation outlasted
  the driver deadline and continued in the original page.
- Installed `dist/cli.js:3590–3603` defaults `debugger.sendCommand` to **60,000 ms**
  and rejects it when the deadline expires. No original raw CDP trace exists;
  the precise downstream error-rewriting site was not traced.
- Disposable same-origin iframe navigation with a 1-second host evaluation
  succeeds. `about:blank` then same-origin navigation also succeeds; both observed
  navigation events belong to the child, not the main frame.
- A 65-second host evaluation fails at **60,005 ms** with the exact original
  `page.evaluate: Execution context was destroyed, most likely because of a
  navigation.` The page operation completes after the driver rejects it.
- The decisive control removes **all navigation**: the same 65-second evaluation
  fails identically at **60,006 ms**, navigation events empty, URL unchanged,
  and the original page's completion marker becomes true. Iframe navigation is
  not necessary to produce this misleading error.

This is grounded timeout attribution, not a claim that all execution-context
errors are timeouts. The first raw CDP subscription returned no events and is
not used as evidence of absence; Playwright frame events supplied the navigation
observations. No retained page needed another execute.

## Harness correction and tests

New files in `examples/todo-app/tests/`:

- `reset-verifier.js`: issue a unique switch token once, return immediately,
  retain its settled/failed status in the host page, and poll short reads under
  one absolute deadline. Never replay the switch on an ambiguous initiation
  failure. Require completed token, API readiness, and **expected-generation**
  hydration (or explicitly install-only mode). Lost host state is terminal.
- `reset-evidence-v2.js`: separate stage labels; exact source-generation checks,
  hydrated enabled input, nonzero PDF workload; preserve the original failure
  even if diagnostic collection fails. No deletion/runtime/action retry.
- `prepare-reset-verifier.ts`: bundle that helper with the Browser Control
  execute body, exclusive-write a fresh output. Existing recipes remain intact.
- `reset-verifier.test.ts`: **7 tests / 25 assertions pass**. Covers bounded
  transient context reads, stale readiness, absolute deadlines, terminal runtime,
  protected-UI/closed-target/ordinary timeout messages, and no initiation replay.
  `bunx --bun tsc --noEmit` also passes in `examples/todo-app`.

Browser evidence on disposable session `tidy-walrus-255`, origin
`http://127.0.0.1:59673`:

- Corrected initiation returns in **5 ms**; a 65-second page operation completes
  and verifies in **65,306 ms**, exactly one initiation/completion, generation 5
  hydration and nonzero workload marker. No context-read recovery was needed.
- Live stale generation 2 vs expected 3 times out rather than passing on
  `ready:true`. Live API `ENOTEMPTY` and failed operation token each fail on their
  **first read**.
- The actual bundled v2 execute body passes the small DOM fixture from generation
  1 to 2. Its source/PDF APIs are stand-ins: **not real 26-file/PDF/runtime proof**.
- One fixture-only setup attempt failed on an undefined bundle name before any
  switch; CommonJS wrapping corrected that setup. Journal retains the error.

The final post-read deadline guard and host-URL pass guard were added after the
live checks; focused tests/typecheck and final bundle preparation pass. No second
long live run was added for those fail-closed guards.

Read recovery matches only the exact page-evaluate context-destroyed message,
with at most three such reads inside the same deadline; it is not a general
retry policy. Its transient branch is unit-tested, not live-induced. Browser
Control's misleading diagnostic remains unfixed upstream. A protected boundary
reported with an indistinguishable generic context message remains a driver
diagnostic limitation; these fixtures contain no protected UI.

## Evidence and cleanup

Distinct ignored evidence/recipes, absolute:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase4-browser-interruption-20260929/`.
Includes short/blank/long/no-navigation receipts, `long-fixed.json`,
`live-negative.json`, v2 receipt, original timing summary, disposable journal,
server and build recipes. Ignored evidence does not travel with the commit.

Only owned disposable session/page and server PID **74810** were closed.
Servers **43222/43223**, all six retained failure pages and `lucky-tiger-691`,
isolated runtime candidate, production pins, IRS/archives remain untouched.
No resets, model calls, deployments, pushes, or service cohort retries occurred.

## Exact next qualification proposal — not executed

After reviewing this fix, authorize **one new fresh actual-service cohort**, not
resumption of the old cohort: startup plus **at most 12 A/B switches**, stop at
the first runtime, verifier, action, or deadline failure; no replacement cohort.
Use `127.0.0.1:43225` only after confirming it is free and has no reused fixture
storage, otherwise choose a separately inventoried fresh origin. Continue exact
isolated **446df00f86d5d6d5d856a2e5deec0fac49f242fa** distribution/payload receipts
and re-verify served identities before startup. Do not update production pins.

Prepare a new v2 body with `bun examples/todo-app/tests/prepare-reset-verifier.ts
<fresh-private-output.js>`; set fresh `resetEvidenceOrigin`, absolute
`resetEvidenceDirectory`, initial/switch action, and a distinct token for every
switch. Use the Bun-backed CLI, retain its journal plus stage receipts and frame
navigation events. Switch-observation deadline **120 seconds**; generation
hydration/PDF checks **30 seconds** each; outer call watchdog **240 seconds**
after startup (never extend it). No retry of switch/delete/install/PDF click.

Each counted pass still owes exact 26-file bytes, outgoing filename absence,
incremented source generation, matching hydrated preview, enabled input, and a
new nonzero PDF workload, plus joined shutdown/drain evidence. Readiness alone
never counts. This prospective cohort cannot retroactively qualify switch 2.
Node/native-build, baseline-contract and newline framing gates remain separate;
even a green cohort does not authorize unrestricted deletion or production use.
