# Single-kernel status, baseline comparison, and next direction

Date: September 30, 2026. This consolidates the evaluation and subsequent user
direction from the parent chat so that neither the findings nor the next steps
depend on chat history. It is a status/decision record, not new acceptance evidence.

Absolute document path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-status-and-direction.md`.

## Bottom line

**Continue single-kernel as the preferred experimental integration candidate; do
not replace the baseline or promote release pins yet.** “Seems less buggy, but
early” is a reasonable qualitative impression, not a measured reliability result.

The existing acceptance evidence is retained, but scattered and not all green:
bounded functional criteria passed across separately labelled runs; the fresh full
E2E failed its post-close worker census. Later successful UI/model observations do
not supersede that failure. There is no matched baseline-versus-single-kernel
performance comparison or demonstrated reduction in failure rate yet.

The next milestone is **reliably faster real workspace switching**, not merely
fewer workers. Keep the baseline as the comparison/control and fallback.

### Latest rollup (updated with integration and live QA follow-ups)

| Workstream | Latest state |
| --- | --- |
| Chat readiness/drafts | Repaired `691cd5aa`; primary lab passed. Complete visible controller/model fixture passed 9 checkpoints/91 guards; headless follow-up failed and used wrong Playwright version. Whole-app acceptance pending. |
| Close target retention | Unchanged-runtime case-1 live control passed with termination/lock/census observations. Historical cause still unknown; full suite pending. |
| Cached installed artifacts | Endpoint/PID-egress repairs pass offline; lazy-loader planted-symlink counterexample still blocks cache admission. Optimization paused pending conservative integrated qualification; no on adapter or measured gain. |
| OpenCode process retention | Root requalification stopped at browser-session setup, no guest launch. Shared-config stable-root toy frozen but unexecuted. No reuse/remote-release proof. |
| Workspace switching/stress | Integrated frozen candidate, matched off/on comparison, full applicable E2E and stress/recovery qualification still pending. |

The sections below preserve the original evaluation and chronological follow-ups;
earlier “pending”/failure statements are snapshot facts, not erased by later bounded
passes. Refer to each latest follow-up's scope before treating any gap as closed.

## Snapshot identity and evaluation method

- Single-kernel toolkit HEAD before this document:
  `262c51a9ebc9bb82b289988d197046d07881aca3`.
- Baseline toolkit HEAD: `64de5229381feb1f6f14335b3d4a2edae66fcf58`.
- Toolkit common ancestor: `7f5c0919fc09afe3ed549c29457748cddd9778e6`;
  eight baseline-only and 25 single-kernel-only commits at this snapshot.
- Experimental runtime:
  `/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel`,
  `e35eab4af7a53ff08eb70c09df59c40b78bfdd67`.
- Retained experimental distribution:
  `bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`.
- Both toolkit `vivari/runtime-source.json` files still pin canonical runtime
  `e998de62a10e5382104b51e0b860ee9d4d7a2401`. Normal setup does not select the
  experimental runtime; explicit overrides and isolated artifact preparation do.

The parent evaluation used source/history and retained experiment reports, with
independent read-only source and baseline-evidence reviews. No fresh browser run,
benchmark, runtime rebuild, model call, deployment or pin change was performed for
the evaluation. A mutable local build receipt is not proof of what a historical
consumer actually served; frozen run receipts identify that.

**Later artifact correction:** freshly verified delivered OpenCode server bytes
differ between baseline and frozen single-kernel, despite both reporting 2.0.3.
See the real-server staging follow-up below. Historical baseline source-review
line numbers and restricted-retention conclusions require review against the
actual delivered single-kernel artifact; matching version labels are insufficient.

## What the architecture changes—and what it does not

Baseline runtime boot creates a kernel worker, filesystem worker, fetcher worker
and PID-owned guest workers, plus an optional Python editor language-service worker.
HTTP supervision already lives in the kernel in this baseline path.

Single-kernel imports filesystem and fetch modules into the kernel worker. That
worker now owns VFS/FsServer, persistence/dependency-cache coordination, SQLite,
process supervision and HTTP/fetch coordination. Guest programs and guest threads
still use separate workers; the browser Service Worker remains a relay.

The important simplification is direct kernel-local filesystem access: the kernel
no longer synchronously waits for another filesystem worker to complete its own
filesystem operations. Mutations still use the shared dispatch/persistence/watch
logic. Guest SAB waits and the existing host/HTTP streaming transport remain.

This structurally removes a cross-worker registration/delivery/completion boundary.
It does **not** make cancellation, persistence, shutdown, or operations interleaved
at `await` transactional. Heavy filesystem/compression/SQL work now shares the
supervisor's event loop and can delay other servicing. Fetch still materializes
whole response bodies; removing its worker does not remove buffering cost.

Other branch changes include filesystem completion-predicate repair, newline-safe
directory framing, fetched-body lifetime fixes, boot-failure ownership release,
and large synchronous binary child-capture/publication/spill cleanup. These are
correctness repairs, not proof that consolidation caused the observed successes.
Some are independently useful to the baseline.

Kernel/guest artifacts must ship together: changed wire payloads are not fully
distinguished by the coarse existing ABI label. Python guest execution remains,
but Python editor LSP is disabled. Source-mode Studio and general application
compatibility are not qualified.

## Actual workspace-switch semantics

The TODO app provides logical workspaces above one physical `/workspace` and one
origin store. It saves source bytes and native OpenCode session bundles in
IndexedDB; it does not create a separate physical runtime per saved workspace.

Current switch order:

1. Validate incoming image and require connected, idle chat.
2. Capture outgoing source/native sessions and durably journal saved images.
3. Dispose chat and stop owned runtime/services.
4. Clear `/workspace` and `/.server`, restore source, deliver managed dependencies.
5. Start/qualify Vite, then start OpenCode; import native sessions and hydrate chat.
6. Commit incoming active identity and remove the pending checkpoint.

`stopRuntime()` retains the workspace host/kernel; workspace close destroys it.
That separation already existed in the baseline. The new UI nevertheless removes
managed dependency roots and restarts both services; it is not a warm-service
switching implementation.

**Clarification requested in the chat:** the kernel is already retained across the
current UI's workspace changes, as in the baseline. The missing retention concerns
installed dependency/cache state and running service processes—not kernel lifetime.
Do not describe this workstream as first introducing kernel retention.

The journal makes interrupted replacement recoverable, not atomic across OPFS,
native session APIs and IndexedDB. Imported native sessions receive remapped IDs;
this is resumable native transfer, not just transcript display. Snapshots omit
managed/generated roots, git metadata and empty-directory/mode fidelity; source
symlinks and secret environment files block capture. Unsent drafts are not part of
the durable archive, even though a bounded parent-state draft restoration passed.
TODO application data remains shared host memory, not workspace-isolated storage.

## Acceptance ledger: passes, failures, and unqualified scope

| Area | Evidence at this snapshot | Boundary |
| --- | --- | --- |
| Worker consolidation | Source review, independent headless tests, retained active Chrome inventories | Sampled topology, not continuous census of every case |
| Runtime functional criteria | 19 Chrome client stages plus separately labelled same-version reload and ten focused cases/14 steps | Criterion completion across runs, not one all-green original cohort |
| Fresh full E2E | 19 app stages, five hydrated TODO/PDF generations, HMR/SSE/reload stages; case 0 census passed | **Failed after case 1; cases 2–9 not reached** |
| Interactive workspaces | Source/native-session/model round trips, same-origin restart/reload and real CRUD passed | Bounded smoke acceptance, not stress-test or switching SLA |
| Paid model path | One Muse Spark 1.3 response `OK`; transcript/model retention across reload/switch passed | No tool/file/dependency mutation; Qwen selection is not Qwen inference |
| Recovery | Injected/observed outgoing recovery passed; healthy progress presentation passed | Not exhaustive interruption/failure coverage |
| Performance/reliability comparison | None for baseline versus single-kernel | No measured speedup or lower failure rate attributable to topology |

### Visible improvements already demonstrated

- Stable preview attachment props repaired an iframe reattachment loop (the old
  observer recorded 2,828 navigations); subsequent bounded CRUD/HMR caused zero
  preview navigations after observer reset.
- Compiled public CSS repaired model-picker pointer interception.
- Nullable cursor handling enabled native-session snapshot pagination.
- Sequential Vite-before-OpenCode startup replaced the parallel startup that
  exhausted Vite's 30-second listen budget twice for Smoke A; outgoing recovery
  preserved the original workspace.
- Healthy switching now shows neutral progress rather than an Interrupted alert.
- Workspace source, native chat selection/history and model choices survived
  observed round trips/reloads without wiping user storage.

Most of these are app integration/readiness fixes. Sequential startup supports a
contention hypothesis, not precise root-cause proof or a parallel/sequential timing
comparison. They should be retained independently of the topology decision.

### Concrete unresolved stability gaps

1. **New chat → immediate send:** observed `ChatError: Chat is not ready`; the
   initial prompt was lost during hydration. The later successful paid response
   required waiting and refilling. Readiness must match controller admission, and
   draft preservation must not leak text between sessions or cause duplicate sends.
2. **Post-close kernel target retention:** fresh full E2E case 1 (response-reader
   cancellation) passed runtime assertions but left a Chrome kernel target visible
   through 34 observations across the 15-second deadline and a post-failure capture.
   Earlier eventual disappearance/remaining-only passes do not erase this result.
   Distinguish actual live resources from delayed browser target observation;
   simply increasing the deadline is not a causal repair.
3. Agent edit/tool/dependency-mutation workflows and repeated interrupted switches
   remain unqualified. One tiny model response is not acceptance of those workflows.
4. A hydration attributes mismatch including `caret-color: transparent` was logged;
   instrumentation is a possible, unproven cause. Do not describe the whole browser
   session as console-error-free.

## Baseline performance work: what translates

The measured baseline experiments are restricted candidates, not production
optimizations with general safety certification. Their timings cover different
workloads and **must not be added or multiplied into a combined expected gain**.

| Work | Observed baseline result | Port/integration assessment |
| --- | --- | --- |
| Retain installed dependencies, kernel and Vite disk cache; restart both services | Five switches per condition, ten passes: client median 32.153 → 15.456 s (51.9% shorter); driver-through-PDF median 35.560 → 19.071 s | Best first controlled integration candidate |
| Retain OpenCode process; evict/reacquire location; mount fresh controller/session | First pair 22.316 → 8.425 s; reversed-order confirmation 22.971 → 9.651 s; descriptive pooled medians 22.644 → 9.060 s | Worth preparing, but general remote drain/ref-release prerequisite remains |
| Retain running Vite | Safety review stopped before live execution | Not a demonstrated win; stopped-tree audits do not prove complete writer history |
| Direct hash optimization | Instrumented median improvement 6.55%, mean 2.53%, substantial order drift | Insufficient evidence to adopt; original hashing remains default |
| Payload pruning | 13.3% smaller benchmark payload without maps/native workspace binaries | Size result, not demonstrated general latency win; compatibility qualification limited |

Dependency-retention results include two complete installed-tree audits per switch:
12,305 entries, combined median 5.783 s. Avoided delivery was approximately 1.548 s;
most observed gain was service readiness. Retained kernel/cache/reopen/contention
effects were not independently isolated. One retention sample was slower than
reset. Small ordered cohorts are not a production SLA.

Prepared compressed VFS images, verified compressed delivery/download caching,
optional installed-tree verification/reuse, and incremental source replacement
already exist in the shared library. Single-kernel's normal UI does not enable the
installed-environment retention path and clears its roots first. Start by checking
what is already inherited; this is principally guarded integration/requalification,
not wholesale rewriting. Similar directional savings are plausible, not promised.

The later baseline OpenCode process-retention clients are not incorporated in the
single-kernel UI. Reuse avoids process launch/initial health setup but still repeats
activation/config/plugin/catalog checks and actual controller/session hydration.
Activation remains about 5–6 s, approximately 62% of the restricted warm transition.

### Why OpenCode process reuse is not generally safe yet

Pinned OpenCode 2.0.3 location eviction uses `RcMap.invalidate`: removing a key does
not join finalization if remote references remain. Same-key reacquisition can overlap
old services. Awaitable local chat disposal, an idle session, successful DELETE,
and absent debug key are **not remote reader/ref-release proof**.

Successful tests relied on exclusive, normally consumed, source-reviewed finite
handlers. They did not qualify cancelled/concurrent remote readers, arbitrary agent
execution, tool/PTY ownership, or arbitrary project replacement. Location identity
is directory plus optional workspace ID, not source generation. Persisted old chats
and unchanged ESM caches must not be mistaken for isolation/reinitialization. Plugin,
environment, dependency, runtime or directory changes may require restart.

The baseline also had a post-completion harness defect: referenced host children
prevented initiator exit and an outer 900-second timeout stopped the new hosts after
successful guest measurements. The `host.unref()` correction passed offline tests
but had no new live validation. Guest timings remain valid; the whole retention
protocol was not flawless. Single-kernel does not inherently repair either issue.

## Decision matrix

Decision: obtain reliable, faster real workspace switching while reducing runtime
coordination complexity, without mistaking bounded experiments for release readiness.

| Criterion | Harden baseline only | Promote single-kernel immediately | Continue gated single-kernel plus retention |
| --- | --- | --- | --- |
| Coordination complexity | Keeps separate FS/fetch authorities | Removes those boundaries | Same simplification with explicit lifecycle qualification |
| Switching speed | Restricted retention wins measured | No matched topology timing evidence | Requalifies existing opportunities under new topology |
| Reliability confidence | Known failures and bounded repairs | Readiness/close gaps unresolved | Requires repeated lifecycle, recovery and preservation passes |
| Compatibility | Existing feature set | LSP regression and parity gaps | Explicit supported scope, baseline fallback and staged promotion |
| Attribution | Does not evaluate consolidation | Conflates topology and incidental fixes | Holds UI/fixes/startup policy constant and varies retention separately |

Provisional choice: the third column. User subsequently authorized concrete
stability work and separate cached-artifact and OpenCode-retention subagents, then
isolated workspace-switch testing after the candidates are ready. This is not
authorization to push, deploy, promote default reuse, or overwrite existing evidence.

### User direction: retain OpenCode long term; evaluate a stable layout

The user explicitly wants to preserve long-term OpenCode process retention as a
performance goal, not abandon it because the current same-root eviction experiment
is blocked. They suggested keeping the server in a stable isolated subdirectory
that project replacement never touches. The final refactor decision should follow
hardening and practical comparisons, not precede them.

The server binary is already delivered separately at `/app/server.js`; server-path
stability alone does not fix location ownership tied to replaced `/workspace`.
The parent proposes a **hypothesis to test**, not a chosen production layout:
stable server/state plus distinct stable physical project directories per logical
workspace (for example `/workspace/projects/<id>`), with explicitly routed clients
and native sessions. Switch the active location/preview instead of destructively
replacing the same source path and evicting/reacquiring the same key each time.
A different logical ID over the same physical source path is not that isolation.

This could avoid one dangerous boundary while keeping the process warm. It does
not prove safe background refresh/plugin routing, global session/event isolation,
configuration changes, memory growth or eventual workspace deletion/eviction.
Retained old locations still need explicit ownership and bounded resource policy;
do not portray persistent directories as a substitute for finalizer joins.

Source feasibility agent `ses_f0c1d07d2ffeieeJXkjkkKVFc0` checks actual public
selective service lifecycle APIs, path/cwd/dependency/config/database constraints
and native routing, without changing active integration or runtime work. Intended
technical report: `2026-09-30-stable-opencode-workspace-source-feasibility.md`.
High-level design/decision remains parent/user-owned; no wholesale rewrite or
stable-layout benchmark has been performed.

## Active work authorized in the chat

These are work assignments at dispatch, **not completed repairs or acceptance**.
Each worker must return its own commits/tests/limitations; later reports should
append outcomes without retroactively promoting this snapshot.

| Workstream | Agent session | Ownership / intended report |
| --- | --- | --- |
| New-chat readiness and draft preservation | `ses_f0c72443cffehcvxDrj34e0Ire` | Chat source/tests; `2026-09-30-chat-readiness-draft-stability.md` |
| Post-close kernel-target retention | `ses_f0c71c461ffem2XwuJueuiJeKZ` | Editable runtime source/tests; proposed toolkit harness changes returned for coordination; `2026-09-30-single-kernel-close-retention-stability.md` |
| Guarded cached-artifact/environment retention | `ses_f0c70fb06ffelu8471ELiEmCMX` | App-level opt-in integration/tests; restart both services; `2026-09-30-single-kernel-cached-artifact-retention.md` |
| OpenCode process-retention prerequisite and bounded pilot | `ses_f0c703804ffe3taIYD8CvLNjDG` | New experiment-only files/contracts; no shared app/chat/runtime edits; `2026-09-30-single-kernel-opencode-retention-preparation.md` |

Toolkit work directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`.
Runtime work directory:
`/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel`.
Baseline reference directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit` (read-only).

Workers have been directed to use deterministic/offline tests and isolated builds
first; preserve live user browser/server/origin/storage and frozen artifacts;
perform no paid model calls; commit only their own files and do not push. Browser
work requires parent coordination and fresh owned origins, not the exploration
origin. No parallel browser-owner contention. Cache/process reuse stay separate;
unknown/incompatible state must fail safely or use a qualified conservative path.

### Explicit user requirement: live runs and manual QA for every candidate

The user subsequently required live runs/manual QA, suggested Browser Control, and
requested headless coverage where practical. Offline passes are preparation, not
the final deliverable. Each of the four workstreams must receive relevant isolated
live qualification; a preparation-only or blocked reuse candidate must be labelled
as such, rather than passed by analogy with the baseline.

- Use deterministic unit/headless runtime tests for lifecycle order, fault injection
  and repeated regression coverage. Node/headless worker tests do not qualify
  browser OPFS, Service Worker routing or Chrome target removal.
- Where the consumer/tooling supports it, use isolated headless Chromium against
  an actual served application for repeatable browser regression/stress tests.
  Record browser/version/origin and do not equate that with visible-profile QA.
- Use the Bun-backed `browser-control` **CLI**, never its MCP server, for deliberate
  visible-browser inspect/act/verify QA. Verify ordinary pointer/keyboard interactions,
  disabled/readiness states, drafts, session/model controls, preview HMR and recovery;
  do not substitute forced clicks or synthetic success for usable interaction.
- Prepare/freeze candidates first. Parent coordinates a single browser owner and
  fresh test origins after sibling changes are ready; workers must not independently
  run conflicting visible-browser tests. Do not run competing stress jobs during
  performance measurements. The existing exploration workspace remains untouched.
- Retain screenshots/journals, exact served artifact identities, independent state
  checks, failure observations and joined guest/host cleanup receipts. Record both
  headless and manual/visible outcomes, including limitations and unrun cases.
- Live model calls are not implicitly authorized by the QA request. Use deterministic
  local fixtures/request counters for send admission and preservation when possible;
  any paid/tool-enabled inference needs separate bounded authorization.

After individual qualification, run a combined workspace-switch stress test against
the integrated frozen candidate. Do not report “everything accepted” before these
live checks and their cleanup/preservation assertions are complete.

### Follow-up: cached-artifact preparation returned; safe integration still blocked

The cached-artifact agent completed commits `09cfe47` and `d5f165e`, without push.
Its [detailed report](2026-09-30-single-kernel-cached-artifact-retention.md) records:

- Source snapshots now exclude managed backend archives/cache receipts, alongside
  dependencies. Legacy saved images containing those paths fail validation before
  mutation; this is not a silent migration and needs live compatibility QA.
- A byte-exact dependency/config admission helper was added but remains unwired.
  It is not complete runtime/artifact/config-transitive-input safety proof.
- Deterministic regression exposed fallback delivery beginning before an audit
  output reader settled. A resolved stop alone was insufficient to establish joined
  reader ownership. Existing installed-reuse also deletes Vite disk caches and
  needs supported cache-preserving before/after audits, not an ignored subtree.
- 38 offline tests/320 assertions passed; app-only external-library bundle and
  standalone admission typecheck passed. Full consumer staging was blocked by
  missing built toolkit packages. No live browser/headless-browser/manual/stress
  acceptance, service operation or speedup measurement occurred.
- Conservative defaults, pending recovery journal and native session restoration
  remain; both services restart and the existing kernel remains retained.

The parent assigned a **new shared-library prerequisite agent**,
`ses_f0c647241ffe7bz6oIZ122tv6C`, to repair joined audit cancellation/reader/exit
ownership and prepare a supported opt-in cache-preserving audit contract. Its
intended report is `2026-09-30-cached-retention-library-prerequisites.md`. It owns
the relevant workspace library helpers/tests, not app retention wiring or sibling
chat/runtime work. App integration and live off/on testing remain gated on that
repair and review. This is continuation of the authorized perf work, not acceptance
of retention-on or permission to skip manual/live QA.

### Follow-up: chat candidate ready; close retention remains a bounded unknown

- Chat commit `55ae98c72437d27ff683c65dbb79f3b3f9e31572` independently reproduced
  both original behaviors against the baseline: Send enabled during creation despite
  controller rejection, and server ID assignment remounting Composer/erasing early
  text. The candidate publishes mutation readiness and keeps a stable logical draft
  identity, with explicit retry/session isolation and no queued sends. 62 targeted
  tests passed; one repeated run encountered an inherited handshake-disposal timing
  failure and a subsequent rerun passed. Full package qualification remains blocked
  by missing workspace peers. See [candidate report](2026-09-30-chat-readiness-draft-stability.md).
- New independent QA agent `ses_f0c5f766cffeLB1OeryKn5xwEp` has exclusive visible
  Browser Control CLI ownership for the fresh, nonpersistent, no-provider-call chat
  stub lab. It must verify ordinary controls/drafts/counters and attempt separate
  headless real-browser coverage. Whole-app integration is still pending; an agent
  assignment is not a live pass. Intended report: `2026-09-30-chat-readiness-live-qa.md`.
- Runtime close investigation commit `516ef37` added offline characterizations and
  an observation fixture, not production runtime changes; toolkit report commit
  `3b42a10` records **bounded unknown**, not a leak fix or stale-CDP conclusion.
  The existing evidence proves failed target disappearance but lacks terminate-call
  and post-close ownership/liveness observations. Three offline close paths and
  termination negative control passed; full runtime contracts still stop on
  `markAsUncloneable is not a function`. See [close investigation](2026-09-30-single-kernel-close-retention-stability.md).
- An unchanged-runtime frozen control is prepared at
  `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-close-retention-control-2026-09-30`.
  Its fresh browser run is queued **after chat lab QA releases browser ownership**:
  observe native termination, actual Web Locks and target census together for case 1,
  without changing the 15-second bound. No server/browser run has occurred for this
  control. Cases 2–9/full combined acceptance remain unqualified.

### Follow-up: OpenCode preparation returned; real-server foundation queued

Commit `9e09cb8` added dedicated restrictive prerequisite gates and an actual-
controller qualification entrypoint; 12 offline tests/99 assertions and targeted
strict typecheck passed. See [preparation report](2026-09-30-single-kernel-opencode-retention-preparation.md).
The mounted test uses mock transport/ownership/codec callbacks. There is **no
served real-server qualification, eviction, switch, process-retention integration,
or new speedup result**. General remote release remains unproved; preparation
receipts keep remote proof/eviction authorization/retention acceptance false.

The prerequisite gate permits only exclusive serial normally consumed reviewed
finite routes and fails closed on cancellation, concurrency, execution/tool/PTY
or identity mismatch. Actual controller bootstrap may overlap finite reads, so
mounted plumbing success does not imply that this separate serial gate was met.
The final test history includes seven test-assertion deadlock timeouts and a corrected
location-routing failure; these were not live server failures or excluded live samples.

New agent `ses_f0c5a466bffeh5lnJia894WoOY` is staging a runnable real pinned-server
qualification foundation with genuine codec parity, raw evidence and source/session
identity checks, using fresh output only. Intended report:
`2026-09-30-single-kernel-opencode-live-qualification-staging.md`. It is not authorized
to evict or enable retention. Browser QA follows the current chat lab and queued
close diagnostic under one owner; an actual restricted A→B retention attempt needs
separate gate review, and general reuse still requires remote ownership guarantees.

### Follow-up: independent chat live QA failed; repair and close diagnostic assigned

Independent QA commit `d8f2a49` records **no passing live cohort**. See
[live QA report](2026-09-30-chat-readiness-live-qa.md). Frozen lab JS SHA-256 was
`332455a344edaa030ea72757de4dd2495a7c823b504f75ae70e472e82f5345ec`.

- Visible Browser Control v0.8.2 session `cosmic-sparrow-334` verified the old draft
  and zero prompts, then ordinary locator inspection failed with
  `target.addEventListener is not a function`. The lab's classic-script bundle
  overwrote native global `addEventListener`; no selector/global repair bypass was
  used to report a pass.
- Independent headless Brave Chromium 154.0.8037.58 / Playwright Core 1.62.1
  completed zero checkpoints and failed its first assertion. Immediate trusted
  New chat + typing initially appended new text to the old `ses1` draft while Ready;
  the later pending-creation capture showed a new logical draft with empty text.
  Actual admission timing versus event/test scheduling requires diagnosis, not a
  waiting adjustment that removes the immediate-typing acceptance condition.
- Both cohorts stopped on first failure. Zero prompts/provider calls/persistent
  storage; only owned resources were closed and their absence verified. Evidence:
  `/Users/kkrausse/Documents/opencode/chat-readiness-qa-20260930/`.
- New repair agent `ses_f0c51d9a6ffe1iNG7JTdE7bXqy` owns chat admission/draft
  timing and module-isolated lab bundling, with a new independent live run required
  after its candidate is frozen. Intended report:
  `2026-09-30-chat-readiness-live-failure-repair.md`.
- Chat QA released browser ownership. New diagnostic agent
  `ses_f0c510edbffeptJkqc3uMjERXB` now has exclusive visible Browser Control CLI
  ownership for the unchanged-runtime close control, case 1 first and separate
  abort-before-headers control only after a pass. It must correlate native terminate,
  Web Locks and Chrome targets within the original bound. Intended report:
  `2026-09-30-single-kernel-close-retention-live-qa.md`. Assignment is not acceptance.

### Follow-up: close control passes; repaired chat enters independent QA

- Live close report commit `f09b1b9` records case 1,0 run once on unchanged `e35eab4`:
  native terminate called/returned once, observed live ownership, then zero owner
  locks/kernel/guest targets in all 91 original-window samples (first empty sample
  149 ms after joined close). Observer dropped/query failures were zero; all 9,588
  frozen inputs reverified before/after. This is **no retention reproduced**, not
  a causal repair or historical stale-target/leak classification. See
  [close live QA](2026-09-30-single-kernel-close-retention-live-qa.md).
- That run used the existing extension-connected Brave profile and a new owned
  origin/session, not a pristine profile. Dark Reader inserted a session-storage
  marker; strict zero-storage preflight failed and the stated marker was retained.
  A full-page screenshot timeout was recorded; bounded viewport/manual inspection
  succeeded. Case 0, headless/full-suite/performance checks were not run. Exact
  owned server/session/PID/port absence was verified and browser ownership released.
- Chat repair code commit `691cd5aa0880349968773047402adec0bfeb16df`, report
  `6712c2b`, causally reproduced both prior failures, then moved creation/selection
  admission synchronously ahead of scheduled work and isolated lab declarations
  in an IIFE. 66 targeted tests/325 assertions and targeted typecheck/build passed;
  package peers and inherited disposal flake remain limitations. See
  [repair report](2026-09-30-chat-readiness-live-failure-repair.md).
- Frozen chat staging:
  `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/chat-readiness-repair-0nXBtN/`,
  bundle SHA-256 `16ae8532768e09441c458b07d255b9b88cabfd3af0a22a1b2ca3c134e9d83bb4`.
  New independent QA agent `ses_f0c40f179ffeFwTifmd7zRF5nu` now owns the visible
  Browser Control slot, followed by serialized headless coverage and separately
  labelled same-view controller-switch QA where supported. Immediate typing may
  not wait for pending. Intended report: `2026-09-30-chat-readiness-repair-live-qa.md`.
  This candidate remains **live pending** until that report; original failed cohorts
  are unchanged. Full workspace integration/stress and cases 0–9 still need testing.

### Follow-up: real-server qualification staged; delivered server identity differs

Source `874e759`, report `d9ddab4` prepared an isolated executable real-server
codec/mounted-controller foundation at
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-f50f5e6f-037b-48ac-9a14-5542b35c9e9a`.
See [staging report](2026-09-30-single-kernel-opencode-live-qualification-staging.md).

