# OpenCode process reuse — concrete API, missing joined boundary

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-opencode-process-reuse-source-review.md`

## Decision

**A server restart is not intrinsically required for a source-only switch.** The
packaged OpenCode **2.0.3** already supports location-service eviction and lazy
reinitialization in the same server process. Pursue a narrowly scoped reuse pilot,
alongside future Vite reuse; do not change the production switch strategy yet.
The present controller lacks an awaitable client-reader disposal boundary, and
the eviction API itself does **not** supply that boundary. Those are concrete
prerequisites, not reasons to abandon process reuse.

Audit hashing remains the original default from `e18f602`; the apparent 6.55%
instrumented difference is not an established switch saving. No new startup,
browser, server, model request, reuse switch, full-switch cohort or production
configuration change was performed in this investigation.

## Source identities and version distinction

Read the recovered-pair and bounded-audit reports, toolkit/runtime instructions,
example startup/controller paths and the retained runtime receipt. The target is
runtime **446df00f86d5d6d5d856a2e5deec0fac49f242fa**, clean-worker distribution
**4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a**,
not the implicit current vendor checkout. No runtime build or source edit occurred.

The packaged application uses `@opencode/server@2.0.3` / `ServerProcess.start`,
not today's embedded `@opencode/sdk` host. Its tag is
`d44b52ca66b6bf69626c0384626d1a9cd9555977`; registry archives are the actual inputs.
The local retained `server.js` was checked against its build receipt: **27,721,709
bytes**, SHA-256
`1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929`.
Application source was inspected read-only in that verified bundle; it was not
edited or treated as editable runtime source.

Current V2 docs consulted:

- <https://opencode.ai/v2/docs/api>
- <https://opencode.ai/v2/docs/build/sdk>
- <https://opencode.ai/v2/docs/config>

Today's docs expose `/api/location/reload`, `/api/info`, and an experimental
session wait path. **The pinned 2.0.3 contract differs:** `/api/health`,
`/api/session/:sessionID/wait`, and `/api/plugin/await-activation` are present;
`/api/location/reload` is absent. Do not port current endpoint names into this
package. Current SDK `OpenCode.create()/close()` owns a whole embedded host;
it is not the selective reset interface used by this packaged HTTP server.

New, separate ignored evidence directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/opencode-reuse-source-review-20260930/`
It contains bundle/receipt identity, numbered pinned-source excerpts, prior
per-generation concurrency headroom, and an offline RcMap characterization script.
No existing evidence was overwritten or existing pages/servers touched, including
43222/43223. There was no push, deployment, archive/IRS/pin/auth edit.

## Exact reuse mechanism and identity

Authenticated request using the existing service's connection/password:

```text
DELETE /api/debug/location?location%5Bdirectory%5D=%2Fworkspace
```

The operation is `debug.location.evict` (OpenAPI ID `v2.debug.location.evict`),
returning NoContent. `GET /api/debug/location` lists cached refs. Eviction calls
`LocationServiceMap.invalidate(requestRef(request))`; the next location-scoped
request builds new location services and plugin registrations. Follow with the
**pinned** activation barrier, plugin/config verification, and fresh session
creation; keep the same server execution, endpoint, credentials and runtime owner.

Verified bundle references:

| Boundary | Lines in retained `server.js` |
| --- | --- |
| Evict contract and handler | 518459–518472; 557373–557378 |
| Location key canonicalization | 442619–442647 |
| Location build/invalidate | 552754–552815 |
| Query/header routing | 555262–555267 |
| Health exposes server PID | 557354–557360 |
| Session create without inherited parent | 452206–452243 |
| Interrupt and await-idle | 81953–81982; 451912–451941 |

Location cache identity is a structured **directory + optional workspaceID**, not
source contents, the toolkit's generation, or a new fresh session ID. On macOS the
canonicalizer preserves the supplied directory spelling rather than realpathing
it. HTTP accepts `location[directory]` / `x-opencode-directory` and optional
`location[workspace]` / `x-opencode-workspace`; absent directory defaults to process
cwd. Always explicitly route `/workspace`: the packaged process cwd is `/app`.
The current client supplies directory only, with no workspaceID.

