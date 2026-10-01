# Effect loader phase1: source review and bounded phase2 handoff

2026-09-30. **APPROVE the bounded phase1 cutover; no blocking defect identified in
its loader/native-join contract. Recommend sequential phase2 implementation units,
PID/launch/subtree authority first, remaining loader adapters second.** Parent owns
authorization and the high-level migration plan; this is a technical handoff, not
authorization to implement or a replacement plan.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-loader-phase1-review-and-phase2-cutover.md`.

## Review boundary and evidence

Read-only review of actual runtime `3ee918522c1233a1f8e10a9b798c09b6c3e30c81`,
diffed against `33fa135`, in
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/vivari-effect-loader-pilot`.
Read toolkit `73dbae7` and current `workspace-api/src/runtime.ts`, runtime/toolkit
instructions, DEVELOPMENT, the parent plan, Effect services/testing references and
installed **4.0.0-rc.118** source. Runtime tree was clean. No build, test, browser,
host, guest, package upgrade, pin, generated-output or evidence modification was
performed. Only this new report is owned.

Read the implementation handoff `fc91222`, URL repair `c711c03`, independent
qualification `bf791e0`, historical browser failure `4470897` and integrated
follow-up `8593093`. Evidence is supporting qualification, not a substitute for
the source reasoning below:

- Independent qualified Node: 10 expanded + 4 loader + 6 PID-egress + 8 endpoint +
  3 close cases, plus actual emitted URL/native pack gate.
- Browser: real tsgo compiler normal load and held-header/public Runtime-stop pass.
- New unchanged integrated attempt: 19 stages, five generations, persistence
  reload/final close, 10 focused cases/14 steps pass.
- The original apps-1 `Failed to fetch` remains an unexplained historical failure;
  the follow-up does not erase it or establish a statistical reliability rate.
  No further phase1 browser loop is recommended.

## Source anchors and contract conclusions

Runtime paths below are relative to the exact worktree above; toolkit paths are
relative to `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`.

