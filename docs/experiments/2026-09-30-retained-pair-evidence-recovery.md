# Retained pair evidence recovery — no new run

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-retained-pair-evidence-recovery.md`

## Chronology and scope

Followup to report `6c39529` and live driver `913b8b9`. The completed pair remains
**10/10 measured passes, five per condition**; these reads add **zero qualification
samples or workload executions**. Offline inspection identified the unbounded
nested-array export and the retained client API. A CLI status observation confirmed
the exact original sessions/targets were retained. Then the atomic repository-wide
`.diagnostics/matched-pair-initiator.lock` was acquired without stealing ownership.

The Bun-backed Browser Control CLI made **39 serial, bounded, pure page reads**:
15 on `rapid-raven-347` (43228), then 24 on `cosmic-panda-884` (43229). The existing
sessions were used without adoption, reset, reload, navigation, workload clicks,
switch/rearm, service start/stop, workspace close, or page deletion. Every response
settled before the next. The evidence lock was released after all reads settled.
The old evidence pages and servers 43222/43223 were untouched; no server was started.

Fresh evidence directory (original evidence was not overwritten):
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/ownership-fixed-pair-recovery-20260930/`

It contains every CLI script/result, `identity.json`, complete condition exports,
`summary.json`, and four isolated typecheck receipts. Recovery and aggregation
scripts are retained alongside this directory as
`.diagnostics/recover-owned-evidence-20260930.ts` and
`.diagnostics/aggregate-owned-recovery-20260930.ts`.

## Identity and completeness

The retained server-side consumer still matches the original **473383-byte** client,
SHA-256 `c51eb5b8afcc87a0c98ba7a2610d08816819337999b4002ced655db76f55bb93`.
All original receipt source hashes except the intentionally edited driver match.
The receipt pin remains `446df00f86d5d6d5d856a2e5deec0fac49f242fa`; recovered runtime
open events confirm distribution
`4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a`.
No client/runtime rebuild or pin edit occurred. This is continuity evidence from
the original retained targets and served-byte receipt, not a fresh network fetch
of the client from the now-absent servers.

Every timing name/value in the previously surviving 50-sample prefixes matches
exactly. Newly recovered `source.operations.detail` also identifies incoming
generations 2–6. Ordered stopped generations are 1–5, incoming readiness generations
are `[1,1,2,3,4,5,6]`, and final retained service-only stops identify generation 6.
All recovered event IDs are unique. Original source/PDF completion receipts remain
the qualification proof; recovery did not call their workload APIs again.

| Export | Baseline | Reuse |
|---|---:|---:|
| Complete timing samples | 94 | 94 |
| Complete diagnostic events | 397 | 284 |
| Complete reset evidence records | 26 | 36 |
| Serialized characters | 96260 | 171275 |
| Measured switch groups | 5 | 5 |

Thus **188/188 retained timing samples and all 10 measured stage groups** were
recovered; previously missing G4–G6 totals/stages are available, not reconstructed.
The concatenated serialized payload SHA-256 values are:

- Baseline: `0ab30ad16b00007346bcd3ffbfdda9f3dc8476a9da0173314117255ba7943ea0`
- Reuse: `36981bee2bdd2ec203ae4c93bbed68182d98cecd4808202ea5a233f4a6b9bf37`

## Actual measured timings

Milliseconds, rounded to three decimals. Exact precision and per-generation stages
are in `summary.json`. Cold startups and same-generation re-arms are excluded.

| Incoming generation | Baseline client total | Reuse client total | Baseline driver→PDF | Reuse driver→PDF |
|---|---:|---:|---:|---:|
| 2 | 14330.370 | 15514.775 | 17877.969 | 19071.197 |
| 3 | 32153.215 | 15455.835 | 35559.546 | 18934.163 |
| 4 | 32148.780 | 15400.310 | 35384.888 | 19218.384 |
| 5 | 33575.640 | 15378.905 | 37359.748 | 18718.043 |
| 6 | 35287.155 | 16476.930 | 38904.877 | 20043.974 |
| **Median** | **32153.215** | **15455.835** | **35559.546** | **19071.197** |
| **Mean** | **29499.032** | **15645.351** | **33017.406** | **19197.152** |

