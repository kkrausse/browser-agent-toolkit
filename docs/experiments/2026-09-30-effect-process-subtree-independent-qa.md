# Effect phase2A — independent process/subtree qualification

2026-09-30. **PASS the bounded offline process/subtree gates: 17 PASS / 0 FAIL /
0 unrun; 31 unchanged preserved cases PASS, plus routing and sync-capture suites.
One cohort, no retries. Browser/full-app qualification and parent scope review
remain pending.** Not phase2B/fetch migration, release promotion or all-writer close.

Absolute report:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-process-subtree-independent-qa.md`.

## Independent decision on the failed fixture

Read the full implementation report `848d321`, frozen new lifecycle core, old
phase1 failure authority, Kernel cutover diff, production Worker acquisition,
Node adapter and public SDK/Runtime fixture contracts. Did not accept the owner's
16/17 result as independent evidence or edit production.

The original `effect-process-fixture.ts:201` first verifies both stale SAB assertions,
then requires `await kernel.stop(pid)` to succeed after an accepted loader rejects
with `OLD_LOADER_REJECTION`. **That last assumption is wrong.** Phase1 core
`index.ts:174-178` records the original operation error into live lease owners;
`:113-134` retains it in the rejecting owner receipt. Accepted failure retention is
also explicit in the migration plan and accepted review. Superseding syscall
publication must not erase accepted owner failure. New source preserves that policy
(`index.ts:224-228,127-143,157-182`). Production rejection here is truthful, not a
stale-publication violation requiring a runtime fix.

Created a **NEW `effect-process-fixture-v2.ts`**; original fixture/runner/report and
all frozen baseline evidence remain unchanged. All other scenario code/assertions
is byte-identical, independently compared after excluding the header and this case.
The two original stale-publication assertions remain unchanged. Version2 strengthens
the corrected stop contract:

1. Capture and throw one exact original Error object, not just a matching string.
2. After the old dispatch settles, assert REQUEST state and the complete SAB data
   window still match the newer held invocation.
3. Stop while that newer native loader is held; require one repeated PID receipt
   and pending stop until explicit native release. This prevents a legitimate newer
   response from obscuring the no-publication check.
4. Require rejecting stop whose AggregateError tree retains the **exact original
   Error object**; repeated stop returns the same receipt and same rejection object.
5. Recheck full SAB state/data after settlement, verify textual proc-exit cleanupError,
   and require the memoized ownership-root close to reject with that original failure.

No catch-and-ignore, waived failure, production edit or retry-to-green. The old
implementation-owner v1 result remains **16 PASS / 1 FAIL**. Historical frozen3ee
baseline remains **2 PASS / 15 FAIL**, not relabelled as a new run or acceptance.

| Test identity | SHA256 |
| --- | --- |
| Original17-case fixture v1 | `1a89c10dc0bef4ae184b423a04dcb846e479f879eb68eaebc6703170f00a27e3` |
| Qualified fixture v2 | `767193c9af8a74c440034f7713fdf53efa5f931ec8c643e106b917c7ea2a9e6c` |

Both copies, the exact correction diff and byte-identity verification are archived
in the independent evidence root below. Only the new17-case version was executed
against this new candidate by this owner.

## Exact provenance and admission

Frozen input, read-only:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-process-subtree-candidate-atw4whjs`.

| Identity | Independently verified value |
| --- | --- |
| Runtime | `cc5a932bf4f9a1da4bf8b5d16f6c6c7e4aec573d` |
| Toolkit library inputs | `9814c715cfca42309c581440577976833f4326e6` |
| Exact Effect dependency | `4.0.0-rc.118` |
| Distribution | `446021ba611932b0c531570ecc5739255e8d97f608dcc8c53ad1ca07eeceb6a6` |
| Candidate receipt SHA256 | `838195f4fed09e75ce83e9991f57d89e3001dd7990b5225e12466ea64f49a1f3` |
| Freeze manifest SHA256 | `59b394fab8d6773863f54435e2489b282f10429ad2603f9aebd86d1f3efa9fc8` |
| Actual compiled core SHA256 | `05859327b72d924b3533fc5b35c6b3db5a3c6ca429339a20da6abe1f5f2ebed5` |
| SDK/runtime worker SHA256 | `7d21c5bfe263b047c1113d219623dcba50c47001624939448ae0d3d191926cea` |
| Worker placement | `assets/kernel-worker-a6UDx747.js` |
| Built SDK host SHA256 | `14e5b1e965c4645ccbed41a93536db8b941b5ed076225dfea9288d9a0b5dfc87` |
| Built workspace SHA256 | `2676b568a393d6738441b0e55af2839da9dac9114b810621bc6aa1e67c219da7` |