| Contract | Actual authority / reasoning |
| --- | --- |
| One shared loader supervisor | `packages/kernel-host/kernel.js:301-304,371-399` replaces `lazyInflight` with the TS core; `packages/kernel-lifecycle/src/index.ts:50-71,183-220` keys one operation by registered loader function. Command aliases share that key. Worker `launchByExec` is routing to an owner, not another installer/inflight ledger. |
| Atomic admission and reentrancy | Core `:83-112` memoizes owner receipt, closes admission and notifies departure before abort/finalizers. `:194-203,213-219` registers operation, lease and caller task before executing native code. Last release sets operation Closing before `AbortController.abort()`. `Owner.commit` at `:82` checks admission and performs the synchronous bridge without an intervening await. |
| Exact generation and disposal | Core `:185-187` waits for a Closing generation's settlement before another generation can acquire write authority; `:173` deletes only if the map still contains that exact operation. `:145` checks root/operation admission and live interest at adapter commit boundaries. No old-generation cleanup removes a newer map entry. |
| Shared interest | Core `:61-71,199-211`: releasing one consumer leaves another's native operation running; last release aborts and returns its native-settled receipt. The closed caller's task may reject promptly, but its owner close joins last-release settlement. It does not wait for another still-live consumer's installation. |
| Native settlement, not an interrupt receipt | Core `:147-180` masks the native-promise bridge, explicitly signals abort, awaits the operation fiber and its memoized scope receipt before resolving `op.settled`. `loader-vendor-bytes.js:3-49` awaits fetch, outstanding reader read and memoized reader.cancel, releases its lock, and retains cancel/release failures. Bodyless response fallback also awaits arrayBuffer; installer checks admission after fetch. Ignored abort cannot manufacture early cleanup success. |
| Joined transactional tsgo | `load-real-tsgo.js:141-174` installs through `loader-install-transaction.js:4-44`. Previous bytes/directories are journaled before mutation; batch settlement precedes its post-write admission check and rollback. Restored shims use the same transaction. Rollback awaits every restore/unlink/rmdir and aggregates original plus rollback failures. Sync writeFile/mkdirp are the existing synchronous VFS contract, not arbitrary Promise-returning adapters. |
| Failure retention and idempotence | Core `:54,89,113-134,174-178` keeps failed generations independently of the live operation map and records consumer failures. Aborted AbortError/ECANCELED is successful cleanup only after settlement; aggregate rollback/cancel failures are not normalized away. Owner receipt and scope receipt are memoized. Kernel `:978-995,1136-1151` retains exact PID receipts including failures; failed descendants remain in `_processCleanup` after leaving `procs`. |
| Pre-PID production seam | Kernel `:337-368` exposes `createLaunchOwner`, `launchLoaded`, `closeLoaderOperations`; worker `:1258-1288,2583-2589` registers the launch owner before awaiting, maps/publishes PID synchronously via onStarted, and closes that exact owner on proc-kill. Launch cleanup failure is published only after its join; allocated PID is stopped if admission/publication fails after allocation. |
| Guest no-late-launch checks | Kernel `:1763-1768,1847-1851` checks exact parent record, finalized flag, loader-owner admission and current SAB REQUEST/opcode after the load await. No extra async gap precedes child creation. This is not a universal syscall invocation-token scheme: later child-exit and unrelated syscall paths still use their old guards. |
| Public failed-stop bridge | `cleanup-failure.js:4-11` serializes nested AggregateError messages without transporting Effect internals. SDK `packages/core/src/host-sdk/execution.ts:61-69,96-106` memoizes rejecting stop and maps pre-start cleanupError to CLEANUP_FAILED. Toolkit `workspace-api/src/execution.ts:1` reexports this SDK; Runtime `:48-64,89-102` retains pre-PID cleanup failure after pending-launch removal and refuses detach/replacement on failure. |
| Same compiled ownership core | Kernel `:24` imports `../kernel-lifecycle/dist/index.js`; browser worker imports that Kernel and Node harness `scripts/lib/spike-harness.mjs:34` imports the same Kernel. `scripts/build-kernel-lifecycle.ts:1-14` typechecks and emits one environment-neutral ESM bundle. There is no browser-only lifecycle implementation. Prior qualified artifacts share core digest `211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070`; this review did not rebuild it. |

### rc.118 semantics checked, not assumed

Installed `node_modules/effect/src/internal/effect.ts:3960-3984` marks a scope
Closed **before** running finalizers; another close returns immediately. Close
enters an uninterruptible region. `:4004-4024` collects finalizer exits.
`acquireRelease` at `:4165-4180` requires a release with typed error `never`, so
typed cleanup failure cannot safely be delegated to an acquireRelease finalizer.
`forkIn` at `:5649-5658` registers an interruption finalizer, avoids interrupting
itself, and removes its registration on exit.

The pilot correctly supplies its own domain memoized native receipts/Exit ledger.
Scope state is not read as a drain proof. The JS observer at core `:159-180` closes
the operation scope after Fiber.await, outside the executing native fiber;
owner drain is outside caller tasks. The load task does not call owner.close,
and launchLoaded closes only after its load task returns. This avoids a task
waiting for its own receipt. Returning the promise from loader code that itself
awaits its owning close would still be an invalid cyclic adapter contract; the
production tsgo adapter does not do so.

### URL repair

Actual SDK `host.ts:43-55` resolves the public distribution root; constructor
handoff puts it in the worker URL query. Worker `kernel-worker.ts:123-137` uses
native URL resolution with that root and a parent-directory fallback for the
SDK's `assets/`/`./` layout. The source repair concerns asset placement, not
ownership. It does not promise CDN/CORS behavior or mount an absent host route.

## What phase1 does not guarantee / concrete next-cutover risks

These are **not phase1 acceptance blockers** within the explicitly bounded loader
contract. They are requirements or exclusions for subsequent implementation:

1. **PID ownership is not yet in Effect.** `proc.loaderOwner` owns loader interests
   only. Kernel `finalize`, descendant traversal, native termination, resource
   cleanup and exit publication remain imperative (`kernel.js:978-1151`). Root
   loader close does not kill PIDs or close persistence. SDK Host.destroy
   (`host.ts:164-172`) terminates the kernel; it is not an all-writer drain receipt.
