# Cached TODO switching after PID-egress repair

## Outcome

The previous PID-fetch blocker is repaired. **A distinct kernel-owned lazy-tool
load remains outside execution shutdown and can write into the audited cache after
successful SDK stop.** No retention adapter, no-op flag or frozen off/on pair was
shipped. Default conservative switching, durable snapshot/pending ordering, native
session restoration/hydration and recovery are unchanged.

Report path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-cached-switch-post-egress-integration.md`.

Reviewed the actual committed runtime `33fa1359a003ca9c50cb3bc49699b99bc1a063f1`
and toolkit `d0eec346dbc749db1c0cd82dd8aad0b27c1da363` candidate, version
`3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.
The historical a66d365/ba16454 characterization/report remain read-only historical
evidence, not a current PID-fetch failure.

## Positive bounded repair scope

`Kernel.finalize` closes PID fetch interests, cancels queued/active operations when
their last live owner exits, and joins `fetchTasks`, exited-child cleanup, body
release/rollback and publication before public exit. Shared live owners are not
incorrectly cancelled. SDK stop rejects cleanup failures; toolkit runtime retains
execution failures after registry removal and refuses detachment on failed stop.
Endpoint `settled` remains a separate joined, failure-retaining boundary.
This establishes these specific paths, not every deferred kernel operation.

## Remaining causal path: first-use shell tool loading

Committed source locations under `vivari-single-kernel`:

- `packages/kernel-host/kernel.js`: `handleSpawn` / `handleSpawnAsync` await
  `ensureCommandLoaded` before checking whether the parent still exists.
- `ensureCommandLoaded` invokes a registered loader without a PID lifetime signal,
  keeps it in the shared `lazyInflight` map, and catches loader rejection. Neither
  its promise nor its failure is added to the parent's `fetchTasks`/exit joins.
- `packages/core/src/workers/kernel-worker.ts`: `registerLazyTools` registers npm,
  tsgo, yarn, pnpm and corepack using `fetchVendorAsset` and their real installers.
  These are kernel vendor fetch/unpack continuations, not `OP_FETCH_ASYNC` work.
- `packages/kernel-host/load-real-tsgo.js`: `ensureRealTsgo` awaits vendor bytes;
  `loadRealTsgo` decodes, writes the batch, then `applyRealTsgoShims` writes
  `/usr/lib/tsgo/tsgo-run.js`, `/bin/tsc.js` and `/bin/tsgo.js`.
- TODO `examples/todo-app/src/start-editor.ts` explicitly enables `shell`;
  `opencode-chat/src/opencode-launch.ts` grants that action resource `*`.
  Guest filesystem access is not constrained to the captured project tree.

The post-load dead-parent check is good: it prevents spawning a new child. It does
not cancel/join the already-started installer or retain its failure in SDK stop.
Ordinary destinations are outside the source/cache tree; that fact alone is **not**
an overlap counterexample. Redirectable destinations make the distinction causal.

### Executed concrete overlap

New own fixture:
`examples/todo-app/tests/cached-switch-lazy-loader-stop-proof.mjs`.

It imports the isolated committed kernel, protocol, real tsgo installer,
FsServer/direct-kernel-fs and verified reused Rust VFS, plus actual matching built
SDK `host.js`. Worker/relay/vendor-byte delivery are controlled leaves. The tiny
synthetic gzip archive has the real vendor framing; no compiler is run. It issues
an actual `OP_SPAWN_ASYNC` SAB request for `tsc`, holds vendor delivery, and joins
SDK stop and both output drains. The fixture plants `/bin` as a directory symlink
to `/workspace/.browser-editor-cache/vite` before launch. Releasing delivery after
exit causes the **shipped loader and real VFS** to create `tsc.js` and `tsgo.js`
inside that cache. The link remains a symlink and no child is spawned after exit.

```json
{"executionStopJoined":true,"readersJoined":true,"processesAtStop":0,"pidFetchActiveAtStop":0,"lazyLoadsAtStop":1,"lateAuditedCacheFiles":2,"lateChildSpawn":false,"sourceOwnershipProvenAtStop":false}
```

