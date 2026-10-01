# Effect phase2A — launch/PID/subtree implementation

2026-09-30. **Production 2A cutover implemented, committed and frozen. Offline
implementation-owner checks pass 16/17 new cases; the remaining fixture passes its
stale-publication assertions but wrongly requires successful stop after an accepted
loader failure. That fixture remains FAIL, not silently waived or rewritten.
Independent qualification and parent review are still required.** No browser,
application host, inference, release promotion, pin update or push.

Absolute report:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-process-subtree-implementation.md`.

## Source and scope

Runtime worktree, initially clean at exact `3ee9185`:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/vivari-effect-loader-pilot`.
Branch: `experiment/effect-loader-pilot`. Final source:
**`cc5a932bf4f9a1da4bf8b5d16f6c6c7e4aec573d`**.

Owned commits:

- `90befdc094e3c4a8294e1bbfc09b1f4420dd99df`: core process/launch/descendant authority,
  kernel bridges, browser acquisition, native Node termination join, normative docs.
- `ca5eb413ce3322766a95fd17a1596b8c5b5cd9be`: concrete sync-capture regression repair;
  preserve standalone SAB framing while guarding registered PID publication.
- `5c5685b1b1e37194d1a2e30b9dabf5f6f87cc8fe`: reclaim settled resource captures,
  retain exit callback failure in subsequent wire metadata, unwind publication faults.
- `cc5a932bf4f9a1da4bf8b5d16f6c6c7e4aec573d`: forbid root/transferred-handle reuse for
  PID registration.

Production edits are only `packages/kernel-lifecycle/src/index.ts`,
`packages/kernel-host/kernel.js`, `packages/core/src/workers/kernel-worker.ts`,
`scripts/lib/spike-harness.mjs`; runtime AGENTS/ARCHITECTURE document the cutover.
No independent fixture, parent plan, SDK public source, fetch queue/body/pin,
loader2B, persistence, application/chat or native source was edited. Existing
toolkit staged work was preserved and is not part of this report commit.

## Frozen interface and authority

Existing `Owner.open`, identity, memoized `close(): Promise<void>`, `commit`,
`outcome`, loader function identity/generation/leases and OperationContext remain.
Kernel `registerLazyProgram`, `createLaunchOwner`, `launchLoaded(...,owner)` and
`ensureCommandLoaded` remain available.

| Addition | Contract |
| --- | --- |
| `Owner.cleanup(release)` | Accept a synchronous or Promise-returning cleanup before adapter invocation; close attempts every accepted leaf and aggregates every failure. Ordinary registration requires open admission. |
| `Owner.afterClose(publish)` | Register the synchronous settlement publication bridge before native invocation. Callback throws reject the same receipt; never join an ancestor from this callback. |
| `registerProcess(pid,parentPid,suppliedLaunchOwner?)` | Register the exact PID/parent in the core. An optional untransferred launch handle becomes that PID's process handle atomically; a root, foreign, closed or already-transferred handle cannot be reused. |
| `processOwner(pid)`, `processReceipt(pid)` | Core-backed exact identity/receipt accessors; duplicate stop uses the same receipt even after removal from `procs`. |
| `acquire(owner,invoke)` | Accept acquisition task before synchronous invocation; `invoke(own)` registers native resources. Reentrant close still owns and joins resources acquired before the adapter returns, including late cleanup failures. |
| `parentPid(pid)`, `reparentProcess(pid,parentPid)` | Core-authoritative parent bridge. The existing internal `proc.parentPid` setter forwards to this operation, rejects closed parents/cycles, and is not a second ownership ledger. Needed by the unchanged PID-egress fixture. |
| Worker `info.own(release)` / returned `owned:true` | Production browser/Node adapters transfer each partial resource into core cleanup before the next acquisition step. Older complete-handle adapters still use a preaccepted handle-transfer cleanup slot. |

The JS `_processCleanup` and `_processReceipts` maps are removed. Core owners own
children, close receipts, failed descendants, accepted cleanup/tasks and failure
outcomes. `procs` retains only synchronous process data/routing; its `finalized`
flag is a teardown projection, never admission authority. Core `open`/receipt is
the decision source. SDK exec maps hold the same `{execId,pid,owner}` projection;
pre-PID routing contains the authoritative launch handle.

