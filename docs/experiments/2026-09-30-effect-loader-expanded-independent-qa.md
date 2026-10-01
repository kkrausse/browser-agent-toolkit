# Effect loader pilot — expanded independent offline QA

2026-09-30. **Expanded offline gates pass; qualified Node/browser/full-app
acceptance remains pending. No phase2 or release/default promotion.**

Absolute report/handoff:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-loader-expanded-independent-qa.md`.

## Outcome and denominator

Independently authored expanded fixture exercises actual exported native download
adapter, real Kernel pre-PID launch methods, real tsgo transaction/installer over
Rust VFS, separately built SDK and workspace library. No implementation-owner
supplemental scripts were executed or counted as independent proof. Reviewed their
source/log descriptions as inputs, full handoff `fc91222`, current committed plan,
and regression handoff `5ed70ba` before writing these gates.

- **New expanded denominator: 10 PASS / 0 FAIL / 0 not run**, enumerated below.
- Unchanged independent loader assertions: held vendor, held write, shared interest,
  loader failure — **4 PASS** on the same frozen candidate under actual Node.
- Preserved read-only suites: PID-egress **6 PASS**, endpoint **8 PASS**, all original
  assertions intact, matching built SDK. These are separate denominators, not ten
  additional newly authored tests or a full-runtime green claim.
- Provenance/static-delivery gate passes, independently before tests.
- Pending: qualified Node 24.18.0; real-browser native cancellation/worker/platform
  observations; full TODO app/editor/close integration. Remaining lifecycle domains
  and all-writer quiescence are explicitly outside this pilot, not passed exclusions.

Runner stops and preserves evidence at the first failed gate. **No new assertion
failed** in either recorded expanded run. Initial successful run was followed by
a metadata-only correction: adapter-only cases now correctly say they do not
execute Kernel/Rust VFS. Acceptance assertions did not change. Both runs and
preflight are retained; this is not retry-to-green or stress/performance sampling.
No runtime, bridge, build, pin, plan, master status, old test or other-agent changes.

## Verified frozen identity

Frozen input (read-only throughout):
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-frozen-20260930-v2`.

| Identity | Exact value |
| --- | --- |
| Runtime source | `5c4b1c5655b54a840370fa6215e51fd661701591` |
| Toolkit archived source | `9814c715cfca42309c581440577976833f4326e6`, containing bridge `73dbae7` |
| Effect pin | `4.0.0-rc.118` (archived lifecycle package dependency checked) |
| Distribution version | `15da540e2381261aa4d23b4bb8abbb4e27c66ec8943db535c81d4b62856c9c43` |
| `delivery.tar.gz` SHA-256 | `52b857effc27289d553d0e39851954b1fb9042a5eb80f01c1b551c4a07e71b47` |
| Candidate receipt SHA-256 | `1ef11f7c30b262b211d43a57f2142697ddf87ac3e086d87fb684640b225e75f9` |
| Freeze manifest SHA-256 | `96dc1eba24133db20d1000d5cb39cc74f80ca567fd5ec9f1274a65eb2a47229b` |
| Compiled ESM core SHA-256 | `211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070` |
| Built SDK `host.js` SHA-256 | `bd8b87d2c6a034955541cbd915240fda1c3838e6e23d1ea014711ad555a41711` |
| Built workspace `index.js` SHA-256 | `e76784aebf35ea4ee1e023c73198ea1b4d8fc83a25fcb918ce5a893897bd53cc` |
| Packaged kernel worker SHA-256 | `b9f92ede6d72ff791d1461855393368f7c3b7f21f951862a5bc0ff43008b68f3` |

Verified all **106 candidate and 997 freeze entries**, zero mismatches, including
native outputs, logs, source archives, library/declarations and consumer assets.
Runtime/toolkit archive digests also match receipt. Seven relevant runtime source
members were compared byte-for-byte with committed `runtime-source.tar`: Kernel,
tsgo installer, native vendor adapter, install transaction, lifecycle TS source,
production kernel worker, SDK execution. Toolkit Runtime source likewise matches
its archived member. This is independent verification of the delivered cohort,
not a new native/toolkit build or fresh package-manager reproducibility claim.

### Node/browser compiled-core identity meaning

Actual Node fixtures import frozen `kernel.js`, which imports
`../kernel-lifecycle/dist/index.js` (the checked compiled-core hash). Archived
production browser worker imports that same Kernel and calls its `createLaunchOwner`
and `launchLoaded`; tsgo registration calls actual `fetchLoaderVendorBytes` with
`context.signal`. Packaged browser worker contains the compiled core's named install/
drain functions and cleanup ledger marker, plus real launchLoaded wiring. SDK and
runtime-distribution kernel worker bytes are identical and match checked receipts.
There is no separately instantiated test Effect supervisor or private future API.

