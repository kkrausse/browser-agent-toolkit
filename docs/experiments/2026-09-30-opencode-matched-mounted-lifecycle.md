# Matched mounted-controller lifecycle comparison

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-opencode-matched-mounted-lifecycle.md`

## Prospective freeze (before either navigation)

One pair, two fresh origins: restart first on 43230, reuse second on 43231.
These ports were absent from the listener inventory. All retained resources,
including 43222–43227 and their existing PIDs/browser sessions, remain untouched.
One exclusive serial global initiator, Bun-backed Browser Control CLI only.

Five measured transitions each, ten total; zero rearm transitions. Each origin
starts at A0, then switches B1, A2, B3, A4, B5. The same incoming source/config
and accumulated persisted session store are used in both conditions. A fresh
empty root session is mounted through the actual unchanged ChatController on
every generation. No workspace reset, dependency installation, bootstrap overlap,
model inference, tools, shell, PTY or execution RPC is permitted.

Each transition and initial cold launch has the same 150 s enclosing budget;
finite calls/drain 20 s, service listen 60 s/connect 90 s/overall 150 s,
EOF shutdown 10 s, healthy final cleanup 15 s. Per-origin observation watchdog
300 s. Budgets are fixed, never renewed by progress. First failure stops the
whole pair: no action retries, replacement origins or extensions. The second
origin is not started unless the first has passed and zero guest work is proven.
Short serial status observations do not retry actions.

The metric ends at actual `ChatController.ready`, not subsequent proof requests.
Activation/plugin/config/project/catalog qualification remains inside the metric;
independent root/history/source/plugin/PID/process proofs run after ready and must
pass before the next transition and final acceptance. Cold/environment delivery,
proof and healthy cleanup times are separate; this is not a full workspace SLA.

Both outgoing paths freeze/join normally consumed finite requests, then await
local controller disposal/global SSE cancellation. Restart stops/drains only the
owned OpenCode service, proves zero guest work, writes config/source, and launches
with unchanged environment/dependencies. Reuse awaits DELETE with zero refs inferred
from the already-reviewed exclusive finite-handler fence, writes config/source,
then reacquires. Remote zero-ref receipts are not fabricated. Cancellation,
semantic failure, pending finite work or timeout blocks eviction and stops the pair.

Pinned clean runtime `446df00f86d5d6d5d856a2e5deec0fac49f242fa`, server 2.0.3
SHA-256 `1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929`;
10,528 managed payload hashes verified. Isolated client preparation and targeted
strict TypeScript checks passed. Contract/fence/controller preflight: 61 tests,
350 assertions, zero failures, including actual pinned HttpApi nullable-cursor
schema decode/encode/transport serialization. Runtime/artifacts/pins remain unchanged.

Private evidence directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/opencode-matched-lifecycle-2026-09-30T05-24-21-330Z/`

## Outcome: all ten transitions passed

**Observed median transition-to-ready: restart 22.316 s, reuse 8.425 s.**
Reuse was 13.891 s lower (62.25% reduction; ratio 0.378, approximately 2.65×).
Every measured generation passed the same actual mounted-controller workload,
qualification, subsequent independent proofs, and final healthy cleanup.
No failure, action retry, origin replacement, deadline extension or rearm occurred.

This answers the restricted comparison, **not** a production or causal 2.65×
guarantee. There is just one fixed-order pair, with five serial generations per
condition, not ten independent origins or randomized observations. Restart times
declined markedly through its run; the later reuse origin also had faster cold
startup. Browser/JIT/cache/host warming and fixed order are material confounders.
There is no defensible population confidence interval from this design. The
observed ranges do not overlap, but confidence in the general magnitude is low.
No follow-up experiments are implicitly authorized.

| Transition | Restart to ready (s) | Reuse to ready (s) |
| --- | ---: | ---: |
| A0 → B1 | 28.131 | 8.277 |
| B1 → A2 | 23.468 | 8.425 |
| A2 → B3 | 22.316 | 8.448 |
| B3 → A4 | 20.957 | 8.702 |
| A4 → B5 | 17.992 | 8.402 |

### Stage distributions

All entries below are **min / median / max seconds**, five transitions each.
Nested rows are not additive independent measurements; medians need not sum.
`controller.ready` starts at controller creation and ends at its real ready
promise. Bootstrap/create/hydration are derived from complete request timestamps:
controller start → session POST start → fully consumed POST finish → ready.
Bootstrap retains its original parallel reads/pagination; hydration retains all
original history/permission/form/active checks. No controller scheduling changed.