`launchLoaded` transfers the same handle during PID registration **before** worker
construction, then rechecks its admission before `onStarted`. Successful launch
does not immediately close the transferred process owner. Failed acquisition,
boot-before-return, revoked transfer or failed publication joins that exact owner.
No PID can escape merely because `launch()` threw before returning its number.

Process worker callbacks capture exact record/owner. Spawn load-return, child-exit
and rejected dispatch bridges check an invocation counter plus exact process,
live owner, SAB REQUEST and opcode; old same-opcode responses cannot answer a
new invocation. Async-child exit checks its exact parent; thread online/exit checks
the exact parent and reqId-to-child projection. Thread acquisition failure publishes
its failed thread-exit only after owned cleanup; parent shutdown prohibits late online.
Native sync VFS/SAB framing, unused-owner synchronous fault settlement, guest Node
event loop and worker topology are unchanged. The standalone raw SAB helper remains
usable without registering a fake PID, as required by the existing protocol fixture.

`closeLoaderOperations()` now closes the shared loader/registered-PID ownership
root. **It is still not kernel all-writer, storage, persistence, HTTP-reader or
workspace quiescence.** Parent should review this intentional domain expansion;
there is no new all-kernel-close wire message.

## Failure, unwind and retention policy

Owner close freezes admission and allocates the memoized receipt before any abort,
native cleanup or callback. Cleanup invocation is guarded per accepted leaf;
one synchronous throw cannot skip other leaves or strand settlement. The existing
fetch cancellation, fetch tasks and body release receipts compose as PID cleanup
leaves; their backend queue, sharing, pin and rollback authority is unchanged.
The Effect drain joins these native promises and child receipts, not Scope.closed.

Exited children remain core obligations while cleanup is pending or failed, even
after deletion from `procs`. All accepted cleanup failures are aggregated, not just
the first rejected join. Failed owners and loader generations remain root-lifetime
failures. Exit callback failures are carried into subsequent public proc-exit
metadata; a publication bridge throwing after its own transport operation cannot
manufacture a transport acknowledgement. Nested textual cleanupError, rejecting
memoized SDK stop, Runtime attachment/no-replacement, Endpoint closed/settled and
output-reader separation remain the existing public contracts.

Partial browser worker ownership covers created worker, worker routing projection,
both FS channel ends and FS registration (unregister is accepted before register).
Constructor, registration-after-partial-insert and init postMessage throws finalize
the PID and attempt all accepted releases. Kernel owns transferred thread/workerData
ports too. Browser `Worker.terminate()` is a synchronous action, **not an invented
exit acknowledgement**. The Node spike adapter registers and joins the actual
`Worker.terminate()` Promise and releases registration/ports independently.

Reclamation decision: no TTL/count eviction of receipts or failed descendants.
At settlement, cleanup/publication closures, task sets and leases are cleared,
releasing dead worker/SAB/output captures. Successfully settled children detach
from the pending subtree graph. Compact PID identities/receipts/outcomes and failures
remain until their root is released, preserving duplicate stop identity. This is
**O(total allocated PIDs) metadata in a long-lived root**, not a count-bounded cache
claim. Failed roots must remain attached. A future explicit forget/handle-release
API would require compatibility review; this unit does not silently add one.

## New matching delivery