2. **Partial worker acquisition remains exposed.** `createProcess:587-625` enters
   the PID/debug registries before invoking spawnWorker. Browser adapter
   `kernel-worker.ts:1495-1608` creates worker/ports/registers FS before postMessage
   and only returns its cleanup handle afterward. A synchronous constructor,
   registration or postMessage failure lacks a locally owned acquisition unwind.
   This is existing process-domain work for phase2, not a demonstrated new tsgo
   failure or justification for an unapproved reproduction run.
3. **Universal late-publication/admission is absent.** Child exit handlers
   (`kernel.js:1791-1829,1873-1883`), thread-spawn, generic failSyscall (`:1304-1316`)
   and worker messages are not all exact-owner/operation-identity commits. The
   load-return guards must not be described as solving those old paths.
4. **Failure is preserved, but not every simultaneous PID failure is aggregated.**
   Finalize uses the first rejected join for public cleanupError (`:1137-1141`);
   loader aggregate detail survives, and child failures remain in the pending/
   failed registry, but phase2 must retain/compose all accepted cleanup failures
   when moving that registry's authority. Synchronous leaf/callback throws and
   ignored terminate errors must not strand its new memoized receipt.
5. **Remaining loaders are wrapped, not transactional/cancellable.** Worker
   `:1922-1946,1968-1981` passes native signal/transaction context only to tsgo.
   npm/yarn/pnpm/corepack ensure functions keep the old no-context fetch, shim and
   null-on-unavailable behavior. Their returned promises are joined by the shared
   core; they can continue writing while close is pending, and cancellation does
   not yet roll those writes back. Direct loadReal* helpers also remain outside an
   owner unless their caller uses the registered path.
6. **Retention/cost remains explicit.** `_processReceipts` retains successful PID
   receipts for Kernel lifetime (`:288,986`), and failed-operation/error ledgers
   retain failures. Decide bounded lifetime/receipt-handle reclamation without
   deleting failed descendant obligations or breaking duplicate stop. Original
   matched worker increase was **+621,609 raw / +135,365 gzip bytes**; runtime
   performance and allocation cost remain unmeasured. No speedup or measured
   overhead attribution follows from the app timing/failure.

No path-confinement/security guarantee is added: the transaction is not a hostile
symlink-safe installer or validated pack decoder. Guest markAsUncloneable gap,
old editor failed-save/busy-close/retained-target observations, cache admission,
native model/session/chat disposal and process reuse remain unresolved. Successful
integration workloads do not supply exclusive writer admission or fix these races.

## Ready phase2 implementation units (for parent authorization)

### 2A — launch/PID/subtree authority, before more loader adapters

