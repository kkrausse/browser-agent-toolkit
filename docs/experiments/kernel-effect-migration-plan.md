# Kernel Effect migration plan

Date: 2026-09-30. Owner: parent session. Status: implementation authorized by user;
first wave is bounded, experimental, and not a release/pin promotion.

## Decision and objective

Extract a TypeScript Effect lifecycle core **inside the consolidated kernel**.
Rewrite its asynchronous ownership/orchestration, not the synchronous VFS, SAB
ABI, native algorithms, guest Node runtime or worker topology. Browser and Node
hosts must consume the same compiled core.

The objective is one coherent admission, ownership and cleanup model. Effect is
the implementation mechanism, not evidence that arbitrary native work has stopped.
Successful stop/replacement receipts must mean the relevant underlying work joined.

Research: [rewrite scope](2026-09-30-effect-kernel-lifecycle-rewrite-scope.md).
Current evidence: [status](2026-09-30-single-kernel-status-and-direction.md).

## Baseline and work policy

- Runtime source: `/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel`;
  baseline `33fa1359a003ca9c50cb3bc49699b99bc1a063f1`.
- Toolkit: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`;
  implementation baseline `d0eec346dbc749db1c0cd82dd8aad0b27c1da363`.
- Existing repaired candidate version:
  `3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.
- Preserve frozen candidates, reports, licenses, upstream pins and user changes.
  No canonical generated-output edits, default promotion or push.
- Current editor tracing is limited to diagnostic/test preparation; do not launch
  further old-candidate editor cohorts during this migration without parent approval.
- Completed imperative app/focused acceptance stays as comparison evidence. It does
  not qualify the Effect candidate or erase failed editor/close cohorts.
- Bun/TypeScript; separate runtime/library builds from example consumers. Read
  runtime development instructions before edits. Commit explicit owned paths only.

## Contracts before code

### Owners

| Owner | Owns | Successful close means |
| --- | --- | --- |
| Kernel root | Platform resources and explicitly root-owned operations | Admission closed; all owned continuations/storage cleanup joined |
| Launch | Work before a PID exists | No late transfer/spawn/publication; its interests and cleanup settled |
| Process/subtree | Process work, descendants and consumer interests | No dead-process publication; owned work and descendant receipts joined |
| Shared operation | One download/install/fetch generation and its write authority | Backend/body/staging/commit or rollback settled; failures retained |
| Consumer lease | Interest in a shared operation | Consumer cannot receive further publication; release is accounted for |

Stopping one consumer must not cancel another live consumer's operation. Last-owner
departure closes that generation's admission, requests cancellation and joins its
settlement. Any retained root interest must be explicit, not an accidental daemon.
Old finalizers must never remove a newer generation's entry or files.

### Admission and outcomes

- Each owner has `Open -> Closing -> Settled(success | failure)` and one memoized
  joinable receipt. Freeze admission synchronously before asynchronous teardown.
- Register cleanup before calling code that may complete synchronously or re-enter.
- Publication checks exact owner/generation/syscall identity immediately before the
  synchronous SAB/VFS bridge commit. No stale/dead-PID response or late child launch.
- Effect interruption requests cancellation; adapters separately abort **and join**
  native promises, stream readers, writes and rollback. Ignored abort cannot produce
  successful cleanup early. A timeout is not proof of settlement.
- Preserve expected errors and failed receipts after removal from live registries.
  Do not hide errors in finalizers or equate `Scope.state === Closed` with completion.
- Explicit shutdown ordering must avoid reader/task self-join cycles. No caller
  should enumerate private subsystem maps to construct a stop guarantee.

### Public API compatibility and intended improvements

Preserve `Endpoint.closed` as admission notification, `Endpoint.settled` as request
cleanup join, `Execution.exited` cleanup-error metadata, and rejecting idempotent
`Execution.stop()`/`Runtime.stop()` on failed cleanup. Failed shutdown retains
attachment and prohibits destructive replacement/fallback.

