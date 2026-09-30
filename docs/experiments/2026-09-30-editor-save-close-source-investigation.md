# Editor Save/Exit: exact-source investigation, not a repair

## Outcome

The `955265d` cohort has two retained failures/boundaries: explicit Save rejected
its **second chat-idle checkpoint**, and the original kernel target identity was
still returned after public Exit. Neither has a proven live causal trace.

- **Save rejection is correct conditional behavior of the shipped guard**, not
  proof that legitimate concurrent chat work occurred. Which idle predicate failed,
  and whether its cause was genuine execution, hydration/finite request activity,
  or model-update timing, remain unknown. Do not remove the guard or retry Save
  automatically. A concrete omission exists: `idleChat` ignores
  `sessionOperationPending`, although native model mutation publishes that flag.
- **No normal-path missing kernel termination was found.** The exact public close
  chain awaits workspace flush and calls `Host.destroy()`, which calls the owned
  worker's native `terminate()`. That call is synchronous, not a termination join
  receipt. Same-ID target retention is established; a still-executing kernel is
  not established by the retained census alone. No likely retain mechanism is
  proven.
- **A separate concrete ownership gap exists:** the editor attachment callback
  discards `chat.dispose()`'s Promise. This is not proof that it retained the kernel.
  No production repair is implemented here; fix contracts must be agreed before
  implementation. No async-framework rewrite follows from this investigation.