Project identity is separate: Git discovery uses remote/cached/root-commit identity;
a non-VCS directory uses a hash of `directory:<absolute directory>` (74624,
523507–523537). Replacing source at `/workspace` therefore does not create a new
project. Eviction reruns location/project resolution but does not delete persisted
project inventory or session history. Do not claim a new project ID per generation.

Configuration is **location-scoped even when the files are global**: its loader
rereads global supplementary documents during location boot (451110–451138).
This package sets `config.project:false` and disables file watching
(`vivari/experiments/opencode-release-server/server.ts`). Ordinary project configs
are therefore intentionally ignored; `/workspace/.server/config/opencode/` is the
active global config/plugin directory. A changed document there can be loaded
after a properly joined eviction. Its file bytes must be checked explicitly.

Eviction does not change launch environment/HOME/XDG/database paths, dispose the
global database/catalog/session execution services, clear persisted sessions, or
promise an ESM module-cache reset. Plugin import uses the main-context default
dynamic loader with its original specifier (83806–83823). Changed plugin or
provider/dependency module bytes at the same URL must **fall back to process
restart** unless an explicit invalidation mechanism is separately proved. Changed
working directory, mount/root, runtime/distribution, server package, launch env or
dependency identity likewise fails the initial source-only reuse admission check.

## The precise missing lifecycle fence

1. `POST /api/session/:sessionID/interrupt` requests interruption. HTTP success or
   `{interrupted:true}` alone is not completion. Follow with pinned
   `POST /api/session/:sessionID/wait`, then authoritative active-session checks.
   Wait joins the session agent-loop coordinator's `done` and loops until idle;
   it is not an all-location HTTP-reader / shell / PTY shutdown API.
2. Freeze new prompt/tool/read/archive admission for the outgoing generation.
   Account for every owned session, including children, not only the selected UI
   session. Reject unsupported independently owned shell/PTY/background work in
   the first pilot rather than treating agent idle as its proof of exit.
3. `ChatController.dispose()` closes its root Effect scope and aborts local
   streams/requests, but **returns void** and launches the join/runtime disposal
   asynchronously (`opencode-chat/src/controller.ts:592–600`). It does not interrupt
   server execution. Existing tests explicitly preserve that ownership split.
   Add an awaitable completion interface before using disposal as a switch fence;
   returning/awaiting that existing scope close is the minimum integration change.
4. Pinned `RcMap.invalidate` removes the key, then returns immediately when
   `entry.refCount > 0` (15614–15627). LocationServiceMap additionally signals RPC
   close, which is not a reader/finalizer join. A successful DELETE plus an absent
   debug key does **not** prove outgoing services are disposed. Outstanding
   requests must settle/release references **before** eviction and before any
   incoming same-key request. Otherwise two generations can overlap.

An offline characterization using the installed matching Effect `4.0.0-rc.112`
confirmed key disappearance and distinct same-key reacquisition without old
finalization. Its subsequent assertion that closing the old reader would finalize
it **failed**: with the new key already present, the old entry's infinite idle TTL
path retained it. This is consistent with RcMap's release branch checking key
presence rather than entry identity. This is dependency characterization, not a
successful OpenCode reuse test or a fully verified leak claim in Vivari. No further
execution followed that assertion failure. An initial setup attempt had failed
before acquisition because a duration string was invalid; both offline attempts
are recorded in `identity.json`. No live startup budget was consumed.

`attachChat` caches a controller in a WeakMap keyed by **Service identity**
(`opencode-chat/src/editor-adapter.ts`). Retaining the service does not create a
fresh controller/session. The pilot must explicitly release the outgoing
attachment, await its disposal, and attach a new controller with
`startNewSession:true`, or explicitly create/select a new root session. Omit
parent/fork/move/input-ID reuse, then verify unique session ID, correct location,
empty messages, no inherited model/permissions/metadata/instruction entries and
no stale events/errors. Persisted older sessions may remain listed; that is not
history leakage into the new selected session.

