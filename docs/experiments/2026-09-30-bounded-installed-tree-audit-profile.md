# Bounded installed-tree audit profiling — keep baseline, profile OpenCode next

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-bounded-installed-tree-audit-profile.md`

## Decision

**Do not enable direct hashing by default or run a full-switch comparison yet.**
The example-only candidate preserves validation and passes differential controls,
but this bounded, instrumented run does not establish a reliable saving against
the prior uninstrumented **5.783 s combined audits**. Prioritize a separately
authorized OpenCode-start profile next; its previously measured 5.899 s readiness
is a more useful target than adopting this inconclusive micro-optimization.
Retained Vite remains parked at its existing active-writer/config-path blockers.

Observed instrumented per-audit median: **13,611.965 ms stream → 12,720.090 ms
direct**, difference **891.875 ms (6.552140%)**. Mean difference is only
**314.933 ms (2.527751%)**; adjacent stream-minus-direct differences are
417.135, 228.020, 891.875, **−481.265**, 518.900 ms. Both conditions accelerate
strongly in the later samples. No causal switch-time gain is established and no
part of the original 5.783 s is claimed removed. Doubling the median difference
would be an unsupported extrapolation, not a measured two-audit switch benefit.

## Exact budget, execution and identities

New ignored evidence directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/audit-direct-profile-20260930-live/`

`plan.json` was written before serving or browser navigation. Fixed order:
stream, direct, direct, stream, stream, direct, direct, stream, stream, direct.
Actual: **5 stream + 5 direct audits, 10/10 valid**, one fresh-origin installation,
ten individually owned guest audit processes, **0 resets, retries, workload runs,
source switches, service starts, model calls or full-switch cohorts**.
There was no warmup audit, excluded audit or replacement sample.

One offline preparation attempt stopped before building/serving because the
ownership receipt's directory contains a client/receipt, not the reused library
artifacts. The corrected resolver uses the original reviewed library directory
adjacent to `receipt.runtimeSource`. The abandoned new directory
`.diagnostics/audit-direct-profile-20260930/` contains no live samples; this was
not a live retry. Existing preparation/evidence was not changed.

The new sole browser session was `clever-otter-925`, origin
`http://127.0.0.1:43231/`. A repository-wide exclusive initiator lock prevented
concurrent switch initiation; the server refused a second document request.
No existing page was adopted, navigated, reset or closed. After evidence export,
the new runtime/workspace stop/close joined, its server PID 51647 exited on
SIGTERM and released its own lock, and only the new browser session was deleted.
Existing retained pages/servers on 43228/43229 were preserved.

Runtime source remains **446df00f86d5d6d5d856a2e5deec0fac49f242fa**, distribution
**4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a**.
All receipt-listed frozen runtime artifacts, the original manifest, every managed
file asset and original bundle/image were verified before serving. Reviewed
workspace index/delivery/diagnostics artifacts were checked against receipt hashes.
`identity.json` identifies the exact built example consumer and used artifacts.
No runtime/library rebuild, runtime instrumentation/edit, pin/archive/IRS change,
push or deployment occurred. Only the example consumer was bundled.

## All measured audits

Times include script encoding/digest, install/read-back, launch, complete guest
validation, stream/exit joining, JSON parse and final stop/join. Both conditions
have the same profiling wrappers; “stream baseline” here means **instrumented
original hash algorithm**, not the untouched earlier baseline client.

| Sequence (zero based) | Algorithm | End-to-end ms |
| --- | --- | ---: |
| 0 | stream | 14184.000 |
| 1 | direct | 13766.865 |
| 2 | direct | 13503.840 |
| 3 | stream | 13731.860 |
| 4 | stream | 13611.965 |
| 5 | direct | 12720.090 |
| 6 | direct | 10542.665 |
| 7 | stream | 10061.400 |
| 8 | stream | 10705.885 |
| 9 | direct | 10186.985 |

Every audit checked **12,305 entries: 1,268 directories, 511 symlinks, 10,526
files**, reading/hashing all **230,606,655 managed file bytes**. Every profiled
audit recorded 12,306 lstat calls, 1,270 readdir calls, 511 readlink calls,
10,526 file reads, 10,527 hashes (including empty cache-inventory digest), and six
exists calls. All non-profile result objects were byte-identical after JSON
serialization. Cache and state inventories were empty throughout this fresh,
service-free fixture; this is **not** a measurement of populated Vite caches.