**One implementation owner** should own `packages/kernel-lifecycle/src/*`,
`packages/kernel-host/kernel.js` lifecycle/spawn/thread seams and
`packages/core/src/workers/kernel-worker.ts` launch/worker acquisition seams.
Include the small Node worker-host adapter updates needed for truthful termination
joins (for example `scripts/lib/spike-harness.mjs:61-96` currently discards
Node Worker.terminate's promise); do not rewrite all test harnesses or platforms.

Move the existing pending launch, PID receipt and descendant-failure authority into
the TS core. Keep `procs` as the synchronous process-data/routing table, not a
second lifecycle state machine. Worker execId maps remain routing projections;
each holds the authoritative owner/token, not independently deciding close.
Remove or reduce `_processCleanup`/`_processReceipts` to core-backed accessors once
their obligations transfer; do not maintain parallel close/failure ledgers.

Freeze a narrow interface before delegation:

- Preserve existing `Owner.open`, `close(): Promise<void>` (same receipt identity),
  `commit(publish)`, `outcome`, `OperationContext`, `registerLazyProgram`,
  `createLaunchOwner`, `launchLoaded(..., owner)` and `ensureCommandLoaded` bridge.
- Add core-owned parent/child registration and exact PID/launch handles, plus
  accepted-task/cleanup registration **before invocation**. Names can be selected
  by the implementation owner; these additions do not exist today. Separate
  close-admission initiation from joining so a child's exit callback cannot await
  an ancestor receipt which itself awaits that child.
- Atomically transfer launch responsibility to a registered PID before publishing
  proc-started; retain acquisition cleanup if allocation/boot/publication fails.
  Scope must not be the public receipt. Adapter must return its owned resource
  cleanup even on partial acquisition, and join asynchronous native termination
  where the platform offers it. Browser termination is a synchronous platform
  action, not an invented worker-exit acknowledgement.
- Descendant obligations survive removal from `procs`, including exited-child
  failure. Already-authoritative guest-fetch receipts are **composed as leaves**,
  not migrated to a second fetch owner in this unit. Keep its queue/body/pin
  implementation and phase3 gate intact.
- All spawn/thread/exit/error publication must check the exact live owner and
  applicable syscall identity at the synchronous bridge. Preserve synchronous
  unused-owner boot-fault behavior while handling acquisition exceptions.

Keep wire/ABI stable: proc-started/proc-exit/execId, exitCode/signal/forced,
textual nested cleanupError, LAUNCH_REJECTED versus CLEANUP_FAILED, idempotent
rejecting stop and retained Runtime attachment. Preserve Endpoint.closed versus
Endpoint.settled and output-reader separation. Do not transport Effect Cause or
introduce a new all-kernel-close message in this unit.

### 2B — all registered lazy-loader adapters, after 2A freezes

Own `load-real-npm.js`, `load-real-yarn.js`, `load-real-pnpm.js`,
`load-real-corepack.js`, shared `loader-install-transaction.js`/native byte adapter,
and the narrow `registerLazyTools` wiring (serialize any worker edit with 2A).
Reuse the same loader function identity/generation/lease model; no loader-specific
inflight map, root cache interest or hidden daemon.

Pass the operation context into every actual registered ensure path, use native
abort-and-join bytes, and journal each managed package root, shim and auxiliary
write (npm's node-gyp stub included). Keep decode/batch/restore/shim work within
that operation's receipt. Last interest cannot leave a successful stop followed
by writes; rollback failure must reject and retain registration for retry.
Review the current optional-null asset policy explicitly: do not silently turn
null into successful installation/removal of registration, nor change guest/public
errno policy without parent compatibility approval. Preserve no-asset boot and
ordinary upstream commands. This is not a pack-security or dependency-cache rewrite.

### Independent regression ownership and bounded integration

A separate regression owner owns **test files/reports only**, with no implementation
edits. Coordinate the frozen handle/receipt interface with 2A; use deterministic
handshakes, not arbitrary sleeps or a new generic unit-test framework. Reuse the
existing 10 expanded/4 loader gates and baseline negative controls, six PID-egress,
eight endpoint, three close, routing and sync-capture contracts.

For 2A add only concrete cutover cases: stop-before-PID and repeated receipt,
child exit-before-parent-stop with failed/pending cleanup, synchronous worker
acquisition/postMessage failure, boot/exit before handle transfer, late publication,
and cleanup callback failure without self-join or hung receipt. For 2B extend the
held vendor/write/shared-interest/rollback gates to actual remaining ensure paths
and cover their auxiliary writes and unavailable-asset mapping. Existing tests
must import the real core/Kernel/SDK, not a shadow owner.

After each unit: frozen source/build/import/type contracts, independent offline
regressions and truthful failed-stop mapping. After both units: parent assigns
matching delivery and reuses the existing native browser loader/stop and unchanged
integrated acceptance gates, with one visible owner and first-failure stop. Do not
start new phase1 cohorts now. New source needs its own qualification; phase1 PASS
cannot be relabelled as a phase2 result.

Exclude fetch-authority migration, arbitrary RPC writers, depcache/readiness jobs
(including worker `onProcExit:1704-1707` fire-and-forget snapshot), persistence,
exclusive workspace capture/switch, chat/model disposal and cache retention from
2A/2B. They remain later planned domains. **Advance the staged migration, not its
claims: phase1 is accepted in scope; phase2 is ready for parent authorization.**
