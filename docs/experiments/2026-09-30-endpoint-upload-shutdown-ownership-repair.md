# Endpoint upload shutdown ownership repair

Report: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-endpoint-upload-shutdown-ownership-repair.md`

## Outcome

Implemented the causal host-source cleanup join and wired supported toolkit
runtime/controller ownership to it. **Offline qualification only. TODO cache
retention remains unwired/off, and app admission remains blocked on live QA and
bootstrap/admission prerequisites.** No browser, server, profile, user storage,
paid inference, source VFS/worker topology change, pin update, shared generated
output replacement, frozen artifact mutation or push occurred.

Source commits:

- Runtime `a07915388155df6a2ac2c40b9cf391ff8309bdb2`, then reentrant-pull
  review correction `724909bff00c9c0994ecde7c767a218ae2af25a0` (final built source).
- Toolkit `7713686e26d1fe61da5c75b37796875126f60e11`.

## Causal contract

`Endpoint.closed` still means admission closed. New required public
`Endpoint.settled: Promise<void>` means disposal plus all host-owned HTTP source
read/cancel continuations have joined successfully. Existing `dispose()` remains
synchronous, memoized and prompt. It aborts accepted requests immediately; their
fetch rejection does not await the source cancel promise.

`fetchHttpStream` registers its cleanup receipt synchronously (optional fourth
callback, preserving existing call shapes). Cleanup closes the channel, removes
abort admission, releases response pull waiters and cancels the upload once. Its
receipt awaits both source cancellation and every outstanding upload task, then
releases the reader lock. Read/cancel/channel-cleanup failures remain aggregate
failures; an unresolved source keeps the receipt pending. Rejection observers
prevent unhandled-rejection noise but do not convert the original public promise
into success. A task may request cleanup without awaiting its own receipt: no
self-join cycle. Response reader cancellation returns the same cleanup join.
Upload tasks are registered before invoking user-source reads; a source pull may
abort reentrantly. Already closed queued tasks do not initiate new reads.

Endpoint ownership is independent of active response/admission accounting: a
request cleanup receipt is registered before synchronous abort is possible, and
failed request receipts remain retained even after their request has finished.
Listener unlisten may close admission while responses drain; disposal joins their
receipts. Runtime abort, explicit disposal, listener replacement and host failure
remain idempotent closure paths. Initially aborted runtime signals close promptly.

Toolkit `Runtime.expose` registers every concrete endpoint receipt, not its
`closed` notification. Successfully settled endpoints can retire; rejected receipts
are retained as runtime failures. `Runtime.stop` is memoized, closes admission and
aborts promptly, joins pending launches and all execution/endpoint stops with
all-settled ownership, then rejects on any cleanup failure. `state.attached` is
released **only after successful joins**. A held cancellation prevents completion;
rejection prevents clear/replacement/new wrapper through the existing attached
owner guard. The SDK capability is required: exposing an old SDK endpoint lacking
the receipt disposes it and permanently records ownership-unproven failure, rather
than treating `undefined` in `Promise.allSettled` as success.

Controller service settlement includes endpoint cleanup, including services that
exit/detach before stop is requested. `stopService` joins process stop, output drain
and endpoint receipt; `stopServices` retains failures across subsequent attempts.
Failed/late readiness acceptance disposes the endpoint once and joins its receipt
after accepted expose/connect work joins. Consequently `stopRuntime`/close cannot
proceed to workspace release after unproven service cleanup. This adds no queued
replacement or cleanup deadline, and does not promote forced termination to proof.

Compatibility: source callers implementing/mock-constructing `Endpoint` must add
`settled`; updated shipped consumers build against newly emitted declarations.
Old JavaScript host SDKs are rejected at expose. Worker ABI/stream messages and
native code did not change. Keep the newly built SDK/library with their receipt;
the frozen e35 host SDK is **not** repaired by these source commits.

## Validation and boundaries

- New `scripts/test-endpoint-cleanup.mjs`: **eight passing cases**, run against
  source and the separately built committed host SDK. Real `ReadableStream` and
  MessagePorts, public `createEndpoint`, transport substitute only. Covers held
  cancellation after abort/unlisten/reentrant source pull, rejected cancel, response reader cancellation,
  EOF, upload-read rejection and response overflow. Checks exactly-once cancellation,
  pending ownership before release and failure after source rejection.
- New toolkit endpoint regression plus existing service readiness/lifecycle/shutdown:
  **25 pass, 0 fail, 93 assertions** against archived source and built committed
  host SDK. Runtime/controller variants hold real cancellation, preserve attachment,
  reject failed ownership and forbid a new runtime. Controller failure remains
  failure on subsequent stop. These are transport/process fixtures, not live guests.
- Existing `test-single-kernel-close`: all three cases pass, including real thread
  exit. `test-single-kernel.mjs`, `verify-node.mjs`, and
  `verify-runtime-contracts.mjs vm-import` pass.
- Full `verify-runtime-contracts.mjs` **fails**, unrelated to changed host code:
  `worker-uncloneable.cjs`, `TypeError: markAsUncloneable is not a function`.
  Runs used available Node **24.7.0**, not qualified Node 24.18.0; no broad-suite
  green or qualified-toolchain claim is made.
- Strict new ownership/lifecycle/shutdown source check passes. Including the
  readiness fixture in that targeted check also exposed its inherited mock missing
  `Runtime.tools`; that test-source type error was not hidden as a production error.
  Full strict library declaration emit and full off-app declaration consumer check
  pass separately.
- Original e35 characterization was re-run unchanged against the retained MGBmBw
  built archive: admission/fetch rejection precedes held source cancellation exactly
  as reported. The new public-receipt regression fails against that prior SDK because
  the receipt is absent. Neither baseline evidence nor report cases were relabeled.

This is a supported **streaming-input counterexample/regression**, not a claim that
ordinary current TODO JSON requests have caused a live overlap. Platform stream
cancellation receipts and host-owned read continuations are the supported boundary;
it is not a receipt for arbitrary external work hidden outside a source's stream
contract, guest HTTP socket cleanup, Chrome target destruction or OPFS lock release.

## Isolated committed build identity

New stage (not served):
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/endpoint-repair-frozen-H0Z3JO`.
Retains recipe, exact committed source archives, command logs, host SDK, workspace
and chat JavaScript/declarations, full off TODO client/CSS, regression bundles and
`stage.json`. Ordinary installed dependencies are reused read-only; no fresh
package-manager-lock reproducibility claim. Workspace/chat are built separately;
the full app consumes built library JavaScript and emitted declarations, not
mutable checkout implementation aliases. Owner tests use built host JavaScript.

