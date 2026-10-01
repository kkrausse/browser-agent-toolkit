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