This is a planted-tamper offline counterexample, **not an observed TODO shell
overlap, browser behavior or live cache corruption**. No actual guest/browser/
network/server/OPFS was launched. All filesystem mutations are in a fresh in-memory
Rust VFS. Private loader promises are inspected only to release/join fixture work,
not offered as an app API. Earlier exploratory parent/leaf redirects did not
establish overlap: recursive mkdir rejected the parent redirect, and write_file
rejected a symlink leaf. The final evidence uses the successfully followed `/bin`
ancestor; it does not claim all symlink forms are followed.

## Why admission cannot yet use that stop receipt

The required exclusively stopped interval must precede helper installation,
immutable/cache audit and source replacement. A workspace-only helper ancestor
check cannot reject the external `/bin` redirect above. Checking cache bytes once
cannot join a held loader; it can mutate after an otherwise valid audit. The
demonstrated cohort has nonzero `lazyInflight`, so diagnostics would reject it;
zero PID-fetch activity demonstrably would not. A zero lazy-load sample is not
the missing failure-retaining ownership receipt: loader rejection is swallowed,
and no completed loader failure is propagated through execution/runtime stop.
No blanket assertion that *all* diagnostic-based bounded exclusion is impossible
is made here; such a policy would need its own explicit admission/settlement and
failure proof rather than substituting a sampled count for the requested joins.

Concrete owner coordination: join PID/subtree interests in lazy command loads
through fetch, decode, batch/shim writes and their failures (without cancelling
other live interests), or separately establish a narrow supported exclusion that
closes lazy-load admission and proves every writable destination/ancestor cannot
reach the admitted source/dependency/cache tree. Do not delete or repair unknown
user symlinks as an app workaround. This task changes no kernel/runtime owner code
and proposes no general quiescence architecture.

Once that boundary is established, public workspace-relative
`diagnoseWorkspaceEntry` can fence every helper ancestor/leaf after joined stopped
writers, rejecting unexpected symlinks/kinds/bytes without deletion. Admission
still needs prepared/provenance/dependency/config-transitive/launch/runtime/new
SDK/artifact/library closure, exact incoming source/identity, and the actual
bounded tools-only before/replacement/after interval with identical cache digests.
Unknown config/plugin inputs must miss. Cancellation/unproven cleanup must retain
attachment and pending and forbid fallback. Recovery remains conservative; both
Vite and OpenCode must restart, without process/location routing reuse.

## Reproduction and new evidence

Fresh own evidence directory (not a runnable frozen consumer):
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/cached-switch-post-egress-J7rEAd`.

From the toolkit repository:

```sh
bun examples/todo-app/tests/cached-switch-lazy-loader-stop-proof.mjs /private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/kernel-egress-repair-3GsF7d/runtime-source /private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/kernel-egress-repair-3GsF7d/candidate/sdk/host.js
```

Fresh executions, stdout/stderr/exit retained in separate JSON logs:

- `lazy-loader.json`: concrete overlap above, exit 0.
- `pid-egress.json`: existing built-SDK repaired fetch suite passes held backend,
  dead queued owner/duplicate stop, exited-child pending joins, shared active and
  queued owners, cache-reader pins, rollback join and rollback-failure retention.
- `endpoint.json`: existing eight matching built-SDK endpoint cases pass.
- `toolkit.json`: existing matching endpoint/execution/service fixtures,
  **26 pass, 0 fail, 98 assertions**.
- `candidate-verification.json`: all **111** recorded candidate output hashes
  rechecked, zero mismatches.

The owner candidate remains unchanged. Its runtime archive SHA-256 is
`a76baad09c091b03d7dbc2563dc28b781e4a14e5e7c02888e932796393f5c832`;
toolkit archive SHA-256 is
`35a01cf1f209f378d44d07f49c799ba3c7b79ef54eb3cfca431ca54e9e811914`.
Its rebuilt SDK/JS workers are the new matching repair assets, **not e35 workers**.
Native artifacts were verified reused by the owner; no native rebuild is claimed
or performed here. No new library/consumer build or complete frozen off/on origin
was manufactured while retention admission is blocked.

Independent agent `ses_f0bb96551ffeDRP5f7QzZaMgm0` owns live guest-egress candidate
qualification; this task neither used its browser nor modified its files. Full
live cache switching, matched timing and stress remain pending parent assignment.
No acceptance or performance claim follows from these offline results. No
canonical pin, shared dist/.runtime, historical stage/report, Root/model/runtime
code, storage or host origin was modified. Own fixture/report only; no push.