Observed client median is **51.9% shorter**, mean **47.0% shorter**. The original
driver-inclusive median comparison remains **46.4% shorter**. G2 reuse is slower
than baseline; keep that observation and all five samples, not a selected warm
subset. Small, ordered cohorts establish neither confidence nor production SLA.

Each distribution below has **n=5**; notation is **median [min–max]**.

| Named stage | Baseline ms | Reuse ms |
|---|---:|---:|
| runtime.stop sample | 37.150 [23.590–49.885] | 29.105 [19.320–35.745] |
| workspace.clear | 1096.930 [434.880–1132.900] | absent |
| workspace.close | 2.025 [0.280–2.410] | absent |
| workspace.open | 1912.740 [845.990–2033.380] | absent |
| source.install / source.replace | 11.925 [6.660–15.700] | 81.175 [80.065–82.005] |
| runtime.start wrapper | 4.580 [4.080–5.170] | 4.700 [4.550–5.475] |
| dependency environment.deliver | 1547.980 [1446.120–1613.805] | absent |
| environment.flush | 291.670 [157.695–308.940] | 0.980 [0.715–1.830] |
| validation.compatibility | not applicable | 1.665 [0.615–2.590] |
| validation.before-retain | not applicable | 2903.905 [2848.535–2939.925] |
| validation.after-replacement | not applicable | 2882.790 [2864.155–2912.330] |
| Two audits combined, per switch | not applicable | 5783.060 [5712.690–5840.990] |
| config (inside services.wall) | 7.185 [3.970–9.345] | 4.550 [3.480–4.675] |
| vite.launch (inside preview.ready) | 8141.655 [1972.840–9391.125] | 1812.245 [1801.005–1848.845] |
| preview.ready: HTTP + interactive | 25230.195 [9361.920–28095.690] | 7504.205 [7453.835–8467.430] |
| chat.healthy: server/plugins/catalog | 15112.875 [6275.175–18326.040] | 5899.325 [5873.355–7107.545] |
| services.wall | 25237.835 [9366.105–28104.535] | 7509.120 [7457.500–8472.235] |
| switch.flush | 3.420 [0.655–5.095] | 1.555 [1.310–1.600] |

Preview and chat readiness run concurrently: **do not add them**, nor add config
or vite.launch again to services.wall. Both audits remain fully included in client
totals. All ten measured reuse audits are valid, each checks **12305** managed
entries, and every before/after cache digest is the same:
`9c46eebf4a98cef74f4535a2d40c869cf1fefeb457de4adca04529d0f26d4348`.
Initial audits' empty-cache digest is distinct; no cache-only duration is exposed.

After summing only non-overlapping sequential named samples inside switch.total,
the **unattributed client residual** is baseline 2081.810 [2042.680–2124.625] ms,
reuse 2045.455 [2039.400–2051.055] ms. It includes unsampled work within that total;
diagnostic stop-boundary reads are present in the code, but no separate duration
can be assigned to them from these samples. `runtime.stop` alone is **not** the
complete cleanup/diagnostic shutdown boundary. No residual was silently assigned
to cache, HTTP, audit, or shutdown stages.

Driver interval minus actual client total is baseline 3547.599 [3236.108–3784.108]
ms and reuse 3556.422 [3339.138–3818.074] ms. These differences include polling,
CLI overhead, source verification and token-specific hydrated PDF verification;
they are not a client stage.

Recovered model-catalog HTTP request timings for G2–G6: baseline
**96, 242, 214, 213, 423 ms**; reuse **96, 93, 91, 97, 183 ms**. These are catalog
reads, **not inference calls or proof of usable chat**. Plugin activation request
medians are **5633 ms baseline / 2182 ms reuse**. Baseline G3–G6 also each has a
~3002-ms failed health probe before a successful probe; these in-budget readiness
polls were already included in chat.healthy, not new driver/run retries.

## Bottleneck and next bounded experiment recommendation

