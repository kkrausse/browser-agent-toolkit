# Effect loader: offline first-preview fetch investigation

## Outcome / gate

**No artifact-specific causal production defect is established. Do not implement a
fix or enter phase2 from this investigation.** The strongest new lead is a cold
first-response/dependency-optimizer boundary very near the existing 20-second
request deadline. That is a timing correlation, not a proven timeout diagnosis or
permission to enlarge the deadline.

The readiness operation is **public `Endpoint.fetch('/')` over a direct
MessageChannel**, followed by `Response.arrayBuffer()`. It is not native browser
`fetch('/preview/5173/')`. The retained evidence does not distinguish rejection
before headers from rejection while consuming the response body. Consequently
“the first preview fetch failed” identifies an operation boundary, not its exact
throwing API, browser URL, status or cause.

Only offline evidence/source comparisons were performed. No browser, host, guest,
install, build, retry, production edit or evidence mutation was made. This report
is the sole owned change.

Absolute report:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-loader-preview-fetch-investigation.md`.

## Exact comparison inputs

Runtime source: clean worktree
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/vivari-effect-loader-pilot`,
commit `3ee918522c1233a1f8e10a9b798c09b6c3e30c81`. Compared committed objects against
`33fa1359a003ca9c50cb3bc49699b99bc1a063f1`, not current toolkit working-tree guesses.
Read toolkit/runtime AGENTS, `vivari/DEVELOPMENT.md`, normative runtime architecture
and the full independent browser report associated with `4470897`.

Under the absolute evidence root
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/`:

- New frozen delivery: `effect-loader-full-app-UMORaL/frozen`; toolkit
  `9814c715cfca42309c581440577976833f4326e6`, distribution
  `bd39000ff5bbc334f836ad65a4433e627525070413f810d7169132102f49b9f9`.
- Actual failed delivery: `effect-loader-visible-combined-20260930`, origin63491.
- Raw failure: `effect-loader-visible-combined-evidence-20260930/failure-app.json`,
  `result.json`, `failure-app-browser-logs.json`, numbered JS/JSON receipts.
- Additional receipts: `effect-loader-visible-evidence-20260930`, including
  `delivery-receipt.json`, `16-combined-failure.json` and natural retirement records.
- Exact old freeze: `conservative-full-app-Yb8T8p/frozen`; toolkit
  `d0eec346dbc749db1c0cd82dd8aad0b27c1da363`, distribution
  `3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.
- Old `70d8c23` evidence:
  `conservative-full-app-live-evidence-20260930-once/app-evidence.json`.
  Its application stages passed; its overall suite failed later at the separate
  duplicate-library focused observer. It is not an all-green baseline.

## First failing operation and expected route

Frozen new `client/single-kernel-client.js:10262–10267` executes, in order:

1. Launch actual Vite and obtain the listener-bound public endpoint.
2. `previewHTTPThenAttach(owner.signal, () => preview.endpoint.fetch('/',
   {signal: AbortSignal.timeout(20000)}), attach)`.
3. Inside the helper (`9827–9834`): await fetch, require `response.ok`, await
   `response.arrayBuffer()`, check owner cancellation, then attach iframe.
4. Only after that, launch chat.

Source equivalents are committed toolkit
`examples/todo-app/tests/single-kernel-client.ts:192–197` and
`examples/todo-app/tests/matched-qualification.ts:18–25`; their action/deadline
source is unchanged between old d0eec346 and new 9814c715.

Actual runtime path (`packages/core/src/host-sdk/browser/endpoint.ts:52–74`):
`'/'` becomes a local `Request('http://workspace.invalid/')`, GET, empty headers,
ordinary Request mode (default cors), with combined request/lifetime signal.
`workspace.invalid` is a synthetic metadata base, **not a DNS/network request**.
The host posts `workspace-http-stream` with `{port:5173, listenerId,
request:{path:'/',method:'GET',headers:{}}}` and transfers a MessagePort.
`kernel-worker.ts:3075–3084` checks that exact listener generation and calls
`Kernel.openHttpStream`. The kernel allocates a fixed PID-owned request ID and
posts `http-stream/open` to Vite PID1. Guest `packages/runtime/http-stream.js:35–53`
uses its Node-compatible `http.request` to guest loopback127.0.0.1:5173, path `/`,
connection close; it flushes headers and accepts upload EOF even for GET.

Guest response raw headers/status are returned over `http-stream-out`; the SDK
constructs a synthetic Response and credits 64KiB body chunks until EOF. There is
no native redirect-following fetch in this adapter. A non-ok status would produce
`Error: Preview HTTP <status>`, not the recorded string. Channel/guest error messages
are reconstructed as `Error(message.error)`; signal abort uses `request.signal.reason`.
The recorded `TypeError: Failed to fetch` therefore does not alone select any of
these error branches or identify a status/body-cleanup event.

The endpoint's *eventual iframe URL* is same-origin
`/preview/5173/?__vv_listener=<generation>`. That SW/native navigation route is
used only after successful headers/body completion. No attachment or chat launch
receipt exists. CORS, SW preview path filtering and host 404 routing cannot be
assumed to be the direct readiness transport failure.