Final frozen root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-process-subtree-candidate-atw4whjs`.

| Item | Identity |
| --- | --- |
| Runtime | `cc5a932bf4f9a1da4bf8b5d16f6c6c7e4aec573d` |
| Archived toolkit library | `9814c715cfca42309c581440577976833f4326e6` (same committed library inputs as phase1; rebuilt against new SDK) |
| Effect | Exact `4.0.0-rc.118`; unchanged license/dependency pin |
| Distribution version | `446021ba611932b0c531570ecc5739255e8d97f608dcc8c53ad1ca07eeceb6a6` |
| Worker | `assets/kernel-worker-a6UDx747.js` |
| Worker SHA256 (SDK/runtime identical) | `7d21c5bfe263b047c1113d219623dcba50c47001624939448ae0d3d191926cea` |
| Compiled core SHA256 | `05859327b72d924b3533fc5b35c6b3db5a3c6ca429339a20da6abe1f5f2ebed5` |
| candidate-receipt.json SHA256 | `838195f4fed09e75ce83e9991f57d89e3001dd7990b5225e12466ea64f49a1f3` |
| freeze-manifest.json SHA256 | `59b394fab8d6773863f54435e2489b282f10429ad2603f9aebd86d1f3efa9fc8` |
| Native reuse | 12 tracked inputs / 37 output hashes verified before/after copy; **not rebuilt** |

Runtime source/core/SDK-worker build, workspace library/declarations/typecheck and
distribution packaging ran in isolated archive directories. `candidate/sdk`,
`candidate/workspace`, `candidate/runtime` contain 103 hashed delivery files;
1,475 freeze entries cover archives/source/native/core/builds/receipts/recipe.
Effect/Vivari/SQLite/vendor licenses are retained. No canonical dist/.runtime or
pins were changed. `compiledCore.browserWorker` is relative to `candidate/sdk`
(the identical path exists in `candidate/runtime`). This is a new receipt, not
the old hard-pinned phase1 admission schema. Full app/chat/consumer preparation
remains parent-assigned; no old combined app PASS is relabelled as 2A acceptance.

## Actual offline checks and remaining qualification

Final evidence root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-process-implementation-evidence-aylqy160`.
All commands use the previously verified official **Node24.18.0 arm64** executable
whose SHA256 is `ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a`.
Each JSON records the exact command, independent fixture digest, stdout/stderr and
status; every final candidate/freeze hash was rechecked afterward. These are
implementation-owner executions, **not independent acceptance**.

- New contracts: **16 PASS / 1 FAIL / 0 unrun**: held native terminate, duplicate
  stop, exited pending child, concurrent subtree stops, throwing terminate,
  multiple exited-child failures, public Runtime failed-PID attachment, launch
  revocation, boot before handle return, stale child publication, thread transfer
  revocation, late thread after stop, actual native Node terminate and actual
  production Node adapter Promise; actual emitted browser acquisition with
  constructor, FS registration and postMessage failure all pass.
- `stale-loader-rejection`: exact bytes/SAB state remain unchanged after the old
  rejection (**both intended stale-publication assertions pass**). Its final
  `await kernel.stop(pid)` at fixture line201 rejects with OLD_LOADER_REJECTION,
  as required by phase1 retained accepted failure. Fixture owner must review the
  final-success assumption; production does not erase that obligation. File untouched.
- Preserved: **4 loader + 10 expanded loader/native/public + 6 PID-egress + 8
  endpoint + 3 close cases PASS**, plus unchanged routing, real binary sync-capture,
  single-kernel review and single-kernel suites PASS. No skipped/modified assertions.
- Early `90befdc` frozen check exposed the raw SAB helper regression; its failed
  evidence is preserved at `effect-process-implementation-evidence-zfem39i5`.
  Source `ca5eb41` fixes that concrete cause; final unchanged suite passes.
  Earlier builds/failed staging directories remain preserved, not overwritten.

Final worker cost, recompressing phase1 donor and new worker with the same Python
gzip level9/mtime0 recipe: **5,457,312 -> 5,465,904 raw (+8,592)**;
**2,082,241 -> 2,084,140 gzip (+1,899)**. Original phase1's recorded matched
imperative comparison remains **+621,609 raw / +135,365 gzip**, a separate baseline
measurement. Runtime scheduling/allocation overhead is **unmeasured**; no speedup,
overhead attribution or app timing conclusion is claimed.

Next: parent/independent owner reviews the one fixture-contract mismatch and admits
the new frozen receipt for independent offline qualification. Parent separately
assigns matching consumer/full-app preparation and a single browser owner later.
No 2B loaders, phase3 fetch, all-writer/persistence/cache/session disposal or broader
quiescence audit is authorized or implied by this handoff.