Add supported kernel writer/operation quiescence composition when the migrated
domains can actually guarantee it; do not expose an all-writer receipt prematurely.
Later workspace capture/switch must acquire exclusive mutation admission rather
than race pre/post idle snapshots. This includes pending native session/model
operations and joined chat disposal. Interface changes need explicit compatibility
review; translating the old races into Effect is not acceptance.

## Technical boundaries

- Keep `kernel.js` synchronous syscall/VFS logic and SAB publication imperative.
  Extract lifecycle implementation into environment-neutral TS modules with narrow
  checked bridges; verify standalone kernel-host import/build compatibility first.
- Kernel worker supplies native fetch/body, installer, worker, timer/port and storage
  adapters. Same compiled ownership code serves browser and Node fixtures.
- Use named Effect functions, scopes/fibers, services and typed outcomes where they
  improve orchestration. Avoid one Effect runtime per request and hidden daemon work.
- Choose an exact Effect v4 pin in phase 0. Prefer an available version with reviewed
  scope/interruption semantics; document differences from existing chat rc.112.
  Scope research inspected rc.112 and upstream rc.118, not an installed runtime pin.
- Cache/RcMap are not authoritative drain receipts. Use them only where their verified
  semantics fit; shared install/write generations need explicit lease/receipt policy.
- Do not change permission/path confinement under the guise of lifecycle migration.
  Joining writes does not prevent an installer following a hostile ancestor symlink.

## Phases and gates

### 0. Package, bridge and dependency decision

Inventory runtime entrypoints/importers; select exact Effect pin and compiled-core
placement/export format. Verify browser-worker bundling and Node import. Specify
owner identity, leases, outcome/error wire mapping and publication bridge.
Gate: actual build/import smoke checks, no protocol or topology change; record bundle
size before/after. Do not claim a lifecycle repair from scaffolding alone.

### 1. Real lazy-loader cutover — first implementation wave

Migrate the actual shared tsgo loader and pre-PID launch seam into the core. Join
vendor download/body, installer writes and failure/rollback outcomes. Replace its
old authority for that domain; do not create a second shadow supervisor.

Gate: held real vendor bytes cannot produce writes after a successful relevant stop;
two interested callers share one install, first stop preserves the second, last stop
joins cleanup, no late launch/publication, failures remain visible. Reuse the planted
`/bin` counterexample as a lifecycle regression, not an assertion of path security.
Existing direct consumers/fixtures must use the migrated path, not a fake sidecar.

### 2. Process/launch/subtree ownership and remaining loaders

Transfer pending launches, PID/descendant lifetimes and all registered lazy loaders
to the same model. Retain exited-child failures and partially acquired resources.
Gate: stop-before-PID, duplicate stop, child boot/exit races, shared load failure and
late worker publication. No fire-and-forget work escapes an explicit owner.

### 3. Fetch queue, dedupe, bodies and pins

Migrate existing repaired guest fetch ownership without losing its guarantees.
Preserve queue sharing, body-reader pins, remap/fallback joins and exact-generation
rollback. Native adapters must join underlying operations, not only Effect fibers.
Gate: historical PID-egress negative control plus active/queued/shared owners,
ignored-abort body/backend, rollback failure, EFBIG/chunk retry and native browser
held-header/open-body stop. Exotic injected failures remain offline when unsupported
by real browser APIs; do not block all live tests on uninjectable cases.

### 4. Remaining kernel async writers and resources

Inventory and transfer accepted RPC writers, snapshot/depcache/search-replace work,
readiness jobs, HTTP buffering/spills, listeners, pipes/watchers, ports and timers.
Every row needs an owner and truthful receipt or an explicit excluded guarantee.
Gate: concrete existing protocol/failure fixtures; no generic speculative test suite.

### 5. Persistence and host/workspace composition

Join accepted SQLite/OPFS work before disposal, own partial boot unwind and locks.
Compose SDK endpoint/output/process/kernel receipts without self-join. Introduce
exclusive capture/switch admission and await chat disposal through the owner chain.
Gate: held writes/flush, failed acquisition/close, editor save/native model race,
source/session preservation, interrupted reload and explicit outgoing recovery.

