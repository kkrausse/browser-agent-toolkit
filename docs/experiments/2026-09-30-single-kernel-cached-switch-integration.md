# Cached TODO switch integration: shutdown proof blocks admission

Report: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-cached-switch-integration.md`

## Outcome

**No retention-on adapter or flag was shipped.** Default conservative switching,
durable outgoing source/native-session capture, incoming pending journal, identity,
session hydration and final catalog ordering remain unchanged. Both services still
restart; the already-retained workspace/kernel is not a new treatment. No live
process/location reuse, paid inference, browser/server start, origin/storage/host
mutation, canonical pin change or shared generated-output replacement occurred.

Built the complete current TODO UI against separately built library JavaScript and
emitted declarations from committed source, including `691cd5a` chat repair and
`d1f60e4` library prerequisites. The full consumer and strict checks pass offline.
This is **off-only build evidence**, not a qualified on/off pair or a live result.

The remaining stop-proof issue is outside the assigned app/bootstrap ownership:
public endpoint closure does not join its upload source's asynchronous cancellation.
An explicit committed-runtime characterization reproduced that boundary. A
`servicesStopped: true` literal, endpoint `closed`, fetch rejection, empty kernel
process inventory or successful controller stop cannot substitute for that join.

## Concrete supported-API gap

Read the real sources and the frozen `e35eab4af7a53ff08eb70c09df59c40b78bfdd67`
host SDK archive, rather than inferring execution lifetime from a stub:

- `workspace-api/src/react.tsx:127–135` retains both service drains;
  `214–219` retains exit/drain settlement; `280–292` joins launch/service/settlement
  ownership before releasing the runtime. A cleanup rejection forbids proceeding.
- `workspace-api/src/runtime.ts:68–75` aborts endpoint lifetimes and joins pending
  launches and execution stops, but exposes no endpoint HTTP-source cleanup join.
- Frozen `packages/core/src/host-sdk/execution.ts:61–64,90–94`: execution stop
  awaits the exit notification; exit ends both byte queues. Ending the queues is
  not consuming them, so the controller/library reader joins remain necessary.
- Frozen `packages/core/src/host-sdk/browser/endpoint.ts:16–21`: disposal aborts
  its lifetime and immediately resolves `closed`.
- Frozen `packages/core/src/host-sdk/browser/http-stream.ts:12–19`: cleanup calls
  `void upload?.cancel().catch(() => {})`, then calls `onClose`. Neither pending
  `upload.read()` nor the cancellation promise is a public shutdown receipt;
  cancellation rejection is swallowed. The public `Endpoint` type has only
  synchronous `dispose()` and `closed: Promise<{reason}>`, not a cleanup join.

New characterization:
`examples/todo-app/tests/cached-switch-endpoint-stop-proof.mjs`.
It imports the **built committed host SDK's public `createEndpoint`**, creates a
real streaming `Request` upload whose cancellation awaits an explicitly held
promise, and aborts the endpoint runtime lifetime. The only substitute is the
message transport: no guest/kernel/server is run. Assertions observe endpoint
closure and fetch rejection while cancellation is unfinished, then release and
join the fixture's cancellation and close its ports. No fixture/private runtime
state is promoted into a production ownership guarantee.

Observed output:

```json
{"endpointClosed":true,"fetchRejected":true,"uploadCancelStarted":true,"uploadCancelJoinedAtClose":false,"stoppedOwnershipProven":false}
```

This is a **demonstrated supported streaming-input counterexample**, not a claim
that the current TODO's ordinary JSON requests have caused a live overlap. It also
does not prove that every conceivable narrowly constrained consumer is impossible.
A separate exact request-source proof excluding asynchronous upload owners could
admit a narrower fixture. Such an exclusion has not been proved across all current
chat/client/plugin request paths, and a package/config byte comparison cannot prove
it. Under the requested all-fetch/reader/stop-joins contract, the existing public
shutdown API alone is insufficient. Do not force an apparently functional on flag.

Needed owner prerequisite: a supported join that retains every endpoint request's
upload read/cancel work and failure through disposal, and is awaited by runtime /
controller shutdown. It must not resolve merely on abort dispatch, headers,
endpoint `closed` or kernel inventory disappearance. Cancellation failure or an
unresolved source must leave ownership unproven. This touches separately owned
runtime/controller code, so it was not patched here. Disk retention restarting the
whole OpenCode process is distinct from the other experiment's location-eviction /
remote-reference proof; that experiment's remote drain is not substituted here.

## Bootstrap review and admission boundary

The known helper path remains unsafe without an owner fence:
`runEnvironmentScript` installs its hash-named file with `ToolContext.installFile`;
the runtime implementation uses following `stat`/read/write at the destination and
does not lstat-check its ancestors. Auditing inside that script is too late to
protect its installation. No helper was run against a real workspace here.

There is a possible narrow app-side path using public `diagnoseWorkspaceEntry`
**after proved shutdown**: validate `/workspace` (workspace-relative `/`), the cache
directory, experiment directory and all existing helper leaves, refusing links,
unknown kinds/names, enumeration failures and budget overflow; validate receipt
ancestry/leaf independently. Keep exclusive stopped ownership through installation.
Do not treat arbitrary exceptions as absence, remove unexpected user objects, or
claim lstat solves concurrent TOCTOU. A tree installer also uses lstat-safe ancestor
validation in this pinned runtime but replaces its declared roots; it is not
permission to delete a tampered helper tree containing unknown user data.

That fence alone would not repair the endpoint join. Consequently no bootstrap API
expansion, unsafe attestation or source mutation was added as a partial integration.
The byte-only preparatory admission helper remains explicitly unwired and is not a
retention permission. Legacy snapshots with excluded managed paths still reject
before disposal/stop/clear rather than silently discarding user data.

Required eventual adapter identity remains byte-exact, not version-only:

- preparation manifest/provenance, managed entries/roots, bundle and image lengths
  and SHA-256, backend policy/archives and actual runtime distribution/assets;
- package/locks/config presence and bytes, known transitive config/plugin inputs,
  launch entry/args/cwd/env, generated OpenCode/model configuration and origin inputs;
- durable outgoing logical identity matching the active catalog and exact incoming
  source recursive path set/bytes, including additions, deletions and renames.

Arbitrary project/plugin compatibility is not established. A future narrow TODO
fixture must freeze the known config import boundaries (including local imports),
reject unknown config/environment/transitive/plugin inputs, and not merely compare
the current `retainedEnvironmentInputs` list. A/B agreeing on unprepared bytes is
insufficient. Recovery/retry always selects conservative replacement.

Retained cache policy, if eventually admitted, must explicitly name
`/workspace/node_modules/.vite`, `/workspace/node_modules/.vite-temp` and only the
qualified external `/workspace/.browser-editor-cache/vite` root. Library maxima
remain 10,000 entries, 16 MiB/file, 64 MiB total, depth 32. The before/after successful
immutable-tree audit and equal sorted cache inventory digest cover absence, names,
topology, modes, sizes and contents, not mtime/inodes. Bind audit and replacement on
a fresh tools-only runtime **before apps delivery**, then restart both services with
fresh executions/endpoints. No such interval was executed or qualified by this task.

After a proven invalid audit/compatibility result, conservative clear/restore /
redelivery may proceed only after every owned operation joins. Cancellation,
ownership failure or unknown cleanup proof retains pending and forbids fallback.
Incoming identity, native-session mapping/selection/hydration and final durable
catalog commit are still prerequisites to clearing pending. This report describes
the required adapter, not newly implemented rollback behavior.

## Offline build, tests and immutable-source evidence

Successful unique stage:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/cached-switch-consumer-MGBmBw`.