Zero ordinary switches (0/4), zero recovery runs. Exit's later implicit Save
retained exact source and a flat native bundle; it does not rehabilitate explicit
Save or establish editor close acceptance.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-editor-save-close-source-investigation.md`.

## Inputs and verification

Read the complete stopped-cohort report
`docs/experiments/2026-09-30-conservative-editor-switch-recovery-live-qa.md`,
toolkit/runtime AGENTS, `vivari/DEVELOPMENT.md`, and normative runtime topology.
This is offline source/evidence investigation only. No browser, host, guest,
installation, build, old-origin replay, benchmark, test scaffold or production
change; the independent focused live agent retains sole browser ownership.

Exact preserved roots:

- Evidence: `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-editor-evidence-20260930-once`.
- Delivered run: `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-editor-live-20260930-once`.
- Frozen preparation/source: `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-full-app-Yb8T8p`.

Independently rehashed all 21 evidence-manifest entries: mismatches **[]**.
Compared frozen toolkit editor/session/local-workspace, controller/workspace/runtime,
chat-controller/adapter source byte-for-byte with `git show d0eec346:<path>`;
compared frozen runtime host SDK/kernel-worker/filesystem source with
`git show 33fa135:<path>`: all comparisons equal. Current uncommitted source was
not used to infer behavior.

Actual delivered `client/single-kernel-live-client.js` SHA-256:
`98c927872253ffbfbc1091f8c3f1c3d5dbe047f5165bce4cc378e6f761e896ed`.
The prepared manifest's `/app/server.js` entry and actual `.bin` independently
hash to `648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5`;
the preserved qualified OpenCode server has that same hash. OpenCode published
packages are 2.0.3; the manifest records upstream revision
`d44b52ca66b6bf69626c0384626d1a9cd9555977`. Server line references below name that
exact preserved `qualified-opencode/.runtime/opencode-bun-server/server.js`, not
a current upstream checkout.

## Save: precise contract and native path

At toolkit `d0eec346`, `examples/todo-app/src/workspace-editor.tsx`:

1. `action()` synchronously takes its UI lock and calls `controller.run()`.
2. `WorkspaceController.run()` (`workspace-api/src/react.tsx:60–78`) publishes
   **workspace** `busy:true`, runs the task, catches/report errors, then clears busy.
   That busy flag blocks competing workspace actions, not `idleChat()`.
3. `save()` calls `assertIdle()`, then `capture()` checks chat idle again, flushes
   workspace, samples selected session, captures source, captures native sessions,
   validates the snapshot, and checks chat idle **again** before returning.
4. Only after capture returns does `persist()` replace the catalog; identity write
   and the Saved status follow. The retained alert is the final check at source
   line 57 / delivered client line 100020. It is not initial admission rejection,
   a persistence exception, or switch failure.

`local-workspaces.ts:34–35` / delivered line 99869 requires connected + idle
execution and no sending/loading/loadingOlder/interrupt/forms/permissions.
The predicate does **not** read workspace busy, scheduled recovery, an in-flight
hydration fiber, or `sessionOperationPending`. Therefore saying “Save marks itself
busy, hence it always rejects” is false for these bytes. Saying enabled Save proves
all model/native work has joined is also false.

The native export path (sometimes described as `getNativeExport`) is actually
`workspace-sessions.ts:captureSessions()` / delivered line 99788. There is no
`getNativeExport` symbol in these frozen sources/server. It directly invokes
`service.connection.fetch`, not `ChatController.exportChats()`:

```text
GET /api/session?directory=%2Fworkspace&limit=100[&cursor=...]
GET /api/session/<native-id>/export                 (for each native session)
decode native info/messages, order parent-first, return
```

These are real finite server operations, with per-request 30-second signals,
pagination duplicate/cycle/size checks; an empty browser request list does not
mean they did not happen. The server handler `session.export` (556244–556247)
calls `SessionTransfer.export` (553921–553927), which calls `sessions.get` and
`sessions.messages`, filters settled messages, and returns native info/messages.
`Session.get` routes to `forSession().get()` (452268); `Session.messages`
(452290–452292) gets the session then reads stored messages; `Session.get`'s
underlying function (451784–451789) is a store read. The bound `operations` table
(451962–452031) has no automatic execution-start wrapper around these reads.

**Do not promote “capture performs finite operations” into “export emits busy SSE”
without evidence.** The inspected exact export/read path contains no such publish
or execution wake. A self-triggered export/SSE-hydration explanation is a hypothesis
to discriminate, not a proven causal chain. Likewise the workspace controller's
operation busy is not OpenCode execution busy.

### Native model update and chat hydration

The observed New chat created `ses_f0b8630f1ffe7ZM6q1QIri7nAc`; normal model
selection chose `nemotron-3.5-lightning-free` / `opencode` / `default`.
`opencode-chat/src/controller.ts:selectModel` checks idle/sending/mutation,
publishes `sessionOperationPending:true`, awaits `api.model`, updates the model,
and clears that flag in its ensuring block. `api.ts:85–87` calls the official
`session.switchModel`, not a prompt.

Exact server `Session.switchModel` (451812–451817) publishes
`session.model.selected` unless the selected model/variant is already equal.
Its projection (76751–76761) appends the durable **`model-switched`** message.
Those are different objects: an SSE event versus a stored native history message.
The chat event handler updates model and schedules `recover()`; the recovery
waits 120 ms then invokes hydration. Hydration concurrently reads messages,
permissions, forms and active execution; overlapping event revisions can cause
another recovery. Active execution comes from `SessionExecution`'s coordinator
(228518–228555), not the workspace-action busy flag; `/api/session/active`
(556248–556253) encodes running IDs. Hydration can publish execution and request
state; it does not universally set `loading:true` on every recovery.

Concrete admission mismatch: native model selection's pending flag disables chat
model/send controls but is omitted from workspace `idleChat`. The compound journal
command starts about `22:41:18.798Z`; native model/message time is
`22:41:19.044Z`; it selects the model, waits for enabled Save, names A, flushes the
marker, clicks Save, then times out at `22:41:48.997Z` (30,199 ms). This does not
time the actual failed checkpoint or prove mutation was pending at the click.
Adding that missing flag to admission could prevent one overlap; it cannot be
claimed to fix this cohort's final-check failure from these observations.

### What the retained state proves, and cannot prove

Failure catalog: same active ID `56b6848d-3de6-4bd3-b570-85aa8cab4fb1`,
Current workspace, 34 files, zero native sessions, no pending. Live source had
35 paths including `/qa-owned-marker.txt`. The later Exit save persisted QA owned A,
all 35 exact source-byte digests (mismatches **[]**), one selected flat session,
the model above, zero tokens/cost and one real `model-switched` message, no pending.
Native semantic digest:
`bba85f056b95366fcebdfa15b1cf3afe17d1517025a3e609db1620b84f3c4c36`.
Neither restoration, hierarchy nor across-switch preservation was exercised.

The failure-page snapshot later says Ready with the alert still present. That is
compatible with a transient non-idle checkpoint; it does not identify which field
was non-idle at that checkpoint. No subscribed snapshot ring, native request spans,
SSE sequence or active-response capture was installed. No prompts/inference occurred.
No evidence establishes an external concurrent actor, a pending model mutation,
or export-induced busy. A genuine non-idle state should reject; misclassification
of read/hydration activity would need a different narrowly specified contract.
The exact cause remains **unknown**, not admitted concurrency proven correct and
not incorrect Save rejection proven.

## Exit: owned worker path versus target accounting

The delivered Exit handler awaits its built-in Save, then `controller.close()`,
then `onExit()` (return to Open editor). Exact source chain:

```text
WorkspaceEditor Exit
  -> WorkspaceController.close() / react.tsx:309–314
     -> stopRuntime(): stopServices(), runtime.stop(), clear runtime
     -> Workspace.close() / workspace.ts:160–171
        attached/clearing guards, close admission, await host.flush()
        finally unsubscribe/clear watches; host.destroy(); release document opener
     -> publish workspace absent / persistence closed; status
  -> onExit()
