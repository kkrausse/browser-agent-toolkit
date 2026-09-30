# Cached retention: shared-library prerequisites

Report: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-cached-retention-library-prerequisites.md`

## Outcome and boundary

Repaired the inherited script ownership failure and added an explicit, bounded
stopped-tree cache audit plus a narrowly scoped `preparedApps` policy hookup.
**TODO retention remains unwired/off. No speedup, live browser qualification or
runtime shutdown proof is claimed.** This work preserves disk artifacts only;
it does not retain Vite/OpenCode processes, listeners, endpoints or locations.
The existing UI already retains its workspace/kernel.

Baseline fixture read as reference only:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/examples/todo-app/tests/installed-tree-audit.ts`.
No baseline, runtime source, controller/React/readiness, startup, workspace editor,
local-workspaces, frozen artifact/receipt/pin, served origin or storage changes.
No server/browser start, package download/install or paid inference call.
Other agents' files/commits were not staged or changed.

## Causal ownership fix

`workspace-api/src/environment-experiment.ts` now retains both output drains and
`exited` before observing failure, and joins **all three plus one memoized stop**
before returning or throwing. Reader/exit/close failure aborts the launch signal
and requests stop immediately. Consumer cancellation is combined with the existing
120-second deadline and also requests stop promptly, including an abort during
launch. Both output channels are capped at 4 MiB each.

Failed launch, failed reader/exit join, failed stdin close, output overflow or
failed stop yields exported `EnvironmentOwnershipError`, with
`code: "ENVIRONMENT_OWNERSHIP_UNPROVEN"`, original `cause` and `failures`.
Installed-reuse never catches that error as a cache miss. Cancellation/deadline
also rejects after cleanup, not opportunistically falling back. An unresolved
sibling deliberately keeps the operation pending; a timeout is not an invented
ownership receipt. A joined ordinary guest nonzero exit or invalid tree may still
select conservative redelivery.

The same runner covers audit, receipt invalidation/publication, cache reset and
source replacement. Failure in receipt/cache cleanup prevents delivery. Receipt
writes reject symlink/non-directory ancestors and non-file receipt leaves.
The former TODO characterization is now a failure regression: sibling reader
settlement must precede release, and failed reader ownership permits no fallback.
Focused regressions inject stdout/stderr/exit/launch/close/stop failures, abort,
abort plus failed stop, held reader/exit/stop, and output overflow.

## Exported opt-in contract

Public `@kev-browser-agent-kit/workspace/delivery` exports:

- `experimentalInstalledEnvironmentAuditTool(entries, roots, policy)`, returning
  `ToolDescriptor<{ servicesStopped: true; signal?: AbortSignal }, InstalledEnvironmentAuditResult>`.
- `InstalledCachePolicy`, `InstalledCacheEntry`, `InstalledEnvironmentAuditResult`,
  `EnvironmentExperimentResult`, and `EnvironmentOwnershipError`.
- Existing `experimentalSourceReplacementTool(source, { incremental?, signal? })`
  remains a void-options tool. Existing calls without the new signal are preserved.
- `managedDeliveryTool(..., { signal, experimentalReuseInstalled: {
  runtimeVersion, preserveCaches: { servicesStopped: true, policy }, onResult? } })`.
  Cache-preserving hits include the successful audit in `onResult`.

`preparedApps`' sixth argument now additionally accepts
`experimentalPreserveInstalledCaches: { servicesStopped: true, policy }`, **only
with** `experimentalReuseInstalled: true`. Neither option is default-enabled.
Ordinary installed reuse still deletes `.vite`/`.vite-temp` and performs the old
exact installed verification. Normal delivery is unchanged. The existing delivery
signal is forwarded to verification, receipt and reset scripts.

The cache policy is not a subtree-ignore list:

- Canonical absolute paths, disjoint roots/cache paths, unique manifest entries,
  directory-only manifest parents, and no immutable manifest/cache overlap.
  Cache paths must be descendants of explicit managed roots, or the specifically
  supported external `/workspace/.browser-editor-cache/vite` directory.
