# Awaitable local reader fence — live reuse pilot remains gated

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-opencode-reader-fence-gated-pilot.md`

## Outcome

Implemented the prerequisite **awaitable local chat disposal** and tested safe
**join → evict → acquire** ordering against pinned Effect `4.0.0-rc.112`.
**No live A→B pilot was attempted.** The packaged OpenCode `2.0.3` HTTP API still
does not prove remote location-reader release/finalization. The authorization was
conditional on proving that lifecycle; local success does not discharge it.
There is no speculative DELETE, broad eviction helper, replacement attempt or
production switch-strategy change in this commit.

This follows `d440efa` and
`docs/experiments/2026-09-30-opencode-process-reuse-source-review.md`.
OpenCode/Effect skills and V2 API/config/client documentation were consulted:

- <https://opencode.ai/v2/docs/api>
- <https://opencode.ai/v2/docs/config>
- <https://opencode.ai/v2/docs/build/client>

Current documentation is not substituted for the pinned server contract.

## Library/API change

- `ChatController.dispose(): void` becomes `dispose(): Promise<void>`.
  It freezes admission synchronously, invalidates callbacks, clears listeners,
  joins its root scope, joins the injected transport and response-body cleanup,
  then releases the managed client runtime. Repeated calls return the same promise,
  including after failure. Legacy callers may still ignore completion; awaiters
  observe cleanup failures. It does **not** interrupt remote sessions.
- `opencode-chat/src/reader-fence.ts` tracks injected fetch promises independently
  of Effect interruption. A fetch ignoring abort keeps disposal pending. Responses
  arriving after closure have their bodies cancelled and their cancellation
  promises joined. Body reads and cancellation are accounted for, including SSE
  and JSON reads after the fetch promise has resolved.
- Cancellation errors are retained for disposal even though the pinned Effect
  Web-stream adapter can suppress them. Failed/unresolved cleanup does not become
  a successful fence. There is no timeout that converts uncertainty into success.
- Public request admission rejects after disposal without launching additional
  HTTP work. Archive admission keeps its existing synchronous disposed check.
- Controller test teardown now awaits disposal. README documents the await and
  local-only ownership boundary. No archive/IRS/autosave code was changed.

This adapter wraps bodies for the official client's body/status/header interface;
it does not promise to preserve native Response URL/redirect metadata. The fence
can only join the cancellation/settlement contract provided by the injected
transport, not unreported producer or remote work.

`attachChat`/workspace attachment cleanup remains void and is **not** silently
upgraded into a switch fence. A future reuse consumer must retain the outgoing
controller, await disposal explicitly, release its attachment/cache, and prevent
incoming attachment until the remote fence and eviction have both joined.

## Deterministic coverage

Final focused run: **43 pass, 0 fail, 179 assertions**, no network/model traffic.

- Delayed SSE cancellation holds disposal pending; repeated disposal has identical
  promise identity and disposed admissions launch no additional requests.
- Delayed history, archive, permission reply, form reply and post-acceptance
  refresh transports are aborted locally but remain in the fence until the
  injected fetch settles **and** its late body finalizer settles. Snapshots remain
  unchanged throughout cleanup. Prompt acceptance is a mock-only fixture.
- Body consumption is joined after fetch resolves; unresolved cleanup prevents a
  test caller from proceeding to eviction/acquisition. Failed cancellation rejects
  the cached cleanup and never permits that continuation. A controller-level SSE
  failure also rejects `dispose()` for the awaiting owner and blocks reconnect.
- Matching RcMap test delays a controlled non-model Effect task's interruption
  finalizer, closes its reader scope, then invalidates the zero-reader entry.
  Eviction itself remains pending during the delayed location finalizer. Only
  after finalization completes does same-key build 2 occur. The incoming reader
  is also closed and evicted; both location finalizers complete.
- Failed reader-scope finalization leaves the key uninvalidated and build count 1;
  no replacement is acquired.
- An explicit local/remote ownership negative shows local transport cleanup can
  finish while separately controlled remote work remains unfinalized. It is not
  counted as a packaged server/core-tool test.

The RcMap test is an offline dependency contract, **not** a supported OpenCode
core/session tool harness. No fake transcript or inference was used to claim
server tool cancellation.

## Concrete blocker and required remote sequence

The retained bundle was read-only and its identity reverified: **27,721,709 bytes**,
SHA-256 `1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929`.
Evidence preserves these numbered pinned boundaries:

| Boundary | `server.js` lines | What it does not prove |
| --- | --- | --- |
| Interrupt / awaitIdle | 81953–81982; 451912–451915 | Wait covers execution coordinator, not all HTTP/location readers |
| Location middleware | 555276–555281 | Client cancellation is not an acknowledgement that server reader scope has joined |
| RcMap invalidate | 15614–15627 | Removes key and returns if references remain |
| Location invalidate | 552774–552815 | RPC close is not a reader/refcount completion receipt |
| Debug location endpoints | 557373–557378 | Lists keys; no reference count or await-all-reader/finalization barrier |

The safe dependency ordering is now demonstrated, but **there is no proved API
receipt tying client disposal to zero remote location references before DELETE**.
Session idle/active-empty, local fetch settlement and debug-key absence cannot
replace that receipt. There is also no exercised supported packaged/core harness
for controlled model-facing tool interruption/finalization in this phase.
Consequently the live admission gate remains false and execution stops here.

If a supported remote fence is subsequently proved, the consumer must freeze all
outgoing admission; account for all owned sessions/children and independently
owned shell/PTY/background work; interrupt and wait every session; await old
client readers **and remote reference/finalizer receipts**; then evict, await
eviction and only then acquire the incoming location. The pinned reset remains:

`DELETE /api/debug/location?location%5Bdirectory%5D=%2Fworkspace`

There is **no server API change** in this work. Changed managed dependencies,
plugin/module bytes, launch environment, runtime payload or working directory
still require restart fallback. This phase does not implement/qualify that
admission-policy comparator or its negative cohort.

## Attempts, timing, identity and retained resources

| Item | Exact phase result |
| --- | --- |
| Live origins / OpenCode launches | **0 / 0** |
| A→B reset attempts / passes / failures | **0 / 0 / 0**, prerequisite blocked |
| Replacement/repeat/cohort attempts | **0** |
| Live sessions / model calls | **0 / 0** |
| Browser operations / Vite starts / consumer builds | **0 / 0 / 0** |
| PID stability, incoming config/project freshness, fresh empty session | **Not measured** |
| Process launch vs reset/reinit latency | **Not measured**, no synthetic timing substituted |

Five focused test invocations were made during implementation: first **38 pass,
1 fail** (the new disposed-admission test exposed closed-scope interruption rather
than the intended disposed error), then **39/0**, **41/0**, **42/0**, final **43/0**. The
admission implementation was corrected; these are development validations, not
five live pilots. Four targeted typecheck invocations: first failed on five
new test calls omitting a required fetch init, then three passed after making the
private fence wrapper's init default explicit. Two full package typechecks failed
on the same four existing `src/browser.ts` workspace-export/signature errors.
One additional untouched-HEAD baseline typecheck reproduced those exact errors
at `22e4a00d67f1edbb00e050e1288918f43d073e7f`; no dependency/build repair was made.

Runtime target remains clean `446df00f86d5d6d5d856a2e5deec0fac49f242fa`; no runtime
was launched, rebuilt or repinned. Because the gate failed before launch, no
isolated consumer build or workspace payload writes were warranted. Retained
43222/43223 listeners were only inventoried read-only (Bun PIDs **6885/7042**);
their servers/pages/evidence were not changed. No newly owned server/process/page
requires shutdown. Test controller/scoped resource cleanup is joined.

This is **not a full-switch speed result** or mounted-model-usability result.
The prior five chat-only samples still have **0 ms** idealized wall critical-path
headroom because preview completed later. No Vite retention claim is added.

## Evidence and commands

New, inventory-checked evidence directory (prior evidence unchanged):
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/opencode-reader-fence-20260930/`

It contains inventory, bundle identity, pinned boundaries, captured final
validation and the read-only HEAD-source baseline typecheck copy/result.

From `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/opencode-chat`:

```sh
bun test test/controller.test.ts test/reader-fence.test.ts test/location-fence.test.ts
bun x tsc --noEmit --target ES2023 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --lib ES2023,DOM,DOM.Iterable src/controller.ts src/reader-fence.ts test/reader-fence.test.ts test/location-fence.test.ts
bun run typecheck
```

The first two final commands pass. Full package typecheck retains the reproduced
baseline failures. `git diff --check` passes. Only this phase's own library,
tests and report are committed; no push/deployment/pin/auth/IRS edits occurred.