### 6. Cache-retention delivery and integrated qualification

Once the required writer barrier is real, wire the guarded default-off cache adapter.
Prove helper ancestor/leaf safety, complete artifact/config compatibility, exact
source/native-session/journal ordering and equal before/after cache digests.
Unknown/unproven state misses conservatively; failed cleanup must not trigger fallback.
This phase is a deliverable, not indefinitely deferred after migration.

Freeze matching runtime/SDK/library/consumer assets; run original app stages and
focused cases, editor switching/reload/startup recovery, and a bounded off/on timing
comparison. Separately compare Effect vs repaired imperative with retention off to
isolate framework overhead. Report failures and resource/bundle costs, not just medians.
User/parent decides default promotion after evidence; no automatic pin update.

Long-lived OpenCode process reuse remains a separate later deliverable: the kernel
rewrite cannot invent remote location/ref/finalizer acknowledgements. Preserve its
stable-root experiment and background-work/routing limits.

## Delegation and integration

First wave starts after this plan is committed:

1. **Kernel implementation owner:** phases 0–1, runtime lifecycle modules/bridge,
   dependency/build wiring and real loader integration. One authority over those files.
2. **Regression/evidence owner:** existing late-loader negative control and migrated
   acceptance fixtures in separate test files; preserve earlier endpoint/PID-fetch
   regressions. Coordinate the seam through explicit contracts, not simultaneous
   edits of implementation files. Offline until a frozen implementation is available.
3. **Parent:** API/phase decisions, report index, integration review and next-wave
   assignments. No implementation agent may expand silently to all six phases.

On phase1 completion, review ownership/error semantics and real tests before assigning
process/fetch phases. Host/toolkit work can parallelize later against a frozen receipt
interface; agents must not invent incompatible public contracts in parallel.

Use isolated experimental branches/worktrees when needed without discarding current
changes. One authoritative migrated implementation per domain; no permanent dual
supervisors. Commit only owned paths. One independent visible-browser owner at a time,
using the Bun-backed Browser Control CLI; headless cohorts are separately labelled.

## Acceptance and stop rules

- Deterministic handshakes for known regressions; no sleeps/retry-to-green or generic
  unit scaffolding. Preserve negative controls against the exact old implementation.
- Real builds and guest adapters, matching source/artifact receipts. Rebuild changed
  JS workers; native artifacts may be reused only after provenance verification.
- Preserve current app19-stage/five-generation and focused10-case/14-step evidence as
  controls. New Effect artifacts need their own independent acceptance.
- Known `markAsUncloneable` contract gap, failed editor save and retained-target
  observations remain in denominators/limits until specifically resolved.
- If pilot packaging, ownership semantics or measured costs are unsuitable, stop
  and report rather than widen the rewrite to justify sunk cost.
- Rollback selects a whole verified artifact cohort, never an old-host/new-kernel mix.
  No revert/reset/discard of unrelated work.

## First-wave completion receipt

Return exact source/Effect versions, touched APIs, build/provenance receipts, known
regression results, browser/Node delivery identity, shared-interest semantics,
remaining limits and a runnable frozen candidate or precise staging blocker.
No invented completion date or performance gain. Next phase is a reviewed decision,
not evidence that pilot success means the whole kernel is migrated.

## Execution log

- Regression wave delivered `5ed70ba`:
  [real-loader gates](2026-09-30-effect-loader-migration-regression-gates.md).
  Verified baseline reproduces two late cache shims after successful stop. Held
  vendor, held installer-write and swallowed-loader-failure gates fail at intended
  assertions. Two-live-interest control passes: one download, only live caller
  receives a child, exact installed bytes, no stopped-caller SAB publication.
  Migrated positive results and native abort/pre-PID host launch/rollback/public
  attachment receipts remain pending. No production migration qualification yet.
- Previous editor trace preparation `61c0be5` is retained as optional diagnostic
  evidence tooling; no live activation is requested during first-wave migration.
