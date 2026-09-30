# Effect loader pilot implementation handoff

2026-09-30. In progress; phases 0–1 only. No candidate qualification claimed.

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

Build/source/provenance and regression receipts will be appended after checks.

Latest adapter contract: rollback awaits each native restore/unlink/rmdir result
(ordinary Rust VFS calls remain synchronous); async injected leaf cleanup is joined,
and all rollback errors aggregate with the original installation failure. The
toolkit Runtime pre-PID `CLEANUP_FAILED` ledger bridge is committed as `73dbae7`.
Core strict check and SDK typecheck pass; complete SDK rebuild/freeze still pending.
