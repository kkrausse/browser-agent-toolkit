# e35eab4 final-version attempt 1: application acceptance passes, close census race

Report: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-e35eab4-attempt1.md`.

## Outcome and remaining gates

Actual Chrome completed **19 client stages**, including all five application
generations (startup plus **four A/B switches**), corrected SSE open/cancel,
generation-specific hydration/todo/PDF verification, HMR and joined shutdown.
The attempted cohort is nevertheless **failed**, not complete: its immediate
post-close zero-worker census still listed the terminated kernel and PID 14.
Reload and the separate ten focused cases were not initiated after that failure.
No lifecycle action was retried, and no frozen page/artifact was modified.

One later explicitly read-only census, with no application work or cleanup,
showed **only the page, no workers**. This supports a transient Chrome target
removal/observation race; it does not turn the failed attempt into a pass.
Prepared the bounded read-only close-census correction offline for a separately
labelled next attempt. It observes target removal for at most 15 seconds after
joined close; auxiliary workers still fail immediately, and stop/close is never
replayed. No further live acceptance was initiated.

## Exact criteria for this version

PASS in actual Chrome on e35eab4:

- Exact original execSync binary fixture, once first after open: 1048583 bytes,
  maxBuffer 2097152, guest byte-by-byte checks plus independent host FS readback.
- Capture sizes 0/255/700000/800000/1048583, both stdout and stderr at 1048583,
  latin1 and ENOBUFS default/16-byte limits, natural process completion.
- **spawnCapture.ownedSpills=0** at every retained diagnostics checkpoint,
  including after original capture, capture boundary cases, all live app
  generations and shutdown. No process remains at the completed capture stages.
  Runtime owner's staging-fault injection remains offline evidence, not a claimed
  live fault-injection pass.
- Sync FS newline filenames, symlink/lstat/readlink/rename and >1 MiB exact bytes;
  async spawn/spawnSync/execSync minimal completion.
- Evicted fetched-body pin survival, exact fd fallback and reclamation; concurrent
  writes/watch/flush; close/recreate OPFS persistence and deleted-file absence.
- HTTP 16 MiB exact stream, unread producer stalls at 2/256 chunks, 256 drains,
  cancel then healthy sync-FS handler, graceful shutdown marker, stale rejection,
  zero listeners/processes/pending HTTP/fetch work after service stop.
- Actual Chrome active census: one kernel and only guest process workers, matching
  runtime registry; no FS/fetcher/HTTP/LSP/SQLite auxiliary workers.
- Five Vite/OpenCode app generations with generation-specific A/B hydration,
  actual todo creation and fresh PDF completion in each generation; obsolete
  switch-module removal from the workspace between generations.
- Same-document fresh-marker HMR, OpenCode health/plugin activation/config/model
  catalog readiness each generation; corrected mounted SSE server.connected
  handshake/abort followed by pendingHttp=0 and healthy service. **No model call**.
- Joined final stop/drains and workspace close: retained shutdown result reports
  procs=[], listeners=[], pendingHttp=0, inactive fetch work, ownedSpills=0.

FAIL: immediate post-close census expected zero but saw kernel target
`F90EF3D1CFE94B3F8B756622A2721F7D` and PID 14 target
`82636390F623A17F86022341C7721B6E`. Both later absent observationally.

NOT RUN: same-origin document reload persistence; selected focused before-header
abort/reader cancel/credit, process cleanup/port reuse, managed-root bulk
delete/recreate, Web Locks, concurrent flush and SQLite rollback/reopen cases.
No claim that headless results fill those live gaps.

## Build identity and immutable evidence

Clean source: `e35eab4af7a53ff08eb70c09df59c40b78bfdd67`.
Distribution: `bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`.

- Kernel `kernel-worker-1aDiRZSX.js`, SHA-256
  `1316335f08db867e269b43dc324163b5449487ee9ca14588d8b5ca2ff2aead09`.
- Guest `process-worker-ZQRq3H73.js`, SHA-256
  `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7`.

Actually rebuilt kernel and guest bundles together from the clean checkpoint via
Vite/core declaration build. Verified exact tracked native inputs and **37** native
outputs against clean donor `446df00f86d5d6d5d856a2e5deec0fac49f242fa`; no wasm-pack
rerun claimed. **40** emitted assets receipted; new matching app preparation has
**12301** verified entries. Frozen artifact/library hashes verified before page
initiation; no old runtime bundles mixed in.

Library build:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-2026-09-30T07-01-29-722Z`.
Served final prepared output:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-e35eab4-full-attempt1`.
Evidence:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-live-e35eab4-attempt1`.

`failure-app.json` retains all 19 client stages and zero-spill/shutdown results.
**344** command receipts (including failed census `0301.json`) preserve polls,
one-shot initiations, interactive UI and worker census evidence. The driver error
was shortened to `[object Object]` because the shared adapter stringified a
structured CLI ScriptError; exact Chrome census failure is in `0301.json`.
Offline adapter repair now preserves `.message`.

`post-failure-readonly-census.json` is a separate full CLI receipt: at
1790752026517 ms, only owned page `F8077A56158E4FFA27E0C557B5F5C2C4` exists.
The failure-capture diagnostics request after close reported `Workspace is not
open`, as expected; failure evidence itself exported successfully. Prepared
offline diagnostics repair retains this as unavailable rather than another
capture exception. No kernel request was stimulated to manufacture a frame.

## Retained resources

- App `http://127.0.0.1:54123/`, server PID **90390**,
  Browser Control `single-kernel-app-32c23419`.
- Unused focused origin `http://127.0.0.1:54122/`, server PID **90391**,
  session `single-kernel-cases-816a2711`.
- Fourth distinct ownership lock:
  `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-acceptance-e35eab4.lock`.

Pages/servers/lock remain preserved as failed-attempt evidence despite the healthy
completed workspace close. All three older failed cohorts and their locks/pages/
servers remain unchanged. No runtime source edits, canonical pins/archive edits,
performance comparison, model request, push or deployment.

Offline repair verification: **26 tests pass, 0 fail, 140 assertions**; generated
consumer strict typecheck passes. The close-census repair is not in the frozen
attempt-1 driver/consumer receipt; next acceptance must be separately labelled
and authorized, without continuing this failed driver's lifecycle.