- Phases0–1 implementation delivered runtime `5c4b1c5`, toolkit cleanup bridge
  `73dbae7`, final handoff `fc91222`:
  [loader implementation](2026-09-30-effect-loader-pilot-implementation.md).
  Effect pin rc.118; actual loader/shared interests/pre-PID launch joins migrated.
  Four unchanged independent gates pass; supplemental launch/rollback/attachment
  and preserved regressions pass under implementation-owner checks. Expanded
  independent acceptance, qualified Node and real-browser execution remain pending.
  Worker adds 621,609 raw / 135,365 gzip bytes; runtime overhead unmeasured.
- Independent regression owner `ses_f0b6415eaffe2pbRMSqCj4VSlX` now qualifies the
  actual native adapter, pre-PID launch, rollback and public attachment contracts;
  intended report `2026-09-30-effect-loader-expanded-independent-qa.md`.
- Delivery owner `ses_f0b3fd6c9ffe6RLKXhGwI2HQE4` prepares matching full app/browser
  artifacts, first recovering/verifying the missing qualified OpenCode receipt
  rather than bypassing its verifier. Intended report
  `2026-09-30-effect-loader-full-app-delivery-preparation.md`. Both tasks are offline;
  no phase2 expansion or release promotion follows until review.
- Expanded independent report `a401707`:
  [expanded qualification](2026-09-30-effect-loader-expanded-independent-qa.md).
  All 10 expanded gates pass, zero unrun; preserved 4 loader/6 PID-egress/8 endpoint
  cases pass. All 106 candidate and 997 freeze entries verify. Native held work
  delays cleanup, both rollback/install errors survive and Runtime refuses detach/
  replacement. Actual Node was 24.7.0; compiled browser/core identity is static
  evidence, not live execution. Overall pilot acceptance remains false pending
  supported Node24.18 and browser/full-app qualification. Regression owner resumes
  qualified-Node checks with isolated verified tooling; intended report
  `2026-09-30-effect-loader-qualified-node-qa.md`.
- Full-app preparation report `efee448` (scripts `fba397e`/`90e6c3f`/`d64ed23`)
  built matching workspace/chat libraries, styles, six single-WeakMap clients and
  prepared dependency image; 9,720 hashes verified, 12,303 prepared entries.
  [Delivery preparation](2026-09-30-effect-loader-full-app-delivery-preparation.md)
  recovered the exact qualified OpenCode receipt through the committed verifier;
  independent application outputs reused with matching four recipe inputs, not
  rebuilt or relabelled. Normal registry downloads recorded; no live execution.
- Live loader gate blocked by actual compiled worker vendor URL: origin + `"./"`
  yields an invalid host/port string before `/vendor/tsgo-pack.bin`. Original frozen
  assets preserved. Implementation owner resumes source/build URL repair and actual
  bundled regression, then supplies new matching SDK/worker receipts; intended report
  `2026-09-30-effect-loader-vendor-url-repair.md`. Full-app preparation will be paired
  with that new candidate before any browser qualification. Phase2 remains gated.
- Qualified Node report `71ddbe3`:
  [Node24.18 qualification](2026-09-30-effect-loader-qualified-node-qa.md).
  Official darwin-arm64 archive checksum and actual executable verified. Same
  10 expanded + 4 loader + 6 PID-egress + 8 endpoint gates pass unchanged, plus
  routing, three close cases and native markAsUncloneable fixture. Guest missing
  markAsUncloneable export still fails byte-identically to baseline; cohort stopped,
  VM-import/postflight unrun. Frozen5c4/9814 assets (106 + 997 hashes) unchanged.
  This does not qualify forthcoming URL-repaired artifacts, browser/full-app or
  the whole runtime contract suite. Baseline compatibility exclusion remains explicit.