**103 candidate + 1,475 freeze entries**, and **12 native input + 37 native output
hashes**, independently rehashed before/after, zero mismatches. Native reuse, not
rebuild. Runtime/toolkit tar digests match the new receipt; every regular committed
archive member matches imported frozen source. Comparing to the independently
hash-verified3ee source archive finds exactly six changed paths: AGENTS.md,
ARCHITECTURE.md, core kernel-worker.ts, kernel-host/kernel.js,
kernel-lifecycle/src/index.ts and scripts/lib/spike-harness.mjs. Guest-fetch sources,
SDK public sources, protocol and all existing runtime regression fixture assertions
are unchanged. No independent compiler reproducibility claim.

The NEW admission runner explicitly understands this revision's103/1475 inventory
and `compiledCore.browserWorker` path relative to `candidate/sdk`. It does not apply
or weaken the old phase1 receipt schema. It pins exact source/core/worker identities,
verifies SDK/runtime worker byte equality, native reuse and preserved fixture hashes.
Node imports actual Kernel -> lifecycle/dist; browser worker source imports that same
Kernel; Node production harness imports it too. **Same compiled-core import wiring
and emitted identity are static evidence, not live browser execution.**

Actual official qualified binary, absolute for parent and every Node CLI child:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-qualified-node-toolchain-20260930/node-v24.18.0-darwin-arm64/bin/node`.
Actual **v24.18.0 / darwin / arm64** and executable SHA256
`ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a`
asserted at admission/postflight. Official archive/HTTPS-manifest provenance retained
from71ddbe3; no new download, PATH fallback or upgrade. Workers inherit this native
executable; guest `node` commands are Kernel dispatch, not machine PATH Node.

## Executed denominator

| Gates | PASS / FAIL / unrun |
| --- | --- |
| held termination + exited pending child + concurrent subtree stop | 3 / 0 / 0 |
| throwing cleanup + multiple exited-child failures + Runtime retained attachment | 3 / 0 / 0 |
| launch revocation + boot-before-transfer | 2 / 0 / 0 |
| stale spawn exit + corrected stale loader rejection | 2 / 0 / 0 |
| thread transfer revocation + late thread after stop | 2 / 0 / 0 |
| actual native Node termination + actual Node adapter Promise return | 2 / 0 / 0 |
| actual emitted constructor/register/postMessage partial failures | 3 / 0 / 0 |
| **New process total** | **17 / 0 / 0** |
| Preserved loader | 4 / 0 / 0 |
| Preserved expanded native/loader/SDK/Runtime | 10 / 0 / 0 |
| Preserved PID-egress/fetch | 6 / 0 / 0 |
| Preserved endpoint | 8 / 0 / 0 |
| Preserved close | 3 / 0 / 0 |
| **Preserved case total** | **31 / 0 / 0** |
| Unchanged routing suite | PASS |
| Unchanged sync-capture suite | PASS |

Orchestration denominator **36 PASS / 0 FAIL / 0 unrun**. It contains the17 new
cases,14 individually invoked preserved loader cases, three multi-case preserved
suites, routing and sync-capture. Do not add36 to the contained case denominator.
Sync-capture includes the real >1MiB binary execSync fixture, standalone raw SAB
EFBIG framing, maxBuffer/errors, repeated live-parent rollback, unrelated spill
preservation, successful unlink receipt and exit cleanup. Its existing timer/file
handshakes remain unchanged; no new sleep/padding was introduced in our new gates.
Existing main-thread OPFS SQLite warning remains in stderr; not persistence evidence.

All native held work and fault leaves are labeled offline. Tests use real compiled
Kernel/core/Rust VFS and built public SDK/Runtime; no model supervisor. Real Node
Workers are used for native joins and existing guest suites. Actual emitted browser
acquisition is evaluated only as its hashed function with controlled platform
leaves; no browser worker entry executes. Partial registration injects failure
after actual FsServer insertion, checks both actual ports released and no PID/FS/
worker routing residue. Stale-SAB schedules are explicit same-opcode supersession
fault injection, not a naturally observed guest trace. Guest-fetch stays its single
existing authority and composes into PID receipts as leaves.

## Bounded authority review and remaining limits

- Old JS `_processCleanup`/`_processReceipts` authorities are removed. Core process
  identities, parent/child edges, failed descendants and memoized receipts decide
  close; `procs`, parentPid getter/setter and worker exec maps are routing projections.
- PID registration transfers the exact launch owner before native Worker invocation;
  accepted acquisition task and cleanup slots exist before reentrancy. Fatal boot/
  revoked launch/partial acquisition join returned resources rather than publishing
  a late PID. Native Node termination returns/joins its actual Promise; browser
  termination remains synchronous, not an invented worker-exit acknowledgement.
- Core owner close closes admission and allocates receipt synchronously, invokes
  each accepted leaf under failure capture, closes children independently and joins
  them outside their exit callbacks. Pending/failed exited children survive `procs`
  removal. All accepted failures aggregate; the multi-child/public Runtime assertions
  verify this rather than relying only on implementation source.
- Spawn/rejected dispatch use exact proc/owner/invocation/SAB/opcode checks. Thread
  callbacks additionally check exact parent and reqId-to-child routing. The unchanged
  raw SAB fixture confirms no requirement to invent a registered PID for standalone
  framing. This is not proof over every arbitrary asynchronous kernel writer.
- **Intentional scope expansion:** `closeLoaderOperations()` now closes the shared
  loader/**registered-PID ownership root**, not merely loader interests. Source and
  normative docs agree; existing gates pass with it. Parent must explicitly review
  that public scope change. It is NOT storage/persistence/HTTP-reader/workspace or
  universal all-writer quiescence; no new all-kernel-close wire protocol exists.
- Core `compact` clears resource/publication closures, tasks and leases at settlement;
  successful child edges detach. PID identity/receipt/outcome and failures remain
  root-lifetime metadata: **unbounded O(total allocated PIDs)** for a long-lived root,
  not a count-bounded cache. This is source-level retention review, not heap profiling
  or a measured reclamation rate. Failed attachment must remain for recovery.

No blocking defect found in these executed contracts. No browser/full-app,
performance, all-writer/persistence/cache/chat/model disposal or universal guest API
claim. Known guest markAsUncloneable gap and historical failed cohorts remain.
No phase2B, phase3 fetch-authority migration, production/build changes or promotion.

## Reproduction and evidence

From toolkit root, with a fresh output directory:

```sh
NODE=/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-qualified-node-toolchain-20260930/node-v24.18.0-darwin-arm64/bin/node
CANDIDATE=/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-process-subtree-candidate-atw4whjs
"$NODE" examples/todo-app/tests/effect-process-qualified-runner.ts "$CANDIDATE" /absolute/new-evidence-directory
```

Independent evidence:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-process-independent-qa-20260930`.
Contains exact commands/stdout/stderr, source/archive comparison, v1/v2 snapshots/
hashes/diff, admission provenance, final summary and postflight. The provenance
`phase2APositive: not yet executed` is the **admission-time** snapshot; final summary
records36 completed PASS entries and `independentOfflinePassed: true`.

One cohort with first genuine failure stop, zero retries/timeouts/signals/tool failures.
30s runner bound is a failing watchdog, never proof of cleanup success. New scheduling
uses explicit native entry/release Promises and MessageChannel checkpoints. No browser,
host/guest servers, inference, dependency upgrades or consumer-delivery overlap.