This establishes **static delivered import/source/core identity**, not independent
rebuilding of Vite or browser execution. Frozen owner build provenance remains the
compiler-transform authority. Browser execution and native Chromium cancellation
must still qualify the same artifact cohort. Compiled core is imported at runtime
by actual Node, not Bun's TypeScript source alias.

## Expanded concrete gates

| New case | Assertions observed |
| --- | --- |
| `native-stream-cancel-held` | Actual `fetchLoaderVendorBytes` forwards exact AbortSignal to injected fetch; real ReadableStream pending read is cancelled once with the exact reason; adapter stays pending and lock held while real source.cancel Promise is held; after release rejects AbortError and releases lock |
| `native-stream-cancel-failed` | Same real read/cancel schedule; rejected cancellation retains both AbortError and `INDEPENDENT_CANCEL_FAILURE` in AggregateError, once-only cancel and released lock |
| `native-fetch-ignored-abort` | Real registered tsgo loader + adapter + createLaunchOwner/launchLoaded; last close synchronously freezes admission, exact repeated close Promise, actual signal abort; ignored-fetch Promise holds both close and launch pending; release settles underlying fetch; no PID/worker/publication/shim or tsgo tree created; root loader close succeeds |
| `native-read-ignored-abort` | Actual adapter over explicitly controlled native reader leaf; cancellation acknowledges while read ignores abort; adapter/lock remain pending until actual read Promise resolves; then AbortError, one cancellation, lock release. This is NOT a real Web Stream/browser reader claim |
| `prepid-shared-interest` | Two actual Kernel launch owners (`tsc`/`tsgo`) share one actual installer/download; first close/launch rejection complete without aborting download; second remains pending then gets the sole PID/publication; exact Wasm bytes `[11,12,13]` and engine `[21,22]`; planted `/bin` symlink remains; root close succeeds |
| `prepid-held-write` | Actual Rust batch writes occur, then native batch-return Promise held ignoring cancellation; stop/launch remain pending; release joins actual transactional rollback; prior Wasm byte `[99]` restored, new engine removed, no shim/worker/publication; root close succeeds |
| `prepid-rollback-failed` | Real installer writes batch/runner then real shim commit fails; transaction's native kernel.unlink leaf held; close and launch remain pending; release performs real Rust unlink then throws; original install AND rollback failures aggregate; launch.cleanupError retains both; repeated close/root close remain rejecting and memoized; zero workers/publication |
| `sdk-pid-rollback-failed` | Built SDK Execution, actual parent SAB OP_SPAWN_ASYNC and same real installer/held failing rollback; stop and exited remain pending; both concurrent stops reject CLEANUP_FAILED after rollback, exited.cleanupError retains both original+rollback errors, repeated stop keeps same error text; readers join, stopped SAB unchanged, no late child; root loader receipt retains failure |
| `runtime-prepid-held-success` | Separately built workspace Runtime and its bundled SDK use actual Kernel launch seam through controlled relay; Runtime.stop exact memoized Promise; ignored native fetch holds Runtime stop and launch pending, attachment true and replacement ATTACHED; after release SDK launch rejects LAUNCH_REJECTED (cancelled, no cleanup failure), stop succeeds and only then detaches; replacement allowed; zero workers/proc-started/shims |
| `runtime-prepid-rollback-failed` | Built Runtime pending pre-PID launch, real installer/held failed rollback; Runtime stop cannot detach while held; after underlying rollback rejects, wire cleanupError and public launch CLEANUP_FAILED carry both failures; Runtime stop/root close reject, repeated Runtime.stop has exact same Promise/error; attachment retained and replacement remains ATTACHED; zero workers/proc-started |

The exact retained public cleanup text in install/rollback cohorts is:

```text
Loader cleanup failed: tsgo install and rollback failed: INDEPENDENT_INSTALL_FAILURE; INDEPENDENT_ROLLBACK_FAILURE
```

There is no Execution object for a failed pre-PID SDK launch: its supported
observable is the rejecting launch Promise plus worker wire cleanupError. The PID
cohort separately verifies supported `Execution.exited` and rejecting stop; no
private pending-launch object was invented to simulate those public surfaces.

Held-native checkpoints use Deferred Promise leaf handshakes and MessageChannel
acknowledgements, not sleeps/time padding or retries. A pending sample alone is not
proof: tests subsequently release and join the actual underlying read/fetch/batch/
rollback Promise and inspect successful/failed receipts, VFS bytes and publication.
Deadline/forced subprocess destruction is only a red watchdog, never green drain.
Public `owner.close`, Kernel stop/root loader close and Runtime stop receipts are
used, not Scope.state, Effect fiber interruption, private maps or sampled diagnostics.

