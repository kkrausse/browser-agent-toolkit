# Single-kernel lifecycle repair: second live browser run (2026-09-30)

Second live Chrome run, on the close-budget heads. The regression checks and the
failure paths behaved as designed. The real-chat part stopped at the first prompt:
this build offers only free-tier models and the provider rejected the request with
a 403. One run, no retries; one prompt sent of the ten allowed.

## What was served

| Item | Value |
| --- | --- |
| Runtime | `vivari-sk-track` `2367a645e34fa5e0cba935004ccd706442ae9586`, clean |
| Toolkit | `bat-sk-track` `8c790c0` |
| Kernel worker | `assets/kernel-worker-DkyaMQkp.js`, sha256 `4a2b20480e7b96f9c71e8048480c5b9f40f9a1c901d188f27f8ae78118304664` (served bytes re-hashed) |
| Distribution | `03d24fb4838bb0d38b3f7588bb72b34fd33e64357c05001ca7a081387e58d1fd`, policy `single-kernel` |
| App origin | `http://127.0.0.1:46901` (fresh) |
| Contract origin | `http://127.0.0.1:46902` (fresh) |
| Browser | Chrome 154, Browser Control CLI 0.8.2, one session `sk-live2-m4x8` |

Built exactly as in run 1 (`receipt-single-kernel.ts` with the native donor,
`distribution.ts`, `prepare:editor` with the Tailwind candidate, `build`). The server
was started with `bun --env-file=<sibling .env.local> server.ts`, so the model key
was loaded host-side only; presence was checked as a boolean and the evidence
directory was scanned for the value afterwards (0 files).

`workspace-api/dist/runtime/assets` still contains the previous kernel file
(`kernel-worker-CEBsdEpm.js`); `distribution.json` points at the new one.

The app passes no diagnostics sink, so stage timings come from page-side
instrumentation in my own session: `controller.diagnostics.record` was replaced by
an in-page recorder. Observation only.

## Part 1: regression

| Check | Result | Key measurement (run 1 in brackets) |
| --- | --- | --- |
| A. Boot | PASS | Ready 20.8 s (25.4 s). `crossOriginIsolated` true. No page errors. |
| B. Topology | PASS | 1 kernel, 3 process workers, 0 other; `vivari-vfs-owner` held by the kernel. |
| C. Basic function | PASS | CRUD agreed with the host API. Source edit hot-updated in 121 ms, no reload. |
| D. Graceful close | PASS | Close resolved 174 ms after the Exit click; lock free by 204 ms (206 ms). |
| E. Reopen ×3 | PASS | Durable each time, marker present. Table below. |
| F. Reload durability | PASS | No lock or workers 65 ms after reload. Reopen 51.9 s; marker and todo present. |
| G. Save / switch | PASS | A→B 49.6 s, B→A 48.2 s, A→B 49.7 s. Own marker each time. "Paused: …" shown. One kernel throughout. |
| H. SQLite close | PASS | Case 15 both steps `{ok:true}` (1183 ms, 699 ms). Lock last held 29 ms and 15 ms before close resolved. Persisted row read back. |

Close timing against the 15 s budget (times from the Exit click; Exit saves first):

| Close | Close resolved | Lock free | Reopen ready |
| --- | --- | --- | --- |
| 1 | 174 ms | 204 ms | 52.4 s (opened 15 s later) |
| 2 | 522 ms | 576 ms | 52.5 s (reopen clicked at 523 ms) |
| 3 | 482 ms | 494 ms | 51.2 s (reopen clicked at 484 ms) |
| after chat activity | 2058 ms | 2071 ms | 57.8 s |
| 6, 7, 8 (idle) | 519 / 157 / 519 ms | 565 / 204 / 565 ms | n/a |

Idle closes are unchanged from run 1 (0.2–0.5 s). The close after a chat session
existed took 2.0 s; the three process workers stayed listed until about 1.9 s, so
most of that is probably the save exporting the session, not the kernel shutdown.

CDP census: in the todo app the old kernel stayed listed about 2.4 s after each
close, as in run 1. After the SQLite case no kernel was listed at 3 s (run 1: about
123 s), so that linger did not reproduce.

## Part 2: where the reopen time goes

Per-stage times in seconds. "Controlled" means the page was already controlled by
the runtime's service worker when it loaded.

