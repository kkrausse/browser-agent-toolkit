# Frozen preview adapter: offline reason / cleanup regression

**Adapter gates pass; old failure unexplained.** One execution of one finite
10-case regression set passed on actual Node 24.18.0. No unexpected assertion
failure, retry, browser loop, server, inference, install, build, production change,
deadline change, pin change or phase2 migration occurred.

Absolute report:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-preview-adapter-reason-cleanup-qa.md`.
Assignment/report date 2026-09-30; execution follows the retained readiness trace.

## What ran

New fixture/runner (single TypeScript executable):
`examples/todo-app/tests/effect-preview-adapter-reason-cleanup.ts`.
It imports the **actual unchanged built SDK `createEndpoint` public endpoint**,
which calls its production `fetchHttpStream`; neither implementation is extracted,
rewritten or modeled. Native Node MessageChannels, Request, Response and Web Streams
execute the real adapter. Only the host posting/guest protocol leaf and upload
source are controlled offline. `location.href` supplies inert endpoint URL metadata.
No Kernel, guest HTTP stack or browser/network execution is claimed.

Read both prior investigation and readiness-trace reports in full. The observed
HTTP200 at 11.12s, body EOF at 17.31s and timeout at 20s are **successful trace
boundaries**, not rejection receipts. Optimizer output at 16.91s is not a diagnosed
cause. Page-only tracing, 12 drops, missing legacy probe/WASM receipts and the
driver's outer export timeout remain limitations of that separate cohort.

### Finite denominator: 10 PASS / 0 FAIL / 0 unrun

| Case | Actual public outcome / cleanup assertion |
| --- | --- |
| Already aborted before admission | Exact supplied DOMException; no transport post; endpoint settles |
| Abort before headers | Fetch rejects with exact supplied reason; cancel observed; channel closes; endpoint settles |
| Abort during body | HTTP200 resolves; original body read rejects with exact supplied reason; same completed cleanup |
| Abort after body EOF | HTTP200/plain-text headers and complete body; late abort causes no cancel/public error; cleanup finishes |
| Guest error before headers | Fetch rejects with `Error: offline guest ECONNRESET`; cancel/channel/endpoint cleanup finishes |
| Guest error during body | HTTP200 resolves; body rejects with same typed wire-message Error; cleanup finishes |
| Native host-post failure | Exact original `TypeError: offline native post failed`, including original `cause`; endpoint settles |
| Upload read rejection | Exact original `TypeError: offline upload read failed`; no self-join; reader unlocked and endpoint subscription removed |
| Held upload read/cancel, abort | Exact TimeoutError; endpoint stays unsettled/reader locked while source cleanup is held, then joins completion/unlocks |
| Held upload read/cancel, EOF then late abort | Body EOF succeeds; late abort is harmless even while source cancellation is held; endpoint waits, then completes/unlocks |

Abort reasons are explicit `DOMException('signal timed out', 'TimeoutError')`,
code23. Assertions compare object identity, not just rendered text. **No actual
20-second sleep** or replacement request budget is used: controllers deterministically
trigger the relevant lifetime boundaries. Message receipts, source pull-entry,
cancel-entry and explicit release promises are handshakes; there are no retries,
deadline padding or generic fuzz scaffolding. The 5-second watchdog is failure-only.

Native Web Streams cancel resolves an outstanding reader read. The held fixtures
keep the real upload source pull and cancellation unfinished until explicit release;
the cancellation promise joins that pull. The real adapter owns the reader/read
task and its continuation. These cases prove its endpoint receipt does not finish
while this source cancellation is held, and that all source work has finished and
the reader is unlocked at settlement. They do not claim an independently stalled
native reader continuation or arbitrary ignored-cancellation behavior.

The source-read negative case asserts the expected **rejected** cleanup receipt,
not a swallowed-error success:

```text
public fetch: original TypeError: offline upload read failed
endpoint.settled: AggregateError: Endpoint cleanup failed
  AggregateError: HTTP source cleanup failed
    original TypeError: offline upload read failed (read task)
    original TypeError: offline upload read failed (cancel of errored source)
