# Actual Chrome routing diagnostic: 3e390d4

Report: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-routing-diagnostic-3e390d4.md`.

## Outcome to runtime owner

All three tiny probes passed in actual Chrome, sequentially and without retries:
async `spawn`, direct `spawnSync`, shell-backed `execSync`. Each observed its
identical existing-file reader's completion stdout/file, parent before/after
markers, natural exit `{exitCode:0,signal:null,forced:false}`, and zero processes,
listeners, pending HTTP and active/queued/inflight fetch work.

The one parent-authorized original `childSyncProbe` then failed at its predeclared
**20,000 ms** deadline. It retains the exact guest command
`execSync('node /workspace/sync-child.cjs',{maxBuffer:2097152})`, including the
1,048,583-byte binary FS and captured-output contract. No retry or cleanup followed.

Full diagnostic snapshot (not a shortened trace):
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-spawn-diagnostic-3e390d4-attempt1/first-failure-full-trace.pretty.json`.
Original digest-checked serialized snapshot is the same path without `.pretty`.

### Precise failure boundary

- PID **8** alone remains: `/bin/node.js /workspace/diagnostic-parent.cjs`.
  Control is `{state:1,opcode:20,requestBytes:1139,responseBytes:0}`;
  `syscalls=1`, `workerErrors=0`, booted and not debugger-paused.
- `syscallRouting.clients[0].sameSab=true`; kernel and FS sampled controls agree.
  `nextPid=11`, `lazyInflight=0`; lazy commands are npm/npx/tsc/tsgo/yarn/pnpm/
  pnpx/corepack, not sh or node.
- The final ring contains **64 events**, sequences **587–650**, total **650**.
  PID 10 performs FS dispatches, including writes with requestBytes 524320,
  reads returning 524288, 524288 and 7 bytes, and final close. These observations
  show child work advanced well beyond a pending command-load gate.
- Sequence **646** unregisters PID 10; **647** unregisters PID 9 (its live control
  is opcode 26). **648** is PID 8 `spawn-child-exit`, `childPid:9`.
  **649** is PID 8 `kernel-response-ok-before`, still pending opcode 20.
  **650** is PID 9 `worker-message-error`, `control:null`, `errorName:"Error"`.
  Parent remains pending after that boundary; original host stdout/stderr are
  both empty. The bounded trace does not contain the error message or stack.
- The original spawn-entry/doorbell events have rolled out of the latest-64 ring
  during child FS work. Do not pretend this snapshot contains their exact
  dispatchedOpcode values. Child creation/execution/exit is directly evidenced;
  the response/error boundary is the actionable remaining failure. Error cause
  and exact thrown text remain runtime-owner work, not a proven diagnosis here.
- Chrome census independently sees one kernel and PID 8's process worker, matching
  runtime counters; no auxiliary FS/HTTP/fetcher workers. Kernel vv-diag responded
  after the timeout; listeners/pending HTTP/fetch work are zero.

## Verified artifact and startup differences

Clean source revision: `3e390d4d664c50268a6f8a8662ca73085820eb42`.
Distribution identity: `a471015e1d10dc238d076570cdbe39cf6a02fd04a37cdf71a972005ae6d6aa66`.
Build/preparation receipt:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-2026-09-30T06-24-51-690Z/receipt.json`.

The existing receipt script actually reran core Vite JS/declaration build; it did
**not** run wasm-pack. It verified identical tracked native inputs and **37** native
outputs against clean donor `446df00f86d5d6d5d856a2e5deec0fac49f242fa`, then receipted
**40** emitted assets. All consumer receipt hashes were verified before navigation.
No runtime source, canonical pin, published archive, or generated source was edited.

Compared with first cohort source `33e74eb`, runtime changes add trace/control/SAB
diagnostics and associated tests/docs; the inspected host diffs do not change the
spawn algorithm or runtime boot notification routing. New kernel URL is
`kernel-worker-JP8UniWF.js?opfs-disable=` (old: `kernel-worker-W_1uBQG1.js?opfs-disable=`).
Process-worker filename and SHA-256 remain identical:
`process-worker-vyBhnbjL.js`,
`528f8c1804a538ca98703192b64d8f26f94997261d83fa89d0f5073e35eff5a1`.
This is a newly verified distribution, not mixed old guest bundles.

Unlike the first app acceptance, this is a fresh minimal-only diagnostic consumer:
no app preparation or earlier FS acceptance workload; tiny probes run before the
original contract. Startup reports durable persistence, with `open.ready` at 206 ms
(an observation, **not** a performance comparison). The original parent is PID 8
after successful minimal cases, rather than PID 2 in the first cohort. Therefore
tiny success does not establish the old failure was repaired or isolate a startup
effect. The larger original contract still fails.

## Ownership and reproducibility

Fresh diagnostic origin: `http://127.0.0.1:49169/`, server PID **72461**.
Browser Control session: `single-kernel-spawn-b24855a4`.
Distinct retained lock:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-spawn-diagnostic.lock`.
The old ownership lock, origin 62428, reserved origin 62427, and older servers/pages
are unchanged. Both failed states remain live; no close/reset/kill was attempted.

The driver initiated open, three minimal probes and exactly one original probe.
It stops at first failure, freezes one full read-only diagnostics snapshot, exports
8,000-character chunks with SHA-256 verification, and retains ownership. No full
acceptance cohort, performance comparison, model call, deployment or push ran.

Toolkit files added: `single-kernel-spawn-diagnostic-client.ts`,
`single-kernel-spawn-diagnostic-driver.ts` and its fail-fast unit test. Preparatory
build/server now support an isolated `--spawn-diagnostic` consumer. These are
toolkit-only changes; neither runtime source nor frozen artifacts were edited.

Offline verification after the live attempt: **23 tests pass, 0 fail, 129 assertions**
across six focused suites; generated consumer strict typecheck passes. Offline
tests are separate from the three observed Chrome passes and one Chrome deadline.
