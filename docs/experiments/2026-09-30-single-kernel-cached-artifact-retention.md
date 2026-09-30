# Single-kernel cached-artifact retention: offline preparation, integration blocked

Report: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-cached-artifact-retention.md`

## Outcome and qualification boundary

Reviewed single-kernel starting HEAD `262c51a` against read-only baseline HEAD
`64de522`. **No production installed-environment retention opt-in is wired or
enabled. No browser workload, service start/stop, origin/storage operation or paid
inference was performed. No speedup was measured.** The current TODO switch still
disposes chat, stops the runtime, clears project/server state, restores source and
restarts Vite and OpenCode. Its pending journal and session restoration ordering
are unchanged. No live process or service-location reuse was introduced.

Actual bounded app work:

- Source snapshots now exclude `.browser-editor-backends` and
  `.browser-editor-cache` (alongside `node_modules`). They cannot copy prepared
  archives or experiment receipts/scripts into IndexedDB snapshots, nor restore
  an incoming receipt over installed state. This avoids unnecessary managed-state
  reads/copies; no duration or byte-saving claim is made. Incoming legacy catalog
  images containing these paths fail validation before disposal/stop/clear,
  rather than being silently stripped or migrated. Existing durable working source
  is not cleared by this validation failure.
- `src/cached-artifact-admission.ts` provides a **preparatory, unwired** byte-exact
  package/lock/config gate. Requested mode must be explicit; recovery/retry is
  ineligible. Both outgoing and incoming must match preparation, including absence
  of optional inputs; A/B agreement on an unprepared dependency input is insufficient.
  Unknown Vite/React Router config extensions reject admission. This bounded gate
  does **not** prove runtime identity, transitive config imports, arbitrary plugin
  inputs, installed integrity or stopped ownership. It must not be used alone to
  enable retention.
- Focused offline tests characterize a concrete inherited ownership blocker and
  exercise admission, managed snapshot exclusion, journal/recovery ordering,
  native sessions and existing installed-tree audit fences.

## Already inherited versus missing

`workspace-api/src/environment-experiment.ts` and `opencode-chat/src/prepared.ts`
are byte-identical between the inspected baseline and fork. Existing capabilities:

1. Preparation-built gzip managed bundles and compressed VFS images; runtime image
   installation when supported, otherwise ordinary bundle installation.
2. CacheStorage download reuse with byte length/SHA-256 validation and corrupt-cache
   eviction. A download hit still decodes and installs; it is not an installed hit.
3. `preparedApps(..., { experimentalReuseInstalled: true })`: receipt key binds
   runtime version, bundle/image SHA-256, managed roots and entries. The helper
   checks complete installed paths/modes/content/symlink targets before skipping
   delivery; receipt alone is not accepted. Manifest/candidate provenance validation
   remains in the normal preparation-loading path.
4. `experimentalSourceReplacementTool`: exact source deletion/replacement, optional
   unchanged-file reuse, preservation of managed roots, removal of `/.server`.
   Its contract requires stopping/draining all outgoing readers first; partial
   failure is not transactional.

Missing from normal TODO UI: installed-reuse option, cache-retaining source
replacement, bound audit/replacement tools, input/runtime/artifact/identity
compatibility checks, before/after cache-preserving audits and an owned fallback
adapter. `start-editor.ts` delivers through `preparedApps` without the opt-in;
`workspace-editor.tsx` calls `clearWorkspace` before `restoreSource`.

The baseline experiment's **n=5 per condition**, client medians
**32.153 → 15.456 seconds**, includes two 12,305-entry audits (~5.783 seconds
combined). It retained kernel/installed dependencies/Vite **disk** cache while
restarting both services. This is neither cache-only causation nor an SLA and
does not qualify this single-kernel TODO UI. See baseline report
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-retained-pair-evidence-recovery.md`.

## Precise blockers and required shared-library coordination

No shared library/runtime/controller/readiness code was changed by this task.

1. `preparedApps` installed-reuse mode explicitly treats
   `/workspace/node_modules/.vite` and `.vite-temp` as disposable. Verification
   removes them, so simply adding its opt-in cannot implement the observed
   disk-cache-retaining condition. `environmentVerificationScript` rejects extra
   installed paths; omitting disposable cleanup alone is insufficient because
   generated cache files then fail full-tree verification. Need a supported audited
   cache exception: lstat-safe inventory/content digest, bounded traversal, immutable
   before/after digest while services are stopped; not a blanket ignored subtree.
2. `runEnvironmentScript` awaits `Promise.all(stdout, stderr, exited)` and stops in
   `finally`. If one reader fails, the others need not settle before the helper
   reports a miss, invalidates the receipt and invokes delivery. Deterministic test
   `tests/cached-artifact-ownership-blocker.test.ts` holds the stderr reader after
   stdout failure and observes delivery **before stderr settlement**, even when
   `execution.stop()` resolves. This is intentionally a characterization of an
   unsafe ordering, not permission to accept it in production. Repair must join
   both readers AND exit on every failure/cancellation path and propagate unproven
   cleanup; a join/stop failure forbids fallback. The script currently uses its own
   timeout, not the consumer cancellation signal. Source replacement uses the same
   helper, so it also needs owned cancellation/settlement semantics.