## Scope substitutions and receipt limits

- Kernel tests use actual Rust VFS/FsServer/direct access; no same-thread Atomics.wait
  facade. Worker handles and host relay are controlled leaves. No guest/compiler or
  actual browser kernel-worker script runs. Relay calls actual production Kernel
  host methods; it is not a copied lifecycle implementation or Effect core.
- Built SDK always requests `/bin/node.js`. Runtime pre-PID gates explicitly register
  the real tsgo installer under that command to create the held first-use seam. This
  is a **command-registration substitution**, not a claim production Node boot loads
  tsgo. Transport/workspace acquisition is supplied through exported workspaceInternals;
  public Runtime.start replacement guard, node and stop implementations remain built
  library code, not mocks. Attachment is observed; replacement is verified publicly.
- Rollback injection is at the actual transaction's native `kernel.unlink` call.
  It forwards to synchronous Rust unlink after a held Promise, then fails. It proves
  that adapter's async settlement join, not arbitrary async filesystem semantics or
  platform persistence. Held batch case also proves restoration of previous bytes.
- Initial unchanged four gates intentionally retain old registration callback shape:
  they prove backward-compatible native joins, not AbortSignal propagation. Expanded
  registrations explicitly pass real context/signal and prove cancellation separately.
- First consumer stop may precede legitimate shared writes while another consumer is
  live. Last relevant successful stop cannot precede its joined writes/rollback.
  `/bin` still follows the planted cache ancestor link; **path security is not fixed**.
- `closeLoaderOperations` is loader-domain admission/settlement only. It is not
  all-kernel/VFS/SQLite/OPFS/write/persistence/remote OpenCode quiescence. SDK's existing
  `forced` signal metadata is not an observed platform termination acknowledgement.

## Toolchain, commands and evidence

Actual executable: `/Users/kkrausse/.nvm/versions/node/v24.7.0/bin/node`, **v24.7.0**.
Read toolkit `vivari/DEVELOPMENT.md`'s qualified Node 24.18.0 requirement. Local PATH
and NVM inventory offer only 24.7.0; known temporary Node is 24.13.0, not qualified.
No 24.18.0 was located in that bounded inventory. No global/isolated install or
download was performed. Qualification remains pending, not silently substituted.

From `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`:

```sh
FROZEN=/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-frozen-20260930-v2
node examples/todo-app/tests/effect-loader-expanded-runner.ts "$FROZEN" "$FROZEN-expanded-new-evidence"
node examples/todo-app/tests/effect-loader-expanded-runner.ts "$FROZEN" "$FROZEN-preserved-new-evidence" --preserved-only
# Optional independent provenance-only preflight, no tests/builds:
node examples/todo-app/tests/effect-loader-expanded-runner.ts "$FROZEN" "$FROZEN-preflight-new-evidence" --verify-only
```

Every output directory must be new and outside frozen root. To qualify another
locally available Node executable, invoke that absolute executable instead of
`node`; runner uses its own process.execPath for every child and records version.
Source changes require a new explicitly verified receipt cohort, not modifying the
hard-pinned frozen input or reusing its labels. Runtime/library consumer artifacts
were built separately by the owner; QA consumed them without building or editing.

Final evidence roots:

- `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-expanded-independent-final-20260930`
- `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-expanded-preserved-final-20260930`

Per-case command/stdout/stderr/exit/signal/error, ordered handshake events, source
and fixture hashes, pending denominator and summaries are retained there. Pre-cleanup
observations emitted before leaf release. No evidence/input directories were removed.
Archive (also preserves initial successful run and provenance-only preflight):
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-expanded-independent-evidence-20260930.tar.gz`.
Archive SHA-256:
`c7b951dad50d39c136724950f96077ad63afac43cdf6d9d02d86970122d86dd8`.

Baseline negative controls/report/archive `5ed70ba` stay unchanged: the old baseline
failed the early vendor/write join and swallowed-error assertions. They were not
rerun or overwritten; unchanged assertions now pass against real migrated delivery.
Preserve app comparison **19 stages/five generations** and focused **10 cases/14
steps** as earlier imperative evidence; no app/editor/browser/close cohorts rerun.

Known framework/build cost remains owner-measured **+135,365 gzip kernel-worker
bytes** (+621,609 raw); runtime overhead unmeasured. Frozen consumer is import-only;
full TODO app build was blocked on missing qualified OpenCode release receipt at
handoff, with separate delivery owner investigating. No inference, registry access,
server, browser, live guest, storage/profile mutation, performance or promotion claim.
Parent must review this bounded offline receipt plus outstanding qualified-toolchain/
browser/application evidence before authorizing phase2.