| Artifact | SHA-256 |
| --- | --- |
| Toolkit source archive | `1a2003a348d52ab4ffa25d9971d6e2b1b2765787ac5ad9e4c88ea2c287d1c3f4` |
| New host source archive | `451a5d98a45575f468a32d9ad241f74e29f8eb25d27357f2a6eb9943e4b3cf4e` |
| New built host SDK | `d7d63f2784a797340375d7c4500b232512dea6f6639ecb0eeb28dc2a674ac919` |
| New built workspace index | `6188d78d03c9ce8247e6187eba73a6a5fff719e3a36ddb365ceb32aea0660c20` |
| New built workspace React | `527a1a6eb8a163dbca33a57fc0245c7205b1c3f375fefae79b280cfc29c60da0` |
| Full off TODO UI JavaScript | `e655695d75fe5b5a86ab7254b7d3bd942b81423691512295bba3ef1c3c49378d` |
| New stage receipt | `39a536cc2bfb526462eebdac334d106678f0215640e0afa8c1ac511575096995` |

All original frozen input receipt hashes were verified before reuse. Committed
worker/runtime/kernel/protocol and native input trees were compared against e35
and are unchanged. The retained runtime distribution remains
`bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`,
with distribution JSON hash
`94a50946622e2095536c30bf42d4cbcb03c6e7c74f33caec9e5503e4afa129a0`.
This is explicit verified **reuse**, not a WASM rebuild. New host identity is recorded
separately from retained worker/native identity. The stage is an offline SDK/library/
consumer candidate, not a new frozen whole-origin live or off/on qualification.
The earlier isolated `.../endpoint-repair-frozen-ctBSsN` stage at a079153 is retained
unchanged as superseded review evidence; it was not overwritten or relabeled.

## Remaining admission and parent handoff

1. Parent coordinates exclusive Browser Control CLI ownership. Still required:
   exact held/rejected streaming-source fixture in a real browser and manual/headless
   workspace switches, stale endpoint rejection, nonoverlapping cancellation/fallback,
   service drains, process/target and OPFS owner release. No deadline inflation or
   forced-kill receipt substitutes for unknown ownership.
2. Host `ToolContext.installFile` helper bootstrap still uses following stat/read/
   write; no ancestor lstat installation fence was added. Validate every helper and
   receipt ancestor/leaf with supported diagnostics under exclusive proved-stopped
   ownership, rejecting unknown/tampered objects, before installation. lstat alone
   is not concurrent TOCTOU protection.
3. Preserve durable outgoing capture/incoming pending journal, exact prepared/runtime/
   package/config/transitive/plugin/launch/identity admission, tools-only before/apps
   ordering, bounded immutable/cache before/after audits, exact source path set/bytes,
   native session hydration and final durable catalog ordering. Ownership rejection
   or cancellation retains pending and forbids fallback. Known invalid audit may
   select conservative delivery only after every owned operation joins.
4. App owner must implement/review the actual retention adapter and freeze new
   matching off/on origins and receipts. This source repair alone does not authorize
   the app flag or claim a performance benefit. Original cached-switch integration
   and library prerequisite reports remain historical boundaries, not new live proof.