Retained `stage.ts`, `source.tar`, `host-source.tar`, command logs, built `workspace/`,
`chat/`, `host/`, full `client/`, emitted declarations, strict configs and `stage.json`.
Source archive is exact toolkit commit `3a34772c2f5cf113ae992e60ad2bb9de7cd46e7e`;
host archive is exact frozen runtime commit e35 above. Toolkit package source is
never resolved from mutable checkout source in the final consumer. Ordinary installed
third-party dependencies are reused read-only via node_modules links; this is not
a freshly installed tarball/package-manager-lock reproducibility claim. Built bytes
are hashed in `stage.json`. CSS is compiled from archived source into the isolated
stage, not read from or written into shared `dist`.

| Evidence | SHA-256 |
| --- | --- |
| Committed toolkit source archive | `a1ded1e6eb23fc87d635d55009d8ce853513a343ce7f438c39e58dad75c034d2` |
| Committed host source archive | `4059a0acf14f197d0bdce2207490fe596560217ecdad41b947b06ae397df5372` |
| Frozen input receipt | `112f16cdfd83a8da5ee60827f9b0ddf6814903276835bad71e8a5b50d8bf4ad9` |
| Full off UI JavaScript | `6f9695a4add6d7a9837d97e357d083e4e5c17b3aaf8bf902265f68cd8a7a544c` |
| Full off UI CSS | `3001957bde872c351aa2d5440ceb8605171fc7f7a9b4bf19ab117a705dc1c051` |
| Built host SDK used by characterization | `64e6a12afd0ec7a5dda9f3b63f015b38b8bc962ed1b0bb6af8de1d269baebef3` |

All frozen input receipt hashes were verified before building. Runtime version is
`bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`;
runtime `distribution.json` hash is
`94a50946622e2095536c30bf42d4cbcb03c6e7c74f33caec9e5503e4afa129a0`.
This is staging verification, **not runtime app-admission code**.

Validation passed:

- Separate browser-target workspace index/react/diagnostics/delivery, chat
  index/browser/controller/editor/react and pinned host SDK builds.
- Full TODO `single-kernel-live-client.tsx` bundle consumes built library JS only.
- Strict workspace/chat declaration emit; strict full app consumer check against
  those emitted package declarations. No app source alias to library implementation.
- Endpoint characterization against the separately built archived host SDK.
- Existing focused suites: **59 pass, 0 fail, 297 assertions** across environment
  experiment/ownership/delivery, cached ownership, source admission, switch and
  native-session fixtures. No new hypothetical unit tests were added.

First stage attempt at `.../cached-switch-consumer-pMGAKA` failed full UI resolution
because the archived app lacked its read-only dependency link (`valibot`). Preserved
that partial stage, added the app dependency link to the staging recipe, and ran the
complete build in the new unique MGBmBw directory. No frozen/canonical artifact was
overwritten. The retained staging recipe is scratch evidence, not another committed
shared harness. It does not install/download packages or start a server/browser.

## Parent handoff

Characterization commit: `3a34772`. Report is committed separately, own paths only;
no push. Sole visible browser ownership remains with foundation QA session
`ses_f0c3017fcffemJ1wewPHKzo46p`; this task did not consume a live slot.

**Runnable retention-on fresh-origin candidate is unavailable safely.** The stage
has complete off client/library bytes but is not a served/qualified whole-origin
candidate. No matched-pair timing, manual/headless browser QA, stress or performance
guarantee follows from this build. Parent should coordinate the endpoint-owner
prerequisite (or exact request-source exclusion proof), then assign integration and
new frozen off/on origins. Do not compare these off bytes against a no-op on flag.
Prior 32.153→15.456s medians are historical observations, not an expected guarantee.
