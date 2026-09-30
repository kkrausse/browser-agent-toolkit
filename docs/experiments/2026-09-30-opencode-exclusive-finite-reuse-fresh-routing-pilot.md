# Fresh routing-corrected finite-reader reuse pilot — stopped before reset

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-opencode-exclusive-finite-reuse-fresh-routing-pilot.md`

## Outcome and small blocker

**Routing/startup qualification succeeded; process reuse was not established.**
The separately authorized fresh attempt stopped at `Error: Root explicit location`
in `reuse-pilot-client.ts:55`, before any reset or DELETE. No retry, replacement,
budget extension, config B write, or model/tool/shell/PTY/execution-RPC call occurred.

The precise caller defect is that `GET /api/session/:sessionID` returns
`{data: session}`, but lines 54–56 test the envelope as the session. The packaged
2.0.3 handler at `server.js:556252–556255` explicitly returns that envelope.
Thus `session.location` is undefined at the assertion, irrespective of the nested
session's location. The actual response body was not retained before this assertion;
no additional guest request was issued to recover it. The minimal prospective fix
is to unwrap `.data` and retain the session/snapshot before asserting, then verify
the remaining field assertions offline against the packaged schema. **That fix
and another live attempt were not performed or authorized by this run.**

The controller had already passed its ready/empty-history assertion (nonloading,
no snapshot error, session ID present, zero messages). Full session/root-location
qualification still failed; this is not a qualified successful cold baseline.

## Narrow routing verification and frozen build

This follows, but does not relabel, the prior failed origin documented in
`2026-09-30-opencode-exclusive-finite-reuse-pilot.md` at `3f821d8`.

Read the exact pinned SDK `host-sdk/browser/endpoint.ts:33–55`: it admits only its
own preview prefix, removes `/preview/4096/` and `__vv_listener`, and forwards the
remaining guest path/query using the owned port/listener ID. Read the pilot URL
composer and descriptor callers, and `opencode-chat/src/api.ts:111–128`: the
official controller client composes the prefix as its base URL and reinserts the
listener query. No runtime source change was needed.

Added a focused offline test importing the **actual pinned SDK endpoint**. Its
stub host throws at the transport boundary after capturing metadata: corrected
config URL becomes exactly `/api/config?location%5Bdirectory%5D=%2Fworkspace`, port
4096, listener `owned`; the old root-absolute URL rejects before host dispatch.
No guest process/HTTP is used by that test. Existing route-admission regressions
remain. The test imports the already verified isolated source checkout; it is an
experiment test, not a portable library test requiring that diagnostics fixture
on a clean checkout.

Two focused invocations each passed **52 tests, 0 failures, 223 assertions** across
pilot fence, controller, reader fence and location fence. One fresh preparation
completed, including targeted TypeScript checking; a separate final targeted
check also passed. No offline failures occurred in this phase. Final logs are in
the new evidence directory. `git diff --check` passed.

Served **new isolated library/consumer builds**, not the original failed artifact.
Preparation verified 10,528 managed/payload files; runtime source was clean pinned
`446df00f86d5d6d5d856a2e5deec0fac49f242fa`, distribution
`4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a`.
Packaged OpenCode 2.0.3 bundle remains SHA-256
`1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929`.
New client: **1,919,308 bytes**, SHA-256
`2aecf2605b5cf32037e720cd3c4c2df5ed4f7dd79e9eca17b5bc1951319a578c`.
Receipt, local bytes and actual host-served bytes agree; build was not modified
after navigation. The server accepts an explicit fresh port argument now.

## Predeclared controlled protocol and exact attempt counts

Receipt/code fixed budgets before navigation: one cold startup, at most one A→B
reset; 90 s cold, 60 s reset, 20 s request/drain, 15 s healthy cleanup, 180 s
observation; first failure stops, zero retries/replacements/extensions.

The approved protocol remains exclusive owned 2.0.3, finite normally successful
fully consumed responses only. Reset order is freeze admission → join normal
finite calls → awaited local controller disposal → awaited explicit location
DELETE at refs zero → only source/config replacement → fresh incoming session.
Global SSE has no location lease; local disposal must join its cancellation.
Aborted, timed-out, failed or unresolved finite work never licenses eviction.
No reset boundary was reached here.

| This separately labeled attempt only | Actual |
| --- | --- |
| Fresh origins / host servers / cold launches | 1 / 1 / 1 |
| Accounted guest HTTP calls | 16: 15 normal fully consumed finite responses, 1 global SSE HTTP 200 |
| Failed/aborted/timed-out finite calls | 0 |
| Session creation | 1: `ses_f0f6d9d9bffecKLPYjVduLx2iL` |
| DELETE / A→B reset / incoming acquisition / B writes | 0 / 0 / 0 / 0 |
| Retry / replacement / budget extension | 0 / 0 / 0 |
| Model inference / tools / shell / PTY / execution RPC | 0 each |
| OpenCode guest PID | 1 observed at health; A→B stability not measured |
| Config/plugin/project | A marker `reuse-pilot-A`, both editor plugins active, `/workspace` project resolved |
| B freshness / distinct B session / reset/reinit speed | Not measured |

The historical prior attempt remains one cold launch, zero guest HTTP,
zero reset, zero sessions. Across these two labeled attempts there were two cold
launches and zero resets, **not** one successful retry or reuse cohort.

| Timing | ms |
| --- | ---: |
| Environment delivery | 1630.615 |
| Spawn accepted / listener wait (rounded diagnostic stages) | 53 / 7167 |
| Cold server readiness qualification | 13456.540 |
| Cold client hydration plus failed session qualification | 6559.955 |
| Cold launch through failed final qualification | 27238.820 |

No cold-vs-reset speed ratio or full-switch speed claim is supported.

## Evidence, ownership and retained work

Distinct evidence absolute directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/opencode-exclusive-reuse-2026-09-30T04-27-59-438Z/`

Contains frozen `receipt.json`, isolated builds/config, `live-evidence.json`
(524,068 serialized characters), final test/typecheck logs and
`served-client-identity.json`. Evidence export was one-write HTTP 200; older
evidence was not overwritten.

Sole browser owner: Bun-backed Browser Control CLI session **`tidy-falcon-686`**,
page **`http://127.0.0.1:43225/`**, host Bun PID **1493**. Four successful executes:
fresh navigation, status read, terminal-status wait/read, one evidence export.
No browser failure, reload, replacement, adoption or second navigation. No
Browser Control MCP, raw CDP or other browser owner was used.

Failure preservation: **controller, open global SSE, guest server and page remain
owned and retained**. No manual disposal, server stop, DELETE, page/session
deletion or host shutdown followed the assertion failure. Joined cleanup and
final zero-work diagnostics are not claimed. The service launch had succeeded,
so the prior run's failed-readiness auto-cleanup is not applicable here.

Read-only listener inventory confirms the untouched prior host resources:
43222/PID 6885, 43223/PID 7042, 43224/PID 90779. In particular,
`clever-tiger-361` and its 43224 origin were not revisited or retried. All older
pages/servers and runtime pins remain untouched. No push/deployment, archives/IRS,
runtime regeneration or production strategy change occurred.

## Remaining production gap

This restricted finite-success protocol does not supply a production
cancelled/concurrent-reader close-admission/drain receipt. Fetch cancellation or
settlement is not proof of remote location-lease release; DELETE at nonzero refs
still risks stale-release/same-key reacquisition. That production cancellation
gap remains unresolved and separate from this small caller-envelope blocker.