| Stage | Restart | Reuse |
| --- | ---: | ---: |
| **Whole transition to ready** | **17.992 / 22.316 / 28.131** | **8.277 / 8.425 / 8.702** |
| Freeze/join finite calls | 0.000040 / 0.000055 / 0.000210 | 0.000025 / 0.000030 / 0.000215 |
| Local dispose + global SSE cancellation | 0.000480 / 0.000765 / 0.006735 | 0.000495 / 0.000505 / 0.002450 |
| Stop/drain/zero-work proof | 0.034 / 0.103 / 0.215 | — |
| DELETE 204, await completion | — | 0.015 / 0.026 / 0.054 |
| Source/config write + flush | 0.014 / 0.017 / 0.038 | 0.008 / 0.011 / 0.017 |
| Owned service launch including qualification | 15.046 / 18.767 / 23.421 | — |
| Pre-qualification launch residual | 5.700 / 7.730 / 8.838 | — |
| Qualification health | 3.744 / 4.350 / 5.890 | 0.003 / 0.003 / 0.005 |
| Qualification activation | 5.354 / 6.308 / 8.277 | 5.175 / 5.209 / 5.545 |
| Qualification plugins | 0.005 / 0.010 / 0.033 | 0.003 / 0.004 / 0.006 |
| Qualification config | 0.003 / 0.007 / 0.016 | 0.002 / 0.002 / 0.004 |
| Qualification project | 0.003 / 0.006 / 0.010 | 0.002 / 0.002 / 0.010 |
| Qualification catalog | 0.232 / 0.257 / 0.392 | 0.209 / 0.225 / 0.236 |
| Reuse qualification total | — | 5.411 / 5.443 / 5.784 |
| **Actual controller.ready** | **2.826 / 3.476 / 4.470** | **2.777 / 2.872 / 3.004** |
| Controller bootstrap | 0.737 / 0.859 / 1.177 | 0.714 / 0.716 / 0.768 |
| Session create, full response | 1.140 / 1.543 / 1.866 | 1.144 / 1.151 / 1.198 |
| Controller hydration | 0.946 / 1.060 / 1.427 | 0.906 / 0.918 / 1.101 |
| **Extra proof, excluded from ready metric** | **0.267 / 0.277 / 0.442** | **0.242 / 0.284 / 0.327** |

Pre-qualification residual is service-launch duration minus all timed
qualification calls; it covers spawn/listen/publication overhead, not a fabricated
CPU profile. Restart does not benefit from dependency installation: the same
already-delivered dependencies, workspace and runtime remain mounted throughout.

Separate nonmeasured cold-to-ready: **19.644 s restart-origin**, **12.896 s
reuse-origin**. Environment delivery: 2.051 / 1.646 s. Initial extra proof:
0.395 / 0.229 s. Final healthy cleanup: 0.038 / 0.138 s. These are not included
in the five-transition medians or advertised as full-workspace readiness.

### What remains expensive; is reuse worth it?

Restricted reuse materially avoided owned-process startup and initial health
initialization in this run. DELETE itself cost only a 26 ms median. But activation
still dominated reuse: **5.209 s**, roughly **62%** of its 8.425 s median whole
transition; controller readiness added about 2.872 s. This is a measured dominant
stage, not proof of which internal plugin/config computation consumed CPU.
Catalog qualification is intentionally duplicated by unchanged controller
bootstrap (12 model-catalog reads per condition), not removed for a favorable
result. There are no model inference calls.

The earlier 24.335 s one-shot reset included different surrounding timing/proof
boundaries and substantially slower activation (14.115 s); it is not pooled with
these samples. The earlier 5.9 s restart was catalog-only and remains explicitly
non-equivalent, not a mounted-session baseline.

**Decision:** reuse is worthwhile for this narrowly fenced, finite-owned workload
as a latency opportunity; this evidence does not justify enabling general
production reuse. Do not optimize controller bootstrap yet. Production still
needs concurrent/cancelled-reader admission, cancellation joins and verified
remote lease/ref release, plus robust failure-stop/eviction ownership guarantees.
No execution/tool/production-concurrency compatibility is claimed here.

## Complete acceptance and ownership evidence

