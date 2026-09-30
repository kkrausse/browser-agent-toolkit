# PID egress browser qualification — preparation gate

## Finite manual actions / evidence plan (written before launch)

1. Read the repair report, older endpoint fixture and actual matching SDK/worker
   source. Verify candidate receipt, final provenance, archives, every candidate
   hash, source hash, built worker/native asset and reused native provenance file.
   Freeze inputs in a new `sk-pid-egress-qa-prep-*` stage; never edit older stages.
2. Establish a supported control for **abort-ignoring** kernel backend/body work
   and cleanup failure before building or launching a consumer. A local HTTP hold
   qualifies only native HTTP behavior, not ignored-abort browser continuations.
   **If this gate fails, stop without a mislabeled browser/mock qualification.**
3. If that control exists, bundle a separate consumer from the verified built
   exports only. Use public workspace/runtime/node/execution APIs and a plain
   Node guest using `node:http` outbound requests. Record guest source hash and
   unchanged workspace markers. The real transport must reach `OP_FETCH_ASYNC`.
4. Launch an owned host on a fresh OS-assigned loopback origin, recording its PID
   and stdout/stderr. Before the first execute, explicitly create a named CLI
   session (`browser-control session new sk-pid-egress-qa-<unique>`), verify it
   with `browser-control session list`, then navigate only that session's tab.
   Do not inspect or mutate existing tabs/storage/profile/relay.
5. Inspect UI, then trusted clicks: start real guest → backend admission receipt
   → kill dead owner → held stop/exit checkpoint → release backend/body gate →
   joined stop and both output drains. Saturate the unmodified concurrency cap
   (10) to queue a dead-owner request; prove its backend never dispatches.
   Repeat a distinct shared-live-owner cohort, retaining its real body read.
   Capture raw backend/body/worker events, source/owner/PID IDs and read-only
   public receipts at each checkpoint. Inspect saved screenshots, not merely
   their filenames. Do not infer pins or absent writes from zero processes alone.
6. In a separately fresh negative cohort, require public `Execution.exited`
   `cleanupError`, `Execution.stop()` `CLEANUP_FAILED`, failed runtime stop and
   public replacement-attachment rejection. A request/network failure alone is
   not a cleanup failure. Retained owner page destruction is forced cleanup,
   never normal-close acceptance. Stop on the first failed assertion; preserve
   failed evidence and never retry-to-green.
7. Only after visible success, check/pin the actual installed Playwright package
   version before launching a separate ephemeral Brave/Chromium headless cohort.
   No fake Browser Control headless option, user profile reuse or browser install.
8. Normal acceptance requires guest/output/stop joins and unchanged source markers.
   Close only owned pages/session/browser and host, join host output/exit, verify
   exact owned PID/listener absence, retain evidence, and release visible slot.

## Outcome

**Preparation blocked; not browser qualification.** Independent verification
passed: 111 candidate files, 758 archived-source files, 40 original built assets,
37 reused native outputs (each also matched the original provenance checkout),
both source archives, worker topology/kernel hashes and distribution/build-manifest
identity. Native tracked-input comparison against baseline
`446df00f86d5d6d5d856a2e5deec0fac49f242fa` was empty. Native compilation was not
rerun. No browser execution, host or guest has started.
The old 724909b SDK / 7713686 toolkit endpoint fixture is reference only and does
not qualify this 33fa135 runtime / d0eec346 toolkit repair unchanged.

### Exact preparation blocker

The requested **full controlled cohort** cannot be constructed using the
supported public browser APIs of these unchanged candidate assets:

- `packages/core/src/workers/kernel-worker.ts:1459-1462,1596-1599` creates its own
  fixed `fetcher`, calling `doFetch`; no public network callback is supplied by
  `Runtime.start`, `WorkspaceController.startRuntime`, `Host.open` or `BootOptions`.
- `packages/core/src/workers/kernel-fetch.ts:143,197,202-207` forwards the actual
  ownership abort signal to native browser `fetch`, then awaits native
  `Response.arrayBuffer()`. An owned HTTP server can hold headers/body, but
  last-owner abort rejects that browser operation independently of the server
  hold. A server ignoring socket cancellation does **not** establish that the
  kernel's owned JS backend/body continuation is still pending.