## Cost attribution (independent medians, milliseconds)

| Cost | Stream | Direct |
| --- | ---: | ---: |
| Host script encode/digest | 11.305 | 17.835 |
| Host script install or existing-file verification | 131.085 | 134.265 |
| Launch acceptance | 24.245 | 24.620 |
| Host wait for output/exit | 13445.290 | 12552.625 |
| Host parse | 0.055 | 0.040 |
| Host stop/all-task join | 0.050 | 0.025 |
| Guest fs/crypto require | 0.775 | 0.830 |
| Guest manifest evaluation/Map indexing | 8.845 | 8.200 |
| Guest lstat | 1392.100 | 1424.280 |
| Guest readdir | 168.505 | 172.745 |
| Guest readlink | 40.495 | 30.905 |
| Guest full file read | 6737.760 | 6435.510 |
| Guest full hashing | 4461.360 | 3842.125 |
| Guest exists | 0.810 | 0.820 |
| Guest initial result serialization | 0.015 | 0.015 |
| Guest total through initial serialization | 12962.455 | 12190.870 |

Do not sum independent medians. File reads dominate this instrumented fixture;
hashing is substantial, and module loading/manifest indexing are tiny. Direct
hashing removes stream-class construction using the frozen `node:crypto.hash`
implementation, but the run does not isolate that saving from order effects.
Host drain/exit time includes guest work, not an additional cost. Launch acceptance
does not isolate entrypoint compile/loading. Output framing, post-profile JSON
serialization and transport/exit settling remain in end-to-end/residual timing;
they cannot be individually attributed through the supported example API.
Manifest timing excludes source compilation before the script starts.

**Limit:** these heavily instrumented 10–14 s per-audit times are much slower than
the historical ~2.9 s uninstrumented per-audit cost. Profiling wrapper overhead,
fresh versus warmed data and ambient scheduling are confounders, not quantified
causes. No uninstrumented control remains within the exhausted 5+5 budget, so
there was no extra audit to estimate/subtract instrumentation overhead. Cache
inventory work is zero here; the optional recursive cache timer is inclusive
and overlapping, not an additive category for populated caches. Persistent
helper reuse/batched APIs were not implemented or measured: small observed
module-loading cost does not justify new process-lifetime ownership.

## Guarantees and controls

Default callers continue using stream hashing. The opt-in direct candidate changes
only the hash primitive, not traversal, full-byte hashing, file sizes/modes,
symlink targets, sorted inventories, known cache policy or unknown installed-path
rejection. It trusts no receipt/marker as installed-tree certification. Existing
fallback/serial-driver/export-verifier behavior was not edited. Stop is still
requested promptly on failure, and stop, exit, stdout and stderr all join before
the audit releases ownership; observer failures after launch obey that fence too.
Before/after diagnostics both show no guest processes, listeners, active/inflight
fetches or pending HTTP. No helper or audit process survived cleanup.

Offline tests run the real generated scripts against local fixtures, comparing
stream/direct and profiled/unprofiled result objects: same-length and size-changing
mutations, deleted/added paths, wrong kinds/file/directory modes, matching and wrong
links, unknown caches, cache links and unsafe cache parent, cache content/digest
changes, unexpected installed roots, and injected stat/readdir/read/readlink/hash
errors. Ownership controls cover stdout, stderr, exit, stop, parse and post-launch
observer errors for both hash modes, plus the existing fallback-blocking sibling
drain test. The active-writer history-blindness characterization remains: these
audits certify a stopped-tree snapshot, not concurrent writer history.

Focused audit + serial driver + evidence export tests: **30 pass, 0 fail,
279 assertions** (`tests.json`). Consumer/auditor/tests/server typecheck passes
against the reviewed declarations. `git diff --check` passes. Offline controls
are not additional live audit samples. Raw measurements, profiles, diagnostics,
fixed plan and artifact identities remain in the ignored evidence directory.
