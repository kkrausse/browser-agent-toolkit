# Effect loader pilot implementation handoff

2026-09-30. Phases 0–1 implementation committed and isolated offline delivery
frozen. Four existing independent acceptance cases pass; supplemental owner checks
pass. Independent expanded denominator, qualified Node and live qualification remain
pending. This is not full migration acceptance or a pin/default promotion.

Runtime worktree: `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/vivari-effect-loader-pilot`
Branch: `experiment/effect-loader-pilot`, baseline `33fa135`.
Exact dependency: Effect `4.0.0-rc.118`; npm integrity
`sha512-hxhpCd+swzrtu9lnyPpEFre2ODQzJ9qxgyL1oHIEY8NKnW4PxTbM1XzplMZXiAsLD62HO+KJc41Nqxr9T791ZQ==`.
Chat rc.112 remains independent and unchanged.

## Public seam for independent regression owner

- Build once: `bun run build:kernel-lifecycle` in the runtime worktree. Both direct
  Node `kernel.js` and browser Vite import `packages/kernel-lifecycle/dist/index.js`.
- `Kernel.registerLazyProgram(names, async context => …, notice)` retains its
  positional signature; context adds `signal`, `generation`, `assertOpen()`.
- Actual installer: `ensureRealTsgo(kernel, fetchPackBytes, context)`; byte callback
  receives the signal too. Use actual FsServer/direct VFS adapter. Production worker
  passes context and uses `fetchLoaderVendorBytes(url, signal, fetcher?)`, exported
  from `packages/kernel-host/loader-vendor-bytes.js` for injected native gates.
- Existing guest syscall path automatically gives `ensureCommandLoaded(command,pid)`
  the exact PID consumer owner. `Kernel.stop(pid)` memoizes the existing cleanup
  receipt and now composes its loader-owner close. SDK `exited.cleanupError` and
  rejecting `stop()` remain the observable public bridge.
- Pre-PID: `const owner=kernel.createLaunchOwner()`;
  `await kernel.launchLoaded(command,args,{...options,onStarted(pid) {...}},owner)`
  is the actual orchestration called by production `spawnProcess`. The synchronous
  `onStarted` callback installs routing and publishes `proc-started` inside admission
  commit. `owner.close()` is production pre-PID `proc-kill`: synchronous freeze and
  exact memoized native join. `launchLoaded` rejects only after that close settles,
  attaches `cleanupError` on failed cleanup, and joins any allocated PID if launch
  publication fails. Node fixtures can import the identical host method; no sidecar.
- `Kernel.closeLoaderOperations()` closes root loader admission and joins launch,
  PID-interest and shared operation receipts. It explicitly does **not** promise
  all-kernel/VFS/OPFS quiescence. Diagnostic `lazyLoader` counters are observations,
  not proof; old private `lazyInflight` authority is removed.

First consumer departure releases only its interest. Last departure aborts the
exact generation and joins underlying promise/body/read/cancel/install/rollback.
Ignored abort remains pending. Success registrations are removed only on successful
live consumer completion. Closing generations block newer write authority until
rollback settles. Original installation/rollback failures are retained in root and
consumer ledgers; already-exited PID failures remain in baseline cleanup receipts.

Scope/fiber source reviewed in installed rc.118: `scopeClose` marks Closed before
finalizers and masks close, repeat close can return early; `acquireRelease` release
cannot fail typed. Domain memoized receipts and explicit typed Exit/outcome ledger
therefore remain authoritative, not Scope.state/Fiber.interrupt return values.

Remaining writers, persistence/storage shutdown, full subtree migration and other
loaders' cancellable transactional adapters are future phases. Their existing work
is joined if invoked as a registered loader, but only tsgo has the migrated native
body/installer adapter. Path confinement/symlink safety is not claimed.

Latest adapter contract: rollback awaits each native restore/unlink/rmdir result
(ordinary Rust VFS calls remain synchronous); async injected leaf cleanup is joined,
and all rollback errors aggregate with the original installation failure. The
toolkit Runtime pre-PID `CLEANUP_FAILED` ledger bridge is committed as `73dbae7`.
Core strict check and SDK typecheck pass; final rebuilt delivery is recorded below.

## Committed source and frozen delivery

- Runtime: `5c4b1c5655b54a840370fa6215e51fd661701591`, clean worktree; rebuilt
  lifecycle/core/SDK after commit. Toolkit bridge `73dbae7`, archived toolkit
  `9814c715cfca42309c581440577976833f4326e6` (including evolving handoff).