- The real guest path does exist: Node's
  `packages/runtime/node/internal/fetch-transport.js:302` uses
  `__ocfetchAsync`; `packages/runtime/index.js:1582-1588` forwards it to
  `syscalls.fetchAsync`; `packages/runtime/fs-client.js:295` issues
  `OP_FETCH_ASYNC` (30). Thus the blocker is control/observation of the requested
  ignored-abort and failed-cleanup cases, **not** absence of real guest egress.
- A shared live owner can prevent abort while a native response is held. That
  would be a useful narrower shared-owner/native-network cohort, but it cannot
  prove the last-dead-owner ignored-abort case or rejected VFS rollback.
- `Execution.stop()` maps exit `cleanupError` to `CLEANUP_FAILED`
  (`packages/core/src/host-sdk/execution.ts:61-65,91-95`). In
  `packages/kernel-host/kernel.js:2355-2368`, the relevant cleanup error is a
  failed rollback after an admitted VFS body write. Ordinary network rejection
  does not produce that receipt. Public workspace filesystem operations do not
  provide controlled gates/failures for this internal cache write/rollback.

Replacing worker/native fetch, injecting a private kernel receipt or rerunning
the controlled mock regression would change the evidence boundary. None was
done. Endpoint upload cancel/reject is a separate supported platform-stream
contract; its older frozen fixture is not a substitute for this PID-egress proof.
No alternate narrower live scope was silently substituted.

### Frozen verified inputs / reproducible verifier

New snapshot (libraries/assets remain separate from any future consumer):

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/sk-pid-egress-qa-prep-vvua6O`

This stage contains exact copied candidate bytes, receipts, build manifest and
source archives. It is explicitly **not a runnable consumer or live evidence**.
The verifier only reads the supplied stage/provenance checkout, creates a fresh
snapshot and checks it again; it starts no services. Command (passed, exit 0):

```sh
bun examples/todo-app/tests/sk-pid-egress-qa-verify.ts
```

| Identity | Value / SHA-256 |
| --- | --- |
| Runtime source | `33fa1359a003ca9c50cb3bc49699b99bc1a063f1` |
| Toolkit source | `d0eec346dbc749db1c0cd82dd8aad0b27c1da363` |
| Runtime version | `3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62` |
| Verification receipt | `3e72b0bff5328a752897e284db60245d2410498ae17bfe55c64e8473b5722dd9` |
| SDK host | `34aec10efcd40f28d58d6c2a58084e2476cc157c1f0269aec8cd9d76094bd660` |
| Workspace index | `cb7bb81bab08e5d993962456df1219abfafd5a5cfdbefb45743ade7d284e243c` |
| Workspace React/controller | `fe86273f8f1d8fd2e963b6e2a13a5cfd982c7cf4001c642b4c4632366a13da03` |
| Kernel worker | `1901f5b19c06cfea796a84395a7e46d0159690c61deeba4451ffaaf672aeea7c` |
| Process worker | `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7` |
| Runtime archive | `a76baad09c091b03d7dbc2563dc28b781e4a14e5e7c02888e932796393f5c832` |
| Toolkit archive | `35a01cf1f209f378d44d07f49c799ba3c7b79ef54eb3cfca431ca54e9e811914` |

The new verification receipt records hashes of every copied file, including the
original candidate receipt and final provenance. Native files matched
`/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean`.
Libraries were copied, not rebuilt; no canonical pins, shared generated assets,
app switch or runtime sources were changed.

### Counts, ownership release and remaining work

- Visible cases: **0**; headless cases: **0**; guest/host starts: **0**.
- No live backend/body/worker, PID-death, stop or source-marker receipts exist.
  No screenshot was captured, so none is claimed inspected. No CLI session was
  created because the preparation gate stopped before browser execution.
- No owned PID, listener, page, session or browser needs cleanup. No forced
  cleanup, browser retries, existing-tab access or storage/profile/relay changes
  occurred. The exclusive visible slot is released unused.
- A future owner needs either an explicitly narrowed native/shared-owner browser
  scope or a separately authorized, genuinely supported backend/rollback control
  in a different candidate. Do not label either as qualification of unchanged
  assets for the full requested controlled contract.
- Full workspace persistence/reload, cache integration/admission, HTTP stream
  credit and stress checks remain outstanding here. Historical/offline passing
  regressions were read, not rerun or relabeled live. The previously reported
  full-contract `markAsUncloneable is not a function` failure remains; this is
  **not an all-green claim**.
