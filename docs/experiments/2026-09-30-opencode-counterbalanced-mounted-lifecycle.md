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

## Outcome: direction reproduced with reversed order

**All ten measured transitions passed. Reuse 9.651 s median versus restart
22.971 s: 13.320 s lower, 57.99% shorter (ratio 0.420).** The earlier pair
observed 8.425 s versus 22.316 s, 62.25% shorter. Reuse remained faster when
it ran first and restart ran second; the direction is not explained simply by
the later condition always benefiting from warming.

| Transition | First restart (s) | First reuse (s) | Confirmation reuse first (s) | Confirmation restart second (s) |
| --- | ---: | ---: | ---: | ---: |
| A0 → B1 | 28.131 | 8.277 | 9.843 | 22.971 |
| B1 → A2 | 23.468 | 8.425 | 9.522 | 20.746 |
| A2 → B3 | 22.316 | 8.448 | 9.651 | 21.876 |
| B3 → A4 | 20.957 | 8.702 | 9.417 | 23.418 |
| A4 → B5 | 17.992 | 8.402 | 11.444 | 28.761 |

Descriptive pooling only: **ten transitions per condition across two origins
each** gives restart **17.992 / 22.644 / 28.761 s**, reuse
**8.277 / 9.060 / 11.444 s** (min / median / max). The pooled median difference
is 13.584 s, 59.99% shorter, ratio 0.400. Even-sized pooled medians average the
two middle values. Do not treat twenty serial transitions as twenty independent
origins. These are two opposite-order blocks, not randomized replicated cohorts.
There is no population confidence interval, production guarantee or causal
percentage estimate. Both observed pooled ranges remain nonoverlapping.

First-pair restart declined throughout; confirmation restart fell once then rose
to its slowest final transition. Confirmation reuse was also slower than the
first pair and ended with its slowest transition. Host/browser/JIT/cache/load
effects remain material; there is no universal monotonic warming pattern.
Confidence in the direction for this restricted workload is improved; confidence
in general magnitude remains low. No more live profiling runs are authorized.

### Confirmation stage distributions

All figures are min / median / max seconds, five measured transitions each.
Nested stages overlap; medians need not sum. Ready ends at the unchanged actual
ChatController ready promise; independent proof remains outside the metric.

| Stage | Restart second | Reuse first |
| --- | ---: | ---: |
| Whole transition → ready | 20.746 / 22.971 / 28.761 | 9.417 / 9.651 / 11.444 |
| Freeze/join finite | 0.000070 / 0.000075 / 0.000135 | 0.000035 / 0.000055 / 0.000120 |
| Local dispose/SSE cancellation | 0.000545 / 0.001075 / 0.003040 | 0.000620 / 0.001055 / 0.008010 |
| Stop/drain/zero-work proof | 0.070 / 0.103 / 0.238 | — |
| DELETE complete | — | 0.016 / 0.031 / 0.054 |
| Source/config write/flush | 0.010 / 0.012 / 0.035 | 0.009 / 0.015 / 0.046 |
| Owned service launch incl. qualification | 17.316 / 18.637 / 24.234 | — |
| Qualification health | 4.262 / 4.392 / 5.938 | 0.003 / 0.005 / 0.009 |
| Qualification activation | 6.178 / 6.651 / 8.562 | 5.835 / 5.967 / 6.654 |
| Qualification plugins | 0.009 / 0.012 / 0.013 | 0.004 / 0.005 / 0.006 |
| Qualification config | 0.006 / 0.008 / 0.010 | 0.003 / 0.005 / 0.006 |
| Qualification project | 0.005 / 0.008 / 0.021 | 0.002 / 0.004 / 0.008 |
| Qualification catalog | 0.263 / 0.284 / 0.384 | 0.243 / 0.289 / 0.367 |
| Reuse qualification total | — | 6.172 / 6.277 / 7.038 |
| Actual controller.ready | 3.307 / 3.737 / 4.532 | 3.106 / 3.305 / 4.326 |
| Controller bootstrap | 0.873 / 1.188 / 1.408 | 0.786 / 0.897 / 1.181 |
| Session create, fully consumed | 1.223 / 1.452 / 1.832 | 1.268 / 1.361 / 1.822 |
| Controller hydration | 1.074 / 1.211 / 1.489 | 0.973 / 1.056 / 1.322 |
| Independent proof, excluded | 0.258 / 0.347 / 0.396 | 0.245 / 0.268 / 0.318 |

Separate confirmation cold→ready: **15.854 s reuse first, 15.337 s restart
second**; delivery 1.620 / 1.699 s, initial proof 0.286 / 0.265 s, healthy
guest cleanup 0.028 / 0.071 s respectively. Earlier cold restart/reuse was
19.644 / 12.896 s. These are not workspace SLA or transition samples.

Activation still dominates reuse: 5.967 s median (~62% of 9.651 s), versus
5.209 s in the first pair. Pooled activation min / median / max is
5.175 / 5.690 / 6.654 s reuse, 5.354 / 6.532 / 8.562 s restart. This identifies
an expensive external stage, not its internal CPU/plugin cause. No controller
bootstrap overlap, feature removal, plugin change or runtime optimization occurred.