```

`Runtime.stop()` disposes endpoints, joins pending launches, execution stops and
endpoint settlements; cleanup errors keep workspace attached. Controller service
cleanup also awaits shutdown, output drains and endpoint settlement. No error path
here deliberately returns a successful Exit before workspace close.

Runtime `33fa135`, `packages/core/src/host-sdk/host.ts:161–169` and delivered
client 17932–17947: `destroy()` returns early only if `dead`; otherwise marks dead,
notifies host-error handlers, calls **`this.worker.terminate()`**, rejects pending
RPCs, clears handlers and relay listeners. Workspace close's delivered call is
18147. The host constructed precisely one worker named Workspace storage supervisor
(host source 25); no bridge-owned second kernel or intentional retained kernel
cache exists in this path. Nested process workers are kernel-owned; their normal
termination closes filesystem ports and removes PID registrations.

Two source limitations worth fencing, not attributing blindly:

- `Host.destroy()` marks dead and invokes arbitrary handlers **before** terminate.
  A throwing handler can skip terminate and poison later destroy attempts. This
  is a concrete exception-safety weakness, but no retained handler throw, earlier
  destroy failure, or native terminate observer proves that path occurred here.
  A throw in the ordinary Exit call would prevent `onExit()`; any earlier poisoned
  path would require its own trace. It is not the diagnosed retain mechanism.
- `editor-adapter.ts:22–25` attachment disposal deletes the chat map entry and
  invokes `current.dispose()` without awaiting it; `WorkspaceController.detach`
  uses synchronous callbacks. Chat dispose's scope/readers/ManagedRuntime joins
  can therefore outlive the callback. It owns no kernel Worker constructor, so
  this difference does not bypass `Workspace.close()`'s native terminate call.

### Raw identity and time boundaries

Owned host OS PID **15093**, origin `http://127.0.0.1:49633/`; guest PID labels
1/2/3 are virtual PIDs, not OS host PIDs. Page
`F8DF232B90051B3CD38FF5F3418763EA`, context
`814638BC1C450A0CF99051C28DFA04B4` remained unchanged throughout observations.

| Evidence | Returned workers / locks |
| --- | --- |
| Failure census | Kernel `4704204A3EC0F78B1AB5C905F5A05253`, PID 1 `3525925571E526C8993787375E2CA585`, PID 2 `DF20A0CFDBE588FE06F48BDEC0B6BC57`, PID 3 `9C32FE5B007B95081BD188EC3F8D519B`; exclusive `vivari-vfs-owner` client equals kernel ID |
| `public-close-census.json` | Same kernel + same PID 2; held/pending locks empty; Open editor visible |
| Late `22:44:19.600Z` census | Same kernel, no process targets; held/pending locks empty |

