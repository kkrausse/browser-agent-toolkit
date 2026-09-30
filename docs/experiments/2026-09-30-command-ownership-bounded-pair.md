# Command ownership fix and one bounded live pair

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-command-ownership-bounded-pair.md`

## Narrow fix and deterministic validation

Fix commit: `913b8b9`. The actual CLI command implementation now joins stdout,
stderr and exit with `Promise.allSettled`. Pending ownership cannot clear while
any sibling remains unresolved. A rejected drain or exit observation permanently
retains command ownership, forbidding even cleanup commands after sibling join.
The failure path retains the atomic global lock; no reset/rearm is permitted.

Two deterministic regressions exercise the same exported command implementation
used for cold navigation, where no page action ownership exists. They inject a
stdout rejection or exit rejection, delay both remaining observations, prove
that the pair and cleanup cannot proceed, reject stop/rearm/new commands, then
release siblings and prove that ambiguous ownership and the lock remain held.

Validation: **108 tests pass, 0 fail, 597 assertions, 21 files**; focused driver
suite **7 pass, 0 fail, 58 assertions**. All four isolated typechecks (host,
workspace, chat, consumer including driver/tests) and `git diff --check` pass.
An initial test invocation used inherited restrictive umask and failed the
existing executable-mode expectation; rerunning with `umask 022` passed. The
first draft of the new tests called Bun's rejection assertion before releasing
their fixture, causing test timeouts; deferred rejection capture corrected the
test fixture. Neither attempt initiated browser work.

## Frozen live invocation

Only the driver identity changed: **13009 bytes**, SHA-256
`03d174cb92b61f27c9c72a0110c38dbe2f19531f24637fb31d479b61bd828322`.
The unchanged consumer is **473383 bytes**, SHA-256
`c51eb5b8afcc87a0c98ba7a2610d08816819337999b4002ced655db76f55bb93`.
No consumer/runtime rebuild. Clean detached runtime `446df00f86d5d6d5d856a2e5deec0fac49f242fa`,
distribution `4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a`.
Original artifact/payload identities and unchanged serial verifier are preserved;
the launcher checks artifact and client bytes before serving them.

Distinct evidence paths under the repository's `.diagnostics/`:

- `ownership-fixed-pair-prep-20260930/`: new receipt, unchanged consumer link and verifier copy.
- `ownership-fixed-pair-server-20260930/`: new server/client receipt evidence.
- `ownership-fixed-pair-driver-20260930/`: every CLI script/result, plan and terminal receipts.

Fresh sessions: baseline `rapid-raven-347`, reuse `cosmic-panda-884`.
Fresh origins: ports **43228/43229**. Existing pages and servers **43222/43223**
are not touched. Sole browser initiator: Bun-backed Browser Control CLI driver,
with `.diagnostics/matched-pair-initiator.lock` held atomically.

Frozen plan: two serial cold startups, each stopped/drained/zero-work before the
next stage; two explicitly non-measured same-generation re-arms; ten interleaved
measured switches, five per condition. First failure stops the entire pair:
no retry, replacement, budget extension or extra re-arm.

Budgets unchanged (ms): listen 60000, connect 45000, HTTP/hydration 60000,
services 90000, switch observation 180000, verifier reads 30000, cleanup 10000,
outer watchdog 300000. These are the actual frozen `prospectivePolicy` values.
Validation audits remain named samples included in total time, not subtracted.

## Live outcome

**Terminal execution PASS: 16/16 planned steps, including 10/10 measured
switches (5 baseline, 5 reuse).** Two cold startups, two cold stop boundaries,
and two non-measured generation-1 re-arms passed. No failure, retry, replacement,
extra transition or extension occurred. Driver PID **29499** exited at
**2026-09-30T02:46:04.845146Z**, observed using a macOS process-exit event, not
another browser command. Background shell ID: `sh_0f02e7e56001VFSxCQoii4Tt77`;
its completion notification had no stderr/output.

Exactly **735** CLI commands completed with **0 command failures**. Each origin
has **7** retained source completions, **27 files** each (cold, re-arm, generations
2–6), and **7** distinct token-specific hydrated PDF completions. The unchanged
verifier checked the reviewed generation/document/PDF contract; binary and
outgoing/deleted/renamed source checks were not relaxed. Measured PDF lengths:
baseline **876, 876, 875, 875, 876 bytes**; reuse identical. Cold PDFs: baseline
874, reuse 876; re-arm PDFs: baseline 876, reuse 875. No stale PDF substitutes.

Final stops completed serially. Receipts `0731.json` and `0735.json` prove both
origins have **0 processes, 0 listeners, 0 pending HTTP, 0 fetch inflight/queued/
active**. The driver released its global lock only afterward. The owned static
server PID **29375** was then sent SIGTERM and its exit joined at
**02:48:40.960250Z**; `ownership-fixed-pair-server-20260930/cleanup.json` records it.
No browser/session reset, page deletion, workspace close, or additional browser
read was issued. Pages/kernels remain retained. Listener inspection confirms old
servers **43222/43223** remain and owned **43228/43229** listeners are gone.

Offline aggregation is retained at the absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/ownership-fixed-pair-driver-20260930/terminal-summary.json`.