WorkspaceController owns server execution, endpoint, output drain and shutdown.
`stopRuntime()` stops **all** services; `close()` also stops runtime. Retaining chat
requires the same runtime/workspace owner, selective `stopService('vite')`, and a
separate client reset operation, not calling stopRuntime and pretending the server
survived. Preserve endpoint/password identity. Final cleanup must still join the
retained execution's shutdown, exit and both output drains.

## Startup phases and expected benefit

No new microprofile was run: source inspection already identified the API and
the missing fence. Existing `chat.healthy` measures server/plugins/config/catalog,
**not usable authenticated inference or a hydrated fresh chat controller**.

| Phase | Existing evidence / measurement limit |
| --- | --- |
| Host launch acceptance | Not separately timed for chat in retained cohort |
| Guest bundle compilation/module evaluation + global service start | Not separated; bundle is 27.7 MB, size is not duration |
| Health/listener | Existing request-stage probes; includes polling and transport |
| Location config/plugin boot | Activation request median ~2182 ms in reuse; not pure plugin CPU |
| Plugin/config verification | Distinct HTTP request stages in readiness verifier |
| Model catalog | Existing G2–G6 reads 96/93/91/97/183 ms; no inference |
| UI/SSE/new session/history hydration | Excluded by `waitForClient:false` in performance fixture |

Recovered source-only/restart-both samples have chat **5.899 s median** and preview
**7.504 s median**, running concurrently. In **all five individual generations**,
chat finished earlier than preview: idealized chat-only critical-path headroom
`max(0, chat - preview)` is **0 ms** in each, holding preview unchanged. This does
not measure resource-contention relief, shutdown savings or new reset overhead.
Do not promise a 5.9-second current wall-time reduction.

With future faster/retained Vite, the same avoided chat startup could expose up to
roughly the existing **5.9 s** chat-readiness cost, less joined cleanup, eviction,
location reboot/plugin activation, new-session/client hydration and preview time.
That is a rough conditional ceiling, not a measured benefit; retaining the process
but evicting the location still repeats some activation/config work. Both-service
reuse is worth investigating. Audits (~5.8 s combined) and other work remain.

## Smallest next bounded pilot — return plan before execution

First implement/test the **awaitable client shutdown fence**, with controlled
SSE, history/archive, permission/form and post-acceptance request readers. Prove
their finalizers join and outgoing admissions stay frozen; then characterize the
safe **join → evict → acquire** ordering in the matching dependency. Do not begin
an end-to-end switch cohort based only on the existing void disposal API.

Then propose **one fresh owned origin, one server launch, one isolated A→B reset**,
not five switches. Pin runtime 446df00 and frozen libraries explicitly; bundle
example consumers separately, with no runtime/library rebuild or auth changes.
No model calls. Use a controlled non-inference reader/tool invocation with an
observable cancellation/finalizer receipt; if the packaged extension surface
cannot exercise a real tool without inference, the prerequisite remains unmet
and must be tested through a supported in-memory core harness, not a fabricated
chat transcript or a model call. Keep direct hashing off.

Require: identical PID/execution/endpoint, stopped old tools/readers before source
writes, observed location eviction/reboot, old config marker absent/new inert
config marker present, refreshed project resolution, fresh root session/empty
history, rejected stale generation callbacks and unchanged managed dependencies.
Include offline dependency/cwd/plugin-change admission negatives proving restart
fallback; never proceed after a failed fence. Retained service diagnostics must
allow only the specifically owned chat PID/listener, not waive all-services-stopped
checks globally. Check unmanaged writer activity and full final zero-work cleanup.
Freeze one attempt/no retry/replacement, budgets, ownership and bounded evidence
export before launch. Only after that isolated boundary passes should a paired
startup/reuse timing plan be proposed alongside the future Vite work.

## Validation

- Existing mock-only `bun test test/controller.test.ts` in `opencode-chat`:
  **30 pass, 0 fail, 119 assertions**. No real model/server traffic.
- Verified packaged bundle SHA-256 against original receipt.
- Offline RcMap characterization: **not a PASS**, stopped at the finalizer
  assertion as described above; no reused-server test was executed.
- Report-only tracked change; no startup instrumentation was justified yet.
