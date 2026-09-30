# Effect v4: consolidated-kernel lifecycle rewrite scope

Date: 2026-09-30. **Research / decision input only; no implementation authorized.**

## Outcome and decision

The problem is not merely missing cancellation. Kernel-owned asynchronous work can
outlive the PID, endpoint, or workspace whose successful close is being used as a
replacement fence. The decision is **where to put authoritative execution ownership,
interest ownership, and failure-preserving drain receipts**, and whether Effect is
worth the migration cost at that boundary.

**Provisional recommendation:** extract a TypeScript Effect lifecycle core for the
consolidated Kernel Worker, with a small imperative JS/native/SAB bridge. Include
kernel async orchestration, pending launches, shared operations, persistence and
host-side receipt composition in the eventual scope. Do not convert synchronous
filesystem/syscall machinery, guest Node internals, or WASM algorithms just to put
Effect everywhere. A host-only conversion cannot join work it does not own.

This is a substantial lifecycle redesign, not a `tryPromise` translation, an
automatic cache repair, or authorization to migrate. Start with the bounded pilot
below; a successful pilot would authorize discussion of the full milestones, not
promotion. Parent retains the master status and final decision.

### Decision matrix

Cells describe mechanisms and qualitative assessments, not measured scores.

| Criterion | Keep imperative lifecycle / targeted repairs | Convert whole JS kernel into Effect | Extract TS Effect lifecycle core + minimal bridge | Convert host/workspace only |
| --- | --- | --- | --- | --- |
| Kernel late work | Extend explicit task/owner ledgers at every seam; same omission risk | Can own all async work if every entrypoint migrates | Can own all async work behind a deliberately closed adapter boundary | Cannot own lazy installer/SQLite continuations still running in kernel |
| Shared execution vs consumer interest | Already represented for repaired fetch; expand manually | Requires separate scopes/leases despite library adoption | Explicit shared-operation service; PID scopes own leases, kernel owns execution | Local requests can be scoped; remote/kernel operation remains independent |
| Sync VFS / SAB correctness | Smallest protocol disruption | Broad touch surface; risk accidental async hot-path changes | Preserve predicate waits, publication ABI and same-thread direct VFS | Preserves ABI but does not repair kernel publication authority |
| Typed failures and public receipts | Existing errors plus hand-maintained joins | Strong internal types only if JS is migrated/checked; public adapters still required | Typed orchestration and outcome ledger; narrow Promise facade | Improves facade types; can still certify an incomplete underlying receipt |
| Browser / Node/native reuse | No new dependency; current twin drift remains | ESM/build/package migration touches standalone JS/Node consumers | Need one compiled, environment-neutral core consumed by both hosts | Easiest packaging; extra framework at wrong ownership boundary |
| Persistence / boot failure | More manual ordering and partial-init release | Can scope acquisitions, but cannot interrupt synchronous WASM or prove browser release | Own drains/locks/initialization while leaving native calls imperative | Can observe host close, not establish kernel OPFS quiescence |
| Effort / risk | Lower initial cost; cumulative ownership auditing remains high | Very high effort and compatibility risk; difficult review slices | High effort; bridge incompleteness is principal risk; bounded slices possible | Moderate effort, low kernel churn; inadequate as the requested rewrite |
| Performance | No Effect overhead; correctness joins still cost time | ? Larger dependency / scheduling surface; must measure | ? Smaller scheduling surface, but worker bundle and yield overhead remain | ? Host bundle growth without demonstrated kernel benefit |
| Reversibility | Individual repair revert | Large tangled cutover unless carefully staged | One owner per migrated domain; artifact-level rollback possible | Easy rollback, but not a substitute for kernel repair |

The extracted core is preferred for **boundary clarity**, not a claimed speedup.
Keeping imperative code is a legitimate alternative if the user prefers focused
repairs over framework adoption. Whole-kernel conversion buys no automatic protocol,
security, or remote ownership guarantee. Host-only work is complementary, not sufficient.

## Evidence, identities, and limits

- Runtime source inspected at `33fa1359a003ca9c50cb3bc49699b99bc1a063f1` in
  `/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel` (runtime paths
  below are relative to that checkout). Architecture is one Kernel Worker holding
  VFS/fetch ownership, PID-owned guest workers, and Service Worker relay—not the
  historical separate FS/Fetcher workers.
