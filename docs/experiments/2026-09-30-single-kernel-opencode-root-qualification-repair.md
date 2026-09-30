# Pinned OpenCode root qualification repair — offline only

Absolute report: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-opencode-root-qualification-repair.md`.

## Outcome

Qualification-only repair of the concrete `b5daa94` cohort's local root-request
guard failure and rejected-body evidence gap. **Live qualification pending NEW
independent QA.** No browser/host/guest server started; no prompt/tool/model
inference, reset, DELETE, A→B, source replacement, storage clearing or eviction.
`retentionAccepted:false`, `remoteZeroRef:false` remain mandatory.

The original stage and failed evidence are immutable/read-only inputs, not repaired
in place. Its eleven passing finite codec responses and forced failure cleanup
remain bounded observations. No recovered failed POST body is invented.

## Reviewed actual contract and repair

Read staging and FAILED foundation reports and delivered lifetime audit `4b3738d`.
Reviewed actual frozen 648 bundle's root payload (517546–517561), create handler
(556223 onward), requestRef (555263 onward), RcMap release (15524 onward), global
ModelsDev repeat (538288 onward), and entrypoint `models:{fetch:true}` (558831).
Installed pinned 2.0.3 Effect SDK generated `EndpointSessionCreate` builds all seven
optional payload fields. Its actual schema serializes undefined id/title/agent/
model/metadata/permissions as null. The payload's `location` must explicitly contain
`directory:'/workspace'`: query-only routing is not creation ownership.

`sk-opencode-live-fence.ts` admits null/undefined ONLY for those six known setting
fields, rejects non-null settings, unknown keys (even null parent/fork), existing
IDs, ambiguous/duplicate JSON keys and alternate directory/workspace routing.
Location.Ref and Session.Info use the DIFFERENT optionalKey codec: workspaceID and
root parent/fork/agent/model/metadata/permissions/subpath/revert/outcome must remain
absent, not blanket-null accepted. Live root payloads also execute the actual 648
request schema decoder in the isolated Node codec worker; no caller parity callback.

Every attempted method/URL/complete Fetch body bytes/length/SHA-256 is retained in
memory and independently persisted as `request-attempt-N.json` BEFORE semantic
admission, including rejected attempts. Auth headers are omitted; credentials are
not copied. `finite-response-N.json` independently preserves finite status/full
Fetch headers/body/hash before HTTP status, abort, codec or semantic assertions.
These are normalized Fetch bytes, not TCP bytes. Existing response codec strict
status/body/serializer-owned-header parity is unchanged.

Initial global inventory is only available after fresh-origin, committed client,
frozen A0 source/caller admission, before owned-root establishment; native inventory
must be empty. Create is one-shot. Its actual codec-qualified response must supply
a fresh root ID, correct project and explicit workspace location with no inheritance.
That ID is owned BEFORE controller hydration proceeds. Session reads then require
that EXACT ID; arbitrary matching ID regex is no longer request authorization.
Messages/permissions/forms and global active execution must be natively empty;
controller/rendered idle selection must agree with that root.

## Distinct guarded failure cleanup

Terminal failure is saved to `failed-before-cleanup.json` BEFORE disposal. Only a
known returned service/workspace may attempt local controller/SSE disposal, finite
request joins, that guest's stdin EOF, joined exit/output readers, non-forced clean
exit, zero-work census and workspace close. Each step is bounded; error/uncertainty
stops further release and forbids replacement/eviction. No forced stop fallback is
used by the added EOF path. Ambiguous launch ownership is retained.

Only a preserved FAILED cohort with completed guarded guest cleanup can use the
distinct `/failure-host-join`. Host initiator joins child stdout/stderr/exit and
verifies listener absence, then still exits nonzero: cleanup never turns failure
into a qualification pass. Parent must observe initiator completion. Failed cleanup
cannot use either host-join path. Existing forced-SIGTERM cohort remains failure,
not clean guest/host qualification.

## Remaining exclusions

Actual delivered global repeating ModelsDev refresh makes `backgroundWork:false`
invalid. No delivered server replacement/patch to suppress it. Actual 648 retains
the positive-ref invalidate/same-key reacquisition hazard and lacks server-owned
ref/generation/finalizer receipts. Catalog, activation, local EOF/disposal and codec
parity are NOT remote drain proof. Only A0 foundation is staged; no retention,
headless, ChatView or general lifecycle acceptance is claimed.

## Build and focused regression validation

Candidate requires committed `691cd5a` chat repair and `d1f60e4` helper ancestry;
uncommitted sibling integration/lifecycle repairs are excluded. Isolated library/declaration/consumer
builds never overwrite shared dist/lib/.runtime. Focused tests protect the observed
SDK null fixture, pre-rejection body capture, strict ownership/location fences and
cleanup error remaining failure. No generic unit-test scaffolding.

Final fresh runnable stage (no origin receipt exists):

`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-fe10b82e-932f-40ff-b249-171bc7c8cdbf`

| Identity | Value |
| --- | --- |
| Committed candidate source | `6f88410877d1027bb5fb7bbd9851a82de431356b` |
| Source archive SHA-256 | `fdf775fb7578669c99fb4648dd885cca852412843cc21ef5760dd055b0f1915b` |
| Consumer SHA-256 | `1b4e7e5a98b586033a08691cac9f74833d536cf3c8a9a64343d2bf175e1878d7` |
| Actual delivered server SHA-256 | `648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5` |
| Actual extracted codec SHA-256 | `8ae896cd21951fd8370239d0de61b0e61ea470cc9196f32c40df7c72000fca61` |
| Runtime revision | `e35eab4af7a53ff08eb70c09df59c40b78bfdd67` |
| Runtime/payload version | `bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e` |

Executed `SK_OPENCODE_SOURCE_REVISION=6f88410 bun examples/todo-app/tests/sk-opencode-live-prepare.ts`.
Separate Bun library and consumer builds, workspace/chat declaration emit and strict
consumer TypeScript check all passed. Preparation verified **9,588 frozen files**,
prepared asset hashes/lengths and actual server pin; final **66 staged/source hash
entries** were rechecked after tests. No shared generated library/runtime output.

Ran the **staged committed-source** root-repair and existing staging suites:
**21 pass, 0 fail, 85 assertions, 9.53 s**. The observed failure regression executes
the same committed API adapter/pinned Effect SDK's real outbound serializer with a
strict offline capture-only transport that deliberately throws (no network). Its
complete body equals the actual delivered root payload schema's re-encoding,
including explicit nulls. This is a fixture, NOT recovered live request bytes or
native-root qualification. Existing actual response parity fixtures remain strict.
Authorization-negative subprocesses exit before any listener is opened.
`offline-root-repair-tests.json` retains actual stdout/stderr/exit with both drains
joined; `liveRuns:0`. Node's SQLite warning remains observable in codec executions.

Intermediate stages `sk-opencode-live-ed49a35b-ac7b-4991-af04-85921c404009` and
`sk-opencode-live-35a55a39-901c-4cd3-9435-63b766abd473` also built/tested successfully
but are superseded, preserved, and NOT the live handoff. The final source additionally
captures closed/poisoned attempts before rejection and prohibits late guest admission.

## Independent live handoff — pending parent ownership, NOT executed

Parent alone assigns the NEW exclusive live slot. Rehash this final stage, frozen
receipt/assets and archive against committed source before any start. Use a NEW
Browser Control session and a NEW origin only; existing failed stage/cohort is not
reopened. After that separate authorization, the frozen host initiator is:

```sh
SK_OPENCODE_AUTHORIZE_HOST=yes bun \
  /Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-fe10b82e-932f-40ff-b249-171bc7c8cdbf/source/examples/todo-app/tests/sk-opencode-live-host-owner.ts \
  /Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-fe10b82e-932f-40ff-b249-171bc7c8cdbf
```

Existing staging report's fresh-origin inspection, single Start, visible manual
idle-root review and independent finite codec re-execution requirements still apply;
use ONLY the Bun-backed Browser Control CLI, no MCP. Successful terminal evidence
may request `/host-join`. A FAILED cohort must first retain failed-before-cleanup
and complete terminal evidence; only `failureCleanup.completed:true` with verified
non-forced clean guest exit, joined readers, zero work and workspace-close step may
request `/failure-host-join`. Independently inspect exact method/URL/body hashes,
schema worker/response codec exit/stdout/stderr, root/session ownership, cleanup
receipts, host joins/listener absence, and actual initiator completion. Failure
host initiator exits **1** intentionally even after host drains/absence join.
Uncertain cleanup stays failed/retained; no replacement, eviction or forced-clean
claim. Browser/user storage remains unaffected by this offline repair.

Source commits: `48d0507`, `20b505c`, `6f88410`; final report commit is separate and
does not change frozen candidate identity. All commits use explicit owned paths;
no production app/chat/cache/runtime/default/pin or parent-status edits; no push.