### Distinct legacy HTTP diagnostic

`pendingHttp` samples `Kernel.pendingHttp`, not `Kernel.httpStreams`.
`kernel-worker.ts:1759–1771` separately starts `announceServing` on first listen;
`waitServing`/`warmDevServer` use legacy `handleHttpRequest`. Those probes can
request `/`, `/@vite/client`, and HTML module entries and trigger cold optimization.
The failed sample's one pending legacy request **does not identify the direct
readiness stream**. Its URL and relationship to cold optimization are unrecorded.
Similarly PID2 `booted:false`, zero kernel syscalls, and current opcode14 do not
prove a dead WASI child: no worker error or execution-fault receipt was captured,
and actual Vite optimization output arrived later.

## Negative byte/source comparison

All SHA-256 values below were computed offline from committed source or retained
files, not inferred from package versions and not live response-body hashes.

| Unchanged between exact old/new sources or deliveries | SHA-256 |
| --- | --- |
| `packages/core/src/host-sdk/browser/endpoint.ts` | `440225c7550abdf865ba6be414b3dbf5f9c7b5f766d0230f279851739570505a` |
| `packages/core/src/host-sdk/browser/http-stream.ts` | `62a44cf02af97fd1fd27ed220ea348e802943a99247ddbd0c58a459d8edc6295` |
| `packages/runtime/http-stream.js` | `7db016ec14bc460e6512640844ac19dbe64eb411db799e70ad887e700badf0f6` |
| `packages/protocol/syscall.js` | `eaea96c6239085f09aadca0fdedfc63b9c32662563edc448b3f2b0f7e6788eb8` |
| Delivered `sdk/assets/sw.js` and committed `packages/studio/public/sw.js` | `5838097a14d719e6117fce61a30a5d98d51a8f7e294307ae1e313148db55b404` |
| Delivered `runtime/assets/process-worker-ZQRq3H73.js` | `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7` |

Committed Kernel `openHttpStream`/close/output routing block is byte-identical
(block SHA `9a784569497c2b025b8d7d2802c6421221eeb446fa217e3d03e580b584caa651`).
Legacy `handleHttpRequest` block and `announceServing` function also compare equal.
The emitted SDK HTTP-stream section compares byte-identical. Comparing the emitted
client HTTP/endpoint sections exposed only a later Runtime cleanup-failure catch,
not an HTTP-stream implementation change.

Actual old/new combined `qa/serve-single-kernel.js` differs only in emitted source
comments: removing full-line comments produces identical text, SHA
`82b59adbf299c4b5ea93d65b1b62b2e14d49affd0a1afe27bbbccfda1437b57d`.
Both brokers serve `/client/`, `/runtime/`, `/prepared/`, fixture/API routes and
the same isolation/SW-allowed headers, prohibit inference, and otherwise return
404. **The manual held-vendor host is a different program** and was not the failed
combined host. Its hold admission semantics cannot explain this combined failure.

The new `vivari-asset-base` worker query is consumed by `vendorUrl`, not by the
HTTP request path. Broker path admission uses URL.pathname, so the query does not
change `/runtime/assets/...` admission. SW vendor bypass uses pathname, not an
exact full-worker-URL match. Direct readiness posts the same path `/` independently
of that query. This excludes a source-level query/path-filter explanation; it
does not claim that adding the query has no possible scheduling/performance effect.

Runtime differences are confined to loader ownership/lifecycle, tsgo install/vendor
adapters, launch/stop/finalize/error receipt plumbing, vendor URL resolution and build
delivery. New worker SHA is
`c4193ae0cba8419149738ed2b3a74d79d5f59f5e447eff129106ca2f3532fecb`;
old worker SHA is
`1901f5b19c06cfea796a84395a7e46d0159690c61deeba4451ffaaf672aeea7c`.
No changed HTTP opcode, SAB ABI, guest HTTP parser/process bundle, native SW,
endpoint body-credit protocol or response cleanup implementation was found.
New diagnostics had zero lazy operations/failures; that excludes an observed active
tsgo load, not every possible indirect runtime timing influence.

### Prepared inputs are not globally byte-identical

Compared manifests by destination, not content-addressed filenames:
12,290 old asset destinations all remain; 19 existing entries changed and 13 were
added. Every changed/added destination lies in the local toolkit workspace/chat
package closure. Vite, React Router, rolldown/backend dependencies and project,
sourcePaths, preview argv/env, OpenCode descriptor and dependency configuration
otherwise compare equal (runtime identity fields appropriately change).

The 13 additions are the chat package's qualified application subtree (directories,
server/native/WASM outputs, recipe and receipt). They are not new Vite backend
packages. Existing chat/workspace emitted modules mostly change source-path comments;
workspace index also carries actual Host URL/Execution stop/Runtime failed-launch
receipt changes. Thus no wholesale dependency-backend upgrade explains the failure,
but the delivered managed tree/images are not identical and their size/scan effects
are not measured or excluded.