- Actual frozen SK server SHA-256:
  `648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5`;
  baseline reviewed server SHA-256:
  `1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929`.
  Both reverified; no replacement of frozen server bytes. Executable codecs now
  come from **actual delivered SK bytes**, not a mocked or baseline substitute.
- 9,588 frozen files verified; isolated library builds/declarations and strict
  consumer typecheck passed; 29 tests/138 assertions passed, including actual
  pinned-codec fixture parity. No browser, host/guest server, session or retention
  run occurred. `retentionAccepted:false`, `remoteZeroRef:false` remain.
- The stage binds committed source `874e759` with chat ancestry `55ae98c`; it must
  not be presented as qualification of later chat repair `691cd5a`. Rendered
  actual-controller admission is not ChatView/composer or workspace-switch QA.
- Live foundation QA is queued behind current repaired-chat QA; it launches A0
  only, never evicts or replaces source, and must join both guest and host cleanup.
  Headless coverage is not supplied by the installed Browser Control CLI; no
  unsupported headless-launch option is invented.
- New source-audit agent `ses_f0c34640affedR9vsO0BAkcN4H` will review exact
  delivered SK lifetime/route/finalizer semantics before any retention gate review.
  Intended report: `2026-09-30-delivered-opencode-retention-lifetime-audit.md`.
  This is source review only, no browser or speculative server changes.

