# Effect pilot: one fresh readiness observer cohort

**Diagnostic readiness completed; old fetch failure cause remains unresolved.**
One fresh visible cohort completed the original eleven foundation stages and
`apps-1`, including its existing chat startup. No further generation, interactive
TODO/PDF assertion, HMR/SSE, reload or focused case was run. This is **not a new
full-suite acceptance pass**, does not replace failed4470897, and does not open phase2.

Absolute report:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-loader-preview-readiness-trace-qa.md`.
Assignment2026-09-30; execution2026-10-01 UTC. Observer preparation commit99748de;
offline investigation3009d7a. No production fix/migration or deadline change.

## Exact operation / result

Actual public `Endpoint.fetch('/')` sent GET `/`, empty headers, to listener
`ab9fa2d5-dafb-4065-af22-634b7ab607ca:1`, guest port5173. Its adapter Request was
`http://workspace.invalid/`, mode`cors`; that URL is metadata, not native DNS/fetch.
Actual incoming `http-stream-out` messages establish readiness **stream ID3**.
No legacy probe IDs were captured or invented.

Relative to observer arm at2026-10-01T01:18:22.676Z (monotonic24780.05ms):

| Actual boundary | Elapsed |
| --- | ---: |
| Original fetch await starts | 0.160ms |
| Original20,000ms timeout signal created/observed | 0.225ms |
| Endpoint MessagePort transport posted | 0.360ms |
| Guest upload credit ID3 / GET upload EOF sent | 1,960.410 /1,960.470ms |
| Headers ID3 / public fetch resolves | 11,117.715 /11,117.960ms |
| Original sole `response.arrayBuffer()` starts | 11,117.970ms |
| First/only data chunk ID3,24,367 bytes | 16,916.135ms |
| ID3 end / adapter cleanup / public body EOF | 17,313.345 /17,313.400 /17,313.675ms |
| Original attach call / return | 17,313.690 /17,315.815ms |
| Original timeout abort fires | 20,000.740ms |

Returned status200, statusText empty, oktrue, synthetic Response type`default`,
URL empty. Headers: `Vary: Origin`, `content-type: text/html`, guest Date,
`Connection: close`, `Transfer-Encoding: chunked`. Headers were returned before
the optimizer completion message; successful body EOF followed it.

**No readiness fetch/body/adapter rejection occurred.** The timeout fired after
the readiness request had ended and its abort handler had been removed. Its
original reason was retained: name`TimeoutError`, message`signal timed out`,
stack`TimeoutError: signal timed out`, code23, no cause. The observer signal listeners
also recorded propagation to the adapter Request signal. No adapter cancel/failure
followed that late readiness abort, no second request/body read was issued, and no
manufactured error or pass was substituted.

This demonstrates a successful first cold response/body in this instrumented cohort;
it **does not establish** that the prior `TypeError: Failed to fetch` was a timeout,
nor whether the prior failure happened before headers or during body consumption.

## Vite / optimizer / guest execution

Vite launch01:18:13.557Z; spawn acknowledged278ms later; listen/connection healthy
01:18:22.676Z (listen8,841ms). Guest Vite ready output01:18:22.690Z reports8,712ms.
Optimizer output01:18:39.583Z lists the same TanStack/TRPC/pdf-lib dependencies;
reload message01:18:39.584Z. Healthy→optimizer message **16,907ms**, followed by
readiness body EOF about407ms later. Chat starts01:18:39.999Z and becomes healthy
01:18:42.609Z; it is part of unchanged apps-1, not another acceptance generation.
Model calls0.

Compare old qualified app70d8c23 optimizer≈19.64s and failed4470897≈21.38s after
healthy; this observer cohort≈16.91s. Unmatched runs with passive observer work
are **not** a performance comparison or proof of Effect overhead. A cold budget
boundary remains plausible but is neither a diagnosed production defect nor grounds
for enlarging the20s deadline.