- Full immutable path/mode/content/symlink-target verification remains. Cache roots
  are traversed separately; every ancestor uses `lstat`, and every cache descendant
  is classified without following links. Cache roots must be directories; symlinks,
  dangling links and special cache objects reject.
- Default **and maximum** budgets: 10,000 cache inventory entries (including roots
  and absent markers), 16 MiB per cache file, 64 MiB total cache contents, depth 32
  below each cache root. Callers can lower, not raise these limits. Limit failures
  return an invalid audit, never a partial success. `readdirSync` still materializes
  one directory listing before its count check; this is not an OS allocation cap.
- Sorted inventory includes explicit missing-cache records; directories record
  path/mode, files record path/mode/size/SHA-256. `cacheDigest` hashes canonical
  JSON of that inventory. Successful before/after equality therefore covers
  cache absence, names, topology, modes and content. It excludes mtime/inode/server
  state and is not a performance or compatibility receipt.
- A success returns `{ valid: true, checked, inventory, cacheDigest, cacheBytes }`;
  failure returns `{ valid: false, checked, reason }`. Output shapes are checked
  before returning the supported audit result.
- A proven installed miss invalidates the receipt, safely removes the explicit
  caches (including the external cache), then redelivers. Otherwise a stale external
  cache would survive replacement of managed roots. Reset scope is compiled/frozen
  at policy validation, not re-read from caller-mutable paths. Unsafe cleanup
  ancestors/failures reject without delivery. A hit deletes no cache.

**Caller obligations/limits:** entries/roots come from a provenance-validated
managed delivery. `servicesStopped: true` is an explicit caller attestation,
not a new runtime diagnostic or proof. All outgoing services, readers, launches,
fetches and listeners must already be joined, and no competing writer may run
through the entire before/replacement/after interval. `lstat` is not a defense
against concurrent TOCTOU mutation. The helper still installs its immutable
hash-named script through the existing `ToolContext.installFile` contract; this
task does **not** add a generic SDK lstat-safe script-bootstrap installation fence.
Adversarial helper-directory symlink redirection and real guest stop/exit fidelity
must be reviewed/qualified with the runtime owner before unrestricted app admission.
The audit is read-only for installed/cache contents, not an assertion of zero
helper-script installation. No private fixture/runtime-state inventory was promoted.

## Validation and reproducibility

From the toolkit repository:

```sh
bun test workspace-api/tests/environment-experiment.test.ts workspace-api/tests/environment-ownership.test.ts workspace-api/tests/delivery.test.ts examples/todo-app/tests/cached-artifact-ownership-blocker.test.ts
```

Final focused result: **36 pass, 0 fail, 172 assertions**. Generated audit/replacement
scripts run on real host Node in exclusively owned temporary trees; this is not
the browser guest/Wasm filesystem. Cache tests cover preserved hits, source
add/delete replacement with unchanged before/after cache digest, immutable tamper,
cache content/mode/rename/absence, symlink ancestry/leaves, limits, conservative
external-cache removal and frozen cleanup scope/failure.