The updated global guidance prohibits generic unit-test scaffolding: new tests
must protect a concrete observed failure/regression or true up an external fixture
contract. Existing reproduced chat/ownership failures and pinned-codec fixtures
meet that criterion; subsequent work must preserve this focus.

### Follow-up: repaired chat passes visible/headless; optional harness still blocked

Independent QA commit `6aa7fd8` records **bounded repaired-lab acceptance** for
candidate `691cd5aa`, served at fresh origin 57539 with the required frozen hashes.
See [repair live QA](2026-09-30-chat-readiness-repair-live-qa.md).

- Visible Browser Control QA captured ten gates with no failed assertion: native
  globals/locators, immediate New chat typing, creation/hydration admission and
  Enter blocking, preserved draft, exactly one explicit intended prompt, retry,
  late-result abandonment and draft revisits. Prompt records were local fixture
  counters, not inference. A deliberately induced creation-error banner persisted
  on First; clearing that banner was not asserted, so no such lifecycle pass is claimed.
- Unchanged independent headless script passed six checkpoints/nine captures with
  zero errors in Brave Chromium 154 / Playwright Core 1.62.1. Separate-page baseline
  does not prove same-view controller isolation. Screenshots were manually read.
- Optional same-view wrapper at separate origin 58215 stopped after two passed
  guards/one failed overstrong textarea-identity assertion. It also broadly held
  plugin activation, blocking readiness. These are documented QA-harness defects,
  not proved production defects or accepted same-view/model-mutation coverage.
  All owned servers/PIDs/ports/sessions/headless resources were joined/absent;
  browser ownership released. Whole packaged app/disposal flake remain unqualified.
