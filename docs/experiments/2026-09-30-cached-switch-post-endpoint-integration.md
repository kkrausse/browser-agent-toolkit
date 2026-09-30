# Cached TODO switching after endpoint ownership repair

Report: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-cached-switch-post-endpoint-integration.md`

## Outcome

**The endpoint-upload blocker is repaired. A separate retained-kernel guest-egress
ownership counterexample prevents claiming the requested complete fetch join.**
No retention-on adapter or ineffective flag was shipped. The original default-off
conservative switch, journal, recovery and session hydration remain unchanged.
This is an additional source-supported, reproduced blocker, not a relabeling of
the old e35 host SDK counterexample. No browser/server, live origin/storage/VFS,
paid inference, canonical pin, shared generated output or frozen artifact was
modified. No runtime/controller/chat/Root/model-QA code was edited. No push.

The continuation was evaluated against toolkit `7713686` ownership code (included
in the new committed archive) and **final runtime host source
`724909bff00c9c0994ecde7c767a218ae2af25a0`**, not the first `a079153` repair.
`Endpoint.closed` is admission closure; `Endpoint.settled` joins owned upload
reads/cancellation and retains failures. Runtime/controller shutdown awaits that
receipt and rejects rather than releasing ownership on its failure. The new
endpoint qualification, including reentrant pull/abort, passed again offline.

## Additional causal gap: guest HTTP/HTTPS egress

The retained kernel's `OP_FETCH_ASYNC` transport has a different owner from
`Endpoint.fetch`:

- `packages/kernel-host/kernel.js` `handleFetchAsync` acknowledges the syscall,
  then starts `_fetchIntoVfs`. `_scheduleFetch` retains active/queued network work
  with no PID cleanup receipt exposed to the SDK.
- `finalize` deletes the PID and releases **existing** body pins, then publishes
  `onExit`/`onProcExit`; it does not cancel or join that active/queued fetch work.
- `_doNetworkFetch` can subsequently call `fs.writeLarge` into
  `/var/cache/vv-fetch`. `_fetchIntoVfs` then adds a body pin for the already-dead
  PID. The async completion's `postToProc` cannot deliver to that deleted PID.
- `packages/core/src/host-sdk/execution.ts` `Execution.stop()` awaits the
  `proc-exit` receipt. Toolkit `Runtime.stop()` and controller service shutdown
  have no additional kernel-egress join. Endpoint upload settlement does not
  acquire these kernel-owned outbound operations.
- `packages/core/src/workers/kernel-fetch.ts` `doFetch` executes fetch/body reads
  in the retained kernel; its options carry no PID lifetime cancellation signal.

These kernel/protocol/fetch source trees are **byte-unchanged** between e35 and
724 (`git diff e35eab4af7a53ff08eb70c09df59c40b78bfdd67
724909bff00c9c0994ecde7c767a218ae2af25a0 -- packages/kernel-host
packages/protocol packages/core/src/workers/kernel-fetch.ts` produced no diff).
The supported endpoint repair did not purport to repair this separate transport.

### Executed offline characterization

Own committed test:
`examples/todo-app/tests/cached-switch-egress-stop-proof.mjs`, commit
`a66d365e54032d5067b7b0bc81a334fa263e7114`.

The fixture imports **actual committed kernel/protocol modules** and separately
built committed repaired host SDK `launch`. It sends real length-prefixed
`OP_FETCH_ASYNC` SAB frames through the kernel's syscall dispatch, holds the first
network response and queues a second request, and awaits SDK execution stop plus
both output drains. Then it releases the responses and joins the fixture work.

```json
{"executionStopJoined":true,"readersJoined":true,"processesAtStop":0,"fetchActiveAtStop":1,"fetchQueuedAtStop":1,"queuedNetworkStartedAfterExit":true,"vfsWritesAfterExit":2,"latePinnedBodies":2,"fetchOwnershipProvenAtStop":false}
```

The worker, host relay, filesystem and network are **controlled offline leaves**.
No actual guest worker or browser fetch was run. Kernel dispatch, queueing,
finalization, late writes/pinning and SDK execution receipt handling are shipped
code, not copied implementations. Private fetch promises are inspected **only by
the fixture** to release/join its work; they are not proposed as an app API.
The two writes are to in-memory scratch `/var/cache/vv-fetch`, **not observed writes
to source, installed dependencies, or Vite caches**. This does not demonstrate a
TODO JSON-request overlap, live browser behavior, model traffic, or failure of all
narrowly constrained consumers. It does disprove treating PID exit/SDK stop/output
drain as a complete fetch-ownership join for the supported egress transport.

Reading nonempty `diagnoseWorkspace().fetch` counters would reject this specific
held cohort. A zero counter sample is not a failure-retaining per-owner cleanup
receipt. A separately justified stopped-owner exclusion policy could potentially
be narrower than the requested complete joins; it is not implemented or qualified
here. Idle chat alone does not establish that every earlier guest shell/client/
plugin egress operation has joined. No new safety guarantee is inferred from it.

## Helper bootstrap and remaining admission

The pre-audit helper problem remains real but is not presented as an impossible
app-only fix. `runEnvironmentScript` installs a hashed script below
`/workspace/.browser-editor-cache/experiments`; runtime `installFile` uses following
`stat` and compares existing bytes. Equal bytes through a symlink therefore do not
prove ownership of the helper leaf or its ancestors. Hashing the audit's subject
after executing a redirected bootstrap would be too late.

Once **all** shutdown prerequisites are proved, the app can wrap the audit/
replacement descriptor's `installFile` with a stopped-owner check using public
`diagnoseWorkspaceEntry` for workspace root, every cache/helper ancestor and each
exact leaf, rejecting unexpected kind/symlink/content without deleting unknown
user objects. Absent parents must remain absent or be created only in the
exclusive interval; conflicting leaves must fail closed. `servicesStopped: true`
is not the proof, and lstat is not protection against competing writers.
`diagnoseWorkspaceEntry` addresses `/workspace`-relative entries; it is not an
arbitrary-guest-path audit API. A retention hit should not need `preparedApps`'s
separate `/runtime-probe/.browser-editor` installation at all.

No helper was installed or retained before/replacement/after interval executed in
this work. With kernel-fetch ownership unresolved, wiring the source adapter now
would either weaken the explicit contract or leave the requested on treatment
unqualified. The previous integration report's requirements still apply: complete
prepared/provenance/config-transitive/launch/artifact/runtime/library identity;
durable outgoing snapshot and incoming journal before disposal; positive reader/
execution/endpoint/fetch joins before mutation; bounded full immutable-tree and
cache audits with equal interval digests; exact incoming source/identity; native
session mapping/selection/hydration before final catalog commit. Cancellation or
unproven cleanup retains pending and forbids fallback. Recovery remains off.

## New isolated committed build evidence

New stage (old stages preserved):
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/cached-switch-post-endpoint-gPnbX4`.

