# Single-kernel lifecycle repair: third live browser run (2026-09-30)

Third live Chrome run: real chat on a paid model, plus re-checks of the four run-2
defects. Chat worked end to end, including an agent edit that survived save, switch,
reload, close and reopen. All four fixes held. One expectation was not met: Enter
pressed while a new chat is still preparing is silently ignored. One run, no
retries; five prompts sent of twelve allowed.

## What was served

| Item | Value |
| --- | --- |
| Runtime | `vivari-sk-track` `2367a64`, clean (unchanged) |
| Toolkit | `bat-sk-track` `d24e02e` |
| Kernel worker | `assets/kernel-worker-DkyaMQkp.js`, sha256 `4a2b20480e7b96f9c71e8048480c5b9f40f9a1c901d188f27f8ae78118304664` (confirmed, served bytes re-hashed) |
| Distribution | `a5c492fe74a739179dc1a0a41da7cf2e19e292dd10ead0888162fa80785691ac` (new receipt timestamp only) |
| App origin | `http://127.0.0.1:46931` (fresh) |
| Contract origin | `http://127.0.0.1:46932` (fresh) |
| Browser | Chrome 154, Browser Control CLI 0.8.2, one session `sk-live3-k9p2` |

Built as in run 2. `distribution.ts` does not prune, so the stale gitignored
`workspace-api/dist/runtime/assets/kernel-worker-CEBsdEpm.js` was removed by hand.

**How the paid catalog was supplied.** Neither `prepare:editor` nor `server.ts` has
a catalog option, and the live launcher needs a frozen input directory this build
cannot satisfy. So its manifest change was replicated on generated output:

1. The public `model-config.json` (28 models, default `muse-spark-1.3`, no
   credential, sha256 `7b172e30…11ad`) was copied into the evidence directory.
2. After `prepare:editor`, a scratch script in the evidence directory
   (`merge-catalog.ts`) ran the launcher's own validation
   (`createOpenCodeCandidateConfig`) and wrote `modelCatalog` and
   `editorDefaultModel` into the gitignored
   `examples/todo-app/.editor/prepared/manifest.json`.

No tracked file changed. The disabled-model fix from the earlier paid run
(`disabled: false` for supplied models) is present in this head's `opencode-chat`.
The key was loaded with `bun --env-file`, checked for presence only, and the
evidence directory and manifest were scanned for its value afterwards (0 files).

## Part A: chat end to end

Model: **"Muse Spark 1.3 · opencode"**, id **`muse-spark-1.3`** (cost 1.25 / 4.25,
tools enabled). It was already the default ("Muse Spark 1.3 · opencode (server
default)") and was also selected explicitly through the Model picker. The guest
catalog lists 34 models, 26 with non-zero cost. Prompts sent: **5**. No auth, quota
or billing error.

| Step | Result | Key measurement |
| --- | --- | --- |
| 1. Trivial prompt | PASS | "OK" rendered and composer idle 4.6 s after Enter ("Sending…" until 2.75 s; first content between 3.3 s and 4.6 s). |
| 2. Immediate-send race | FAIL | Enter 98 ms after New chat, during "Preparing chat…", sent nothing. No error; text stayed in the composer. A second Enter sent it once and it was answered once. |
| 3. Agent edit | PASS | `read` and `edit` tool calls in the transcript; run completed in 31.9 s. File and preview show the marker; no full reload. No permission prompt appeared. |
| 4. Hold during a response | PASS | While a 655-word answer streamed, Save, New workspace, Exit and the Workspace select were all disabled. Response completed at 14.3 s; nothing torn down. |
| 5. Durability | PASS | Edit, preview marker, transcript with tool calls, and model survived save, switch to a new workspace and back (12.9 s, 14.2 s), and a reload (37.5 s). |
| 6. Close after agent work | PASS | Close resolved 1.92 s after Exit; lock free 1.95 s. No `CLEANUP_FAILED` or "timed out" text. Reopen 46.1 s with transcript and edit. |
| 7. Follow-up after reopen | PASS | Asked for the earlier marker; the resumed session answered `AGENT-MARK-X7` in 14.1 s. |

Details:

- **Step 2.** The textarea accepts typing while the chat prepares, but Send is
  disabled and Enter does nothing. The chat became ready 0.7 s later with the text
  intact. The earlier "Chat is not ready" loss is gone; what remains is that the
  keystroke is swallowed without feedback.
- **Step 4.** The footer read "Workspace actions wait for connected, idle chat
  (running)." Real clicks on the disabled buttons timed out; no dialog or alert
  appeared. The Name input stayed enabled.
