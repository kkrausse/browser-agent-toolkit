# Contract-preflight controlled reuse pilot — stopped before reset

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-opencode-contract-preflight-controlled-reuse-pilot.md`

## Outcome

**Session-envelope caller fixed; one separately labeled fresh attempt failed at
the new session-list wire validator. No reuse measurement was established.**
There was no retry, replacement, budget extension or second fresh origin. This
does not relabel the failed attempts at `3f821d8` or `7f5c091`.

The failure was `Pilot contract: paged data/cursor` for HTTP 200
`GET /api/session?order=desc&directory=/workspace`, propagated through
`HttpClientError` → `ClientError` → `ChatAPIError` → `ChatError` during controller
bootstrap. The validator fully consumed that response before rejecting it. The
controller then cancelled its concurrent model-catalog read; that read records
`AbortError: signal is aborted without reason`, with no response status recorded.
Neither failed call licenses location eviction. Execution stopped before session
creation, outgoing disposal, DELETE, B writes or reacquisition.

**The offline fixture preflight was insufficient to guarantee actual packaged
wire parity.** Its empty paged fixtures passed but the actual response failed.
The failed response bytes were not retained: the paged predicate checks data is
an array, cursor is a non-array object, and present cursor entries are strings.
Evidence cannot identify which clause failed. No additional guest request was
issued to recover the body, and no speculative cursor/null/array fix was made.
This is a caller/preflight limitation, not proof of a server or runtime defect.
A future authorization would first need byte-preserving failure diagnostics and
offline coverage of the actual representation; this report does not authorize it.

## Changes and offline preflight

`reuse-pilot-client.ts` now retains the raw session envelope and snapshot before
checking, unwraps `data`, checks the requested ID, explicit `/workspace` root
location and optional `workspaceID`, absence of parent/fork/model/permissions/
metadata, idle empty hydration and project identity. First failure also freezes
future transport/source-write admission through the existing stopped flag.

Added `reuse-pilot-contract.ts` and `reuse-pilot-contract.test.ts`. The finite
fence validates normally consumed wire bodies before admitting completion. The
offline table covers health, bare config entries, bare current-project identity,
plugin/model location+data envelopes, activation 204, session create/get data
envelopes, session/history paged arrays, active data record, permission/form data
arrays, interrupt's bare boolean result (offline only), debug-location bare refs
and DELETE 204. Every table entry rejects tagged HTTP errors and error-as-success
wrappers. Tests cover optional session settings, malformed history, and the
actual controller/SDK cold→joined SSE cancellation→DELETE→fresh root acquisition
with injected offline responses. Live interrupt remains forbidden and unused.

Read the actual frozen packaged 2.0.3 schemas and handlers, including session
list/create/get/active/interrupt, message history, permission/form list, config,
plugin/model, project, debug-location and health. Source-backed tests pin the
bundle hash and representative handler/schema details; SDK adapter checks confirm
which responses unwrap `data` and that message pages retain their envelope.
Notably packaged session/history handlers construct `{data, cursor}` with omitted
undefined cursor entries; `Location.Ref` uses `workspaceID`, not `workspace`.
This establishes source/fixture coverage, **not** the failed live-byte equivalence.

Focused tests (contract, pilot fence, controller, reader fence, location fence):
**71 passed, 0 failed, 316 assertions**; two invocations, final 1.309 s.
Preparation's targeted TypeScript check and a separate final targeted check both
passed. `git diff --check` passed. No offline failure was suppressed.

## Frozen identity and budgets

Evidence absolute directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/opencode-exclusive-reuse-2026-09-30T04-40-47-609Z/`

Preparation verified **10,528 managed/payload files**, clean runtime source pin
`446df00f86d5d6d5d856a2e5deec0fac49f242fa`, frozen distribution
`4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a`.
Actual packaged server 2.0.3 SHA-256:
`1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929`.
Corrected isolated client: **1,923,570 bytes**, SHA-256
`70aeab478548975db0f54480fcec96204d65849639dc1978b53cd58e5875709e`.
Receipt and actual host-served bytes agree in `served-client-identity.json`;
the served client was not modified after navigation.

Before navigation: one cold launch, at most one reset; cold 90 s, reset 60 s,
finite request/drain 20 s, healthy cleanup 15 s, observation 180 s. First failure
stops; zero retries/replacements/extensions. Existing reset protocol remains
freeze→join normal finite requests→await local disposal/global SSE cancellation
→await DELETE at zero refs under exclusive finite-owned-handler assumptions
→replace source/config→reacquire. Reset admission records explicitly distinguish
the inferred zero-ref assumption from a remote release receipt. This run never
reached that boundary.

## Exact attempt counts and timing

| This labeled attempt only | Actual |
| --- | --- |
| Fresh origins / host servers / cold launches | 1 / 1 / 1 |
| Accounted guest HTTP calls | 10: 7 normal finite, 1 global SSE HTTP 200, 2 failed finite |
| Contract rejection / aborted finite / finite timeout / pending at export | 1 / 1 / 0 / 0 |
| Session create / DELETE / reset / reacquire / B writes | 0 / 0 / 0 / 0 / 0 |
| Retries / replacements / budget extensions | 0 / 0 / 0 |
| Model inference / tools / shell / PTY / execution RPC | 0 each |
| Guest OpenCode PID | 1 at health; no reset stability measurement |
| Configuration/plugin/project A | `reuse-pilot-A`, both editor plugins active, `/workspace` |
| Configuration B / distinct session IDs / reinit markers | Not measured |

The fence counts do not include the owned service's native readiness probe:
existing process output separately records `GET /` HTTP 401. A model-catalog read
is not model inference. Internal controller request concurrency is still owned
finite work, not another actor. Failed/aborted/pending work never permits DELETE.

| Timing | ms |
| --- | ---: |
| Environment delivery | 1798.805 |
| Spawn accepted / listener wait (rounded diagnostics) | 80 / 8574 |
| Cold readiness qualification | 15890.940 |
| Cold hydration until contract failure | 669.420 |
| Cold launch through failed qualification | 25216.600 |
| Reset / DELETE / reacquisition / cleanup | Not attempted |

No cold-vs-reset ratio or full-switch-speed claim is supported. Across the three
labeled historical attempts there are three cold launches and zero resets, not
a reuse cohort.

## Ownership and preservation

Sole browser owner: Bun-backed Browser Control CLI session **`clever-comet-943`**,
page `http://127.0.0.1:43226/`, host Bun PID **12962**. Free-port listener inventory
preceded launch. Three successful executes: one navigation, one terminal-status
wait/read, one evidence export. No browser failure, reload, replacement, adoption,
MCP or raw CDP. Export returned HTTP 200, **509,752 serialized characters**.

Failure resources remain retained; no manual controller disposal, service stop,
location DELETE, page/session deletion or host shutdown. The controller's failed
bootstrap internally cancelled work: guest logs report `/api/event` HTTP 200 with
`InterruptError: All fibers interrupted without error`. Thus an open SSE is **not**
claimed for this new origin, nor is successful joined cleanup/remote release.

Untouched retained origins: 43222/PID 6885, 43223/PID 7042,
`clever-tiger-361` 43224/PID 90779, and **`tidy-falcon-686` 43225/PID 1493** with
its retained controller/SSE/server. Neither prior page was revisited. Older
evidence remains intact. No runtime edits/pin changes, IRS/archive work,
deployment, push, model calls or production strategy change occurred.

The production cancelled/concurrent-reader admission/drain/remote-release fence
remains a separate unresolved gap. This failed restricted pilot cannot close it.