| Stage | First boot (uncontrolled, empty store) | Boot 3 (SW unregistered, empty) | Boot 2 / 4 (controlled, empty) | Reopens 1–3 and reload (controlled, stored state) | Switch in a cold kernel |
| --- | --- | --- | --- | --- | --- |
| Worker boot to storage durable | 0.27 | 0.23 | 0.27 / 0.32 | 5.0–5.5 | n/a |
| Dependency delivery | 1.9 | 2.0 | 1.9 / 2.0 | 1.7–1.9 | 1.6 |
| Vite spawn to listen | 7.3 | 10.2 | 10.4 / 11.3 | 9.8–10.0 | 10.2 |
| Vite first response | 5.9 | 8.7 | 8.9 / 9.3 | 6.5–6.7 | 8.4 |
| OpenCode spawn to listen | 2.0 | 2.1 | 9.2 / 9.2 | 9.0–9.3 | 9.2 |
| OpenCode health | 0.1 | 0.1 | 0.6 / 0.5 | 6.3–6.7 | 6.3 |
| Plugin activation | 0.2 | 0.2 | 0.9 / 4.9 | 8.1–9.5 | 10.7 |
| **Total to ready** | **20.8** | **25.7** | **41.4 / 43.3** | **51.2–52.4** | **53.1** |

What the evidence supports:

- **About 20 s is tied to the page being service-worker controlled.** With an
  empty store, two controlled boots took 41–43 s and two uncontrolled boots 21–26 s.
  The clearest stage is OpenCode spawn to listen: about 9.2 s controlled, about 2 s
  uncontrolled. The first boot on a fresh origin is uncontrolled because the worker
  is only registered during it; every later boot is controlled. Two samples each;
  the mechanism was not identified.
- **Dependencies are not the cause.** The managed tree is delivered on every boot
  and takes about 1.8 s each time.
- **Stored state adds about 5 s of storage restore.**
- **A non-first OpenCode start adds about 15 s.** The first two `/api/health`
  requests each hit their 3 s timeout, and plugin activation takes 8–11 s. This
  also happened on a switch inside a kernel that had booted from an empty store, so
  it follows "OpenCode has run in this store before", not "kernel restored".
- **Vite is 3–6 s slower on every boot after the first**, including the
  uncontrolled one; not explained.
- Once ready, a reopened kernel is not slower: `/api/health` about 2 ms and a Vite
  module about 90 ms in both cold and reopened kernels.

## Part 3: chat end-to-end

Model selected through the UI: **"Muse Spark 1.3 Free · opencode"**. Prompts sent: **1**.

The picker offered eight models (LongCat 2.5 Preview Free, Space Bunny Free,
MiMo-V2.6-Flash Free, Muse Spark 1.3 Free, Ling 3.0 Flash Fin Free, Nemotron 3.5
Lightning Free, Nemotron 3 Ultra Free, Big Pickle). The guest's `/api/model` lists
all eight with input and output cost 0. No paid model is offered: the prepared
manifest carries no `modelCatalog` or `editorDefaultModel`, which is how the earlier
paid run supplied one.

| Step | Result | Detail |
| --- | --- | --- |
| 1. Trivial prompt | FAIL | "Reply with exactly: OK". "Sending…" for 14.2 s, "Working…" for 1.7 s, then the run failed with the 403 below. Composer returned to idle. |
| 2. Immediate-send race | NOT RUN | Chat part stopped on the auth error. |
| 3. Agent edit task | NOT RUN | Same. |
| 4. Hold during a response | NOT RUN | Same. |
| 5. Durability | PARTIAL | No agent edit exists. The session, its selected model and the transcript (user message plus the error) survived save, switch away and back (58.3 s), and a reload (59.5 s). |
| 6. Close after chat | PARTIAL | Close 2058 ms, lock free 2071 ms; reopen 57.8 s with session, model, transcript and source marker present. |

Error, verbatim, shown as a banner with a Dismiss button and inside the assistant message:

```
{"type":"provider.auth","message":"OpenCode's free tier can only be used from within OpenCode","status":403}
```

The failed session was later listed under the title "Exact OK reply request", which
suggests a title request did reach a model; that was not verified.

## Part 4: failure paths

| Check | Result | Detail |
| --- | --- | --- |
| a. Second tab | PASS, one deviation | Page 2 queued for the lock from 0.8 s and failed loudly at about 10.2 s. No preview, no ephemeral workspace; page 1 undisturbed. The text `STORAGE_BUSY` does not appear in the UI. |
| b. Reopen racing a close | PASS | Page 2 "Retry editing" queued a pending lock request at 0.14 s; page 1 Exit at 3.0 s; page 2 held the lock at 5.3 s and came up `durable` with marker and transcript (61.9 s). |
| c. Tab kill | PASS | Page closed 1 ms after an unflushed write. Lock and workers gone 38 ms later. Reopen worked (56.2 s). The flushed marker survived; the unflushed file was lost. |
| d. Hung stop (INJECTED) | PASS, with findings | See below. |
| e. Dismiss / Retry | OBSERVED (Dismiss only) | Dismiss removed the error banner and left the transcript and composer intact. No Retry control appeared. |