- New QA-only harness repair agent `ses_f0c2f7248ffeD71LJJ6r2ALZbi` prepares a
  distinct correct controller-prop-switch/model-route fixture offline; intended
  report `2026-09-30-controller-swap-qa-harness-repair.md`. Fresh independent live
  coverage remains required. It may not patch production behavior to satisfy the test.
- New real-server foundation QA agent `ses_f0c3017fcffemJ1wewPHKzo46p` now has
  exclusive visible Browser Control ownership for the staged A0-only OpenCode
  qualification. Intended report `2026-09-30-single-kernel-opencode-foundation-live-qa.md`.
  No eviction/source replacement/retention transition is authorized in that cohort.

### Follow-up: cache library ownership/audits repaired; app integration assigned

Commit `d1f60e4` fixes the concrete inherited early ownership-release defect:
reader/exit/stop settlement must join, cancellation promptly requests stop, and
`EnvironmentOwnershipError` forbids fallback when cleanup is unproved. Regression
fails against the inherited runner. Supported bounded stopped-tree cache audits
and explicit `preparedApps` cache-preservation policy are exported; defaults stay
unchanged and proven misses remove explicitly scoped stale caches before redelivery.
See [library report](2026-09-30-cached-retention-library-prerequisites.md).

Validation: 36 focused tests/172 assertions, two isolated built-subpath consumer
tests/20 assertions, built-export smoke and targeted typechecks passed. Full package
builds, actual runtime shutdown fidelity and lstat-safe helper-bootstrap installation
remain unqualified. Library caller attestation `servicesStopped:true` is not a runtime
ownership receipt. No browser, server, app retention or speedup claim occurred.

