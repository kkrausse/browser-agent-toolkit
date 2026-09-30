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