Second-tab error text, verbatim:

```
Open local workspace: Workspace.open: kernel worker boot failed: Error: OPFS still owned by another Vivari kernel after 10000ms; last stage worker.log.kernel, elapsed 10229ms
```

**Hung stop.** The fault was injected page-side in my session: the chat service's
`Execution` handle was patched so `closeStdin()` does nothing and `stop()` never
settles. The guest process and tracked source were untouched. Then a real Exit click:

- Save finished and services detached at 2.5 s. At 12.4 s the close failed with code
  `CLEANUP_FAILED` after waiting 10 002 ms in phase 1. Workspace and runtime stayed
  attached, persistence `durable`, lock still held.
- UI alert, verbatim: `Service cleanup timed out with 0 cancelled operation(s), 0 launch(es), 1 service stop(s), 1 service join(s) outstanding; quiescence unproven Keep this tab visible and retry; existing files are retained. Download diagnostics for the timed stage and last observed milestone.`
- **The close is not retryable from this app's UI.** After the failure Exit, Save
  and New workspace are disabled; only "Retry editing" is enabled.
- `controller.close()` called directly (no UI control exists): `CLEANUP_FAILED`
  again after 10 002 ms, still attached.
- `controller.cancelAndClose({ force: true })` called directly: rejected after
  10 007 ms with `Workspace force-closed; cleanup unproven (Service cleanup timed out with 0 cancelled operation(s), 0 launch(es), 1 service stop(s), 1 service join(s) outstanding; quiescence unproven; Workspace force-closed while a runtime was attached; runtime cleanup unproven)`.
  Lock free and no workers listed immediately afterwards. A fresh forced call still
  spends the full 10 s of phase 1 before forcing.
- "Retry editing" then reopened `durable` with marker and transcript (70.9 s).
- **The next ordinary Exit failed once**, after 3.9 s, with
  `Service cleanup failed; quiescence unproven`, again leaving Exit disabled. A
  direct `controller.close()` then succeeded in 5 ms. This is most likely the stale
  receipt of the injected service being reported once; the inner error was not
  captured, so that is an inference.

## Other observations

- After opening via "Retry editing" in page 2, the Name field read "Current
  workspace" while WS-B was the active workspace.
- New chat showed "Preparing chat…" for between 1.5 s and 5 s.
- Console across the run, no page errors: `using deprecated parameters for the initialization function; pass a single object instead` ×30; the `style.css` preload warning ×27; favicon 404 ×2; the SQLite case's `sqlite3_step() rc= 1555 SQLITE_CONSTRAINT_PRIMARYKEY …` ×1; one React `A tree hydrated but some attributes of the server rendered HTML didn't match the client properties…` on a host-page reload.

## Mistakes in this run

- One storage-clear step was chained after the Exit that failed (the stale-receipt
  case), so OPFS and CacheStorage were removed while that kernel still held the
  workspace. All Part 1, 3 and 4 checks were already complete; later steps check the
  lock is free before clearing.
- My wait script first treated the transcript's error element as a panel alert and
  returned early; one scripted switch was issued while another was running and did
  nothing. Fixed and re-run; neither was an app failure.

## Still unverified

- Any successful model response: streaming, tool calls, agent edits, the
  immediate-send race, and holds refused because chat is busy.
- The mechanism behind the service-worker slowdown and the slow non-first OpenCode start.
- `STORAGE_BUSY` as an error code: only the UI text was observed, and it lacks it.
- A hang produced by a real guest process; the hang here was injected at the handle.
- Forced close through `dispose`/unmount/`pagehide` as an observed outcome, and a
  force call pre-empting a close already in flight.
- Close with a SQLite request in flight; crash recovery; quota exhaustion.
- Whether "no kernel target after the SQLite case" is the new build or chance (one sample each run).

## Evidence and cleanup

Evidence: `/Users/kkrausse/Documents/repos/kkrausse/bat-sk-track/.diagnostics/sk-live-2026-09-30-run2-m4x8/`
(`journal.md`, per-check JSON, `*-diag.json` stage recordings, `all-console.json`,
screenshots, scripts). Screenshots of the provider error, the second-tab failure and
the failed close were viewed and match.

No tracked file was changed. Session deleted, both servers stopped, ports 46901 and
46902 free. Both origins' storage was cleared (OPFS, IndexedDB, CacheStorage; the app
origin's service worker unregistered). Run 1's origin `http://127.0.0.1:46873` was not
cleared because nothing serves that port.
