# Single-kernel lifecycle repair: first live browser run (2026-09-30)

First live Chrome qualification of the close-path repair (`Host.close()` /
`shutdown`, joined SQLite release, per-path SQLite durability, bounded owner-lock
wait). One run, no retries, no model calls. Every check that was run passed; the
limits at the end matter as much as the table.

## What was served

| Item | Value |
| --- | --- |
| Runtime | `vivari-sk-track`, `fix/single-kernel-lifecycle`, `a6ae7d984928f052b35f19bf09b1849e838b858a`, clean |
| Toolkit | `bat-sk-track`, `fix/sk-back-on-track`, `6b31d3a` |
| Kernel worker | `assets/kernel-worker-CEBsdEpm.js`, sha256 `e296c226b6b96bfd0e5fddeceb4b39db96aeba8d5549ab84cae38502f1134ae7` (served bytes re-hashed with curl on both origins) |
| Process worker | `assets/process-worker-ZQRq3H73.js`, sha256 `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7` |
| Distribution | version `bb7b1a1733255c1a6c5248fabb4f3d55d42e0f7a86e7388ecf5517605bccd01a`, topology policy `single-kernel` |
| App origin | `http://127.0.0.1:46873` (fresh: empty OPFS, no IndexedDB, no service worker, no locks) |
| Contract origin (check H) | `http://127.0.0.1:46874` (fresh) |
| Browser | Chrome 154, Browser Control CLI 0.8.2, one session `sk-live-q7k3` |

Commands, from the toolkit root unless stated, with
`VIVARI_SOURCE=/Users/kkrausse/Documents/repos/kkrausse/vivari-sk-track`:

```sh
# wasm-pack is not installed, so build-runtime.ts cannot run. This rebuilds core JS and
# writes the receipt after proving the native inputs/outputs match the donor checkout.
bun vivari/scripts/receipt-single-kernel.ts /Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean
VIVARI_WORKER_TOPOLOGY=single-kernel bun workspace-api/scripts/distribution.ts
cd examples/todo-app
TAILWIND_CANDIDATE_RECEIPT=<random/browser-container-poc/vivari/.runtime/tailwind-wasm-candidate/11050dda…/a6719da6…/receipt.json> \
  TAILWIND_CANDIDATE_SHA256=456722dd32ebba38e957bf9560eaab820936e8c16132d14b5c861381793adc9a bun run prepare:editor
bun run build
NODE_ENV=production LOCAL_EDITOR_ADMIN=1 PORT=46873 bun server.ts   # VIVARI_MODEL_API_KEY unset
```

The core rebuild reproduced the coordinator's kernel bundle byte for byte, so the
already-built `workspace-api/dist/lib` host SDK and the kernel are the same revision.
Native Wasm was reused, not rebuilt (donor `446df00f`, documented hashes verified).

The scripted harness (`examples/todo-app/tests/single-kernel-driver.ts`) was not
used: it requires a frozen receipt for revision `e35eab4…` and matching driver
source hashes. All checks were done by hand with `browser-control execute` scripts
kept in the evidence directory.

## Results

| Check | Result | Key measurement |
| --- | --- | --- |
| A. Boot | PASS | Ready 25.4 s after "Open editor" (preview 22.9 s). `crossOriginIsolated === true`. No page errors. |
| B. Topology | PASS | 1 kernel worker, 3 process workers, 0 other. Lock `vivari-vfs-owner` held exclusive by the kernel's client id. |
| C. Basic function | PASS | Add ×2, toggle, delete verified in the preview and by the host `GET /api/getTodos`. Source edit hot-updated the preview in 118 ms without a full reload. |
| D. Graceful close | PASS | Lock free 206 ms after the Exit click (last held 155 ms). Close promise resolved, no `CLEANUP_FAILED`, no errors. |
| E. Immediate reopen ×3 | PASS | See table below. Durable every time, source marker present, no `STORAGE_BUSY`. |
| F. Reload durability | PASS | No lock or workers 115 ms after `page.reload()`. Reopen ready in 52.7 s. Source marker and todo present. |
| G. Save / switch | PASS | A→B 54.8 s, B→A 46.4 s, A→B 50.4 s. Each workspace showed its own marker. "Paused: …" shown each time. One kernel throughout. |
| H. SQLite close | PASS | Contract case 15, both steps `{ok:true}`. Lock free by the time close resolved. Reopened step read the persisted row. |

Close and reopen cycles (times from the Exit click unless stated):

| Close | Lock last held | Lock free | Reopen clicked | New kernel holds lock | Reopen ready (from reopen click) |
| --- | --- | --- | --- | --- | --- |
| 1 | 155 ms | 206 ms | about 15 s later | not sampled | 48.7 s |
| 2 | 499 ms | 525 ms | 516 ms | 793 ms | 50.3 s |
| 3 | 480 ms | 514 ms | 505 ms | 759 ms | 54.9 s |
| 4 (two saved workspaces) | 425 ms | 475 ms | not reopened | n/a | n/a |

