# Isolated SAB completion regression — 2026-09-29

## Outcome and boundary

**A deterministic source transport defect is proven and an isolated candidate
passes the same schedule. Its occurrence in the retained natural browser failure
is still not proven.** No browser runs, workspace switches, builds, distribution
changes, deployments, or source-pin changes were made. Reset reliability remains
unqualified; return this validation plan before resuming browser qualification.

Runtime candidate:
`/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion`, branch
`candidate/kernel-fs-completion-20260929`, commit **`0af7375`**. It starts from
diagnostic `9ee2b88` and therefore still contains that branch's diagnostic-only
instrumentation; it is not a proposed production distribution or pin.

The original diagnostic worktree
`/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-diagnostic` remains at
`9ee2b88` with only its pre-existing untracked
`scripts/probe-kernel-fs-stale-wake.mjs`. That file was inspected but not edited,
deleted, executed, or committed. Historical pinned `e998de62` source was inspected
with `git show`, not changed. Toolkit status was clean before this report.

## Source mechanism

- `packages/kernel-host/kernel-fs.js` publishes request bytes, opcode, request
  length and `STATE_REQUEST`, then rings the FS-worker doorbell. Previously it
  called `Atomics.wait` once and immediately consumed state/response length/data.
  Any state other than RESPONSE_ERR was treated as a successful response,
  including an unfinished REQUEST. The same single-wait code exists at `e998de62`.
- `packages/kernel-host/fs-server.js::service` writes response data and RES_LEN,
  stores RESPONSE_OK/ERR, **then** calls `Atomics.notify`. A caller can observe
  the response state before the notify executes, consume it via the wait's
  `not-equal` path, and publish the next request. The previous notify can then
  wake that next wait without completing its request. No spurious-wakeup premise
  or concurrent writer is required.
- `packages/runtime/fs-client.js` already checks STATE_REQUEST after each wake
  and waits again. Its signal wake behavior also depends on this invariant.
- `packages/core/src/workers/fs-worker.ts` routes kernel `fs` messages directly
  to `server.service(msg.client)`; process clients use a MessagePort. The new
  regression uses actual FsServer and clients, not a rewritten response producer.
- `packages/studio/public/sw.js` uses the `vv-http` message relay, not this SAB
  filesystem completion channel. The delivered adapter identified in phase 3 was
  not changed; it does not provide the filesystem completion predicate.

The candidate changes only kernel-fs's single park to a predicate wait while
STATE remains REQUEST, matching the existing process client. It does not resend a
doorbell, reissue an operation, retry deletion, swallow errors, reset RES_LEN,
change protocol layout, or change recursive removal's existing catch behavior.

## Deterministic regression

Absolute test path:
`/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion/scripts/test-kernel-fs-completion.mjs`.
Package interface: **`bun run test:kernel-fs-completion`** (runs Node workers).

Atomic handshakes select the following legal schedule:

1. Actual FsServer completes a mkdir with zero response bytes and stores OK.
2. Hold that first notification. Force the caller to consume published OK through
   `Atomics.wait`'s not-equal path, then submit lstat of `/probe/ordinary.map`.
3. Deliver the held notification only once the next wait really parks (native
   notify returns one woken waiter). Do not service lstat yet. Record REQUEST and
   RES_LEN=0 at this boundary.
4. A correct caller enters the predicate wait again, unlocking service of lstat.
   Assert exact ordinary-file metadata or the actual ENOENT error/code.
5. An unfixed caller instead consumes empty bytes and returns the JSON parse
   failure before service. Capture that failure before cleanup releases the gate.

Run both outcomes for kernel and process clients. VFS metadata/errno methods are
injected; response publication is the shipped FsServer. Test-local Atomics hooks
control scheduling and observe waits, without changing response state/data.
Five-second watchdogs bound handshakes; they are not scheduling sleeps or operation
retries. The runner has a 30-second global watchdog and waits for worker shutdown.
Early test prototypes used a mutable OPCODE to select the first notify, which can
itself change before the hook runs and led to incomplete/time-out runs. The final
test selects the first service notification by invocation instead; those prototype
runs are not acceptance evidence. Five consecutive final candidate runs passed.

### Fails before / passes after

From the candidate directory:

```sh
VIVARI_TEST_SOURCE=/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-diagnostic bun run test:kernel-fs-completion
bun run test:kernel-fs-completion
```

| Source/client | Metadata case | Error case | Completion observation |
| --- | --- | --- | --- |
| Unchanged `9ee2b88` kernel | FAIL, empty JSON | FAIL, empty JSON instead of ENOENT | One lstat wait; previous notify wakes unfinished REQUEST, RES_LEN=0 |
| Candidate `0af7375` kernel | PASS, `{kind:"file",size:3015}` | PASS, code ENOENT | Two lstat waits; consumes only completed response |
| Unchanged process client, both sources | PASS | PASS | Two lstat waits; existing predicate wait control |