New agent `ses_f0c2c2416ffeRDntC3dfCqgMKR` owns guarded default-off app integration
and narrowly necessary bootstrap-fence work, with complete compatibility admission,
durable journal ordering, joined stopped services, tools-only before/replacement/after
audits, equal cache digests and owned conservative recovery. Intended report:
`2026-09-30-single-kernel-cached-switch-integration.md`. It stages isolated full built
consumers/frozen off-on candidates but cannot start browser/server work until parent
assigns the slot. Manual/headless live switching, timings and stress remain mandatory;
no flag that silently performs no safe retention may be presented as an on treatment.

### Follow-up: delivered lifetime constraints strengthen; first foundation QA fails

Source audit `4b3738d` verifies exact actual-648 and baseline-1df bytes/provenance.
Critical RcMap/location/request/plugin snippets are identical: zero-ref joined
eviction survives conditionally; positive-ref invalidation/same-key overlap remains.
**Actual 648 enables `models.fetch:true`; baseline disables it.** Global repeating
refresh/cache writes/events and location-plugin reload callbacks invalidate the old
blanket `backgroundWork:false` admission. Serial finite-route reasoning is not
concurrent mounted hydration/SSE proof. Creation routes through payload location,
and session reads require exact owned-root IDs. See
[delivered lifetime audit](2026-09-30-delivered-opencode-retention-lifetime-audit.md).
An A→B retention attempt remains blocked on actual mounted qualification, refresh
owner resolution and exact-delivered core/service acquisition/finalizer evidence;
the remote generation/ref/finalizer receipt is still absent. Cached-artifact reuse
is the nearer-term performance target, not a blind baseline process-reuse port.

Foundation live report `b5daa94`, clarification `53948b5`, records **one failed
cohort, no retry**, on stage/source `874e759`, fresh origin 60643:

- All 9,588 frozen files/63 staged entries verified before/after. Eleven raw finite
  responses passed actual SK pinned-codec parity, independently re-executed offline.
- Fresh-root attempt failed the local guard `Unexpected root create settings`;
  no root selected/manual idle admission/hydration acceptance. Pinned SDK absent
  optional root settings serialize as null; the location-only guard rejected them.
  Exact rejected request bytes were not retained, a stated evidence gap.
- Failed state/errors/raw responses/screenshot/journal/partial network retained.
  Owned page destruction/forced host SIGTERM, host exit 143/initiator exit 1 and
  PID/port/session absence are **failure cleanup, not clean guest/host acceptance**.
  Browser slot released. Global refresh/catalog observations/network limits are
  cited accurately; no absent-background-work or remote-release pass is claimed.

See [foundation live failure](2026-09-30-single-kernel-opencode-foundation-live-qa.md).
New repair agent `ses_f0c21308affegMgHc8w0gKkQdN` owns pinned-schema root admission,
request-byte capture before semantic validation and guarded failure cleanup, with
new frozen source/stage and independent live cohort required. Intended report:
`2026-09-30-single-kernel-opencode-root-qualification-repair.md`. Known null absence
may be accepted only per the actual schema; non-null inheritance/unknown inputs
remain rejected. This is a concrete harness/fixture repair, not a runtime or
retention result. No new browser/server run is authorized for that repair agent.

### Follow-up: cached integration finds endpoint ownership gap; swap QA ready

App integration commits `3a34772`/`93b8a6b` did **not** ship retention-on or a no-op
flag. Public committed-e35 endpoint characterization shows `Endpoint.closed` and
fetch rejection resolving before asynchronous upload cancellation joins; stream
cleanup swallows cancellation failure and runtime stop exposes no equivalent join.
This is a supported streaming-input counterexample, **not a live ordinary-TODO-JSON
overlap claim**. Library audit joins/kernel inventory alone cannot prove that owner
finished. See [integration report](2026-09-30-single-kernel-cached-switch-integration.md).

Full isolated off-only consumer build/declarations/strict check passed; existing
focused suites passed 59 tests/297 assertions. Stage:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/cached-switch-consumer-MGBmBw`.
No safe on candidate/matched pair/live run/timing exists. The lstat-safe helper
bootstrap fence also still needs proof after joined shutdown.

New owner-repair agent `ses_f0c1a168effeok6uYJrpnkV9Mi` owns causal host-SDK endpoint/
stream joins and supported toolkit runtime shutdown propagation, retaining failures
and withholding fallback when cleanup is uncertain. Intended report:
`2026-09-30-endpoint-upload-shutdown-ownership-repair.md`. It is offline-only until
parent assigns a fresh matching candidate's live QA; old e35 receipts cannot be
relabelled repaired. Defaults/journal/source/native session ordering remain unchanged.

QA-only repaired controller-switch harness commit `e1048ed` passed offline build/
strict check and one concrete regression/21 assertions. It checks stable outer
ChatView (child composer may remount), correct empty A return, controller-isolated
text, and exact session-model POST holds without blocking plugin activation.
See [harness repair](2026-09-30-controller-swap-qa-harness-repair.md). Frozen handoff:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/controller-swap-repaired-46MQpb/frozen-final`.
New independent QA agent `ses_f0c19439effe3pvL2PjB06ciX0` now owns the visible CLI
slot, then serialized headless coverage where practical. Intended report:
`2026-09-30-controller-swap-model-live-qa.md`. That assignment is not acceptance.

### Follow-up: same-view isolation observed; model oracle error stops cohort

QA report commit `63dc19a` records three visible checkpoints/ten guards passing,
then one agent-authored assertion failure, not accepted model coverage. Both
controllers reached readiness; A→B→A discarded composer-local drafts without text
crossing controllers, and the actual outer ChatView root stayed identical with
one Profiler mount. See [model QA](2026-09-30-controller-swap-model-live-qa.md).