Isolated stage (not a served candidate):
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/cached-library-prerequisites-kb8zKo`.
Retained `stage.ts` builds browser-target delivery/diagnostics subpaths into an
isolated minimal package and bundles the prepared-app tests with those package
imports external. `bun stage.ts`, then `bun test ./prepared.test.js`: **2 pass,
0 fail, 20 assertions**. `bun consumer.ts` verifies built public imports. No checkout
alias/mock of the library implementation is used by those final consumer tests.
This is a **built-subpath JavaScript consumer**, not a tarball/declaration/full-app
qualification. Prepared manifests/executions are deliberate bounded fixtures;
candidate provenance and actual browser process behavior are not tested there.

Two targeted strict `tsc --noEmit` configurations in that stage pass:
`targeted-tsconfig.json` (runner/audit plus related regressions) and
`targeted-delivery-prepared-tsconfig.json` (delivery/prepared sources/tests and
their imported type graph). They map the missing host dependency to read-only
`/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel/packages/core/src/host-sdk`
source and workspace package types to this checkout. These are explicitly
**source-mapped targeted checks**, not installed/frozen-package declaration checks.

The adapted ownership regression also runs against a separate scratch copy of
`d5f165e`'s inherited runner and fails: inherited fallback resolves rather than
rejecting failed-reader ownership. No repository source was reverted for that check.

Broader `bun test workspace-api/tests/*.test.ts` was attempted earlier: **39 pass,
6 fail, 5 module-load errors**. Missing `@vivari/core/host` blocks the runtime suites;
an unrelated preparation mode assertion also reflected the shell's restrictive
umask. Re-running only preparation tests with umask 022 yields **3 pass, 0 fail**.
Unmodified repository `tsc --noEmit` is blocked by missing host/workspace packages
and cascading type errors. A full build was **not run**: it would replace shared
`dist/lib` and requires unavailable host package staging. `git diff --check` passes.

## Exact remaining app integration requirements

1. Review runtime bootstrap/stop truthfulness and stage full built library consumers
   without replacing frozen artifacts or altering pins. Library joins do not prove
   the runtime's process/listener/fetch diagnostics are complete.
2. Retain existing durable outgoing snapshot + incoming pending-journal ordering.
   Explicit off/on admission must cover prepared/runtime artifact identity, backend
   policy/archives, package/locks/config/transitive inputs, launch inputs and active
   logical identity. Existing byte gate alone is insufficient; recovery stays off.
3. Dispose chat and join both services/output/exits/endpoints/launches/fetches. Retain
   the workspace/kernel only. Never reuse live Vite/OpenCode services or locations.
4. Bind supported audit and replacement descriptors in `Runtime.start({ tools })`
   on a fresh tools-only wrapper **without calling apps delivery first**. Invoke
   `runtime.tools.audit({ servicesStopped: true, signal })`, check validity, perform
   exact incoming replacement with its consumer signal, then invoke the identical
   audit and compare successful `cacheDigest`s. Preserve full budgets/verification;
   do not import TODO benchmark fixtures or cast unavailable tools into existence.
5. Write incoming identity/flush through supported owner APIs; prevent source-marker
   startup logic from resurrecting deleted/outgoing files. After a proved valid
   retained interval, new `preparedApps` opts into that same explicit cache policy
   on the stopped tree. Restart both services with fresh executions/endpoints,
   restore native sessions/selection and existing readiness/catalog ordering.
6. Invalid audit/compatibility selects existing conservative clear/restore/redelivery
   from the durable target, **after** all owned tools join. Cancellation, ownership
   error or unknown cleanup proof retains pending and forbids overlapping fallback
   or restart. Partial replacement is not transactional. Only completed readiness,
   identity/session restore and durable catalog commit clear pending.

## Mandatory fresh-origin live follow-up — pending

Parent owns exclusive visible **Browser Control CLI** coordination. No independent
visible browser was started. Headless real-browser QA, manual UI QA, full consumer
build and timings are all **pending**, not implied by the offline results.

After prerequisite review and a real app adapter, freeze library/app/runtime/prepared
hashes and logs. Stage into a **new nonexistent** output directory:

```sh
bun examples/todo-app/tests/stage-single-kernel-live.ts <qualified-input> <fresh-candidate-staging-directory>
```

Parent assigns new separately owned off/on origins and fresh storage; do not copy
onto an existing server/origin or reset user/test storage. Both treatments retain
the already-retained kernel and restart both services. Serialize visible QA,
headless QA and timing cohorts. Use offline native-session fixtures; no inference.

Required acceptance: exact A/B source bytes and recursive path set (add/delete/rename,
no stale files), active identity, native session hierarchy/isolation/selection and
model metadata, fresh interactive preview/chat readiness, before/after full installed
and cache evidence, rejected stale endpoints/attachments, and final zero-work cleanup.
Negative cases must include dependency/config/runtime/artifact/identity mismatch,
immutable/cache/helper/receipt symlink tamper, cache-budget failure, cancellation
during audit/replacement/start, reader/exit/stop/cleanup failure, catalog failure and
interrupted retry. Unknown ownership forbids fallback. Stress alternating switches
and save/close/reopen separately from timing. Only after both candidates qualify,
collect at least five interleaved matched samples per treatment; record the complete
audited shutdown-to-readiness interval, audit costs and spread. No cache-only causal
speedup or production enablement is claimed by this prerequisite work.
