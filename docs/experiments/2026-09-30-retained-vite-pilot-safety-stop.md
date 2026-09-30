# Retained-Vite pilot — stopped at the active-writer prerequisite

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-retained-vite-pilot-safety-stop.md`

## Decision and actual counts

**Do not initiate the measured pair with the current mutation/audit contract.**
This is a pre-run safety stop, not a failed workload or evidence that retained
Vite is intrinsically unsafe. Actual measured switches: **0 restart-both,
0 retained-Vite**. Cold startups, re-arms, browser commands, service launches,
model calls, and source switches: **0**. No retries or replacement cohorts.
The authorized ceiling remains five compatible switches per condition; none
was consumed and no live plan/preparation receipt was created.

Evidence absolute directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/retained-vite-safety-review-20260930/`

`inventory-before.json` records existing diagnostic directories before creating
review evidence. `review-identities.json` freezes the inspected files and verifies
the existing detached host source is clean at
`446df00f86d5d6d5d856a2e5deec0fac49f242fa`, with receipt distribution
`4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a`.
`tests.json` retains joined stdout/stderr/exit. Existing evidence directories,
pages, sessions, servers and frozen payloads were not modified. No runtime,
library, consumer or native build was performed: the blocker precedes preparation.

## Concrete missing proof

The reviewed implementation supplies these guarantees, and no stronger ones:

- `workspace-api/src/types.ts:98–123` supplies PID/PPID/command and aggregate
  listener/HTTP/fetch activity, **not filesystem writer/path attribution**.
  The frozen host's `packages/core/src/workers/kernel-worker.ts:2700–2721`
  enriches diagnostics with memory/modules/liveness, not a mutation ledger.
- The frozen `packages/kernel-host/fs-server.js:100–127,143–150` owns filesystem
  calls and client IDs and has internal persistence/watch machinery. It does not
  expose a supported host-side, PID-attributed complete write audit in the inspected
  diagnostic contract. Kernel syscall counters cannot stand in for filesystem
  observations: filesystem clients communicate directly with the FS worker.
- `examples/todo-app/tests/installed-tree-audit.ts:15–44` walks and hashes the
  managed tree and inventories cache paths. It is a **stopped-tree snapshot**,
  not an atomic snapshot or a complete history of writes while a reader runs.
  Its symlink/content/mode checks remain valuable; none was suppressed.
- `workspace-api/src/environment-experiment.ts:163–184,190–194` explicitly
  requires all previous readers stopped. Default replacement removes every
  non-kept workspace child, including configuration, then recreates incoming
  files, and removes `/.server`. Even incremental mode unconditionally removes
  `/.server`. Reusing this mutator with an active service violates its contract;
  delete/recreate of matching config is not matching-config preservation.
- `workspace-api/src/react.tsx:273–291` does have selective `stopService(name)`
  and aggregate shutdown joins. That is a useful building block, **not the
  blocker**. `performance-client.ts:194–206,254–257` correctly requires the old
  pair to exit/drain and observes an all-zero boundary. Replacing that assertion
  with a loose process count or accepting all zero in a retained-Vite branch
  would not prove the exact Vite PID survived.

There is consequently no established complete audit here authorizing the active
Vite PID/descendants/readers and exclusively its scoped cache writes throughout
source replacement. A path allowlist plus before/after hashes does not provide
that missing observation. Allowing arbitrary cache digest differences would also
remove an existing fence without a justified replacement. This review does not
claim that every conceivable example-only launcher instrumentation is impossible;
it declines to invent or assert its coverage as part of a timing pilot.

## Deterministic control and validation

Added one characterization in
`examples/todo-app/tests/installed-tree-audit.test.ts`: hash the approved tree,
write unauthorized dependency bytes, read those bytes as a consumer could, restore
the approved bytes, then hash again. **Both audits pass with the same checked
count and cache digest despite consumption of the unauthorized bytes.** This
executes the actual audit script against an isolated local fixture, not a mock
`valid:true`. It demonstrates snapshot history blindness, not a Vite exploit or
an observed live-runtime corruption. Existing stopped-tree usage remains valid.

Focused audit + serialized export + driver ownership tests: **27 pass, 0 fail,
130 assertions**. `git diff --check` passes. These are offline controls, not
qualification samples. No controller behavior was changed, so no selective
controller lifecycle is presented as tested. No timing/PDF/PID/HMR PASS receipt
was written without a run.

## Smallest controlled alternative and priority

Keep the already qualified **restart-both, retain dependencies/cache** switch as
the safe working condition. The smallest *new* prototype worth considering is a
separately authorized **single-edit ownership/mutation prerequisite**, not an A/B
cohort: one fresh isolated Vite-only fixture, no OpenCode/model/session reuse,
one exact source-file update using supported file APIs, no full-tree replacement,
no config rewrite, and unchanged dependency identities. Its subject must be
establishing a complete active-writer scope/inventory and exact PID ownership;
the current snapshots alone cannot certify it. If that evidence cannot be
obtained on frozen 446df00 without runtime changes, stop there as well. Do not
count such a reduced fixture as this pilot or claim deleted/renamed import/PDF
coverage from it. It is a proposed alternative, **not implemented or authorized
as an extra run by this report**.

There is **no actual retained-Vite benefit measurement** to report. Prior recovered
restart-both reuse medians remain 15.456 s client total, 7.509 s service wall,
5.899 s OpenCode readiness, and 5.783 s combined audits. Making Vite instantaneous
would leave restarted OpenCode on the concurrent critical path: roughly **1.6 s
service-wall headroom**, not the whole 7.5 s startup. This is an expectation from
the prior pair, not a guaranteed bound across changed scheduling/contention.

Retained Vite remains a potentially useful responsiveness experiment, but is **not
worth weakening this prerequisite**. Prioritize investigation of the ~5.8 s
audits and OpenCode startup before implementing a broader reuse architecture;
neither cost is automatically removable and integrity audits must stay included
and timed. Production usable-chat, native-build and newline compatibility remain
separate gates. No pins, IRS/archive edits, push, deployment or broad qualification.