```

Both nested reasons retain the original object; source lock release and endpoint
subscription removal finish. This is the expected negative receipt, not a discovered
adapter bug. Wire guest errors intentionally reconstruct `Error(message.error)`;
their original guest class/stack/cause are not carried by this string protocol.
The fixture asserts that actual contract rather than inventing richer preservation.

## Actual 20s signal lifetime / terminal state

Read-only source inspection: `endpoint.ts:54–66` combines caller timeout and
endpoint lifetime via `AbortSignal.any`, then creates the Request. Fetch resolves
at headers; the adapter's abort handler remains active through body consumption.
Before EOF it fails fetch/body using **`request.signal.reason`**, without converting
it into `TypeError: Failed to fetch`.

`http-stream.ts:21–39,100–110`: EOF closes the body and synchronously marks the
adapter closed, removes its Request abort handler, closes its channel and invokes
the endpoint's close callback. Cancellation/read tasks are joined separately;
reader release precedes cleanup settlement. A read task invokes failure/cleanup
without awaiting its own receipt. `endpoint.ts:17–21,27–36` tracks cleanup receipts;
public dispose joins them and propagates their aggregate failures.

The caller's original `AbortSignal.timeout(20000)` timer is not cancelled by
Response EOF. It may still abort its linked Request signal later, exactly as in
the real trace, but that no longer has a live adapter handler. **Late abort after
EOF is a correct adapter no-op**, not evidence of a public error or unjoined
source cleanup. The held EOF case specifically covers the interval between body
completion and upload cleanup completion. This is bounded lifecycle evidence,
not a browser GC/retained-signal memory-leak measurement.

## Exact unchanged identity

Frozen input:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-full-app-UMORaL/frozen`.

Runtime remains **`3ee918522c1233a1f8e10a9b798c09b6c3e30c81`**, toolkit candidate
remains **`9814c715cfca42309c581440577976833f4326e6`**. This QA commit is not a new
runtime/delivery revision. Runner verifies frozen receipt identity and exact SDK
hash before import and after cases. Adapter source working-tree bytes are checked
against those committed objects and compared read-only with exact baseline
`33fa1359a003ca9c50cb3bc49699b99bc1a063f1`; both files are identical.
No whole-baseline benchmark was run.

| Input | SHA-256 |
| --- | --- |
| Actual frozen `sdk/host.js` | `14e5b1e965c4645ccbed41a93536db8b941b5ed076225dfea9288d9a0b5dfc87` |
| `packages/core/src/host-sdk/browser/endpoint.ts` | `440225c7550abdf865ba6be414b3dbf5f9c7b5f766d0230f279851739570505a` |
| `packages/core/src/host-sdk/browser/http-stream.ts` | `62a44cf02af97fd1fd27ed220ea348e802943a99247ddbd0c58a459d8edc6295` |
| Actual qualified Node executable | `ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a` |

Actual executable (not PATH Node/Bun):
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-qualified-node-toolchain-20260930/node-v24.18.0-darwin-arm64/bin/node`.
Runner asserts `process.version === 'v24.18.0'`; receipt records executable path/hash.
Targeted input identity checks are not a new full 9,721-file delivery verification.

## Receipts / reproduction

Evidence directory, never overwritten:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-preview-adapter-reason-cleanup-evidence-20260930`.

- `identity.json`: actual version/executable/source/built SDK identity;
  SHA256 `69ff0bf5a834d43c2284e9ad73ab9f51c339605327304829df2ef7da0bf18f73`.
- `results.json`: 10 named results, actual MessageChannel protocol receipts,
  source cleanup handshakes and raw public error name/message/stack/code/cause/
  aggregate reasons;
  SHA256 `f155f35213e08658df26ea0e1e38b727e150648a54b6d44a06a2940be54ebdcf`.
- If an unexpected assertion fails, runner stops immediately and writes
  `failure.json` with original reason/stack, current case and preceding state/events.
  No unexpected assertion failed in this execution.

Reproduction form (not authorization to rerun): invoke the absolute qualified
Node above with the new fixture path, frozen path, runtime source path
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/vivari-effect-loader-pilot`,
and a **new** output directory, in that order. It performs no installation/build.

## Parent recommendation / remaining gates

No minimal production fix is justified by this set. It specifically clears the
bounded adapter reason/header/body/cleanup concern, **not the historical failure**.
The old apps-1 `TypeError: Failed to fetch` lacks its original stack and header/body
boundary; these passes cannot retrospectively assign its cause to timeout, optimizer,
Effect or transport. Native messageerror/deserialization faults, real guest/network
failures, WASM/legacy probes, browser scheduling, performance and arbitrary source
cancellation remain outside this controlled-leaf denominator.

**Recommend one UNCHANGED fresh full acceptance attempt, subject to parent approval,
rather than another speculative audit/deeper trace now.** The genuine successful
readiness trace plus these finite adapter gates support moving back to the actual
acceptance gate. Keep the original 20s bound, actions, assertions, prepared candidate
and inference policy; this report does not itself authorize that run. If that attempt
fails, stop and preserve its original public reason/stack and headers/body/cleanup
boundary; deepen only the implicated trace. Do not repeat the partial page-only
observer and treat it as complete native coverage.

Full suite/focused acceptance still unqualified until that independent gate passes.
No promotion, editor/guest API/path security/all-writer fix, or phase2 is implied.
Only this new report and new fixture/runner are owned; other staging is preserved.