- **Step 5.** The first session kept its explicit model ("Muse Spark 1.3 ·
  opencode"); the second, created with New chat, shows the server default.
- **Step 6.** OpenCode's shutdown fit easily inside the 5 s EOF window: the whole
  Exit took 1.9 s.

## Part B: re-check of the four fixes

The hang was **injected** page-side, as in run 2: the chat service's `Execution`
handle was patched so `closeStdin()` does nothing and `stop()` never settles.

| Check | Result | Key measurement |
| --- | --- | --- |
| a. Hung stop, Exit | PASS | Recovery alert with both buttons at 11.9 s (10.0 s in phase 1). Exit stays enabled. |
| b. Retry exit while hung | PASS | Failed again after 10.0 s, `CLEANUP_FAILED`; alert remains; attached, durable, lock held. |
| c. Force exit | PASS | Closed 0.31 s after the click. Status line shown, lock free, no workers. |
| d. Reopen, then ordinary Exit | PASS | Reopen durable with marker (35.1 s). Exit succeeded first time (3.5 s), no stale failure. |
| e. Second tab | PASS | Plain "already open" message at about 10.6 s; `errorCode` `STORAGE_BUSY`; after page 1 closed, Retry editing opened durable (33.1 s) with Name "WS-A". |
| f. Recovery during a switch | PASS | Stop failed at 21.9 s; both recovery alerts shown; journal intact; force exit 0.31 s; reopen offered the retry; retry completed (55.0 s). |

Texts, verbatim:

- Recovery alert: `The editor is still open: exit or stop did not complete. Files saved in this browser are kept. (Service cleanup timed out with 0 cancelled operation(s), 0 launch(es), 1 service stop(s), 1 service join(s) outstanding; quiescence unproven)`
- Hint in that state: `Preview and OpenCode are not running. Retry editing to continue working, or exit.`
- Confirm dialog: `Force exit closes the editor without confirming that preview and OpenCode stopped, and without saving again. Files already saved in this browser are kept. Force exit?`
- Status line after force: `Editor closed without confirmed cleanup: preview or OpenCode may not have stopped cleanly. Files saved in this browser are kept and the editor can be reopened. (Workspace force-closed; cleanup unproven (Service cleanup timed out with 0 cancelled operation(s), 0 launch(es), 1 service stop(s), 1 service join(s) outstanding; quiescence unproven; Workspace force-closed while a runtime was attached; runtime cleanup unproven))`
- Second tab: `Open local workspace: This workspace is already open in another tab or window. Close the editor there, then choose Retry editing.`
- Interrupted switch: `Interrupted switch to WS-B. Both saved images are retained; chat is unavailable until recovery.` and, on reopen, `Install application source and OpenCode config: Interrupted workspace replacement retained. Choose Retry interrupted switch or Recover outgoing workspace.`

Notes:

- **Force path (fix 3).** The app's button did not run the graceful phase again.
  The operation took 257 ms: a `service.cleanup.timeout` with `waitedMs: 250`, then
  the forced close. Same in the switch case (256 ms).
- **Stale failure (fix 2).** A `service.cleanup.late` diagnostic
  (`{"source":"chat","error":{"name":"AggregateError","message":"chat settlement failed"}}`)
  was recorded at each forced exit, and the next ordinary Exit was clean.
- **Switch stop deadline.** A stop inside a switch is not under the close budget:
  it waited 20.0 s before failing, against 10.0 s for Exit.
- After the failed exit the older footer alert with the raw timeout text is still
  shown below the new recovery alert, so the same error appears twice.
- After the interrupted switch was retried, switching back to the original
  workspace (64.3 s) showed the agent edit and full transcript intact.

## Part C: quick regression

| Check | Result | Key measurement (run 2 in brackets) |
| --- | --- | --- |
| Boot | PASS | Ready 25.7 s (20.8 s); 1 kernel, 3 process workers, 0 other; owner lock held by the kernel. |
| Close and reopen | PASS | Close resolved 3.44 s, lock free 3.45 s; reopen 58.6 s (about 52 s). |
| SQLite contract case | PASS | Both steps ok (767 ms, 373 ms); lock last held 19 ms and 10 ms before close resolved; no kernel target listed 3 s later. |

**Exit time now tracks the save, not the shutdown.** With two real sessions in the
workspace, "Save workspace" alone took 3.3 s, and Exit took 3.4–3.5 s. With one
short session earlier in the run Exit took 1.9 s; with none (run 2) 0.2–0.5 s. All
are far inside the 15 s budget.

Reopen and switch times varied more than in run 2: reopens 33–59 s, switches
12.9 s and 14.2 s early in the session but 55–64 s later. This run did not
investigate why; run 2's stage breakdown was not repeated.

## Errors observed

No page errors and no provider errors. Console: `using deprecated parameters for
the initialization function; pass a single object instead` ×22, the `style.css`
preload warning ×20, favicon 404 ×2, the SQLite case's own
`sqlite3_step() rc= 1555 SQLITE_CONSTRAINT_PRIMARYKEY …` ×1. The only failure
texts are the injected-hang ones quoted above.

## Still unverified

- Permission prompts, the unsupported-form path, "execution state unknown", and
  the chat Retry control: none occurred.
- Interrupting a response with Stop, and holds refused by anything other than
  disabled controls.
- A hang from a real guest process; this one was injected at the handle.
- "Recover outgoing workspace" after an interrupted switch.
- Forced close through `dispose`/unmount/`pagehide` as an observed outcome.
- Why reopen and switch times vary so widely within one session.
- Any model other than Muse Spark 1.3; the picker also still lists free-tier
  models that fail with the run-2 403.
- The catalog reached the manifest through a scratch merge, not a supported
  prepare or server option.

## Evidence and cleanup

Evidence: `/Users/kkrausse/Documents/repos/kkrausse/bat-sk-track/.diagnostics/sk-live-2026-09-30-run3-k9p2/`
(`journal.md`, per-step JSON, `transcript-session2-final.txt`, `model-config.json`,
`merge-catalog.ts`, `all-console.json`, screenshots, scripts). Screenshots of the
agent edit, the recovery alert and the second-tab message were viewed and match.

No tracked file was changed. Session deleted, both servers stopped, ports 46931 and
46932 free. Both origins' storage was cleared after confirming the lock was free
(OPFS, IndexedDB, CacheStorage; the app origin's service worker unregistered). The
generated manifest still carries the merged catalog until the next `prepare:editor`.
