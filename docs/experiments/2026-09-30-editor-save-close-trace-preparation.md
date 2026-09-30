# Editor Save/close — offline observational preparation

## Outcome / queue boundary

**An isolated instrumented diagnostic candidate is prepared; no live run occurred.**
The parent's exclusive browser queue still governs activation. This preparation
does not claim to reproduce, explain or repair either `955265d` failure.
Original evidence and frozen sources remain unchanged. No production edit,
Effect rewrite, dependency installation, worker/native rebuild, pin change,
browser/host/guest/server launch, paid inference or relay operation occurred.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-editor-save-close-trace-preparation.md`.

Read the complete `f007ed7` investigation and `955265d` report, original capture,
close scripts and action journal; toolkit/runtime AGENTS, runtime development
instructions and normative single-kernel architecture. Existing Save-busy-field
and retained-target causal uncertainty remain open.

## Frozen preparation and preflight

Final output root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/editor-save-close-trace-Z91iXQ`.

- `instrumented-source/`: extracted exact original toolkit archive plus explicit
  diagnostic overlay; never the current mutable production tree.
- `consumer-stage/`: new isolated consumer, separately rebuilt instrumented
  workspace/chat libraries, exact reused SDK/runtime/prepared artifacts.
- `source-overlay.json`: every exact replacement, original/instrumented SHA-256,
  asserted reversal back to original source bytes, and every artifact hash diff.
- `handoff.json`: commands' outcome, final paths, receipt hash and no-launch flags.
- `trace.tsconfig.json` and `command-*.json`: retained offline command evidence.

