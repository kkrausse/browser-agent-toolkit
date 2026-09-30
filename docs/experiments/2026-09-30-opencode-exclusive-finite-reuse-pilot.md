# Exclusive finite-reader OpenCode reuse pilot — first failure, stopped

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-opencode-exclusive-finite-reuse-pilot.md`

## Outcome

**The authorized single cold attempt failed at the caller's endpoint routing. No
A→B reset was attempted.** The request gate failed closed; no DELETE, incoming
acquisition, B source/config write, model call, or replacement/retry occurred.
This is not a successful process-reuse or switch-speed result.

The first request was accounted as failed:
`GET http://127.0.0.1:43224/api/health`, error
`URL belongs to another endpoint`. Resolving a root-absolute guest path with
`new URL(path, endpoint.url)` discarded the owning `/preview/4096/` bridge prefix.
The pinned endpoint rejected it **before sending guest HTTP**. The server's
listener had been observed, but health/PID/config/plugin/session qualification
had not begun successfully. This is a pilot-caller defect, not evidence against
OpenCode location reuse or a Browser Control failure.

The caller routing has since been corrected **offline only**: preserve the
endpoint prefix and listener query, normalize the owned prefix for route
admission, and refuse host-root/other-endpoint routes. A focused regression passes.
The retained served client is the original attempted artifact; it was not replaced,
rebuilt in place, reloaded, or rerun after failure. A later live attempt requires
new authorization and a newly isolated build/origin.

## Reviewed packaged-source basis (not generic V2 assumptions)

This follows `d702c7e`'s awaitable local disposal, the reader-fence gated report,
and the process-reuse source review. The parent supplied an independent read-only
review without a separate report commit; its decisive conditions are preserved
here, and the actual numbered source was inspected again.

Actual bundle:
`vivari/.runtime/opencode-release-2.0.3/.runtime/opencode-bun-server/server.js`

- OpenCode **2.0.3**, upstream tag
  `d44b52ca66b6bf69626c0384626d1a9cd9555977`.
- **27,721,709 bytes**, SHA-256
  `1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929`.
- Preparation reverified this bundle and the frozen runtime/managed artifact
  hashes, including **10,528** managed/payload file checks per completed receipt.
- Runtime source remains clean
  `446df00f86d5d6d5d856a2e5deec0fac49f242fa`; distribution
  `4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a`.
  Existing pinned source and frozen payload were reused read-only; no runtime
  rebuild, runtime edit, or production pin change occurred.

| Packaged boundary | `server.js` lines | Restricted implication |
| --- | --- | --- |
| Location middleware | 555276–555281 | Finite handler is provided with the location layer |
| `provideLayer`, scoped close | 10258–10265; 5960–5969 | The provide scope joins release before returning normally |
| API handler/encoding, success send | 454325–454381; 37659–37699 | Normal finite success send occurs after that provided handler completes |
| Global event contract/handler | 518305–518315; 557162–557181 | `/api/event` is global feed SSE, not a held location lease |
| Ref acquisition / invalidate | 15610–15627 | DELETE joins entry finalization only when references are already zero |
| Old-reference release | 15521–15524 | Release checks key presence; evict/reacquire with old refs is a real same-key hazard |
| Location invalidation | 552774–552815 | Await inner invalidation then RPC close; not an independent all-reader fence |
| Explicit DELETE handler | 557373–557378; 518465–518472 | Awaited `DELETE /api/debug/location` invokes that invalidation |
| Routing, project, session | 555262–555267; 558325–558329; 452206–452243 | Explicit directory routing; same-directory project resolution; fresh root session |

For this **exclusive no-execution** pilot, normally successful, fully consumed
finite responses are sufficient under the reviewed handler ordering. This
narrows the earlier report's gate; it does **not** turn cancelled/aborted/timed-out
fetch settlement into a server lease receipt. Any such request, unresolved work,
failed disposal, or failed DELETE forbids further eviction/write/acquisition.

Admission excluded model inference, tools, shell, PTY, execution RPC, moves,
children, other clients, changed dependencies, plugin/module bytes, launch
environment, cwd and runtime identity. Global SSE cancellation is joined by the
awaited `ChatController.dispose()`, not misrepresented as a location-reader
cancellation acknowledgement. The production cancelled/concurrent-reader
close-admission/drain gap remains explicitly separate and unresolved.

## Experiment-only code and tests

New files under `examples/todo-app/tests/`:

- `reuse-pilot-fence.ts`: freeze admission synchronously, enumerate exact
  finite/global-stream requests, consume finite bodies before declaring normal
  success, reject cancellation/failure/uncertainty. Required ordering is
  **freeze → normal finite drain → awaited controller disposal → awaited explicit
  DELETE → source/config documents → incoming activation/readiness/new session**.
- `reuse-pilot-fence.test.ts`: delayed body consumption, delayed disposal/DELETE,
  admission after freeze, cancellation, unresolved deadline, failed disposal/DELETE,
  no writes/reacquisition on failure, and the endpoint-prefix regression.