The actual held model body was `{"model":{"id":"m2","providerID":"p"}}`;
the oracle required `providerID` before `id` via string comparison. The same exact
semantic fields/values were correct. Subsequent post-failure pending/text/disabled
control observations are retained diagnostics, **not completed release/reject/Enter/
send checkpoints**. Headless was not run. Exact frozen hashes/screenshots/journal
and owned server/session/PID/port cleanup were retained; browser slot released.

A separately authorized fresh cohort uses the same frozen candidate/harness but
checks exact JSON keys/types/values semantically, preserving raw body bytes. All
other assertions remain, and no production source is changed. The same independent
QA agent `ses_f0c19439effe3pvL2PjB06ciX0` resumes because this is a small concrete
oracle correction with shared context; it again owns the exclusive visible slot,
followed by headless only after a visible pass. Intended report:
`2026-09-30-controller-swap-model-live-qa-followup.md`. The failed original cohort
remains failed; no result is replayed/relabelled into green.

### Follow-up: stable-root feasibility supports a bounded alternative experiment

Source-only report commit `7aa5cf2` confirms public `stopService('vite')` already
expresses selective preview shutdown without stopping retained OpenCode. Distinct
stable physical project directories avoid same-key eviction/reacquisition at switch
time; stable server directory alone does not. See
[technical feasibility](2026-09-30-stable-opencode-workspace-source-feasibility.md).

Actual integration gaps include fixed `/workspace` recipes, chat controller caching
by Service, tool cwd defaults and missing enforced session/client ownership. Global
ModelsDev refresh reaches retained locations; no-inference does not prove inactivity
or drain. Process continuity requires execution-object identity, health PID,
listener generation and host-owner evidence together; public Execution lacks PID/
execId. No source/assets/tests/runtime execution changed in that investigation.

New dedicated toy-preparation agent `ses_f0c0afefdffeLvuXohD76AIZn5` prepares two
unchanged physical roots, one server delivery/start, finite fenced location requests
and optional supported selective preview restart. It must retain raw actual-codec,
source/route-epoch/continuity evidence; no eviction/SSE/native chat/inference/tool
execution, no changed production layout. Background-owner assumptions remain
explicit, and no old root may be destructively replaced. Intended report:
`2026-09-30-stable-root-opencode-toy-preparation.md`. It is offline-only until parent
reviews the bounded scope and assigns independent live QA after current hardening.
This tests the user's long-term retention direction without choosing the final
refactor or claiming full workspace/session/background safety.

### Follow-up: pinned root repair frozen; independent live qualification queued

Source commits `48d0507`, `20b505c`, `6f88410` and report `a6e17ac` repair the
concrete foundation null-settings guard and rejected-body evidence gap. Actual
pinned SDK/request-schema serialization qualifies only six known absent settings
as null; unknown/non-null inheritance and ambiguous location/duplicate keys remain
rejected. All attempted request bytes are preserved before admission, finite
responses before assertions, and session reads bind to the verified fresh root.
See [root repair](2026-09-30-single-kernel-opencode-root-qualification-repair.md).

Guarded failed-guest EOF/reader/exit/zero-work/workspace-close cleanup is distinctly
labelled; its `/failure-host-join` leaves initiator exit nonzero, never turns failure
into acceptance. Unproved cleanup cannot join or start a replacement. Existing
forced-failure cleanup and missing historical POST bytes are not retroactively repaired.

Final runnable stage:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-fe10b82e-932f-40ff-b249-171bc7c8cdbf`.
Source is `6f88410877d1027bb5fb7bbd9851a82de431356b`, consumer hash
`1b4e7e5a98b586033a08691cac9f74833d536cf3c8a9a64343d2bf175e1878d7`;
actual server remains 648 and runtime e35. Includes `691cd5a`/`d1f60e4`, excludes
later endpoint/lifecycle repair work. Isolated build/declarations/strict check and
21 tests/85 assertions passed from committed snapshot; 9,588 frozen inputs/66
stage entries verified. No browser/server run occurred. Independent A0 live QA
is queued after the current controller/model cohort releases ownership; this is
not the repair agent's authorization to launch. Global refresh/remote-finalizer
gaps and `retentionAccepted:false`/`remoteZeroRef:false` remain unchanged.

### Follow-up: model observer issue, shared-config toy scope, endpoint joins ready

Model follow-up `8cb984b` passed its six semantic-oracle checks and six initial
visible guards, then failed its capture helper before typing/actions: it queried
Model via accessible roles while Session & model was legitimately collapsed.
Zero completed checkpoints/headless runs; old partial `63dc19a` observations are
not relabelled. See [observer failure](2026-09-30-controller-swap-model-live-qa-followup.md).
Owned cleanup/slot release verified. New independent QA agent
`ses_f0bfd7b17ffefehZqFUJ1N3FsY` now owns visible CLI QA, with observation safe for
collapsed settings and action-time role checks only after trusted expansion.
Intended report: `2026-09-30-controller-model-complete-live-qa.md`. Production and
frozen fixture bytes remain unchanged; old failed runner/evidence remain preserved.

Stable-root toy preflight commit `6184166` found actual 648's `config.project:false`
and token-free virtual config mean immutable global inputs cannot yield root-varying
GET config bytes. No runnable/live toy was produced. See
[initial toy blocker](2026-09-30-stable-root-opencode-toy-preparation.md).
**Parent decision:** retain the same server artifact/global config and permit equal
config responses; prove distinct filesystem roots and independently observable actual
server location routing instead. Filesystem markers alone do not prove server context,
and shared project IDs/worktrees cannot be passed off as distinct routing. Agent
`ses_f0c0afefdffeLvuXohD76AIZn5` resumes this explicitly revised bounded scope;
intended report `2026-09-30-stable-root-shared-config-toy-preparation.md`. No new
server/config identity, eviction, native chat or inference was authorized.

Endpoint owner source commits runtime `a079153`/final `724909b`, toolkit `7713686`,
report `ec77bbc`, implemented required `Endpoint.settled` independently of prompt
admission `closed`, joining owned source read/cancel work and retaining failures.
Runtime/controller shutdown awaits receipts, preserves attachment on rejection and
blocks replacement. Reentrant source pull correction is included in the final build.
Eight endpoint cases, 25 toolkit tests, existing close/single-kernel/verify-node and
VM-import passed; broad contracts still fail on unrelated `markAsUncloneable` under
Node 24.7.0. See [endpoint repair](2026-09-30-endpoint-upload-shutdown-ownership-repair.md).

Final committed SDK/library/off-only app stage:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/endpoint-repair-frozen-H0Z3JO`.
New SDK hash `d7d63f2784a797340375d7c4500b232512dea6f6639ecb0eeb28dc2a674ac919`;
worker/native/protocol e35 assets explicitly reused, not relabelled a rebuilt runtime.
Old SDK endpoints lacking the receipt are rejected by new consumers. No browser/
server/storage mutation, live ownership proof or cache-on qualification occurred.

Cache-app agent `ses_f0c2c2416ffeRDntC3dfCqgMKR` resumes default-off integration,
using matching new SDK/source archives, safe helper-bootstrap diagnostics, full
compatibility/journal/native/session ordering and bounded cache audits; intended
report `2026-09-30-cached-switch-post-endpoint-integration.md`.
New independent fixture-preparation agent `ses_f0bf852c9ffeRYIMFZF5DVK5xV` stages
held/rejected streaming-source browser ownership tests (actual public built SDK/
library; real guest path where possible), with manual/headless QA pending parent
slot. Intended report `2026-09-30-endpoint-owner-browser-qa-preparation.md`.
All preparation remains offline while model QA owns the browser. Narrow browser
library fixtures must not be presented as whole-guest/switch qualification.

### Follow-up: visible model pass, prepared fixtures and PID-egress repair