Input is the immutable `conservative-full-app-Yb8T8p/frozen` cohort. Toolkit
`d0eec346dbc749db1c0cd82dd8aad0b27c1da363`; runtime
`33fa1359a003ca9c50cb3bc49699b99bc1a063f1`; runtime version
`3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.
Archive SHA matches the original frozen receipt. All original 9,677 receipt-listed
files rehashed before/after preparation. Final candidate **9,683** files verified;
receipt SHA-256:
`18edcbfb95b82c494d38bfb5ea1f255ea4bb5432e7ced70b94bedf6d0fb81773`.
The receipt also hashes the source overlay manifest.

Changed/new artifacts are exactly those in `handoff.json`: five chat JS entries,
two workspace JS entries, editor client JS, observer JS, QA host and archived QA
scripts. **No SDK, runtime, prepared application, worker asset or native output
hash differs.** Consumer CSS differed only in generated path comments: equality
after comment removal was asserted, then exact original CSS reused. Public
declarations are reused unchanged; strict source typecheck validates the overlay.
Existing installed build dependencies are reused, not a fresh install claim.

Strict TypeScript check passed for all eight instrumented source files and both
new TypeScript scripts. Separate library builds and consumer build passed.
Three CLI bodies parsed as async function bodies without invocation. No generic
unit tests or headless/browser acceptance were added/run.

Preflight caught ambiguous source matches and a CSS output naming collision;
those offline candidates were not promoted. More importantly, an imported
observer was initialized **after** bundled library global reads. Final QA HTML
instead loads a separate **blocking classic observer script before the module
client**. No runtime/worker is imported by the observer. Earlier scratch outputs
are not the live input.

**Served hashes are not yet observed**: offline preparation has no listener.
The receipt records expected bytes for the later host; the live agent must hash
actual HTTP response bodies before activation and retain the matching receipt.

## Observations, not fixes

`examples/todo-app/tests/editor-save-close-trace-observer.ts` owns a read-only
`globalThis.__editorSaveCloseTrace.read()` export. The ring retains 4,096 timestamped
rows (UTC, monotonic page milliseconds, sequence), drop/error counters, plus at
most 12 exact cloned source/native captures capped at 8 MiB each. Over-cap/drop
conditions are evidence limits, not success. No credentials or prompt content
are requested; native export in this owned cohort contains only the model change.

The isolated source overlay observes:

| Boundary | Concrete hook |
| --- | --- |
| Actual controller | `editor-adapter` observes precisely the created chat; public `subscribe` + initial `getSnapshot`; no second observer controller or private callback replacement |
| Idle state | Connected/idle, sending/loading/loadingOlder/interrupt, permission/question/unsupported-form counts, selected session/model, **sessionOperationPending**, exact failed-field list |
| Guard checkpoints | Admission, capture initial, capture final, immediately before each original predicate, without an intervening await |
| Capture | Workspace flush enter/return; source capture enter/exact bytes; native capture enter/decoded ordered bundle; catalog persist enter/return |
| Native operations | Actual official SDK endpoint fetch and native transfer fetch start/Promise settlement/status; unique observation span IDs; original Promise returned unchanged |
| SSE | Actual decoded controller event type/session/available sequence at event delivery; public connection-state transitions; no extra SSE client |
| Save/Exit | Public action admission label, Save enter/return, Exit controller close enter/return, onExit return |
| Close | Controller service-stop entry and original execution/shutdown, drained-output, endpoint settlement result positions; runtime stop return; workspace close/flush; host destroy entry/return/throw |
| Discarded disposal | Attachment callback enter/return with the Promise still discarded; actual chat dispose Promise pending/fulfilled/**rejected** side observation |
| Native worker | Host-page Worker constructor entry/return/throw; WeakMap object identity, URL/name/page owner; native terminate entry/return/throw |

The original `idleChat` body is untouched: **sessionOperationPending is recorded,
not added to admission**. Attachment disposal still deletes the map then calls
`current.dispose()` without awaiting it. Existing disposal catch behavior remains;
the extra observer records a rejection as failure, not pass. No source-hook awaits,
timeout changes, extra quiet periods, control-flow repairs or application writes
are introduced. Original native method return values and throws pass through.

### Explicit observer limits and influence

- The ring/subscriber allocation, source cloning, Worker constructor Proxy and
  Promise side-branch microtasks can perturb timing. This is an instrumented
  diagnostic candidate, not a claim of schedule-identical reproduction.
- SDK and native request settlement observes response headers/Promise receipt,
  **not raw response body consumption**. The native return capture is decoded
  export data. SSE transport handshake/close internals are inferred only from
  public connection transitions; no invented transport sequence is supplied.
- SDK host-error handlers remain exact original bytes. Individual notification
  callback identities/entry/returns are **not exposed**. A throwing `Host.destroy`
  is recorded with its error and whether native terminate was reached, but cannot
  alone identify which notification callback threw. No notification exception is
  suppressed. Exact SDK provenance takes precedence over privately wrapping handlers.
- The host Worker wrapper does not run inside the kernel and therefore does not
  intercept nested guest constructors. Actual CDP target census supplies nested
  identities; object IDs are not presented as CDP target IDs.
- This SDK editor exposes no supported `__vv.diag` or public guest-activity handle.
  The close collector records that probe as unsupported; it does not inject a
  guest or send private worker messages. After-close target accounting, empty
  locks, failed attachment or a closed page are not proof of a dead/live realm.
- CDP event discovery may be unsupported by the installed extension. Record that
  actual error and event/drop counts rather than fabricate target-destroyed events.
  Events retained by the collector are scoped to the fresh owned origin/targets.

## Runnable handoff — live only after parent assignment

Recreate offline preparation, if needed, from repository root:

```sh
bun examples/todo-app/tests/editor-save-close-trace-prepare.ts
```

Use the final stage above, not an older scratch candidate. Verify it and make a
previously nonexistent run copy using the already qualified copy-only helper:

```sh
STAGE=/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/editor-save-close-trace-Z91iXQ/consumer-stage
RUN=/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/editor-save-close-trace-live-once
bun examples/todo-app/tests/editor-save-close-trace-prepare.ts --verify "$STAGE"
bun examples/todo-app/tests/conservative-full-app-prepare.ts --run-copy "$STAGE" "$RUN"
bun examples/todo-app/tests/editor-save-close-trace-prepare.ts --verify "$RUN"
```

**Do not execute the following launch while another agent owns the slot.** After
the parent explicitly assigns it, start only the owned host:

```sh
bun "$RUN/qa/live-host.ts" "$RUN"
```

It uses an OS-assigned origin, empty providers, and the existing model route 403
fence. Retain exact PID/origin and host output. Create a fresh named Bun-backed
Browser Control CLI session, verify its exact page/ownership, navigate only to
the new origin with `/?workspaceFixture=1`. No old-origin replay, user profiles,
storage clearing, browser replacement, relay restart or MCP. Reverify actual
client/observer/CSS response hashes and parser-blocking script order before boot.

Trusted visible action sequence (inspect before choosing controls):

1. Click normal **Open editor** once; verify hydrated preview, connected/idle chat
   and enabled Save. Verify `observer.installed` exists before worker constructor
   rows and that the real chat attachment/snapshot rows are present. If missing,
   stop the diagnostic; do not repair observers on the running page.
2. Parent creates a new evidence directory named `editor-save-close-trace-evidence-*`.
   Set `state.editorTraceEvidence` to its absolute path; set
   `state.editorTraceReadPhase = 'initial'`; invoke
   `browser-control execute --session "$SESSION" --file "$RUN/qa/editor-save-close-trace-read.js"`.
3. Open real **Session & model** disclosure; inspect Chat settings. Click normal
   **New chat** exactly once. As in the original cohort, wait for the New chat
   control to re-enable; inspect selected native ID. Open the **Model** combobox,
   inspect the actual options and leave the exact Nemotron option visible.
4. Invoke `editor-save-close-trace-save-once.js` from the archived run QA directory.
   It selects **Nemotron 3.5 Lightning Free · opencode**, waits for the normal
   enabled Save (no pending-flag quiet heuristic), fills **QA owned A**, uses the
   original bounded source fixture to write/flush `/qa-owned-marker.txt` with
   `editor-A-20260930\n`, and clicks public **Save workspace exactly once**.
   The original 30-second Saved-status assertion remains. Its failure is retained,
   not retried. Capture fresh visible alert and exact failed checkpoint fields.
5. Set read phase to `after-save`; invoke archived `editor-save-close-trace-read.js`.
   Preserve raw catalog, source/native capture bytes, selected native model/message,
   screenshot, journal, sequence/drop counters, and per-file/semantic hashes offline.
6. Whether explicit Save succeeded or rejected, invoke archived
   `editor-save-close-trace-close-census.js` **once**. It attempts normal **Exit**,
   including the app's original implicit Save, without retries or force-clicks.
   It retains baseline page/context/worker IDs, native terminate notifications,
   actual locks/targets sampled concurrently across the unchanged **15,000 ms**
   original window, UI receipt, and supported scoped CDP events. Individual
   census requests have a one-second read-observer budget; errors/gaps remain
   missing evidence. Samples finishing outside 15 seconds are explicitly excluded.
   A separate sample at roughly 30 seconds is **post-window observation only**,
   not an inflated close deadline. Never convert absence after page closure to death.
7. Set read phase to `after-close`; invoke archived read export. Retain final
   catalog/native/source boundaries and screenshot. No switch/recovery continuation,
   inference, retry-to-accept or architecture expansion follows from this run.
8. Verify frozen stage and run receipt again, hash all retained evidence. Delete
   only this owned CLI session/page, join only its exact host PID and confirm
   port/PID absence. Page deletion after retained targets is failed-cohort cleanup,
   not native close acceptance. Parent releases the exclusive slot explicitly.

The scripts refuse a repeated Save/Exit in the same CLI state and use exclusive
`wx` evidence writes. Do not re-run them after a relay state reset or script error.
If the new cohort does not reproduce, report that outcome honestly; the original
Save failure and retained kernel remain historical evidence, not erased results.
