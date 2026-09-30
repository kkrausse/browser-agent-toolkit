# Counterbalanced mounted-controller lifecycle confirmation

Absolute report path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-opencode-counterbalanced-mounted-lifecycle.md`

## Prospective freeze

One fresh pair only: **reuse first on 43232, restart second on 43233**.
The exact first mounted pair was blocked restart-then-reuse, not the older phase9
interleaved baseline/dependencies experiment. Reverse only that blocked order.
Both origins retain A0 → B1 → A2 → B3 → A4 → B5; five transitions each,
ten maximum, no rearm, extra warmup, retry, replacement or extension.

Serve the already-built 1,926,835-byte client, SHA-256
`84615fa7f71952080e1afb5f47c0ee2fd3bea45341c9f57bd3cada89c402a461`.
Its inert per-page `policy.order` metadata still names restart/reuse; the external
initiator records actual reuse/restart order. No client/runtime/controller rebuild
or optimization. Runtime pin `446df00f86d5d6d5d856a2e5deec0fac49f242fa`,
server 2.0.3 hash `1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929`.
Recheck all 10,528 managed payload hashes and frozen delivery assets offline.

Same 150 s cold/transition enclosure, 20 s finite-call/drain, 60 s listen,
90 s connect, 150 s launch overall, 10 s EOF shutdown, 15 s healthy cleanup,
300 s origin observation watchdog. Same actual ChatController ready boundary,
qualification, proof workload, fresh empty session and persisted predecessors,
PID and config/plugin/source guards, raw response/codec capture and complete
chunk export. Cold delivery/startup/proof/cleanup remain separate measurements.

Same exclusive `.diagnostics/matched-pair-initiator.lock`, serial Bun-backed
Browser Control CLI only, short status polls with joined CLI drains/exits.
First failed/cancelled/timed-out/unresolved condition stops the pair before
starting the other origin; retain failed ownership, no eviction or replacement.
Second origin starts only after first is passed, zero guest work/healthy joined
exit is proven, and complete export has codec parity. No model/tool/external
client/PTY/execution calls. Do not infer remote zero-ref receipts.

Inventory showed 43232/43233 unused. Preserve every older page/host, especially
43222–43227 and first-pair 43230/PID43010, 43231/PID44514. New evidence pages and
host servers remain retained; only healthy owned guest services are stopped.
The confirmation goal is direction, not population confidence or further profiling.