The retained `stage.ts` archives toolkit characterization commit `a66d365` and
actual 724 host/kernel/protocol source, builds libraries and the complete off TODO
UI separately, emits strict library declarations, and checks the full consumer
against the built package declarations. The app resolves final built library JS,
not mutable workspace/chat source. Ordinary installed third-party dependencies
are reused read-only by node_modules links; no fresh dependency installation or
fully frozen dependency-archive reproducibility is claimed.

| Evidence | SHA-256 |
| --- | --- |
| New committed toolkit archive | `7665661967be4ef2671394ebff2b389cb73e6ce2d5ee3bad90fc89bfe092524b` |
| New 724 host/kernel/protocol archive | `ea0e08f8c8c92e150744c2c609236c151ef581cd8aa2467783fd93c4d78dcce5` |
| Repaired host SDK JS | `d7d63f2784a797340375d7c4500b232512dea6f6639ecb0eeb28dc2a674ac919` |
| Built workspace index JS | `6188d78d03c9ce8247e6187eba73a6a5fff719e3a36ddb365ceb32aea0660c20` |
| Complete off UI JS | `e655695d75fe5b5a86ab7254b7d3bd942b81423691512295bba3ef1c3c49378d` |
| Complete off UI CSS | `3001957bde872c351aa2d5440ceb8605171fc7f7a9b4bf19ab117a705dc1c051` |

All frozen receipt input hashes were reverified. The stage explicitly retains
unchanged **e35 worker/native distribution** with runtime version
`bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`
and distribution JSON hash
`94a50946622e2095536c30bf42d4cbcb03c6e7c74f33caec9e5503e4afa129a0`.
New host SDK identity is separate; no Wasm rebuild or canonical pin update is
claimed. The toolkit archive includes the 691 chat, d1 cache and 771 ownership
changes. Library/UI bytes match H0Z3JO because this task did not change app or
library implementation; the new archive additionally contains the egress proof.

Passed in the new stage:

- Separate library and full off UI builds, strict declarations and full consumer
  typecheck.
- All eight host endpoint cleanup characterization cases, including reentrant
  pull/abort and rejected upload cancellation/read.
- Built-host endpoint/service-readiness/lifecycle/shutdown fixtures: **25 pass,
  0 fail, 93 assertions**.
- Existing environment/delivery/ownership/source admission/switch/native-session
  fixtures: **59 pass, 0 fail, 297 assertions**. These ordinary fixture suites are
  not a claim of browser SDK fidelity; the explicit SDK counterexample above
  imports the newly built repaired SDK bytes.
- The new kernel-egress counterexample; `git diff --check`.

Raw commands, stdout/stderr and exit codes are retained in the stage logs.
The earlier small `cached-switch-egress-aLmHpb` archive is also preserved. Initial
fixture attempts incorrectly encoded a syscall frame, received protocol errors,
and were corrected to use the committed encoder before the successful evidence
above; those attempts are not counted as successful egress tests.

## Parent handoff

Coordinate the kernel/runtime owner for a supported PID/subtree egress cleanup
receipt covering active **and queued** requests, network/body-read/write/pin
continuations and cleanup failures before the exit/stop ownership boundary;
alternatively, separately prove a narrower exclusion across the actual enabled
guest shell, client and plugin request sources. Do not change owner code from this
app task or falsely keep the old worker distribution if a worker-side repair
changes it. Late pins after PID release are an additional concrete owner finding.

Independent endpoint streaming browser QA remains valuable and was not
interrupted. **A safe retention-on frozen candidate and matched off/on pair are
still unavailable.** This stage is complete off client/library build evidence,
not a served or qualified whole-origin candidate. Full TODO manual/headless
switch QA, timing and stress remain pending after ownership and app admission are
resolved. No expected performance improvement is claimed.