Kernel URL is exactly
`http://127.0.0.1:49633/editor/runtime/assets/kernel-worker-5EzLFeOC.js?opfs-disable=`;
process URL is that origin's `/editor/runtime/assets/process-worker-ZQRq3H73.js`.
Matching target ID, parent page, context and URL exclude an unrelated tab/kernel
or replacement generation explanation. They do **not** themselves prove an
executing worker realm after termination: the CDP census is extension-mediated
target accounting, with no post-close liveness evaluation/response recorded.

The close journal ends `22:43:48.059Z`, command duration 950 ms: approximate start
`22:43:47.109Z`. `elapsedMs:867` includes click, waiting for Open editor, census and
catalog read; it is not a separately timed `Workspace.close()` Promise receipt.
The later observation is 32.491 seconds after reconstructed command start. The
original continuous 15-second census was not run. Empty locks show the earlier
lease is no longer observed, not a writer/worker join. No native terminate-call
receipt, target-destroyed chronology or stopped registry sample was preserved.
Subsequent session/page deletion removed the remaining target only as failed-cohort
cleanup; exact host PID/port absence does not repair native-close acceptance.

### Comparison controls

- Full-app `70d8c23`: same 33fa135/d0eec346 runtime ownership path and matching
  kernel/process assets; ordinary controller close completed, original census
  `0307.json` had no scoped workers, reload close census `0362.json` also empty.
  Five app generations are not four editor switches. This consumer did not run
  native New chat/model Save controls or mount this editor's chat attachment.
- Minimal `465460d`: same runtime; one guest, explicit execution/output/runtime
  joins and normal Workspace.close; no editor chat/SSE client. Its pass shows
  the native ownership path can close, not that this editor did.
- Old e35 retention and fresh control `f09b1b9`: independent source/assets and
  cohort. Fresh case 1 observed one native terminate call and 91 empty original
  lock/census samples. Historical e35 cause remains unknown. It neither explains
  today's retained target nor proves all retention is target lag.

## Smallest next observational cohort and fix limits

Only with fresh authorization/frozen provenance, after the sole live owner releases
the slot: one new editor activation, ordinary New chat/model selection, marker,
**one** explicit Save, then one cleanup Exit. Stop on first acceptance failure;
no four-switch/recovery continuation, busy-Save retry or old-origin replay.

Before actions, retain bounded public chat/workspace snapshot transitions with
timestamps, selected ID, all `idleChat` fields **and sessionOperationPending**;
capture native transport operation start/end/status and SSE type/session/sequence
through the supported connection, not ordinary browser network events alone.
Correlate native export boundaries with snapshot changes and the exact failed
predicate. A bounded diagnostic snapshot/checkpoint ring is preferable to private
controller mutation. No payload/credentials/transcripts required. If the required
public observations cannot expose the predicate boundary, report that limit before
adding a narrowly scoped public diagnostic—not a quiescence heuristic.

For Exit, record public service/output/endpoint/runtime/workspace settlements,
native Worker creation/terminate entry/return/error before boot (pass-through
observational wrapper only), then join timestamped lock+census samples through
the unchanged original 15-second window. A surviving exact ID warrants a separate
bounded read-only realm-liveness check if supported; failure to attach/evaluate
is not proof of death. Preserve target-destroyed events and dropped counts.
Neither lease release, registry zero nor UI close substitutes for that boundary.

Potential production work is limited to exact contracts, before implementation:

1. `local-workspaces.ts:idleChat`: exclude `sessionOperationPending` for mutation
   admission; characterize the concrete missing-flag overlap separately from the
   unproven second-check cause. Do not simply await arbitrary “quiet time”.
2. `editor-adapter.ts` + controller attachment API: define an awaited client-disposal
   receipt before server/runtime teardown; retain failure reporting. Do not claim
   this is a kernel-leak fix until instrumented evidence connects it.
3. `host-sdk/host.ts:destroy`: if hardening exception safety, native terminate and
   RPC/relay cleanup must not be skipped by a notification-handler throw. A
   regression selecting that actual throw path is justified, but this task writes
   no test or patch and does not assert the editor selected it.

No broader Effect implementation, cancellation rewrite, blanket all-writer proof,
assertion weakening, timeout increase, cache-tamper expansion or pin change is
authorized by these findings. Effect scope report `10ebbe8` remains scope only.