- `reuse-pilot-client.ts`: one exclusive owner; pinned activation/plugin/config/
  project/model-catalog requests and controller hydration all use the ledger;
  only root session creation is admitted as a session mutation. It changes an inert
  `username` marker A→B while preserving model configuration and plugin bytes.
- `prepare-reuse-pilot.ts`: frozen payload/hash verification, isolated library and
  consumer builds, clean pinned host SDK resolution, targeted consumer typecheck.
- `serve-reuse-pilot.ts`: private loopback origin and one-write evidence export.

The offline source-only identity comparator admits equal directory, model config,
plugin bytes, dependencies, environment, cwd and runtime; changing any one refuses
reuse (restart fallback). Endpoint routing tests separately refuse host-root and
another preview port, changed directory/workspace routing, and session move POST.
These are offline policy controls, **not live negative
cohorts**, and are not production admission changes.

Final focused validation: **51 pass, 0 fail, 216 assertions** across the pilot
fence and existing controller/reader/location-fence suites. Targeted TypeScript
check passes using the isolated matching declarations. `git diff --check` passes.
No simulated tools/transcripts or model calls were used.

## Exact attempts, timings and unmeasured claims

Budgets were fixed before navigation: one cold launch, one maximum A→B reset,
90 s cold, 60 s reset, 20 s request/drain, 15 s healthy cleanup, 180 s observation;
first failure stops, with no retry/replacement/deadline extension.

| Item | Actual result |
| --- | --- |
| Fresh origins / host servers | **1 / 1**, `http://127.0.0.1:43224/` |
| OpenCode cold launch attempts | **1**, spawn accepted, listener observed |
| Accounted OpenCode transport requests | **1 failed locally**, **0 guest HTTP sent** |
| Successful finite requests / SSE opens | **0 / 0** |
| DELETE / A→B reset attempts | **0 / 0** |
| Retry / replacement / extended-budget attempts | **0 / 0 / 0** |
| Sessions / model inference / tools / shell / PTY / execution RPC | **0** each |
| Environment delivery | **1765.495 ms** |
| Spawn acceptance / listener wait diagnostics | **99 ms / 9656 ms** (rounded stages) |
| Failed cold launch-through-hydration timer | **9759.830 ms**, includes failed-readiness cleanup, not successful cold readiness |
| Failed readiness timer | **1.030 ms**, local route rejection only |
| Reset / reinit / session hydration time | **Not measured** |
| Stable server PID / fresh config B / project resolution / empty distinct session | **Not measured** |

Six offline preparation invocations preceded launch: the first failed at consumer
resolution (development JSX runtime and delivery subpath); one later typecheck
failed on the required preparation callback and an unsupported readiness field.
Both were corrected offline. Four preparations completed; the final one alone was
served. There was no runtime/library distribution installation or production dist
overwrite. Four focused test invocations reported respectively 6/0, 50/0, 51/0,
51/0; the final runs include offline post-failure routing regressions. Two
additional post-failure targeted typechecks passed. No additional live attempt followed.

## Evidence and ownership

Attempted artifact and retained failure evidence absolute directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/opencode-exclusive-reuse-2026-09-30T04-14-55-277Z/`

Contains `receipt.json`, isolated `workspace/`, `chat/`, `client/`, `tsconfig.json`,
`live-evidence.json` (**491,922** serialized characters),
`failure-diagnostics.json`, `final-tests.log`, and `final-typecheck.log`.
Earlier offline preparations are separate timestamped
directories and were not overwritten. The attempted client hash remains in the
receipt; source correction afterward is explicitly distinct from that artifact.

Browser Control's sole named owner is **`clever-tiger-361`**. Five successful CLI
executes: one fresh-page navigation, two status reads, one evidence export, one
failure diagnostic read/export; no failed browser operation. The retained page
stays at the failed origin; no reload,
second navigation, adoption, or page replacement occurred.

The workspace owner's existing failed-readiness path automatically joined its
owned execution stop and both output drains; diagnostic
`service.cleanup.join.settled` reports `failed:false`. It also retains the rejected
readiness promise as a settlement diagnostic, which is not a second request.
No chat controller was constructed, so there was no local controller/SSE to
dispose. No subsequent manual shutdown/eviction was attempted. The additional
`__vv.diag()` surface was absent, so **final zero-work diagnostics and a guest PID
receipt are not claimed**. Host server **Bun PID 90779**, listener **43224**, and the
failure page are retained for inspection.

Preexisting 43222/43223 listeners remain Bun PIDs **6885/7042**, inventoried
read-only. Their pages, origins, servers and all prior evidence were preserved.
Only this phase's code/tests/report are committed; no push, deployment,
auth/model traffic, archives/IRS or production concurrency strategy changes.

This pilot does not establish mounted model chat usability, full-switch speed,
Vite retention, or a measured A→B process-reuse benefit.
