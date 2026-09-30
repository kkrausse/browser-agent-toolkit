# Spawn repair preparation and authorized kernel probe

Absolute report path: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-spawn-repair-preparation.md`.

## Retained cohort stayed unchanged

No new runtime build/package, workload, spawn retry, reset, navigation, close or
cleanup was performed. The failed origin, its two servers, and ownership lock
remain retained. The only browser operation was the parent's single explicitly
authorized read-only kernel debugger probe, described below. Offline summaries
were written into new sibling directories, not the retained cohort directory.

## Offline evidence analysis

Read all **283** retained driver command receipts and initiation source files.
Exactly **two** acceptance actions were initiated: initial filesystem checks and
the failed child-sync probe. There were **278 pending status observations**, one
completed result and one failed result; no initiation was replayed. All 283 CLI
commands exited successfully, with no CLI stderr/warnings or page exceptions.

The one console-error record is fully identified: `0001.json` reports the
`/favicon.ico` **404** while visiting `/inspect-empty`, before the runtime started.
There is no retained console error implicating spawn or an unhandled rejection.
This is not proof that nested worker rejections were absent: the old cohort did
not subscribe incrementally to all probe stderr/page-console events. The pending
probe's direct stderr drain was held in a local promise, not incrementally copied
into its retained evidence. No HTTP listeners had been launched at this boundary,
so `listeners=[]` is expected and is not HTTP acceptance.

Machine-readable offline summary:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-offline-analysis-33e74eb-v2/summary.json`.

Pinned source wiring observations (read from commit `33e74eb`, not the active
runtime owner's working tree):

- `packages/runtime/boot.js:68` deliberately rings non-FS operations with
  `send("syscall")`, without a request body in that doorbell message.
- `packages/kernel-host/kernel.js:1132+` reads opcode and encoded request from the
  process SAB. `dispatchSyscall` decodes the SAB and maps opcode 20 to
  `handleSpawn`, opcode 26 to `handleSpawnAsync`. A bodyless wake is not itself a
  missing-body defect.
- Both handlers await `ensureCommandLoaded(spec.command,parent.pid)` before child
  creation. The first failed `execSync` request asks for `sh -c node ...`; direct
  `spawnSync`/async probes below ask for `node` without the shell layer.
- `syscalls` counts kernel-control traffic, not FS-port traffic. The retained
  value 1 does **not** establish that the kernel handled the spawn opcode correctly
  or that only one total filesystem operation occurred.

## Single authorized live kernel debugger probe

Observed exact kernel target:
`216A12FEAB92F224B74E6D32B324E4C8`, at
`http://127.0.0.1:62428/runtime/assets/kernel-worker-W_1uBQG1.js?opfs-disable=`.
The receipted emitted source retains the requested module bindings verbatim:
`kernel`, `filesystemRef`, `decodeRequest`, and `decodeBytes`.

Used the previously verified Browser Control CLI/raw-CDP interface bound to only
`single-kernel-app-3abef79d` and its exact owned root/worker. Enabled the debugger,
requested one pause, then observed for a bounded **5 seconds** without starting
application work. **No paused kernel frame became available** while the worker
was idle, so the requested SAB/registry expression was not evaluated. No fields,
requests, process tables or control words were mutated. `Debugger.resume`
acknowledged in `finally` (**resumed=true, resumeError=null**); the raw client then
closed. No second probe was attempted.

Full exact result:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-kernel-probe-33e74eb.json`.

This is a debugger-frame availability blocker, not an observation about SAB
identity, lazy-loader state, pending spawn, or active handler arguments. Those
requested values remain unknown. Triggering a new task to expose a frame would
need further parent authorization; it was deliberately not done.

## Actual next-version test source prepared offline

- Added `single-kernel-spawn-probes.ts`: one tiny child reads the same preexisting
  workspace file, writes a completion marker, and emits a short completion line.
  Three real public operations run that identical child: async `spawn`, direct
  `spawnSync`, and shell-backed `execSync`. Parent before/after markers discriminate
  dispatch failure from child FS/output completion. Host joins both drains and
  natural exit, checks null signal/no forced teardown, and verifies zero-work
  diagnostics. There is no guest retry loop or headless pass substituted for the
  future actual browser checks.
- The next live driver serially runs the three minimal cases before fetched-body
  and >1 MiB child-output tests. Its existing bounded stage timeout stops at the
  first failure. This source has not been run on the retained old artifact.
- Incremental probe stdout/stderr is now retained immediately in bounded named
  channels. Console/page-error observers install before first navigation; browser
  unhandled-rejection/error events are recorded without preventing their default
  behavior. Auth-shaped strings are redacted. Snapshots use bounded, digest-checked
  chunks, rather than exporting an unbounded nested log array.
- On a settled, nonexpired driver failure, the next driver attempts only bounded
  evidence/log reads; it never initiates cleanup or a replacement workload. An
  ambiguous/expired command still blocks even those follow-up commands.

Offline verification:

```sh
bun test workspace-api/scripts/runtime-assets.test.ts examples/todo-app/tests/single-kernel-contract.test.ts examples/todo-app/tests/single-kernel-driver.test.ts examples/todo-app/tests/matched-pair-driver.test.ts examples/todo-app/tests/single-kernel-spawn-probes.test.ts
bun workspace-api/node_modules/typescript/bin/tsc -p .diagnostics/single-kernel-2026-09-30T05-42-02-396Z/consumer.tsconfig.json
bun workspace-api/node_modules/typescript/bin/tsc --noEmit --strict --allowJs --skipLibCheck --moduleResolution bundler --module esnext --target ES2023 --types bun --typeRoots .diagnostics/single-kernel-deps/node_modules/@types examples/todo-app/tests/analyze-single-kernel-evidence.ts examples/todo-app/tests/single-kernel-spawn-probes.test.ts
```

**22 tests pass, 0 fail, 125 assertions**; both typechecks pass. No new runtime
artifact was built or packaged, and no performance comparison was started.