## Timing evidence and limitation

**Nine** large sample/event snapshots returned Browser Control
`valueUnavailable: true` despite `ok: true`, with textual arrays truncated after
50 items. This is an **evidence-export limitation**, not a switch-verifier failure.
Only **2/5 exact client switch totals per condition** survive in those snapshots.
All ten initiation-to-verified-PDF intervals can be reconstructed from retained
command-file/result timestamps; these include CLI overhead, source/PDF checks
and polling, and **are not `switch.total` or a replacement for missing stages**.
No recovery browser read or new cohort was initiated.

All values below are milliseconds, rounded to 3 decimals; full retained precision
is in the summary and original receipts.

| Generation | Baseline client total | Reuse client total | Baseline driver→verified PDF | Reuse driver→verified PDF |
|---|---:|---:|---:|---:|
| 2 | 14330.370 | 15514.775 | 17877.969 | 19071.197 |
| 3 | 32153.215 | 15455.835 | 35559.546 | 18934.163 |
| 4 | unavailable | unavailable | 35384.888 | 19218.384 |
| 5 | unavailable | unavailable | 37359.748 | 18718.043 |
| 6 | unavailable | unavailable | 38904.877 | 20043.974 |

Driver-inclusive median: baseline **35559.546**, reuse **19071.197**. Mean:
baseline **33017.406**, reuse **19197.152**. This bounded run shows shorter
observed reuse completion intervals after generation 2; it does **not** establish
a fully accounted client-stage speedup, statistical confidence, or production SLA.

| Cold/non-measured stage | Baseline | Reuse |
|---|---:|---:|
| startup.total | 28862.850 | 50588.810 |
| source.install | 30.025 | 26.070 |
| environment.deliver | 1700.550 | 1791.815 |
| environment.flush | 288.080 | 428.530 |
| validation.initial | 6970.085 | 13394.080 |
| preview.ready (HTTP + interactive) | 19463.940 | 34443.720 |
| chat.healthy (server/catalog, not usable chat) | 7429.380 | 15871.135 |
| cold OpenCode model catalog request | 17 | 455 |
| rearm.services.wall (non-measured) | 7550.140 | 7565.445 |

Both cold initial audits were valid and checked **12305** managed entries.
The two measured reuse audits are kept **separate and included in totals**:

| Measured stage | Baseline G2 | Reuse G2 | Baseline G3 | Reuse G3 |
|---|---:|---:|---:|---:|
| runtime.stop sample | 23.590 | 29.105 | 37.150 | 19.320 |
| source.install / source.replace | 6.660 | 80.855 | 11.925 | 82.005 |
| dependency environment.deliver | 1446.120 | no delivery sample | 1568.665 | no delivery sample |
| environment.flush | 157.695 | 0.875 | 291.670 | 0.715 |
| validation.compatibility | not applicable | 1.665 | not applicable | 0.650 |
| validation.before-retain (tree/cache) | not applicable | 2928.660 | not applicable | 2882.920 |
| validation.after-replacement (tree/cache) | not applicable | 2912.330 | not applicable | 2882.790 |
| preview.ready (HTTP + interactive) | 9361.920 | 7499.185 | 25230.195 | 7535.525 |
| chat.healthy (includes catalog) | 6275.175 | 5998.950 | 15112.875 | 5899.325 |
| services.wall | 9366.105 | 7503.950 | 25237.835 | 7539.975 |

Baseline G2 model-catalog request: **96 ms**; subsequent separate catalog timings
are unavailable in truncated event exports. No independent cache-only duration
or HTTP-only preview sample exists: cache validation is inside named audit samples,
and preview HTTP/hydration are combined in `preview.ready`. These are not invented
or subtracted. G4–G6 stage breakdowns remain unavailable. Shutdown exit/output
join and zero-work verification succeeded, but the `runtime.stop` sample alone is
not asserted to measure the entire diagnostic shutdown boundary.

## Recommendation and boundaries

Keep the narrow ownership fix. The authorized bounded correctness comparison is
complete and successful; the observed completion intervals support continued
interest in dependency reuse. **Do not claim complete stage-accounted speedup**
from this export. A future change, separately authorized, should export bounded
sample chunks or serialized JSON strings and fail closed on unavailable values;
no such change or further run was performed here.

No retained-Vite, usable-chat, newline compatibility or production claim.
The known newline case remains expected-red and was not retested. No model
requests, runtime pin changes, IRS/archive edits, deployment, push, existing
evidence replacement, broad requalification or additional live pair occurred.