| Count / identity | Restart | Reuse |
| --- | ---: | ---: |
| Fresh origins / initial cold launches | 1 / 1 | 1 / 1 |
| Measured transitions / extra rearms | 5 / 0 | 5 / 0 |
| Owned OpenCode process launches / clean shutdowns | 6 / 6 | 1 / 1 |
| Normal accepted finite HTTP responses | 95 | 100 |
| Global SSE HTTP 200 / joined controller disposals | 6 / 6 | 6 / 6 |
| Session creates / persisted prior sessions at final generation | 6 / 5 | 6 / 5 |
| DELETE responses | 0 | 5 × empty 204 |
| Failed / cancelled / timed-out / unresolved finite requests | 0 each | 0 each |
| Retries / replacement origins / deadline extensions | 0 each | 0 each |
| Model inference / tools / shell / PTY / execution RPC | 0 each | 0 each |
| Guest PIDs by generation | 1, 2, 3, 4, 5, 6 | 1, 1, 1, 1, 1, 1 |
| Finite raw response bytes | 145,504 | 145,504 |
| Chunk-validated complete export | 14 chunks; 858,642 bytes | 13 chunks; 843,872 bytes |
| Final guest processes / listeners / pending HTTP | 0 / 0 / 0 | 0 / 0 / 0 |
| Final exitCode / signal / forced | 0 / null / false | 0 / null / false |

All twelve root IDs are distinct. Every incoming session had empty hydrated
message/permission/form history and idle execution, explicit `/workspace`, no
inherited parent/fork/model/permissions/metadata. Every controller bootstrap
retained all previously persisted sessions and followed its normal body cursors.
All config/source markers match the frozen A0/B1/A2/B3/A4/B5 sequence; both pinned
plugins are active and their file bytes unchanged. Postflight proves identical
config/dependency/plugin/runtime/location identity and identical normalized HTTP
workloads generation by generation; only reuse adds the five administrative
DELETEs. Each independent generation proof records one guest process/listener
and **zero pending HTTP**, while each outgoing fence has zero unresolved finite
calls and awaited local disposal. The source-audited zero-ref inference is limited
to these exclusive, normally completed finite handlers; no remote receipt is claimed.

All **195 finite responses** retain complete raw base64 bytes, SHA-256, lengths
and headers before validation. Offline postflight rechecked all export/body
hashes and decoded/re-encoded every response with the exact pinned HttpApi
schema/transport implementation: **195/195 byte-for-byte/status/header parity**.
No incomplete export was accepted. Raw credentials/private response contents stay
in uncommitted evidence. The native owned-service HTTP 401 readiness probes are
outside the caller fence: six restart-origin launches, one reuse-origin launch.

Frozen client: **1,926,835 bytes**, SHA-256
`84615fa7f71952080e1afb5f47c0ee2fd3bea45341c9f57bd3cada89c402a461`.
Both host-served copies match the receipt. Driver/prospective report committed
before live as `8bd9999`; later offline export/verifier helpers do not change the
frozen served driver. Final focused tests: **64 passed, 0 failed, 366 assertions**;
targeted strict TypeScript checks passed. Evidence tests cover ordered complete
chunk export, refusal before terminal status and first-chunk-failure no-retry.
An initial test-only async wrapper parse error was corrected offline; no live
action failed or was retried.

Sole browser owner: Bun-backed Browser Control CLI 0.8.2. Restart session
`brisk-sparrow-538`, page `http://127.0.0.1:43230/?condition=restart`, host PID
**43010**; reuse session `brisk-panda-553`, page
`http://127.0.0.1:43231/?condition=reuse`, host PID **44514**. Four successful
restart executes (navigate, two status observations, export), three successful
reuse executes (navigate, status observation, export). No MCP/raw CDP, reload,
replacement, relay restart, second owner, timeout, or browser failure. Restart's
favicon 404 is a non-workload resource miss, not a failed guest call. Evidence
pages and host servers remain retained; their owned guest services were cleanly
stopped before completing each condition. Reuse did not start until restart had
zero guest work and a successful codec-verified complete export.

`receipt.json`, `live-restart.json`, `live-reuse.json`, both chunk/digest receipts,
`live-codec-parity.json`, `summary.json` and protocol-prefix verification scratch
are in the private evidence directory above. No runtime/artifact/pin/IRS/archive
changes, push, deployment or model calls occurred. Prior retained resources,
including 43224/PID90779, 43225/PID1493, 43226/PID12962, 43227/PID31956 and older
43222/PID6885 and 43223/PID7042, remain untouched.