The Exit handler saves the workspace before closing, so these times include the
save. In cycles 2 and 3 the reopen was a real click on "Open editor" fired from a
MutationObserver the instant the button became enabled. The new kernel never queued
for the lock: zero pending-lock samples at 25 ms sampling. So the new 10 s owner-lock
wait was never exercised.

Reopens are about twice as slow as the cold boot (48.7 to 54.9 s against 25.4 s).
In the first reopen the "Open local workspace" step took about 4.2 s and OpenCode
became ready about 23 s after the preview. This run did not investigate why.

## Lock versus CDP target census

- **Todo app, four closes:** the two signals agree within about 2.5 s. The lock was
  free at 0.2 to 0.5 s. `Target.getTargets` kept listing the old kernel (and one or
  two process workers) until about 2.1 to 2.4 s and showed none from about 2.4 to
  2.7 s. On immediate reopen, two kernel targets were listed for about 1.5 s while
  the lock was already held by the new one. The earlier 15 to 30 s linger did not
  recur here.
- **Contract page, after the SQLite case's first step:** the signals disagree. The
  lock was free when close resolved, but the kernel target was still listed about
  123 s later (the last sample before the next step's page reload). After the
  second step no kernel target was listed at 3 s.
- **Whether that lingering worker was alive is not known.** Attaching to it
  returned a session, but sending to it failed with `No session with given id`;
  `performance.measureUserAgentSpecificMemory()` did not resolve within 40 s.
- **The lock is no longer a liveness oracle on its own.** The new shutdown releases
  it explicitly before `terminate()`, so a free lock proves the release ran, not that
  the worker's execution context is gone.

## Admission hold (check G)

During save, create, switch and close a status line read `Paused: Saving workspace`,
`Paused: Creating workspace`, `Paused: Switching workspace` or
`Paused: Closing editor`. While held:

- the chat container was `inert`;
- the Session and New chat buttons were disabled;
- the panel's New workspace, Save workspace, Exit and the Workspace select were disabled;
- the composer `<textarea>` itself was **not** `disabled`; it was only blocked by the inert container;
- the Model button was disabled, but it is also disabled when idle, so that shows nothing.

During a switch the chat pane was replaced by "Connecting workspace chat…". None of
`Chat became busy`, `Chat is held`, `quiescence unproven`, `ATTACHED`,
`CLEANUP_FAILED`, `STORAGE_BUSY`, `Persistent storage unavailable` or `ephemeral`
appeared in the page text or the activity log.

## Errors observed, verbatim

No page errors and no failures. All console errors and warnings across the run:

- error ×2: `Failed to load resource: the server responded with a status of 404 (Not Found)` (favicon.ico, once per origin)
- warning ×12: `using deprecated parameters for the initialization function; pass a single object instead` (kernel worker)
- warning ×15: `The resource http://127.0.0.1:46873/preview/5173/src/style.css was preloaded using link preload but not used within a few seconds from the window's load event. …`
- warning ×1: `sqlite3_step() rc= 1555 SQLITE_CONSTRAINT_PRIMARYKEY SQL = INSERT INTO items VALUES (1, NULL)` (the SQLite case's own UNIQUE assertion)
- probe only: `Protocol error (Target.sendMessageToTarget): {"code":-32602,"message":"No session with given id"}`

## Limits and what remains unverified

- One run on one machine and one Chrome version; no repetition, so no variance data.
- The bounded owner-lock wait, `STORAGE_BUSY` after its timeout, and the
  `Host.close()` timeout/reject path were never triggered.
- Forced close (`CLEANUP_FAILED`), `Host.destroy`, and the chat Dismiss/Retry UI were not exercised.
- No prompt was sent, so chat was always idle: close or switch during a running or
  streaming agent turn, and holds refused because chat is busy, are untested.
- Close with a SQLite request actually in flight was not forced. OpenCode's own
  SQLite database was open during every app close, but no rows were verified there.
- Source edits used the app's opt-in `?workspaceFixture=1` hook; there is no
  source-editor UI. TODO items live in host server memory, so their survival says
  nothing about runtime persistence; the source marker is the persistence evidence.
- Reload goes through `pagehide`, not the graceful close; abrupt tab kill, crash
  recovery and a second tab contending for the store were not tested.
- The service worker did not appear in the page-scoped target list, so its lifecycle was not observed.
- Native Wasm was reused from a donor checkout, not rebuilt.
- No request log exists on the server, so "no model traffic" rests on no prompt
  having been sent and no key being set, not on an observed request count.

## Evidence and cleanup

Evidence: `/Users/kkrausse/Documents/repos/kkrausse/bat-sk-track/.diagnostics/sk-live-2026-09-30-q7k3/`
(`journal.md`, per-check JSON with raw lock and census samples, `all-console.json`,
screenshots, and the execute scripts). Screenshots for boot, close, reload and the
last switch were viewed and match the recorded state.

No tracked file was changed. The session was deleted, both servers were stopped, and
ports 46873 and 46874 are free. The contract origin's OPFS was cleared. OPFS and
IndexedDB for `http://127.0.0.1:46873` (about 94 MB) were left in the browser profile.