- URL repair runtime `3ee9185` / report `c711c03`:
  [worker URL repair](2026-09-30-effect-loader-vendor-url-repair.md).
  Host passes its resolved asset root to the worker; emitted native URL resolution
  and actual 10,793,012-byte pack delivery through the offline handler pass.
  Lifecycle core unchanged; 28 gates pass on Node24.7. New worker/SDK distribution
  `bd39000ff5bbc334f836ad65a4433e627525070413f810d7169132102f49b9f9`,
  107 candidate/1,020 freeze entries; 37 native outputs verified reused.
  Independent owner resumes new-revision delivery/Node24.18 checks (report
  `2026-09-30-effect-loader-url-repaired-independent-qa.md`); delivery owner rebuilds
  matching full app (report `2026-09-30-effect-loader-url-repaired-full-app-preparation.md`).
  Neither task has live authorization yet. New receipts replace no historical bytes;
  browser execution and phase2 remain gated by matching qualified handoffs.
- Independent repaired-delivery report `bf791e0`:
  [new delivery qualification](2026-09-30-effect-loader-url-repaired-independent-qa.md).
  Actual verified Node24.18 arm64 (absolute executable in every Node child) passed
  10 expanded/4 loader/6 PID-fetch/8 endpoint/3 close cases and targeted emitted-URL
  gate, zero failed/unrun. All 107 candidate/1,020 freeze hashes match; compiled
  core unchanged and only four declared runtime source changes. Actual Host.open/
  worker public roots, subpath/CDN/separate-worker placement qualify offline; native
  adapter reads exact real pack. Unmounted subpath correctly returns404, not a
  fabricated supported host route. Browser/full-app remains pending; no phase2
  authorization or full guest API acceptance follows from these targeted checks.
- Matching app delivery `ff3a65e` (preparation `515d0e9`/`56828b2`) ready:
  [repaired full-app preparation](2026-09-30-effect-loader-url-repaired-full-app-preparation.md).
  Frozen `effect-loader-full-app-UMORaL/frozen` in approved temporary root,
  receipt `42d8ba68c2f0c972c7c5bdabe82e5fc112c75af3005d39fcf77693219563ae2a`;
  9,721 hashes/fresh run-copy verified, 12,303 prepared assets. New library/chat/
  styles/clients and single-WeakMap graphs; qualified application reuse verified.
  Actual root/editor vendor handlers deliver exact pack via new SDK/emitted resolver.
- Independent browser owner `ses_f0b18cc82ffeJH6h13O17C0sxW` now assigned real
  loader normal/held-stop cohorts on fresh run copies, followed by original combined
  app/focused acceptance only after the pilot passes. Intended report
  `2026-09-30-effect-loader-browser-full-app-qa.md`. No inference or retention flags;
  one visible owner, first failure stops, old origin/frozen bytes never replayed.
  Qualified Node results are already delivered, despite preparation's historical
  pending statement. Phase2 remains gated by this implementation review/qualification.
- Browser report `4470897`:
  [loader browser/app QA](2026-09-30-effect-loader-browser-full-app-qa.md).
  Two actual visible loader cases pass: real compiler7.0.2 and held native vendor
  abort joined by Runtime stop, no late PID/shim writes after explicit release.
  Minimal UI leaves Workspace open by design; tab cleanup is not a Workspace.close
  receipt. Combined app passed eleven foundation stages then apps1 preview readiness
  failed with TypeError/Failed to fetch; zero generations/focused checks completed.
  Vite listener and one pending HTTP request observed; cause not established.
  Public failure retirement joined and cleared targets/locks without changing failure.
  Source/native/delivery hashes unchanged; exclusive browser slot released.
- Investigation owner `ses_f0b08e627ffeoCwNjAaWE4XtjG` compares exact failed preview
  fetch evidence/static transport and preparation/runtime changes against the passing
  imperative candidate. Intended report
  `2026-09-30-effect-loader-preview-fetch-investigation.md`; offline only, no
  speculative repair/phase2 expansion or failed-origin replay. Overall app/pilot
  qualification remains incomplete despite real loader and qualified Node passes.