Actual diagnostics sampled Vite PID1, WASI child PID2 (`wasi-worker.mjs`, ppid1),
and chat PID3. Vite had869 loaded modules,99 kernel syscalls, zero worker errors;
child had zero kernel syscalls and `booted:false`, as in the failed sample. In this
successful cohort that child sample plainly cannot be used to declare a dead
optimizer. No child execution-start/completion timestamp or optimize-start receipt
is exposed by the retained public diagnostics. Guest optimization output timestamps
are output observations, not instrumentation inside the WASM backend. After apps-1,
legacy pendingHttp0 and lazy operations/failures0.

## Observer preparation / identity

Root for all following retained paths:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/`.

- Immutable input: `effect-loader-full-app-UMORaL/frozen`, exact runtime
  `3ee918522c1233a1f8e10a9b798c09b6c3e30c81`, toolkit
  `9814c715cfca42309c581440577976833f4326e6`, Effect rc.118.
- New never-existing preparation:
  `effect-preview-readiness-trace-stage-20260930-b1e732f4`.
- New never-existing run copy:
  `effect-preview-readiness-trace-run-20260930-b1e732f4`.
- Evidence: `effect-preview-readiness-trace-evidence-20260930-b1e732f4`.
- OS origin`http://127.0.0.1:65292/`, exact hostPID32885, own CLI session
  `effect-preview-trace-d068648a`; explicit session-new preceded page operations.
  Native OPFS/databases/caches/service-worker/localStorage inspection confirmed
  empty storage before client navigation. No old-origin replay/storage clearing.

Only isolated emitted `client/single-kernel-client.js` and combined
`qa/serve-single-kernel.js` changed. SDK/core/workers/application/native files did
not. Eleven client observation edits plus prefixed observer reverse to the original
client bytes; host memory-only URL/request/abort observation plus graceful SIGTERM
handler reverses to the original broker bytes. No action/assertion/budget/order
edit, retry, extra fetch/body clone/read, delay or protocol substitution. Existing
awaits received synchronous logging and catch/rethrow-original boundary observation.
This is a QA-instrumented candidate with possible race perturbation, not a claim
that observation has zero timing cost.

| Identity | SHA-256 |
| --- | --- |
| Frozen original receipt | `42d8ba68c2f0c972c7c5bdabe82e5fc112c75af3005d39fcf77693219563ae2a` |
| New observer receipt | `cd55bf76d8e733f1330689d30854e5b5be17dd293a0b453eef6637b381c93b81` |
| Actual instrumented client | `426eea01bb2f1d084fc793e8d4921f2e220373049040b1af620d57951f88b604` |
| Actual instrumented broker | `f485aedead814a44674a2f466f673b2e21af6020826f6dc3236d3671d178b337` |
| Unchanged SDK host | `14e5b1e965c4645ccbed41a93536db8b941b5ed076225dfea9288d9a0b5dfc87` |
| Unchanged kernel worker | `c4193ae0cba8419149738ed2b3a74d79d5f59f5e447eff129106ca2f3532fecb` |
| Unchanged process worker | `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7` |

Preflight verified9,721 files plus12 native inputs/37 reused outputs, no native
build. Postflight verified frozen/stage/run **29,163 receipt-listed files**, native
12/37, zero mismatches. Core source/build identity stays
`211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070`;
no fresh compiler reproducibility or live core-response hash claim. Source/receipt
proofs are retained in preflight.json, ownership.json, postflight.json.

## Evidence quality / tooling interruptions

`natural-app.json` and `natural-readiness-trace.json` retain complete natural
application/readiness snapshots. Readiness observer dropped0, errors0; its local
error records keep name/message/stack/cause without changing exceptions. It remained
armed through the unchanged successful chat launch, and initially retained that
launch's ephemeral Basic authorization. Three owned exports were redacted after
capture (`authorization-redaction-receipt.json`); original readiness error stacks
were not suppressed. Only owned ephemeral trace exports changed, never frozen
inputs/pins or another cohort. Owned CLI journal inspection found zero unredacted
authorization matches. A post-cohort observer-source redaction correction and one
regression test were added **without rebuilding/replaying this cohort**; their new
source hash must not be represented as the executed observer hash.