- Candidate identity provided for this study: runtime `33fa135`, toolkit `d0eec346`,
  candidate version `3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.
  Toolkit source inspection also includes chronological reports at observed HEAD
  `1fb7efe517067253c53ecd52b1b07ee147d32c6d`; later documentation is not a new frozen
  candidate. A later implementation must record fresh exact source/artifact receipts.
- [Master status](2026-09-30-single-kernel-status-and-direction.md) remains authoritative.
  Its minimal native-fetch browser stop gate (`465460d`) passes for its bounded
  cohort. It explicitly does **not** qualify lazy loading, all-writer quiescence,
  retained OpenCode, or full-app workspace switching. Independent full-app acceptance
  is pending at this research boundary; no browser slot was taken for this study.
- [PID egress repair](2026-09-30-pid-egress-cleanup-repair.md) establishes the current
  explicit fetch task / descendant cleanup / rollback joins and their limits.
- [Cached-switch integration](2026-09-30-cached-switch-post-egress-integration.md)
  contains the concrete counterexample: hold the actual `OP_SPAWN_ASYNC` tsgo lazy
  loader, join SDK stop and readers, then release vendor bytes. The real installer
  writes two late shims through a planted `/bin` symlink into
  `/workspace/.browser-editor-cache/vite`; no late child is launched. This is a
  controlled offline tamper showing an ownership gap, **not observed browser corruption**.
- [Delivered OpenCode audit](2026-09-30-delivered-opencode-retention-lifetime-audit.md)
  is evidence about the actual delivered bundle and remote/global owners; it is
  not replaced by reading newer upstream application source.
- Historical [e35eab4 close-census failure](2026-09-30-single-kernel-e35eab4-attempt1.md),
  [fresh full-E2E failure](2026-09-30-single-kernel-fresh-full-e2e-17ef8e3.md), and
  [close investigation](2026-09-30-single-kernel-close-retention-stability.md) remain
  failures/limits of their own cohorts. A later unchanged-runtime case-1 control
  passed termination/lock/census observations; historical cause remains unknown.
  Broad contracts still hit the known `markAsUncloneable is not a function` gap;
  neither a new framework nor a narrower green gate retires it.

Only source/documentation research and this report were performed: no dependency
installation, code migration, pin update, build, runtime/host/guest/server launch,
browser interaction, test, benchmark, or promotion. All acceptance below is proposed.

## Ownership inventory and rewrite seams

The inventory distinguishes present mechanisms from required future contracts.
Source anchors are audit entrypoints, not proof that every adjacent operation is broken.

| Domain / source seam | Present owner or mechanism | Required authoritative owner / receipt |
| --- | --- | --- |
| Kernel boot and shutdown; `packages/core/src/workers/kernel-worker.ts`, `packages/kernel-host/kernel.js` | Worker boot composes native initialization, VFS/persistence, fetch and guest wiring; imperative callbacks/maps | One root lifetime owns all acquisitions and kernel operations, rejects admission on closing, joins partial initialization on failure and full drain on shutdown |
| PID and descendants; `kernel.js:285`, `:946–1040`, finalize / stop / spawn handlers | PID records, `fetchTasks`, `_processCleanup`; exited child can leave PID table while cleanup remains pending | PID identity/generation scope plus retained descendant receipts; removal from PID map never means drain; failed receipts survive normal guest exit |
| Shared fetch; `kernel.js` `_fetchInflight`, `_scheduleFetch`, `_fetchIntoVfs`, `_doNetworkFetch`; `kernel-fetch.ts` | Shared owner sets and last-owner abort; capped queue; native body/remap sibling work joined in repair | Kernel shared execution scope, PID interest leases; join all native promises, body cancellation, pins, rollback and publication before operation receipt |
| Fetched body / cache; `kernel.js` `_fetchBodyPins`, `_reapFetchBody`; `fs-server.js` body-consumption callbacks | Generation paths, body pins, deferred reap after last reader; whole-file EFBIG is not consumption | Resource leases distinct from lookup cache; preserve fd/chunk retry and exact-generation unlink authority; last pin release participates in drain |
| Lazy command load; `kernel.js:334–362`; `kernel-worker.ts:1885–1960`; `load-real-*.js` | `lazyInflight` shares a Promise; loader rejection swallowed; vendor fetch lacks abort signal; unpack/shim writes outlive caller | Kernel-owned shared install operation with explicit interested launch/PID leases, cancellable download adapter, commit/rollback barrier, retained typed install failures |
| Host launch before PID; `kernel-worker.ts:1246–1267`; toolkit `workspace-api/src/runtime.ts:33–58` | `spawnProcess` awaits loader before process exists; toolkit retains pending launch Promises and stops late Execution | Launch scope exists before PID allocation; closing revokes transfer-to-PID authority; parent/host launch admission checked at commit, not only after await |
| Blocking / async spawn and worker threads; `kernel.js` syscall dispatch, spawn handlers; `kernel-worker.ts` spawnWorker | Deferred callbacks, async Promise guard, PID cascade, worker registry/ports | Owned launch/task plus child lifetime; bounded output staging / cleanup and publication fence for each invocation; no daemon/detached task unless explicit root ownership |
| Guest worker/platform lifecycle; `kernel-worker.ts:1586–1591`, `process-worker.ts`; Node twin `scripts/process-worker.mjs` | Termination unregisters FsServer and closes port; browser termination has no native exit receipt | Scope closes timers/listeners/ports and logical process authority; preserve fatal-boot vs nonfatal Worker error classification; browser target/lock proof remains separate evidence |
| Listener / accepted HTTP; `kernel.js:1323–1388` | Listener close denies new requests; accepted streams keep fixed PID/channel; listener replacement cancels old streams | Listener admission scope and separate accepted-stream lifetime; fixed owner identity, no retargeting to new listener; PID/root stop drains accepted work |
| Buffered inbound HTTP, spills, WebSocket/SSE/pipe relays; `kernel.js:1391+`, `:1449+`, `:1517+`, `:1603+` | Request maps, spill paths, timeout/resolver, connection maps, process-exit teardown | Per-request/connection leases own pending continuations, timers and staged paths; EOF/end/error/cancel all converge on one non-self-joining close receipt |
| SDK endpoint and HTTP pump; `packages/core/src/host-sdk/browser/endpoint.ts`, `http-stream.ts` | Distinct `closed`/`settled`; retained upload reader/cancel failures; cleanup observer | Endpoint rejects admission promptly; accepted request/pump settlement joins read/cancel continuations and errors; Effect adapter preserves browser pull/backpressure and no self-join |
| SDK Execution and host RPC; `host-sdk/execution.ts:64–95`, `host.ts:161+`, `types.ts:32–48` | `exited.cleanupError`; `stop()` rejects `CLEANUP_FAILED`; host pending listeners/RPC cleanup | Failure-preserving process receipt and output readers; root owns launch/error/abort listeners and pending RPC; destroy/terminate is not silently substituted for drain |
| VFS / storage initialization; `kernel-filesystem.ts` | WASM VFS, persistence lock, SQLite/backend/cache initialization; async RPC work; returned `{server,fs,handle}` | Scoped acquisition with partial-init unwind, tracked RPC/snapshot/import/install work, explicit drain/close interface; no same-thread Atomics.wait facade |
| OPFS write-behind; `opfs-persistence.js:171–249` | Background drain Promise, manifest timer, retained errors, polling flush | Persistent root execution owner for accepted durable writes; stop producers, join drain, flush manifest, then release lock/handles; failed flush blocks safe replacement |
| SQLite; `fs-server.js:156–165`, `:238–245`; `sqlite-server.js:22–43`, `:129–154` | Unregister synchronously closes PID connections while request Promise may await persistence and later write response `.out` | Track requests before invocation; join accepted transaction/flush/response or fenced rollback before connection disposal; do not invalidate db pointer mid-continuation |
| Search/replace, snapshots/depcache, readiness probes, diagnostics; `kernel-worker.ts`, `kernel-filesystem.ts` | Tokens, async loops, timers and RPC callbacks across kernel lifetime | Explicit root or workspace epoch owner; track writers, cooperatively yield, fence stale publications; read-only diagnostics cannot be treated as transactional drain proof |
| Toolkit Runtime; `workspace-api/src/runtime.ts:83–94` | Pending launches joined; executions/endpoints stopped; failed cleanup keeps workspace attached | Thin Promise facade over typed lifecycle outcomes; maintain pending-launch and already-exited failure retention, do not detach on a false-success finalizer |
| Toolkit controller/service/workspace; `opencode-chat/src/controller.ts`; `workspace-api/src/process-output.ts`, `service-shutdown.ts`, `workspace.ts`, `environment-experiment.ts` | Service executions, output pumps, EOF stop triggers, runtime attach/detach, workspace close ordering | Controller owns readers/service interests; runtime owns process receipts; workspace owns replacement barrier and filesystem authority; avoid reader→stop→reader join cycle |

SQLite deserves inclusion because source shows an actual asynchronous lifetime seam:
`persist` exports/writes bytes and awaits OPFS flush; SQL iteration can resume after
that await and `request` writes `.out` on either success or error. A synchronous
`release(client)` is not a join. This is a **scope finding**, not a newly reproduced
SQLite corruption claim. Similar scrutiny is required for every non-PID root writer;
limiting the rewrite to PID fetch ledgers would leave the original class open.

Timers and callbacks are resources too: signal grace/force timers, HTTP timeouts,
watchdog/boot timers, manifest debounce, readiness polling, RPC abort listeners,
worker error/message listeners, VFS watches, transferred MessagePorts, Service
Worker/preview subscriptions and controller output pumps need named owners. Clearing
a timer prevents future invocation, not an already-running callback; drain must join
the callback/task it started. Layer construction must not hide a global background owner.

## Proposed lifecycle model and contracts

### Execution ownership is not interest ownership

Use a root kernel lifetime with child PID/launch/request lifetimes and a **separate
shared-operation registry**. A PID or pending launch owns a lease expressing its
interest, not the shared download's execution fiber. The registry owns execution,
native adapter settlement, temporary paths and install commit authority.

- Register the operation/lease and its receipt **before** invoking native/user code
  that can complete synchronously or re-enter stop. Startup interruption must not
  create a resource before its release/join is registered.
- Consumer exit revokes its publication rights and releases its interest. Another
  live consumer keeps the shared fetch/install alive. Never interrupt a shared
  operation merely because the first/requesting PID exits.
- Last-interest departure freezes joins to that operation generation, requests abort,
  and joins backend settlement plus rollback. A new request either waits for that
  closing generation or explicitly acquires a new isolated generation; key equality
  must never let the old finalizer remove the new entry/path.
- An optional retained installer/cache owner must be a declared root lease with a
  write set and close receipt. It is not implicit permission to finish into a
  workspace being replaced. A PID receipt joins release of its lease and all its
  own continuations; it need not kill a shared operation still legitimately owned.
- A workspace replacement barrier additionally joins **every writer with authority
  over the outgoing/reused roots**, including root/shared owners. Kernel-wide shutdown
  joins all shared execution scopes regardless of individual consumer interest.

Shared completion after one PID exits is allowed only while another legitimate
owner remains and the destination lifetime is still valid. It must never publish to
the dead PID or write into roots covered by an already-issued quiescence receipt.
Write-set ownership therefore matters as much as PID parentage.

### State, publication and stop

Each authoritative lifetime has `Open → Closing → Settled(success | failure)` with
one memoized, joinable outcome. Admission freeze and publication revocation happen
synchronously before asynchronous teardown. A scope's closed state, empty PID map,
timeout expiry, or interrupt request is not that outcome.

Publication at the JS/SAB boundary checks exact process/operation identity,
generation, admission epoch, and expected syscall state. The check and synchronous
publication form a non-yielding bridge operation; any async staging is owned and
rechecked before commit. Never write a response into a dead PID or a newer syscall;
preserve existing `STATE_REQUEST` guards and predicate waits. Rollback removes only
that invocation's staged files before errno/outcome publication.

Stop order is a dependency graph, not simply reverse acquisition order:

1. Freeze launch/listener/write admission and revoke stale publication authority.
2. Signal guest subtree, stop request producers and release consumer interests.
3. Interrupt owned fibers / abort native work, then join descendants, pending launches,
   accepted requests, readers and backend continuations without self-join cycles.
4. Join rollback, body pin/spill consumption, watch/port/listener disposal and accepted
   SQLite operations; close native connections only when their users are settled.
5. Drain persistent accepted writes and manifest, retain all errors, then release
   root VFS/storage ownership. Only a successful appropriate receipt allows detach,
   destructive replacement, reuse, or a new stable-root generation.

The uninterruptible section covers authority transitions and finalization, **not all
ordinary execution**. A backend ignoring abort may require waiting indefinitely;
a deadline can return an explicit unresolved/failed cleanup outcome and preserve
attachment, but cannot truthfully return success while that backend can still write.
Forced worker destruction is a separate fallback/evidence category, not a green drain.

### Preserve the public vocabulary

| Surface | Meaning to preserve |
| --- | --- |
| Endpoint `closed` | Prompt reason-bearing admission/liveness notification; does not claim all request continuations finished |
| Endpoint `settled` | Joins accepted HTTP upload/read/cancel cleanup and retains rejection; endpoint disposal initiates, receipt observes completion |
| Execution `exited` | Exit code/signal/forced status plus optional `cleanupError`; normal guest completion can still have failed cleanup |
| Execution `stop()` | Idempotent join; rejects with public `CLEANUP_FAILED` when cleanup failed, rather than succeeding because the PID vanished |
| Runtime `stop()` | Joins pending launches, executions, endpoints and retained failures; failure keeps workspace attached |
| Workspace close / controller stop | Composes actual runtime/service/output/storage owners; errors remain visible and prevent unsafe replacement |

Internal effects should preserve expected typed acquisition, installation, network,
persistence, publication, rollback and cleanup errors. Keep defects and interruption
distinguishable in `Cause`/`Exit`; serialize public errors deliberately at the worker
boundary. Do not use `catch(() => {})`, `orDie`, or a void interrupt result to erase
an expected drain failure. Observation-only rejection handlers may prevent unhandled
rejections **only while the original failure remains available in the receipt ledger**.

HTTP pump cleanup must never await the very `settled` Promise that its own `finally`
completes. Likewise an output-reader EOF trigger must initiate controller stop without
waiting on a receipt that includes that same reader. External observers join the
receipt; internal participants finish their owned task. Preserve this current HTTP
discipline during an Effect Stream adaptation.

## Effect v4 semantics verified from source

### Version and provenance

Local package source inspected:
`workspace-api/node_modules/effect/src` reports **`4.0.0-rc.112`**. Toolkit
`opencode-chat` explicitly pins rc.112; the runtime and workspace package do not
thereby acquire a declared Effect dependency. Node_modules resolution is not a
runtime adoption decision.

Current canonical upstream source was inspected at
[`8b0eac6ac46a689a7208500e2ccf9e3b80fc3898`](https://github.com/Effect-TS/effect/tree/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898),
whose `packages/effect/package.json` reports **`4.0.0-rc.118`**. These are source
observations, not package availability/install guarantees. Archived `effect-smol`
redirects v4 development to the canonical repository; its beta source is not the
current authority. A pilot must choose an exact pin and reverify that pin's semantics;
this report updates no package/lockfile.

### What the primitives do—and do not establish

| Primitive | Verified semantics / version qualification | Consequence for this rewrite |
| --- | --- | --- |
| Scoped fibers | `forkScoped` ties child interruption to scope finalization; explicit fork ownership determines lifetime, not the fact that code is written in Effect | Fork shared execution under kernel operation owner, consumer waits under PID/launch owner; no accidental daemon or request-scoped shared installer |
| `Fiber.interrupt` | rc.112 `internal/effect.ts:857–885`; current implementation requests interruption and awaits fiber termination; returns void | Joining interruption does not preserve failed child Exit by itself; capture/retain Exit separately and combine it with native drain outcomes |
| Scope finalizers | rc.112 `scopeClose:3775–3827` marks state Closed before running finalizers; reverse sequential order or parallel joins aggregate finalizer exits; another close can return while first close still runs | Memoize a domain close receipt; neither `Scope.state` nor repeated `Scope.close` proves drain. Parallel finalizers need dependency-safe grouping |
| Interruption masking | rc.112 raw `Scope.close` is not itself masked; ordinary `Effect.scoped` finalizes through masked `onExit` (`:4013–4017`). rc.118 `scopeClose:3947–3954` explicitly enters uninterruptible mode | Do not copy current implementation assumptions into the installed pin; use an explicit reliable finalization boundary and joinable receipt |
| `acquireRelease` | Both inspected versions mask acquisition by default; support `{ interruptible: true }`; release callback has error type `never` | Acquisition adapters must register unwind correctly. Expected cleanup errors belong in explicit typed drain/outcome ledger, not disguised as defects or forced into an infallible finalizer signature |
| `tryPromise` / Promise bridge | Callback accepts an AbortSignal when requested; underlying `.then` handlers are attached. Interruption cancels the Effect wait but does not force arbitrary Promise/backend settlement | Passing signal is necessary, not sufficient. Finalizer must explicitly abort **and join** native fetch/read/cancel/remap/installer continuation; ignored-abort promises need retained receipts |
| `Cache` | Shares a pending lookup fiber; inspected `EntryImpl` interrupts that pending computation when its last awaiter departs. Capacity/invalidation remove lookup entries, not installed-resource drain receipts | Appropriate for pure/read-only memoization if policy matches; not automatically for body pins, shared installer execution, durable trees or replacement fences |
| `RcMap` release / invalidate | rc.112 release checks key presence, not exact entry identity; invalidate removes entry and returns with positive refs. rc.118 release checks exact identity and closes detached old entries; invalidate still returns with positive refs | Newer release improves old/new entry separation, but invalidate is not all-ref release or resource drain; overlapping generations still need explicit authority/receipt policy |

Current immutable source links:
[Effect](https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/Effect.ts),
[internal effects/scopes](https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/internal/effect.ts),
[Scope](https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/Scope.ts),
[Fiber](https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/Fiber.ts),
[Cache](https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/Cache.ts),
[RcMap](https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/RcMap.ts).
Local rc.112 supporting anchors: `Cache.ts:648–670`, `RcMap.ts:736–774,962–971`.
Current rc.118 supporting anchors: `Cache.ts:477–493`, `RcMap.ts:457+,599–604`.

Consequently, use `Context.Service`/`Layer.effect` for injected platform ports and
owned lifetimes, `Effect.gen`/named `Effect.fn` for orchestration, `Deferred`/queues
for explicit receipts and admission, scoped fibers for owned background work, and
typed errors for domain failures. Use `Stream` where pull/backpressure is actually
needed—not to change the HTTP protocol or buffer whole bodies. A custom shared
resource/receipt registry is justified here precisely because automatic Cache/RcMap
semantics do **not** match the authoritative drain/write-set policy. Reuse those
primitives for compatible subproblems rather than rewriting all caching machinery.

## Recommended implementation boundary (future authorization)

The TS core would expose lifecycle operations through one checked bridge contract:
launch admission/transfer, PID interest acquisition/release, shared operation start,
publication eligibility, and close/drain outcome. Platform services inject native
fetch/stream adapters, guest-worker controls, VFS writes, persistence, timers and
message channels. Avoid two independently authoritative PID/fetch maps during migration.

Keep these outside Effect's asynchronous scheduling:

- Synchronous direct VFS methods, Rust/WASM data structures, compression, codec and
  SQLite synchronous execution. Effect owns their asynchronous lifetimes, not their
  algorithms or instruction preemption.
- SAB layout/opcodes, synchronous response encoding/notify, predicate wait protocol,
  guest require/resolve, transient raw output spills and fd/body-consumption rules.
- Guest Node event-loop phases, host-Promise liveness refs and native/WASM addon
  behavior. Kernel fibers cannot replace a guest's own event-loop contract.
- Browser Worker/MessagePort primitives and Service Worker relay as injected ports;
  no new FS/Fetcher worker, Python LSP worker, or extra process topology.

One compiled environment-neutral TS core must be consumed by browser and Node/native
hosts. Audit direct JS imports in scripts/embedders before choosing package placement
and output/export format; standalone `kernel-host` cannot accidentally depend on a
browser-only TS transform. Keep library builds separate from example consumers.
Use Bun/TypeScript tooling for future work, retain upstream licenses and source pins,
and record generated artifact hashes/worker manifests. Do not edit `.runtime` as
source, silently repin `vendor/vivari`, or build a browser candidate from a different
source tree than the headless/native fixtures.

Qualitative work shape: bridge/types/package compatibility is medium-to-high;
shared operation and native settlement redesign is high; PID/descendant and public
receipt composition is high; persistence/SQLite ordering is high; mechanical host
adapters are medium after the owner model exists; full browser qualification and
performance characterization are high. Whole-kernel conversion additionally requires
large JS-to-TS/module/API churn. There is no credible calendar estimate from this
research alone; identify reviewer capacity and packaging constraints before sizing.

## Bounded pilot and full milestones

### Pilot: real lazy install + two interested launches + joined native adapter

On separately authorized source/artifact branches, implement the smallest extracted
TS owner/receipt core around the **actual shared tsgo loader and pending spawn seam**.
Use the production native fetch/body adapter and installer—not a parallel fake loader.
This targets the concrete late-write counterexample and exercises shared ownership,
pre-PID admission, native settlement, installation failure and publication fences.
Do not simultaneously migrate persistence, guest internals, or all host services.

Pilot exit criteria:

- First requester stops while a second still owns the same install: one download
  continues; second receives a valid install/launch; no first-PID publication.
- Last requester stops while headers/body/remap is held or ignores abort: receipt
  stays pending until underlying continuation and rollback settle, or explicitly
  fails unresolved without permitting detach/replacement.
- Hold real vendor bytes as in cached-switch counterexample, close, then release:
  no post-success shim/source/cache-root writes and no late child. Check exact bytes,
  symlink target and operation receipts; “no late child” alone is insufficient.
- Stop-before-PID, concurrent stop, repeated close, abort during acquisition, loader
  failure and rollback failure produce one stable, failure-preserving receipt.
- Existing fetched-body/pin/queue and output-reader contracts remain unchanged;
  prove actual browser/Node delivery uses the compiled core, not just a fake adapter.

Pilot is evidence for this slice, **not** all-kernel quiescence. If package/adapter
cost is unacceptable, retain explicit imperative repair as the alternative; do not
expand a failing pilot to justify its sunk cost.

### Full milestones after separate decisions

1. **Ownership contract/package design:** enumerate every async entrypoint and writer,
   choose exact Effect pin, compile/export format and error/receipt wire schema.
   Review join graph, shared lease/write sets, startup unwind and ABI preservation.
2. **Root + PID supervision:** authoritative launch/PID/descendant scopes, signal
   timers, worker callbacks and failed exited-child receipts; integrate shared fetch
   queue/dedupe/body pins and native sibling settlement. No unowned task escape hatch.
3. **Remaining kernel operations:** migrate all lazy tools, snapshots/depcache,
   search/replace writers, readiness jobs, buffered HTTP/spills, accepted HTTP,
   WS/SSE/pipe/watch/port lifetimes and RPC task admission.
4. **Persistence:** explicit filesystem acquisition/close, accepted SQLite requests
   joined before connection disposal, OPFS write/manifest drain and lock release;
   boot failure and interrupted partial initialization release required owners.
5. **SDK/toolkit integration:** preserve endpoint/Execution public distinctions,
   reader/pump cancellation and Runtime/workspace/controller failure retention;
   replacement/reuse barriers must cover root and shared writers, not only PIDs.
6. **Independent qualification and matched benchmarks:** frozen artifacts, all
   applicable contracts, exclusive visible-browser ownership, full-app transitions,
   fault cohorts and performance/resource comparison. Parent decides promotion.

Each cutover transfers authority once for that domain, with a narrow adapter back to
unmigrated domains. No dual supervisors, double release, or shadow task ledgers that
make failure appear clean. Rollback selects an entire verified old artifact cohort,
not a mixed old host/new kernel bundle.

## Required regression and acceptance gates

Concrete failures and protocol fixtures justify targeted regressions; this report
does not request a generic unit-test expansion. Proposed gates must fail against the
specific missing join/guard, with per-assertion failure evidence, before green counts
as protection. Deterministic handshakes select interleavings; sleeps and retry-to-green
are not substitutes. Do not reset/discard concurrent user changes to make controls.

| Gate | Observable acceptance |
| --- | --- |
| Shared owner / queue | One requester exit leaves other interest alive; last exit cancels queued/active work; queue slots and inflight records converge; abort-aware and ignored-abort paths tested |
| Native fetch / body / remap | Join headers, `read`, `cancel`, fallback/remap siblings and staged publication; retained cleanup errors; no body deletion during EFBIG→chunked-fd retry |
| PID / descendant | Parent joins live and already-exited descendants' retained failures; stop concurrently with spawn/worker-thread boot; no dead-PID/new-syscall write; every parked live caller gets truthful terminal response |
| Lazy installer | Actual npm/yarn/pnpm/corepack/tsgo loader interests and publication tested; vendor failure not swallowed; `/bin` symlink / held tsgo reproduction guards post-receipt writes; successful shared install still works |
| HTTP / endpoint / reader | `closed` can precede held cleanup; `settled` waits and rejects on reader/cancel failure; accepted stream stays bound to old owner through listener close/replacement; EOF/stop avoids self-join |
| Staging / resource release | Inline/spill/maxBuffer and binary output fixture preserved; rollback precedes errno; exact invocation owns unlink; generation/body-pin/watch/port/timer counts have explicit receipts |
| SQLite / OPFS | Stop during held flush and multi-statement continuation; no db disposal while request uses it, no `.out` after relevant success receipt, correct durability/error outcome; failed acquisition and flush retain failure and release permitted owners |
| Workspace transitions | A↔B exact source/binary/deletion markers, symlinks, dependency/cache roots and chats; reload during replacement, failed startup/retry/outgoing recovery; no resurrection, cross-workspace writes or unsafe detach |
| Browser/platform | Actual Worker error semantics, boot/pre-ready ordering, target termination/OPFS lock/census and Service Worker routing; output/preview/chat visibly usable, normal cleanup vs forced destruction recorded separately |
| Delivered/native provenance | Matching source pins, generated worker/consumer hashes and actual compiled owner core; Node/native twin uses same ownership logic; licenses/manifests preserved; no test-only shortcut around real launcher |

Future validation must include the runtime's named single-kernel/routing/review,
sync-capture and migrated runtime contracts, SDK/workspace HTTP/process/storage
contracts and original full-app acceptance commands. Broad `markAsUncloneable` failure
must be fixed under separately authorized compatibility scope or recorded as a
remaining blocking/excluded contract; never silently omit it from the denominator.
Historical close failures stay in the evidence index with their original receipts.
Browser Worker termination, Chrome census lag, and OPFS lock release require actual
platform observations; an Effect scope cannot manufacture those acknowledgements.

## Benchmark requirements, not performance claims

Compare the repaired imperative candidate against the Effect candidate on matched
source/dependency/native inputs, topology, flags, compression, startup order and
correctness obligations. Keep retention off/on as separate conditions rather than
confounding cache reuse with framework overhead. Freeze exact runtime/toolkit/Effect
versions, worker/consumer hashes and served manifest for each arm.

Predeclare bounded cohorts, timeout/first-failure policy and cold/warm conditions;
counterbalance/interleave fresh isolated origins. Measure end-to-end usable preview
and hydrated chat readiness, workspace-switch completion **including audits and
cleanup**, native-fetch/stop latency, cancellation-to-actual-settlement, persistence
flush/close, output/HTTP streaming backpressure, and mixed filesystem/compression/
SQLite workload tail delay. Include failures/timeouts and unresolved drains, not
only completed samples. Report raw distributions; tiny cohorts do not establish p95/SLA.

Measure compressed VFS physical bytes vs logical bytes, WASM reservation, worker/
PID counts, retained fibers/leases/promises/pins/ports/timers, JS/whole-browser memory
with attribution limits, OPFS churn, worker boot and bundle transfer/parse cost.
Effect tracing/scheduler/yield settings belong in the artifact receipt. No new speed
claim follows from fewer manual Promises, and cooperative fibers cannot preempt a
long synchronous VFS/compression/SQLite call on the consolidated event loop.

## What Effect cannot solve / explicit non-goals

- **Remote OpenCode ownership:** cancelling a client read or disposing a local
  RcMap entry does not release remote InstanceState refs, subscriptions, watchers,
  sessions or globally/background-owned tasks. Need remote admission freeze,
  cancellation/drain and lease/ref acknowledgements on the delivered application's
  actual protocol before broad reuse. Kernel supervision cannot invent that API.
- **Path/write safety:** scopes do not stop a real installer following `/bin` or
  other symlinks into workspace/cache roots. Canonical path/write authority,
  protected-root policy, staging/commit and source/hash verification remain required.
  Quiescence does not prove integrity, and integrity checks do not prove quiescence.
- **Permissions / confinement:** VFS mode/permission emulation, guest capability
  leakage, egress policy/CORS, storage partitions and untrusted message validation
  are not automatically secured by Effect or typed errors.
- **Stable roots / session routing:** workspace identity, stable-root reuse and
  OpenCode directory/session/model/chat selection remain application contracts.
  No scope boundary fixes wrong-session sends, draft loss or stale UI selection.
- **Platform proof and crash durability:** Worker termination acknowledgements,
  Chrome target absence, OPFS lock availability and abrupt tab-close durability
  require platform-specific evidence/policy. Normal finalizers may not run on crash.
- **Protocol / feature parity:** keep guest synchronous require/fs semantics, native
  WASM/Node reuse, output/body lifetime, guest event-loop phases and unchanged topology.
  Python editor LSP remains explicitly unavailable in this fork. Retained Vite,
  expanded OpenCode reuse and unrelated optimizations are not enabled by this study.

## Decisions needed from the user / parent

1. Choose extracted TS core, whole-kernel conversion, or continued imperative repairs;
   host-only is insufficient for the all-writer lifecycle goal.
2. Authorize **only the bounded pilot** or a broader implementation plan, including
   source checkout/package placement and exact Effect dependency pin. Nothing here
   authorizes installs, live launches or changing the frozen current candidate.
3. Agree shared retained-owner/write-set policy, cleanup deadlines/unresolved outcomes,
   public compatibility constraints and rollback artifact selection.
4. Assign independent qualification owners and browser slot only after the current
   full-app owner releases it; specify performance tolerances and parity exclusions.

The next useful authorization is the bounded production-seam pilot plus its concrete
regressions and package/build review. Full rewrite, retention and promotion remain
separate decisions. This report alone changes none of the current acceptance status.