3. Existing cache-preserving audit is fixture/test code
   (`tests/installed-tree-audit.ts`), not a public production contract. Controller
   runtime tools are bound at start, normal editor binds only `apps`, and blindly
   testing tools via casts would not establish supported ownership. Need reviewed
   public audit/result/cancellation semantics or an explicit app-owned adapter,
   with test-only fixture assumptions removed. Do not import test fixtures into UI.
4. Compatibility must include distribution/artifact identity (not version string
   alone), dependency policy/backend archives, generated lock/package inputs,
   preview and OpenCode launch/config inputs and active logical identity. The
   preparatory source gate deliberately does not claim completeness here.

These are reasons to stop at preparation rather than force a query-flag shortcut.

## Minimal later integration design (not implemented)

Keep `switchWorkspace`'s admission/capture/persist sequence. Only after the atomic
outgoing source/native-chat snapshot + incoming pending journal is durable:

1. Dispose outgoing chat; join service shutdown, execution exits and output drains;
   reject incomplete/nonzero process/listener/HTTP/fetch diagnostics. Both services
   must be stopped. Abort observed here leaves pending recovery, no source mutation.
2. For an explicitly requested, non-recovery switch, validate durable active
   identity and full prepared/runtime/dependency/config compatibility. Unknown or
   incompatible state selects existing conservative stop/clear/restore/redelivery.
3. Bind supported audit and replacement tools to a fresh runtime wrapper **without
   running apps delivery first**, since delivery could destroy disk caches before
   the before-audit. Audit all managed entries and Vite cache inventory/content;
   flush exact incoming replacement (including outgoing deletion and server-state
   reset); write incoming identity; run the identical after-audit and compare cache
   digest. Do not allow initialized-source marker logic to resurrect deleted files.
4. Audit/replacement failure must first cancel and join all owned scripts/readers/
   exits. If quiescence cannot be proved, retain pending and stop; never overlap a
   fallback. A proven invalid tree can conservatively stop, clear, restore target
   from the durable journal, redeliver with reuse disabled, then restart. Cancellation
   should leave pending for explicit recovery, not opportunistically start services.
5. Restart Vite and OpenCode using fresh executions/endpoints. Import native sessions
   into the cleared server state, map selection and hydrate through existing boot
   callbacks. Only final successful readiness/identity restoration/catalog commit
   clears pending. Recovery retries always use the conservative branch.

No retained live Vite/OpenCode process, listener, endpoint or location is permitted.
Preserve full validation and before/after audits even if their cost exceeds delivery.

## Offline validation and build limitations

- `bun test src/workspace-sessions.test.ts tests/cached-artifact-ownership-blocker.test.ts src/cached-artifact-admission.test.ts src/workspace-switch.test.ts tests/installed-tree-audit.test.ts tests/matched-qualification.test.ts`:
  **38 pass, 0 fail, 320 assertions**. Deterministic local tests, not browser samples.
- Isolated browser-target app bundle with toolkit imports external:
  `bun build src/workspace-editor.tsx src/cached-artifact-admission.ts --target browser --external '@kev-browser-agent-kit/*' --outdir /private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/sk-cached-artifact-retention-20260930-app-only`:
  passed (13 modules). This qualifies app bundling only, **not** built library
  consumers/runtime integration.
- Standalone strict TypeScript check of `src/cached-artifact-admission.ts`: passed.
- Full app bundle and repository app `tsc --noEmit` attempted: **blocked** by missing
  installed/built `@kev-browser-agent-kit/*` and `@vivari/core/host` packages, with
  cascading type errors plus pre-existing test diagnostics. No package install,
  frozen artifact/pin rebuild, generated-output replacement or server start was
  performed to work around that shared environment. Parent should stage isolated
  built library consumers before a full integration check.

## Minimal matched live comparison needed

After shared blockers are fixed, coordinated fresh separately owned origins and
frozen served-byte/runtime/prepared receipts: normal conservative switch versus
explicit installed-environment/disk-cache retention with **both services restarted**.
At least five interleaved measured switches per condition; cold start and any
same-generation rearm recorded separately/excluded. Freeze deadlines, first-failure
stop/no-retry policy, complete shutdown boundary and full audited switch interval.
Require A/B added/deleted/renamed source correctness, correct incoming identity,
isolated native session restore/selection (offline fixtures, no paid inference),
fresh preview HTTP/interactive generation, fresh chat readiness, stale-attachment/
listener rejection and final zero-work cleanup. Include mismatch/tamper/cancel/
audit-failure recovery qualification separately, not as measured successful reuse.
Export bounded complete evidence; report audit costs and per-sample spread, not
just a median. Do not start this comparison without parent coordination.