The native observer attached the **page CDP session only**. Flattened page Network
events show iframe document and module responses200/fromServiceWorkertrue after
attachment; favicon404 is retained. It did not receive worker target discovery
events, so **no separate kernel/process/SW-domain Network capture is claimed**.
Large data-URL requests exhausted its2MiB cap:345 retained events,12 drops, no
observer command errors. Native absence of failures is not a complete no-network-
failure proof. Exact legacy serving/warm-up probe IDs/URLs remain missing. No ID
was inferred from pendingHttp. Native observer files are explicitly partial.

The outer shell120s limit interrupted the driver **during chunked native evidence
export, after natural apps-1 completion**, not during readiness. No workload was
rerun. Its frozen snapshot still existed in own CLI state; a separate read-only
write saved it locally (`manual-frozen-native-observer.json`) without another
application action. The partial numbered chunk receipts remain. This was a driver
export failure/continuation, not an accepted all-green driver result.

Viewport screenshot `natural-viewport.png` was read/inspected at native size:
actual TodosA heading, PDF button and input rendered, status ready. It is not a
TODO/PDF/hydration assertion receipt; no interactive control was actuated. Raw
guest output and diagnostics are authoritative. Exact broker request/abort logs
contain47 events, dropped0, and joined shutdown (`host.log`). Host responses were
not separately instrumented; page Network statuses cover only observed page traffic.

## Cleanup / ownership

After preserving natural result, invoked the original public `close` once (ready
state; no failure-retirement action needed). It joined Runtime/service/output stop
and Workspace close in53ms. Its stopped diagnostic contains zero processes,
listeners, pendingHttp, fetch active/queued/inflight/cache/pins, spills and lazy
operations/failures. Vite's native signal-stop remains forced143; chat graceful
exit0 is retained. Normal public signal stop is not forced page destruction.

Post-close native census observed only the owned page, no workers/service worker;
native locks held/pending empty (95ms observation, inside15s bound). Detached the
owned raw CDP observer; normally deleted the own CLI session; signalled only exact
host32885 with SIGTERM and joined its graceful `server.stop(false)` shutdown.
Final ps/lsof show no hostPID/listener65292; native relay list has zero old-origin
targets. Removed only empty own evidence lock. No shared relay restart, MCP,
other session/target/source/output or storage cleanup. **Exclusive visible slot
released.**

## Cause / smallest next action

**Proven:** this exact pilot delivery can return first-preview HTTP200 and consume
its complete body before20s, through real guest/channel/response cleanup. Late
timeout is a typed TimeoutError after successful EOF, not the old TypeError.

**Not proven:** cause of failed4470897, original stack/status/header/body boundary,
optimizer/WASM start/finish, runtime-vs-host-vs-prepared-input cost, or causal Effect
regression. Missing old receipts cannot be recovered by this successful fresh cohort.

Do not implement a production fix or blindly authorize another run. Parent should
first decide whether the unchanged20s cold-readiness bound is an acceptance policy
or product behavior needing a separate deterministic investigation. If investigating
timeout semantics, the smallest non-live followup is an observed-failure-focused
adapter fixture using the unchanged real stream adapter to verify abort-before-
headers versus abort-during-body preserves the exact original signal reason and
joins cleanup. It must not turn this successful cohort into proof about4470897 or
invent a cold-optimizer fix. If later native tracing is authorized, repair/cap data-
URL metadata and independently verify worker-domain admission before any workload;
do not repeat this partial observer unchanged.

Normal/held loader2/2 remain useful phase1 positives; failed integrated4470897 is
preserved, focused/full-suite pilot acceptance remains unqualified. Known editor
busy/target retention, guest markAsUncloneable, path security/all-writer guarantees,
performance and pin/cache promotion remain excluded. No phase2 migration followed.