Source-only replacement in this comparison retains dependencies, Vite's on-disk
cache, and the kernel, but **restarts both Vite and chat**. The observed gain is
mostly the service-readiness change (mean 22871.798→7696.556 ms), not simply avoiding
the mean **1541.301-ms** dependency delivery. Reuse's **5786.704-ms mean audits**
cost more than that avoided delivery. Its source write step costs ~81 ms. Cache
identity preservation and fast, stable Vite readiness support the retained-cache
explanation, but the comparison does **not isolate cache from retained kernel,
workspace reopening, or resource contention**; do not claim cache-only causation.

**A narrowly authorized retained-Vite pilot is worthwhile**, not a broad strategy
implementation now. Compare the existing dependencies/cache-retaining,
restart-both condition against the same condition with **Vite retained and chat
restarted**, using unchanged fixture/config/dependencies and separate fresh owned
origins. Freeze five interleaved measured switches per condition, cold/re-arm
boundaries, budgets and first-failure/no-retry policy in advance. Do not reuse these
exhausted retained cohorts as a new run.

Before such a live pilot, separately review/test selective service ownership:
the current all-services-stopped contract cannot simply be waived. Retained Vite
must remain explicitly owned while chat output/exit is joined; audit and source
replacement fences must reject incompatible inputs or unexpected live cache
mutation, not weaken integrity checks. Require exact outgoing deletion/rename,
incoming generation/import/hydration and token-specific PDF verification,
stale-listener/attachment rejection, and full zero-work final cleanup. Export
bounded evidence and measure retained-Vite update→fresh HTTP/interactive readiness
separately, plus complete shutdown boundaries and diagnostic intervals.

Set expectations modestly: with unchanged restarted chat, its ~5.9-second readiness
still runs alongside preview. Even making preview instantaneous would only reduce
the observed ~7.5-second service wall toward ~5.9 seconds (roughly **1.6 seconds**
of concurrent-stage headroom, not a guaranteed saving of the whole 7.5 seconds).
Audits (~5.8 seconds) and unsampled client work (~2.0 seconds) remain. The pilot is
useful to test responsiveness and retained-process correctness, not to promise a
near-zero full switch or usable chat. No pilot was implemented or run here.

## Export fix and validation

`examples/todo-app/tests/matched-pair-driver.ts` now exports at most **8000 JSON
characters per read**, wrapped in a flat envelope, with an export ID, URL,
generation, offsets, lengths, counts and SHA-256. Manifest, every chunk and final
manifest must agree; reassembly must match the digest and parsed counts before a
step evidence file or PASS receipt is written. Missing/unavailable CLI values,
even with `ok:true`, fail closed. No truncated textual fallback is accepted.
All export code stays within the identity-pinned driver, avoiding an unpinned new
helper dependency. Future runs still require fresh authorized preparation;
existing receipts/driver identity were not edited to authorize one.

Deterministic regressions preserve >50 entries in nested arrays, order and event
IDs; reject wrong ID/generation/offset/count/length/hash, missing/truncated/reordered
chunks, final-manifest drift and serialized count mismatch; and reject CLI
`valueUnavailable:true` or absent values despite `ok:true`.

- Focused export + ownership suites: **22 pass, 0 fail, 108 assertions**.
- Explicit consumer tests: **68 pass, 0 fail, 421 assertions**.
- Four isolated original-preparation TypeScript configurations (host/workspace/chat/
  consumer, including new tests), with no artifact emission: **all pass**.
- `git diff --check`: passes.
- Root test command: workspace **50 pass**; chat **121 pass, 2 skip**; consumer
  **71 pass**; runtime-build tests **3 pass, 1 pre-existing failure**. The failure
  expects a historical sibling runtime checkout while the current resolver defaults
  to pinned `vendor/vivari`. No runtime code/test was changed to mask it.
- Root typecheck stops on existing stale packaged workspace declarations used by
  chat (`ServiceReadiness` absent and launch arity/type errors). Isolated checks
  against the preserved reviewed declarations pass; no production package rebuild
  or unrelated repair was performed.

No production pins/runtime/IRS/archive edits, push, deployment, new models,
service starts, or qualification rerun occurred.