- Preview investigation `3009d7a`:
  [transport/timing investigation](2026-09-30-effect-loader-preview-fetch-investigation.md).
  Readiness is direct Endpoint.fetch('/') over MessageChannel; HTTP adapters, guest
  process bundle, protocol and SW match qualified baseline. pendingHttp1 concerns
  legacy probe, not established readiness stream. Cold optimizer completion at
  ~21.38s versus baseline~19.64s against 20s request budget is a plausible lead,
  not proven cause. Missing stack/header/body rejection and abort correlation prevent
  choosing a production fix. Parent authorizes one fresh passive trace cohort with
  unchanged deadline/actions and no retry; owner `ses_f0b08e627ffeoCwNjAaWE4XtjG`
  takes exclusive visible slot. Intended report
  `2026-09-30-effect-loader-preview-readiness-trace-qa.md`; diagnostic pass alone
  cannot replace original failed integrated acceptance or authorize phase2.
- Trace `99748de`/`b2046f4` did not reproduce readiness rejection: stream3 HTTP200
  at11.12s, 24,367-byte EOF17.31s, timeout afterward20s. Optimizer16.91s does not
  establish overhead/cause. Page-only capture dropped12 events; legacy-probe/WASM
  timing missing and driver export hit outer shell timeout. Public cleanup joined;
  owned targets/locks/session/host removed, 29,163 files/native12/37 unchanged.
  [Trace result](2026-09-30-effect-loader-preview-readiness-trace-qa.md) is diagnostic,
  not full-app acceptance or explanation of the old failed cohort.
- Parent assigns bounded offline real-adapter abort/header/body reason-and-cleanup
  cases to `ses_f0aeb66cdffetrxtvcEGyMWl1A`; intended report
  `2026-09-30-effect-preview-adapter-reason-cleanup-qa.md`. No blind browser repeats,
  deadline changes, production fix or phase2 expansion. Preserve old failure and
  assess next integrated gate from concrete adapter evidence rather than guessing.
- Real-adapter report `85e532e` passes10/10 cases on actual Node24.18 using frozen
  built SDK/public endpoints/MessageChannels. Exact timeout/source reasons survive;
  late abort after EOF is a no-op even while cleanup is held; rejection settles
  without self-join. Adapter sources match qualified baseline. This does not explain
  historical Failed to fetch or establish browser behavior. See
  [adapter gates](2026-09-30-effect-preview-adapter-reason-cleanup-qa.md).
- Parent explicitly approves one unchanged fresh integrated attempt, not a retry
  loop or deadline adjustment. Owner `ses_f0ae4e59affeMCGi938w74iT2b` takes the sole
  visible slot for new run-copy's original19stages/fivegenerations +10focusedcases/
  14steps. Intended report `2026-09-30-effect-loader-fresh-integrated-acceptance.md`.
  Preserve old447 failure alongside new outcome; first failure stops, no further
  blind cohorts if it recurs. Phase2 waits for review; any success is bounded
  compatibility evidence, not a reliability rate or completed kernel migration.
- Fresh-run preparation `735c627` stopped before activation on an extra QA-assumed
  runtime-source path ENOENT, not an artifact mismatch. Required delivery inventories
  and native12/37 checks in three actual roots passed; no run copy/host/browser or
  live attempt. [Preflight report](2026-09-30-effect-loader-fresh-integrated-acceptance.md)
  retained. Parent reauthorizes the still-unrun gate after correcting only that path
  assumption. Routine offline setup corrections need not start another review loop;
  genuine artifact failures and first live assertion failures still stop the cohort.
  Same owner/sole slot; intended new report
  `2026-09-30-effect-loader-integrated-acceptance-followup.md`. No deadline/assertion/
  candidate change, extra blind live retry or phase2 authorization.
- Integrated follow-up `8593093` **passes one unchanged combined attempt**:
  [integrated acceptance](2026-09-30-effect-loader-integrated-acceptance-followup.md).
  Full19/19 stages,5/5 generations, hydration/TODO/PDF/HMR/SSE, durable reload and
  final close; focused10/10 cases,14/14 steps. Original deadlines, zero retries/model
  calls, all hashes/native reuse verified before/after. Worker census/topology and
  close-to-zero/empty locks pass; exact owned resources released. Four inspected
  images do not capture rendered TODO UI; original interactive assertions remain
  its evidence. Historical447 failure stays failed,735 stays zero attempts.