- Frozen root:
  `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-frozen-20260930-v2`.
  `candidate/` contains separately built workspace library, SDK, packaged runtime
  distribution with Vivari/SQLite/Effect licenses, and a built browser
  **packaged-library import smoke** consumer. It does not launch a kernel.
- `candidate-receipt.json` SHA-256:
  `1ef11f7c30b262b211d43a57f2142697ddf87ac3e086d87fb684640b225e75f9`.
  All **106** candidate hashes verified. `freeze-manifest.json` covers 997 source,
  artifact and evidence files; archives retain exact committed source bytes.
- Portable `delivery.tar.gz` SHA-256:
  `52b857effc27289d553d0e39851954b1fb9042a5eb80f01c1b551c4a07e71b47`.
  Includes committed source archives and runnable runtime source/core/native archive;
  linked local development dependencies are not dereferenced or shipped.
- Compiled environment-neutral ESM core:
  `runtime-source/packages/kernel-lifecycle/dist/index.js`, SHA-256
  `211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070`.
  Node `kernel.js` imports this bundle; production worker imports the same kernel
  and Vite consumes this exact compiled file. Final worker:
  `candidate/sdk/assets/kernel-worker-BXNXoz3O.js`.
- Native rebuild **not** claimed: 12 tracked native inputs and 37 reused outputs
  rechecked against the donor receipt and frozen source. Isolated packaging uses
  an explicitly labelled experimental build receipt, not a canonical release receipt.
- Tooling: Bun `1.4.0`, Node `24.7.0`, Vite `8.2.0`. Qualified Node `24.18.0`
  has not been exercised. Canonical generated outputs, source pins and chat rc.112
  were not changed; no browser/server/live QA or push.

## Outcomes and retained denominator

The unchanged independent runner passes held-vendor, held-write, shared-interest
and loader-failure against the frozen final receipt. Evidence:
`<frozen root>/independent-final-receipt-acceptance/summary.json`.
Its `overallPilotAccepted` remains **false**: native-abort adapter, pre-PID
production seam, rollback/Runtime attachment and delivery-identity expanded gates
are still pending **independent** qualification. Its earlier exact-baseline
negative controls remain in the independent report; no original/new owner tests
were edited to manufacture acceptance.

Supplemental implementation-owner evidence (not independent acceptance):
`launch-frozen.log` / `effect-loader-launch-evidence.mjs` exercise the real Rust VFS,
actual `launchLoaded`, real tsgo framing/decode/installer, held native source cancel,
shared consumer preservation, last-owner ignored-abort join, held failing rollback,
no late PID/shim/publication, exact repeated receipts and synchronous fatal boot exit.
`runtime-attachment-evidence.mjs` / `.log` run the separately built workspace Runtime
and bundled SDK through that same launch seam: stop waits for held rollback, launch
rejects `CLEANUP_FAILED` with both failures, memoized Runtime stop rejects, attachment
remains and replacement is refused. Worker handles/host relay are controlled leaves;
tiny synthetic compiler Wasm is installed, not executed as a compiler.

Frozen preserved checks pass: broad `verify-node`, single-kernel, routing,
sync-capture, three close cases, six PID-egress and eight endpoint cases. Workspace
library/declarations build and post-build typecheck pass; existing workspace suite
is **80 pass / 0 fail / 360 assertions** with explicit `umask 022`. Initial runs are
retained: typecheck was started before declaration build and lacked React declarations;
default host umask removed executable-mode bits in one prepare fixture (**79/1**).
Neither involved changing tests/runtime assertions. Initial Python archive failure
is preserved separately at `effect-loader-frozen-20260930` (unsupported extract filter).

Matched baseline/pilot SDK rebuild comparison, same installed tooling and native
inputs, recorded in `bundle-size-comparison-matched.json`: kernel worker
4,835,511 → 5,457,120 raw bytes (**+621,609**, gzip **+135,365**); process worker
unchanged at 4,087,554 bytes; host SDK +176 raw / +45 gzip bytes. Standalone core
677,617 raw / 137,992 gzip bytes. This is bundle cost, not runtime performance evidence.

Full todo-app rebuild is **blocked**, not qualified: chat build requires missing
qualified `opencode-release-2.0.3/build-receipt.json`. Both failed isolated chat build
logs are retained; no older chat payload was silently relabelled to match current
source. The delivered consumer is import-only, not full app/editor/cache-switch QA.
Future domains still include all-writer/root shutdown, persistence, other cancellable
installer adapters, protected paths, real browser cancellation and full migration.