**Recommendation:** product-integration design is now warranted, specifically
remote admission/drain for cancelled and concurrent readers, cancellation joins,
verified remote lease/ref release, and failure-stop/eviction ownership. Prioritize
that prerequisite design over more plugin-activation profiling. Do not enable
general production reuse yet. Existing zero-ref reasoning only covers the reviewed
exclusive normally consumed finite handlers; no remote receipt or execution/tool
compatibility is claimed. Activation profiling can later improve the residual,
but is not needed to establish this restricted latency opportunity.

## Evidence, counts and ownership

Private evidence absolute directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/opencode-counterbalanced-lifecycle-2026-09-30-confirmation/`

Prospective driver/report commit **c8deba5** preceded either fresh navigation.
Focused tests: **64 passed, 0 failed, 385 assertions**; targeted strict TypeScript
checks passed. The served client is the first-pair frozen artifact, not a rebuild.
Offline preparation rechecked the clean pinned source, all frozen runtime assets,
the prepared manifest and **10,528 payload hashes**. No implicit vendor build.

| Confirmation count/proof | Restart | Reuse |
| --- | ---: | ---: |
| Fresh origins / cold launches | 1 / 1 | 1 / 1 |
| Measured transitions / rearms | 5 / 0 | 5 / 0 |
| Owned guest process launches / joined clean shutdowns | 6 / 6 | 1 / 1 |
| Accepted normal finite responses | 95 | 100 |
| Global SSE HTTP 200 / joined controller disposals | 6 / 6 | 6 / 6 |
| Session creates / persisted predecessors at final generation | 6 / 5 | 6 / 5 |
| Administrative DELETE | 0 | 5 × empty 204 |
| Failed/cancelled/timed-out/unresolved finite requests | 0 each | 0 each |
| Retries/replacements/extensions/model/tool/execution calls | 0 each | 0 each |
| Guest PID sequence | 1,2,3,4,5,6 | 1,1,1,1,1,1 |
| Raw finite response bytes | 145,504 | 145,504 |
| Complete chunk export | 14; 858,555 bytes | 13; 843,965 bytes |
| Final guest processes/listeners/pending HTTP | 0 / 0 / 0 | 0 / 0 / 0 |
| Final guest exitCode/signal/forced | 0 / null / false | 0 / null / false |

All twelve confirmation roots are distinct, incoming histories empty and idle,
properly configured fresh `/workspace` roots; all five predecessors persist.
Per-generation proofs have one service/listener and zero pending HTTP; outgoing
fences have zero unresolved calls and awaited local disposal. Immutable plugins,
matching project and A0/B1/A2/B3/A4/B5 source/config markers all passed.
Postflight verifies both condition workloads, identities and codec parity. Offline
cross-pair comparison also proves identical config/dependencies/plugins/runtime/
location and normalized nonadministrative routes for every generation, **24 unique
roots**, **390 complete finite raw responses** across both pairs. Each pair has
195/195 exact pinned HttpApi decode/encode status/header/body parity, with complete
base64 bytes, lengths and SHA-256. No incomplete export or fabricated raw result.

Browser Control 0.8.2 Bun CLI was the sole owner; no MCP/raw CDP, external guest
client, relay restart, reload or replacement. Confirmation sessions:
`quiet-otter-207` at `http://127.0.0.1:43232/?condition=reuse`,
`gentle-raven-464` at `http://127.0.0.1:43233/?condition=restart`.
All **47 numbered execute commands** (empty-origin inspections, navigations,
short status polls and exports), plus two fresh-session executes, succeeded.
No browser action failed or was retried. CLI stdout/stderr/exit drains were joined.

### Post-completion host-retention defect (one orchestration timeout)

`completion.json` was written at **2026-09-30T05:46:58.284Z**, after both accepted
conditions, complete codec verification, zero-work healthy guest cleanup and final
inventory. The exclusive lock was released. However the Bun initiator retained
referenced host children; it did not exit after successful completion. The outer
shell reached its **900 s timeout afterward** and stopped the two new host servers,
43232/PID51892 and 43233/PID52519. Thus there was **one post-completion orchestration
timeout**, not zero total harness failures. It is outside all cold/transition/
request/cleanup budgets; do not call the overall host-retention protocol flawless.

Both new evidence pages remain intact; both new host listeners are now absent.
No restart/replacement/retry was attempted. All **19 preexisting browser targets**
and their exact ownership/URLs, plus every prior retained host listener line/PID
(43222–43227, 43230/43010 and 43231/44514), are unchanged after the timeout.
Guest completion/exports predate the timeout and remain valid, but new host
retention deviated from the prospective plan. A minimal offline driver correction
unrefs retained hosts so the initiator can exit; it was not applied to the frozen
client or measured live run, and no additional live pair was run to test it.
Post-correction focused tests: **65 passed, 0 failed, 388 assertions**, including
unref-without-kill/replacement regression; targeted strict TypeScript checks passed.

Evidence includes `plan.json`, frozen `receipt.json`, all CLI request/results,
before/after/post-wrapper inventories, per-condition acceptance/chunk manifests,
`live-*.json`, codec receipts, `summary.json`, `combined-summary.json`,
`completion.json`, and `retention-post-wrapper.json`. Private raw content stays
uncommitted. Runtime/pins/IRS/archives remain unchanged; no push, deployment or
model inference. This is the single authorized confirmation, now complete.