Baseline exits 1 with both kernel assertions failing and process controls passing.
Candidate exits 0 with explicit completion checkpoint. This was reproduced with
the final package test interface; the candidate also passed five consecutive
independent Node runs before the final watchdog/comment cleanup.

## Focused and wider validation

Host Node **24.7.0**, not the integration's qualified 24.18.0. The new regression
requires no Wasm/dependencies. For real-runtime contracts, the candidate uses
ignored symlinks to existing diagnostic `node_modules` and `packages/{vfs,codec,
crypto}/pkg-node` outputs. Native artifacts were reused, not rebuilt or freshly
qualified; no generated source was edited.

- `node scripts/verify-runtime-contracts.mjs fs-remove fs-permissions fs-native-realpath`
  **passes on both diagnostic baseline and candidate**, with exact contract
  checkpoints. This is headless real guest/VFS testing, not browser OPFS proof.
- The full contract entrypoint **fails first at worker-uncloneable**, the known
  `markAsUncloneable is not a function` baseline mismatch. The identical failure
  was rechecked on unchanged `9ee2b88`; no full-suite pass is claimed.
- Running the remaining contracts in explicit groups established candidate passes
  for `ts-module-alias`, `fs-permissions`, `package-self`, `esm-export-comments`,
  `net-backpressure`, `node-entry`, `fs-remove`, `fs-native-realpath`,
  `stream-consumers`, `vm-import`, and `sea` (**11/15 contracts**).
- Other failures were each independently reproduced on unchanged `9ee2b88`:
  `brotli` (Decompression failed in the invalid-input assertion), `shell-quoting`
  (shell source interpreted as commands, exit 127), and `process-warning`
  (`process.emitWarning is not a function`). These are baseline failures in this
  environment, not corrected or silently excluded. Together with worker-uncloneable
  they account for the other four contracts. No claim that all four share the
  Node-version cause is made.
- `git diff --check` passes for the runtime candidate and is required for this
  report before commit. No broad `verify-node`/offline-spike-suite pass is claimed.

## Evidence limits and preservation

The forced schedule reproduces the **same empty-response signature** seen in
phase 3, and explains how zero-length responses from preceding operations can be
consumed as lstat. It does not identify the preceding operation or prove this
interleaving occurred in that natural browser run. The regression does not run
recursive removal, recreate ENOTEMPTY, enumerate all possible transport defects,
or test worker death/timeouts/OPFS. The historical natural chain remains:
empty ordinary-file lstat → parse failure → swallowed classification error →
skipped original file → parent ENOTEMPTY. **Newline readdir framing remains a
distinct known defect**, unchanged by this correction; no newline explanation is
assigned to the ordinary filename.

All five retained pages (`quiet-falcon-568`, `clever-badger-501`, `calm-otter-581`,
`gentle-otter-722`, `amber-badger-702`) were not targeted, reloaded, switched or
closed. Pre-existing servers 43222/43223 were untouched. Phase-3 receipts, original
payloads, served distributions, historical source, toolkit production pins, IRS,
archives and private evidence were not changed. No push or deploy occurred.

## Proposed next boundary — plan, not authorization to run

1. Review the deterministic evidence and minimal correction. Reproduce with the
   qualified Node environment; record the baseline failures separately. Decide
   whether to carry only the minimal correction/test into a clean production-base
   candidate rather than adopt inherited diagnostics.
2. Build a separately identified candidate using the normal source/build receipts;
   keep production pin/archive and existing failure origins untouched. Verify
   actual served FS/kernel workers and SW adapter identities, not merely source
   commits, against candidate receipts.
3. On **new origins only**, propose bounded matched-payload dependency resets with
   a predetermined ceiling and first-failure stop. Require exact fixture bytes,
   outgoing-only removal, generation readiness, PDF bytes, joined service/drain
   shutdown observations and owned-server-only cleanup. Do not revisit or recover
   retained cohorts. Passing this is reliability evidence, not proof of natural
   race attribution.
4. Run ordinary-name and dangling-symlink controls plus the browser OPFS
   absent/recreated-root reload contract. Carry the newline case as a distinct
   expected-red gate until its framing defect is separately corrected and tested;
   this SAB candidate must not be sold as fixing it.
5. If exact natural attribution is still needed, the discriminating probe is a
   bounded transport receipt of wake return + immediately observed STATE + RES_LEN
   before payload consumption, with client/opcode/request attribution. A wake with
   REQUEST proves premature completion; a completed OK state with empty lstat
   bytes points instead toward publication/dispatch. Adding low-volume metadata
   only on unfinished wakes in a separately identified diagnostic build avoids
   successful-operation console flooding. This is a proposed future probe, not
   instrumentation added to retained pages.

Return for browser-qualification approval before carrying out those steps. Even
after a candidate passes bounded resets, newline framing and current baseline
contract limitations prevent an unrestricted production-qualification claim.