Old/new image hashes:
`4eef600c73dc9b180c863ee50c0708795c983a8fc9817b5a056861c33193efae` /
`781f680722ff32bce616a7c7b058d7b53b75bf6462db7f5af0c700a1e102c18a`;
compressed bytes43,191,620 /43,248,637. Manifest hashes:
`00c58fb5a5af99d0820b5dd17ed91f48fa658866d0885daf71e233f72d911ad4` /
`a100c0250d17a4914259ed97a3d5998c564c2f2e7ada2affb7e8d6810bd4e273`.
Image compression deltas are not an execution memory/performance measurement.

## Observed timing: useful lead, not cause

| Event | Old application-success cohort | New failure cohort |
| --- | --- | --- |
| Vite service launch | 22:26:57.489Z | 00:48:35.891Z |
| Listener/connection healthy | 22:27:07.442Z | 00:48:46.723Z |
| Guest Vite ready output | 22:27:07.465Z | 00:48:46.741Z |
| Optimizer output / reload message | 22:27:27.080Z | 00:49:08.098Z |
| Chat launch (after readiness body/attach) | 22:27:27.419Z | absent |

Dates respectively2026-09-30 and2026-10-01 UTC. Old healthy→chat launch is
19,977ms; old optimizer output is19,638ms after healthy. New optimizer output is
21,375ms after healthy; numbered `0120.json` already observes failed status by
00:49:07.027Z,20,304ms after healthy. These are event/observation intervals, **not
precise fetch start/abort/header/EOF timestamps**. Both cold starts were near the
unchanged20,000ms request budget. This makes an optimization/deadline interaction
a concrete plausible lead, unlike a generic CORS explanation. It does not prove
which component exhausted a budget, why new cold work took longer, or that the
TypeError was produced by timeout/body error handling.

The final retained64-event syscall ring is FS reads/stats/fd closes for PID1;
total293,881 shows extensive actual guest work. It has no request paths, stream IDs,
headers, body sizes or historical optimizer-worker completion. Four WASM-init
warnings and favicon404 are the only retained browser messages; dropped logs0,
no pageerror. The failure store stringifies the error; no original exception stack,
cause or DOMException name/code beyond that string survives. No CDP Network request/
response/failure trace or HTTP-stream message trace is present in the raw cohort.

## Next smallest action: one bounded observer cohort, pending parent approval

Do not repair production on this evidence. Prepare **one fresh-copy/fresh-origin
observer cohort matching the original sequence through apps-1**, including the
eleven foundation stages and cold first launch; stop at its natural outcome.
Never replay origin63491 or alter frozen/candidate artifacts, budgets, assertions,
retries, prepared tree or inference policy. Instrumentation is observation-only
and must be separately reviewed/hashed before activation.

The missing receipts this cohort must collect are:

1. Public endpoint-fetch input/path and listener identity; monotonic fetch start,
   headers returned (status/raw relevant headers), body-read start/EOF/error,
   exact thrown stack/name/message/cause, and signal-abort reason/time. Transparent
   QA-only observation must return the original Response and perform **the one
   original body consumption**, not clone/read it twice or substitute native fetch.
2. A bounded tap of the actual HTTP-specific MessagePort/worker messages: open ID/
   path/PID, headers, pull/data byte counts, end/error/cancel and local settlement.
   Include legacy vv-http/probe ID/path separately so pendingHttp is attributable.
   Review the observer placement; do not infer these events from registry samples.
3. Passive native CDP Network events for page/kernel/process/SW targets and the
   exact combined host request URL/method/status/abort records. These establish
   whether any native broker request actually fails; absence of a readiness
   native request is expected for the direct channel. Record SW controller/scope
   and native request mode only where a native Request exists.
4. Bounded timestamped guest Vite stdout/stderr, PID/thread completion/error and
   syscall snapshots around readiness/optimizer completion, plus original public
   stop/drain/Workspace.close and native targets/locks cleanup receipts.

Use explicit per-domain count/byte caps and dropped counters; a cap overflow is an
incomplete observer receipt, not a passing diagnostic. Do not pause debugger frames,
add delays, force cleanup to pretend EOF, inflate deadlines or retry to fill gaps.
If this produces an unambiguous defective route/response/cancellation branch, propose
its smallest production fix and the observed-failure regression before implementation.
If it only exposes a cold budget race, separate deadline robustness, prepared-input
scan cost and runtime overhead causally; do not call that an Effect semantic defect.

## Readiness limits

Normal/held real-loader browser cases remain2/2 positive, foundation stages11 pass,
apps-1 failed, five generations/hydration/PDF/HMR/SSE and focused acceptance unqualified
for the pilot. Successful failed-cohort retirement is not app acceptance. Phase1's
bounded loader qualification is useful; integrated acceptance and phase2 remain gated.
Known guest markAsUncloneable, editor busy/recovery/target retention, path security,
all-writer ownership and performance/pin promotion are excluded, not explained away
by this HTTP investigation.
