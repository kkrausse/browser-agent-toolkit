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

Committed-source archive and fresh runnable stage identities will be appended after
offline preparation. Candidate requires committed `691cd5a` chat repair ancestry;
uncommitted sibling integration is excluded. Isolated library/declaration/consumer
builds never overwrite shared dist/lib/.runtime. Focused tests protect the observed
SDK null fixture, pre-rejection body capture, strict ownership/location fences and
cleanup error remaining failure. No generic unit-test scaffolding.