- Phase1 execution gates are complete as bounded evidence, not statistical reliability
  or full migration/cache acceptance. No further phase1 browser reruns assigned.
  Independent technical reviewer `ses_f0ad6256affeILMl1eDluyTyCh` now reviews actual
  ownership/receipt implementation and defines bounded next process/subtree cutover;
  intended report `2026-09-30-effect-loader-phase1-review-and-phase2-cutover.md`.
  Parent decides phase2 implementation after this review; no all-writer or editor
  race fix is inferred from successful app/focused workloads.
- Technical review `8473869` approves bounded phase1, no blocking loader contract
  defect identified. [Review and cutover](2026-09-30-effect-loader-phase1-review-and-phase2-cutover.md)
  specifies phase2A process/launch/subtree authority first, phase2B remaining
  installer adapters afterward. Parent accepts phase1 for its stated scope and
  authorizes2A; full migration, performance, editor/cache and all-writer limits remain.
- Production owner `ses_f0ad09b55ffeAuVDaD2pB3O01u` transfers pending launch/PID/
  descendant receipts and partial worker acquisition to the core, preserving fetch
  as composed leaf and synchronous routing/SAB. Intended report
  `2026-09-30-effect-process-subtree-implementation.md`. Independent fixture owner
  `ses_f0ad0420dffeEfcgg956Cc1JZh` prepares concrete race/failure/partial-acquisition
  gates (`2026-09-30-effect-process-subtree-regression-gates.md`). Both offline;
  no browser runs or phase2B/3 expansion until matching implementation review.
- Phase2A regression delivery `5c59695`:
  [process/subtree gates](2026-09-30-effect-process-subtree-regression-gates.md).
  Seventeen offline real Kernel/core/Rust-VFS/public-Runtime gates run against the
  qualified phase1 baseline:2 pass/15 targeted failures/zero unrun. All31 preserved
  cases plus routing pass. Actual absolute Node24.18 and107candidate/1020manifest/
  native12inputs37outputs verified before/after. Fault cases cover partial worker
  acquisition, native termination joins, descendant error aggregation and stale SAB
  callbacks. These are offline reproductions, not observed browser failures.
  Migrated positive denominator17 remains pending matching2A production handoff and
  explicit new-receipt admission; implementation agent remains assigned. No phase2B
  or fetch-authority expansion follows from baseline negatives.
- Phase2A implementation report `848d321`, runtime final `cc5a932`:
  [process/subtree cutover](2026-09-30-effect-process-subtree-implementation.md).
  Core owns launch/PID/subtree receipts and failure aggregation; partial worker
  acquisitions unwind, Node termination Promise joins. Resource captures reclaimed,
  compact receipt identities/failures retained for root lifetime (O(total PIDs), not
  count-bounded). Root loader close now includes registered process owners, still
  not all-writer/storage quiescence. SDK/public semantics preserved; fetch composed
  as unchanged leaves. New worker adds8,592raw/1,899gzip bytes versus phase1.
- Implementation-owner new checks16/17 pass; stale-loader test final stop rejects
  retained loader failure despite its success expectation. Independent fixture
  owner reviews contract before any explicit versioned oracle correction; old result
  remains failed. New candidate103files/1475freeze/native12/37, distribution
  `446021ba611932b0c531570ecc5739255e8d97f608dcc8c53ad1ca07eeceb6a6`.
  Independent QA intended report `2026-09-30-effect-process-subtree-independent-qa.md`;
  matching delivery preparation `2026-09-30-effect-process-subtree-full-app-preparation.md`.
  Same respective owners resume offline. No browser, phase2B or phase3 authorization
  until matching handoffs/review; previous app passes are not new-cutover acceptance.