Controller/model QA commits `eae659c`/`dfc3a7e` report a visible local-fixture pass:
9 checkpoints/91 guards, stable outer ChatView, isolated drafts, pending controls,
Enter suppression, release/rejection recovery and exactly one intended A/ses1 Send.
A holds/releases/rejects/prompts were 2/1/1/1, unexpected writes zero; B stayed
unchanged. Headless stopped after 3 checkpoints/21 guards at its first model-hold
assertion and used Playwright 1.63.0 rather than requested 1.62.1. Combined acceptance
is incomplete, and no production regression is inferred from that cohort.
See [complete model QA](2026-09-30-controller-model-complete-live-qa.md).

Root repair QA `29f3db6` failed browser setup: it attempted execution in a nonexistent
named CLI session. No page, Start click, guest, native root or finite codec response
was observed. All frozen inputs verified before/after; owned host-only shutdown
joined outputs and verified PID/listener absence, not normal guest lifecycle proof.
The stage's origin receipt now prevents reuse as a fresh runnable cohort. See
[root setup failure](2026-09-30-opencode-root-repair-live-qa.md).

Shared-config stable-root toy source `653bee9`/report `3fbe8b7` is runnable-prepared,
not executed. Stage:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-stable-opencode-91f64fd6-4875-4412-a9f9-17371316f930`.
Five actual-648 codec fixtures and strict builds passed; proposed A0→B→A evidence
uses unchanged physical roots, actual read-only server location keys and combined
execution/PID/listener/host continuity. Global refresh remains owned and undrained.
See [shared-config toy](2026-09-30-stable-root-shared-config-toy-preparation.md).

Endpoint browser fixture commits `6ecf321`/`ff0107a`/`96a4d9f`/`68c5200` (report
included in concurrent `48b96a7`) prepared six release/reject/reentrant runtime/
controller cases using real workspace/HTTP guest and matching 724/771 assets.
It has not run live and does not automatically qualify later repaired assets.
Stage: `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/sk-endpoint-owner-qa-bL9deI`.
See [endpoint fixture preparation](2026-09-30-endpoint-owner-browser-qa-preparation.md).

Post-endpoint cache integration `a66d365`/`ba16454` exposed separate guest-egress
ownership: zero PIDs while one fetch remained active and another queued, later
dispatching and writing/pinning scratch bodies. This was a controlled protocol
counterexample, not observed project/Vite-cache corruption or live TODO overlap.
See [post-endpoint blocker](2026-09-30-cached-switch-post-endpoint-integration.md).

PID-egress repair runtime `33fa135`, toolkit `d0eec346`, report `5038980` closes
dead-PID admission and joins tracked backend/body-write/rollback/publication work.
Shared requests are cancelled only after their last live owner exits. Abort-ignoring
work must actually settle; public exit carries cleanup failures, stop rejects and
runtime attachment remains retained. Historical sections were identical in baseline
`e998de6` and e35, so this is not established as a single-kernel-only defect.
See [PID-egress repair](2026-09-30-pid-egress-cleanup-repair.md).

Focused regressions, 26 toolkit tests/98 assertions, full-off consumer/declarations,
single-kernel/verify-node and selected contracts passed. Full contracts still stop
at the known `markAsUncloneable` gap. SDK/workers/libraries were built from isolated
committed archives; native inputs and Wasm provenance verified and reused, not rebuilt.
Candidate:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/kernel-egress-repair-3GsF7d/candidate/`,
version `3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.
Browser qualification remains false.

Independent agent `ses_f0bb96551ffeDRP5f7QzZaMgm0` now owns the visible CLI slot for
new matching real-worker/guest egress QA; intended report
`2026-09-30-pid-egress-browser-qa.md`. It must create/verify its named CLI session
before page operations and preserve any failed cohort. Cache integration agent
`ses_f0c2c2416ffeRDntC3dfCqgMKR` resumes offline admission review against that candidate;
intended report `2026-09-30-cached-switch-post-egress-integration.md`. Neither
assignment qualifies all RPC/background ownership, cache-on switching or retention.

### Follow-up: browser egress scope narrowed to supported native transport

Preparation report `7b36dcf` verified 111 candidate files, 758 source files, 40
built assets, 37 reused native outputs, archives and provenance for exact
33fa135/d0eec346 assets. Genuine guest OP_FETCH_ASYNC is available, but browser
workers hard-wire native fetch: no supported callback can inject abort-ignoring
backend continuations or rollback failures. No host, guest or browser was started;
visible/headless counts remain 0/0 and the exclusive slot was released unused.
See [browser preparation boundary](2026-09-30-pid-egress-browser-qa.md).

**Parent scope correction:** this blocks adversarial injection, not all browser
qualification. The same agent resumes with a new distinct supported-native-fetch
cohort: actual guest fetch, native transport/body cancellation, public stop receipts,
queued suppression/shared-owner survival where supported observability permits.
Abort-ignoring/rollback failures remain offline regression evidence and cannot be
claimed live. Missing private pin/queue instrumentation must be reported as a limit,
not replaced by server-only inference or used to block every supported live check.
The candidate remains unchanged. Intended report:
`2026-09-30-pid-egress-native-fetch-live-qa.md`; agent
`ses_f0bb96551ffeDRP5f7QzZaMgm0` again owns the sole visible CLI slot. No cache-on,
full-workspace or general remote-drain acceptance follows from this bounded cohort.

### Follow-up: lazy-loader cache admission blocker; prioritize integrated acceptance

Cache reassessment report `a8c8033` confirms repaired endpoint/PID-egress regressions
pass and all 111 candidate hashes match, but first-use shell tool loading remains
outside process cleanup. A controlled OP_SPAWN_ASYNC request holds tsgo vendor
delivery; after successful SDK stop/output joins, the real installer and Rust VFS
follow a planted `/bin` ancestor symlink and write two shims into the audited Vite
cache. No child is spawned after exit. This is a planted-tamper offline case, not
observed TODO/browser corruption. See
[post-egress cache blocker](2026-09-30-cached-switch-post-egress-integration.md).

Lazy loader admission/settlement/failure ownership or a separately proven narrow
destination exclusion is still required before admitting cache reuse. A sampled
zero PID/fetch count or one clean cache audit is not that receipt. No retention
flag, frozen off/on pair, new performance evidence or production workaround shipped.
Do not remove/repair unknown symlinks as an admission shortcut.

**Parent priority decision:** pause further cache-retention implementation and
repair assignments. Finish the already-running supported native-fetch browser
cohort, then qualify one matching conservative full-app candidate through original
acceptance and bounded switching/reload/failure recovery. Cache retention and
long-lived OpenCode reuse remain separate optimization tracks, not automatic
prerequisites for completing consolidated-kernel evaluation. This does not declare
conservative switching safe against the lazy-loader case: the unjoined loader is
an explicit limitation of any broader shutdown/source-replacement guarantee and
must be considered in integrated results and the final decision. No all-writer
quiescence or general stop-completion claim is justified by the repaired paths.

### Follow-up: guest-loopback fixture failure; integrated candidate preparation

Native-fetch visible cohort `267e01c` observed genuine candidate workers and guest
PID 1, but eleven requests addressed virtual guest `127.0.0.1` and failed with
ECONNREFUSED. Owned backend received zero requests. Native abort, stop joins,
queued suppression and pin/publication assertions were not reached; headless zero.
Forced page/session destruction and verified host/PID/listener absence are cleanup,
not acceptance. See [native-fetch cohort](2026-09-30-pid-egress-native-fetch-live-qa.md).

A new separately preserved cohort corrects the fixture to supported
`host.vivari.internal` routing, first requiring one token-qualified guest-to-owned-
backend round trip before any shutdown action. Candidate/production code unchanged;
prior failure is not replayed into green. Agent `ses_f0bb96551ffeDRP5f7QzZaMgm0`
again owns the exclusive visible slot. Intended report:
`2026-09-30-pid-egress-native-routing-followup.md`.

In parallel, offline agent `ses_f0bab2941ffeK6LyykN6Varirh` prepares one matching
conservative full-app frozen candidate and original acceptance commands, followed
by bounded workspace switching/reload/startup-failure recovery. No optimization
flags, new process topology or production changes are requested. Intended report:
`2026-09-30-conservative-full-app-acceptance-preparation.md`. Independent integrated
live QA follows browser-slot release; build preparation alone is not acceptance.

### Follow-up: genuine guest route passes; saturation fixture does not reach stop

Routing follow-up `8b58f12` proved guest PID 1 reached the token-owned backend via
`host.vivari.internal`, returned exact HTTP 200 payload and recorded actual syscall
30/OP_FETCH_ASYNC through real candidate workers. The held phase issued eleven
requests but only six held headers reached the server; no body/queue checkpoint
or stop action occurred before observer timeout. Same-origin HTTP/1 connection
contention is consistent with the observations, not a proven kernel failure.
Headless zero; source/78 consumer hashes verified; forced page cleanup explicitly
excluded from acceptance. See
[routing follow-up](2026-09-30-pid-egress-native-routing-followup.md).

Parent narrows the next distinct cohort to one held-header plus one open-body
request, avoiding control-origin saturation. Require genuine guest/backend events
before trusted Stop, then actual execution/runtime/output/workspace close joins
and unchanged source receipts. Pool saturation, shared-owner and adversarial cases
stay offline rather than gating this finite browser check. No production/candidate
change or deadline inflation. Agent `ses_f0bb96551ffeDRP5f7QzZaMgm0` retains the
exclusive visible slot for the newly authorized cohort; intended report:
`2026-09-30-pid-egress-minimal-stop-live-qa.md`. Full-app preparation proceeds offline.

## Next validation and stress-test sequence

After the first candidates are ready, commission separate test agents rather than
claiming the implementation agents' offline passes establish live acceptance:

1. **Close the concrete stability gaps.** Reproduce readiness/draft loss without
   inference; show rejected sends retain intended-session text and do not double
   submit. Establish whether case-1 close retention is live work or observation
   lag and demonstrate a causal repair or accurately bounded unresolved condition.
2. **Matched topology × dependency-retention comparison.** Run the same mounted
   UI/source/dependency inputs on baseline and single-kernel, retention off/on.
   Equalize applicable correctness fixes and startup order; use fresh isolated
   origins and counterbalanced/interleaved conditions. Keep actual usable preview
   and hydrated chat readiness inside the metric, including audits and cleanup.
   Report cold and warm times separately, failure counts, raw distributions,
   memory and worker/resource inventories. Do not infer p95/SLA from tiny cohorts.
3. **Workspace-switch stress/recovery testing.** Repeated A↔B transitions with exact
   source/binary/deletion markers, native hierarchy/history and model retention;
   reload during replacement, failed startup, retry and outgoing recovery. Check
   no resurrection/partial-state overwrite/cross-workspace chats. Predeclare counts,
   bounds and first-failure policy; retain failures rather than retrying to green.
4. **Realistic edit workflow.** Qualify file edits/additions/deletions, HMR and
   dependency/config changes followed by switching. Inference/tool calls require
   explicit bounded authorization, not an assumption based on the previous paid
   smoke prompt. Use deterministic fixtures where possible.
5. **Mixed-kernel responsiveness.** Exercise filesystem/compression/SQLite workload
   alongside streaming, cancellation, supervision and preview HMR. Measure tail
   delay/starvation; fewer worker boundaries may increase shared-loop contention.
6. **Broader OpenCode reuse only after remote ownership guarantees.** Establish
   admission freeze, cancellation/drain and remote lease/ref release. Verify
   restart fallback for unsupported mutations; then qualify mounted workspace
   switching with reuse. Do not enable retained Vite simply because audits pass.

Promotion requires repeated full applicable acceptance, preserved user/source/chat
state, understood cleanup, readiness/draft stability, a matched performance result
without unacceptable tail-latency/resource regression, explicit feature-scope
decisions, and reproducible matching artifact selection. Python editor LSP can be
an explicit scope exclusion if acceptable, not a silently claimed parity pass.

## Evidence index

Reports below retain detailed commands, hashes, receipts and run boundaries. This
document supplements them and does not relabel their outcomes.

### Single-kernel / UI evidence in this checkout

- [Original goal and boundaries](2026-09-30-single-kernel-fork-plan.md)
- [Independent consolidation audit](2026-09-30-single-kernel-independent-audit.md)
- [Same-version bounded working-fork criteria](2026-09-30-single-kernel-working-fork-e35eab4.md)
- [Original e35eab4 close-census failure](2026-09-30-single-kernel-e35eab4-attempt1.md)
- [Fresh full E2E failure, not superseded](2026-09-30-single-kernel-fresh-full-e2e-17ef8e3.md)
- [Preview attachment-loop follow-up](2026-09-30-single-kernel-live-wrapper-24c9042-verification.md)
- [Workspace implementation, snapshot/session limits](2026-09-30-todo-workspace-ui-handoff.md)
- [Workspace browser acceptance and earlier failures](2026-09-30-todo-workspace-browser-acceptance.md)
- [Sequential preview startup](2026-09-30-interactive-workspace-preview-startup.md)
- [Compiled model-picker styles](2026-09-30-model-picker-styles.md)
- [Healthy switch presentation](2026-09-30-workspace-switch-presentation.md)
- [Paid model acceptance, readiness race and final served identities](2026-09-30-zen-paid-browser-acceptance.md)

Historical exploration/handoff pages contain earlier host/model/source-panel state;
use chronological acceptance reports rather than assuming an old launch receipt
describes the final hot-swapped UI. Do not reuse retained user/evidence origins as
new test targets.

### Baseline follow-up evidence in the sibling checkout

- [Complete dependency/cache-retention timing recovery](../../../browser-agent-toolkit/docs/experiments/2026-09-30-retained-pair-evidence-recovery.md)
- [Mounted OpenCode restart/reuse comparison](../../../browser-agent-toolkit/docs/experiments/2026-09-30-opencode-matched-mounted-lifecycle.md)
- [Reversed-order confirmation and host-retention defect](../../../browser-agent-toolkit/docs/experiments/2026-09-30-opencode-counterbalanced-mounted-lifecycle.md)
- [OpenCode location reuse source/lifetime review](../../../browser-agent-toolkit/docs/experiments/2026-09-30-opencode-process-reuse-source-review.md)
- [Remote-reader-fence prerequisite](../../../browser-agent-toolkit/docs/experiments/2026-09-30-opencode-reader-fence-gated-pilot.md)
- [Retained-Vite safety stop](../../../browser-agent-toolkit/docs/experiments/2026-09-30-retained-vite-pilot-safety-stop.md)
- [Installed-tree audit/hash characterization](../../../browser-agent-toolkit/docs/experiments/2026-09-30-bounded-installed-tree-audit-profile.md)
- [Payload/prior editor-performance scope](../../../browser-agent-toolkit/docs/experiments/2026-09-29-editor-performance.md)
- [Bounded filesystem/service-switch qualification](../../../browser-agent-toolkit/docs/experiments/2026-09-29-reset-filesystem-phase7-service-qualification.md)

### Representative source entrypoints

- Toolkit: `examples/todo-app/src/workspace-switch.ts`, `workspace-editor.tsx`,
  `workspace-sessions.ts`, `local-workspaces.ts`, `start-editor.ts`;
  `workspace-api/src/environment-experiment.ts`, `workspace.ts`, `react.tsx`;
  `opencode-chat/src/prepared.ts`, `controller.ts`, `react.tsx`.
- Experimental runtime: `packages/core/src/workers/kernel-worker.ts`,
  `kernel-filesystem.ts`, `kernel-fetch.ts`; `packages/kernel-host/direct-kernel-fs.js`,
  `fs-server.js`, `kernel.js`; `packages/runtime/builtins/child_process.js`.
- Baseline-only restricted reuse reference:
  `examples/todo-app/tests/matched-lifecycle-client.ts`, `reuse-pilot-fence.ts`.
