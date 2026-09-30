# Single-kernel OpenCode retention: preparation only

Absolute report path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-opencode-retention-preparation.md`

## Safety status

**Not accepted reuse. No production/default retention, reset or live switch was
performed.** Offline prerequisites and a browser-bundleable actual-controller
qualification entrypoint are prepared. Live/manual QA is mandatory and pending;
the parent owns browser coordination on a fresh isolated origin after sibling
fixes, followed by combined workspace-switch stress. This work does not authorize
eviction. All emitted preparation receipts say `remoteProof:false` and
`evictionAuthorized:false`; mounted qualification says `retentionAccepted:false`.

Baseline `browser-agent-toolkit` HEAD `64de522` was read-only; SK starting HEAD was
`262c51a`. Baseline restricted mounted cohorts recorded 22.316 → 8.425 s medians
and reversed-order 22.971 → 9.651 s, twenty transitions total. These are useful
restricted latency evidence, **not** cancelled-reader/tool/PTY/arbitrary-project
safety evidence or measurements of this SK candidate. No new timing claim.

Only these new dedicated experiment files belong to this workstream:

- `examples/todo-app/tests/sk-opencode-retention-prerequisites.ts`
- `examples/todo-app/tests/sk-opencode-retention-prerequisites.test.ts`
- `examples/todo-app/tests/sk-opencode-retention-mounted-candidate.ts`
- `examples/todo-app/tests/sk-opencode-retention-mounted-candidate.test.ts`
- This report.

No app/workspace switch, installed-cache, chat library, runtime, parent status,
frozen artifact, evidence, pin, auth or package changes. No browser, host, origin,
OPFS, OpenCode server, model request or real execution/tool invocation.

## What actually ports

Baseline reviewed finite routes/contracts, complete normal body consumption,
freeze → finite join → await local disposal ordering, explicit `/workspace`
routing, fresh root creation and stable process identity checks are portable.
Do not transplant the whole baseline harness or its broad GET-prefix allowlist
into a production retention API. SK's existing `reuse-pilot-fence.ts` lacks the
later baseline raw-byte/semantic contract checks, so importing it would not
reproduce the matched cohort's evidence. It remains unchanged here.

The new prerequisite gate is deliberately narrower: serial GET health/config/
project-current/active-empty and POST activation only. It rejects streams,
session creation, arbitrary session reads, tools/RPC, filesystem, shell/PTY and
DELETE. A concurrent admission attempt poisons the gate even though the second
transport never launches. Abort, HTTP/contract/body failures and deadlines also
poison it permanently; late settlement cannot repair uncertainty. Seal joins
normal finite completion and caller-supplied local disposal, but supplies no
remote API acknowledgement. Exclusive ownership and source review are explicit
caller assertions, **not self-authenticating security capabilities**.

Identity admission requires every explicit nonempty field to match: server
bundle, runtime, mount, directory, workspace ID spelling (use an explicit sentinel
for absence), cwd, launch environment, dependencies, plugins, configuration,
owner and endpoint. This phase permits source-marker changes only; even inert
config changes require restart pending separate qualification. Equality does not
itself prove those fingerprints were correctly collected or source writes safe.
The comparator is a negative-policy test, not installed-cache admission logic.

The mounted candidate calls the actual `createChatController`, requests a new root,
renders snapshots via a supplied callback, verifies empty idle hydration, distinct
selected session, explicit location, no parent/fork/model/permissions/metadata
inheritance, source marker and caller-supplied owned identity checks. It captures
complete finite status/headers/base64 bytes/SHA-256 and requires a supplied pinned
codec parity verifier before accepting each finite response. All controller
requests explicitly inherit `/workspace` routing. Global SSE is separately locally
joined by `dispose()`. Finite reads may overlap during controller bootstrap; this
entrypoint therefore does **not** claim the serial prerequisite gate was satisfied.
There is no source replacement, DELETE, incoming generation acquisition, host
launcher, autostart or served-page acceptance in this candidate.

Its test drives the actual controller with an injected **mock** transport and
mock ownership/codec callbacks. That test proves mount/disposal plumbing, not
pinned server codecs, remote release or browser/manual QA. A served harness still
must supply real identity/source checks, pinned codec parity, a rendering surface,
deadline/ownership supervision and complete evidence export. No placeholder
callback may be reported as live proof.

## Remote admission/drain source review

Read the baseline four lifecycle/source-review reports and its retained numbered
source excerpts under `.diagnostics/opencode-reuse-source-review-20260930/`.
This phase reviewed those excerpts; it **did not freshly hash the packaged bundle**
or run an OpenCode core harness. Prior review identifies packaged 2.0.3 server
SHA-256 `1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929`.
Current V2 API docs were consulted, but their `/api/location/reload` and experimental
wait spelling are not substituted for the pinned package's contract.

| Pinned boundary | Consequence |
| --- | --- |
| RcMap invalidate 15614–15627 | Removes cache key first; returns with positive refs; only zero-ref path joins entry scope close. |
| Location map 552774–552815 | Infinite idle TTL; invalidate plus RPC close is not an all-reader reference-release receipt. |
| Debug 557373–557378 | Lists keys and invokes invalidate; absent key/204 cannot establish finalization. |
| Coordinator 81953–81982 | Interrupt forks cancellation; awaitIdle joins execution coordinator, not arbitrary HTTP scopes, independent PTYs or all children. |
| Location identity 442619–442647; requestRef 555262–555267 | Directory plus optional workspace ID; not source generation. Default cwd is unsafe routing for `/workspace`. |
| Session create 452206–452243 | Caller-provided existing session ID can return persisted session; parent can inherit location/settings. Always create a fresh root and independently verify it. |
| Module import 83806–83823 | Main-context loader does not promise module-cache invalidation. Changed plugin/module/dependency/environment needs restart. |

The earlier offline RcMap safe zero-reader ordering test is dependency evidence,
not proof of remotely released OpenCode HTTP scopes. A successful local disposal,
active-empty session list, normal DELETE or debug-key disappearance is not a
remote reference/finalizer receipt. Same-directory project identity and persisted
old sessions are expected; neither establishes a new source generation. Old
inventory is not inherited chat history when a genuinely fresh root is selected.

### Integration options (proposals only, shared source not edited)

1. **Server-owned generation lease/drain (preferred prerequisite for general
   retention):** exclusive owner capability, generation token and monotonically
   increasing epoch keyed to canonical location. Freeze must atomically reject
   *all* new old-epoch acquisitions, including plugins/RPC/session children,
   direct clients, async/background work and shells/PTYS. Track leases through
   response scope/finalizer completion, not merely handler return/body delivery.
   Drain must join tracked readers and owned executions; then joined eviction
   must finalize the exact old entry before exposing incoming acquisition. Return
   a receipt bound to owner, process, location, old epoch and finalization, with
   errors retained. Reject stale tokens/callbacks; never reacquire the same key
   while old refs remain. Do not expose raw RcMap refcount as a raceable gate.
2. **Restricted normally-consumed inference pilot:** exclusive known callers and
   source-reviewed finite handlers, unchanged process identity and no execution
   ever admitted. Can only support the specific reviewed normal-completion
   workload. Global SSE must be independently source-reviewed and locally joined.
   Cancellation/concurrent untracked readers fail admission. Any remote-zero-ref
   conclusion remains source-derived inference, not a receipt. This preparation
   has no reset authorization or live port of the full mounted cohort.
3. **Restart fallback:** mandatory default for changed identity or unsupported
   ownership/execution. After failure/timeout, freeze admissions and retain failed
   ownership; **do not write source, evict, acquire or start a replacement** while
   shutdown/drain is uncertain. Restart only after positively joined owned process
   exit, both output drains and zero-work diagnostics. If shutdown cannot join,
   stop and escalate; a forced kill must not masquerade as clean lifecycle proof.

Minimum toolkit API proposals: awaitable attachment release/cache invalidation
(not merely controller disposal), an exclusive switch owner that freezes both
outgoing and incoming admissions, selective chat retention without `stopRuntime`,
and a remote-generation lease/drain receipt interface. These are integration
recommendations, not edits to siblings' controller/runtime/cache APIs.

Cancellation, concurrent reader cancellation, session children, tool finalizers,
PTY/background shell shutdown, plugin callbacks and independently owned clients
are **unqualified blockers**. No paid inference is authorized to test them. Use a
supported controlled non-inference server/core fixture to exercise real finalizers;
if unavailable, keep that general gate false rather than fabricate a transcript.

## Validation

From `examples/todo-app/tests`:

```sh
bun test ./sk-opencode-retention-prerequisites.test.ts ./sk-opencode-retention-mounted-candidate.test.ts
```

Final: **12 pass, 0 fail, 99 assertions**, offline only. Negative policy tests cover
every identity field and ownership blocker, concurrent admission, abort ignored by
transport, finite body EOF, deadline with late response, failed local finalizer,
HTTP/JSON/body/active-session failure, forbidden routes and permanent closure.
Mounted mock test verifies actual fresh controller hydration, raw records and SSE
cancellation with no DELETE/tool/prompt request. Focused strict/noUncheckedIndexedAccess
TypeScript check includes all four files and imported controller sources; passes.

Development history is not hidden: seven initial test-process timeouts occurred
before identifying a test assertion deadlock (asserting a pending rejection before
driving the deferred producer). Replacing early pending assertions with attached
catch handlers resolved it; the isolated prerequisite suite then passed 11/0.
First mounted test failed because the controller's session routes did not all carry
location routing; supplying `/workspace` in the controller endpoint query corrected
that admission failure. The final combined suite is 12/0. One initial root-level
typecheck command failed because root `node_modules/.bin/tsc` was absent; the
example's installed compiler passes. No dependency install/build/pin mutation.

## Minimal live qualification plan — pending parent coordination

1. Wait for sibling fixes and parent authorization of **one new isolated origin**,
   exclusively parent-owned Bun Browser Control CLI (headless where practical).
   No existing browser/host/origin or OPFS reuse. Prepare a separately built served
   consumer; reverify runtime/server/payload identity without editing frozen assets.
2. Mount the actual candidate controller on A0 with real pinned 2.0.3 codec parity,
   source/config/plugin/dependency identity, raw finite evidence and new root
   proofs. Exercise rendered/manual chat readiness, idle/empty session and cleanup;
   no prompt/model/tool work. This alone qualifies only mount, not retention.
3. Before an A0→B1 retained transition, parent must explicitly select a reviewed
   restricted finite-handler plan or land/qualify a remote generation drain API.
   Freeze prospective routes, ownership, budgets, no retries/replacement, marker
   writes and process/PID/session assertions. Current serial gate is not a drop-in
   adapter for concurrent controller bootstrap; full mounted restricted routes,
   streaming exclusions and pinned codecs need separate review. Missing gate means
   stop at mounted qualification, not accepted reuse.
4. If admitted, one source-only A0→B1 attempt: freeze old admissions; join normal
   finite handlers, local controller/SSE and applicable remote drain; evict only
   after the chosen reviewed boundary; await finalization before source write and
   incoming acquisition. Verify unchanged PID/execution/endpoint/credentials,
   source B1 marker, immutable config/plugins/dependencies, distinct fresh root,
   empty messages/settings, no stale callbacks and separately persisted A0 history.
   Explicitly label restricted inference vs remote receipt in exported evidence.
5. Join final owned guest shutdown, execution exit and stdout/stderr drains; verify
   zero guest processes/listeners/pending HTTP. Parent then coordinates combined
   workspace-switch stress after other candidates pass; it is not authorized or
   performed by this preparation. General cancellation/tool/PTY gate remains false
   unless independently exercised with supported non-inference fixtures.
6. Supervise **owned host cleanup and initiator exit separately**. The baseline
   retained host-child bug caused a post-completion 900 s orchestration timeout;
   its unref fix was offline-only. Prefer an explicitly owned host shutdown/join
   with listener-absence proof after evidence export. If intentionally retaining
   hosts, validate unref and initiator exit live and record retained ownership; do
   not assume guest cleanup makes the whole harness complete.

Live runs/manual QA/retention transitions/combined stress in this phase: **0**.
This pending validation is a barrier, not an accepted performance/safety result.
