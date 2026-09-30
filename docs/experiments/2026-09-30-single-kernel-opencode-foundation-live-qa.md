# Independent pinned OpenCode foundation live QA — failed cohort

Absolute report:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-opencode-foundation-live-qa.md`

## Outcome

**One visible live cohort, one failure, zero passing mounted qualifications.**
The actual controller's first native-root POST was rejected by the staged harness
with **`Unexpected root create settings`**, before guest transport. No retry,
validator modification, replacement origin, manual admission, host-join request,
DELETE, source replacement or retention transition occurred.

`remoteZeroRef:false`, `retentionAccepted:false`. Eleven earlier finite guest
responses passed actual delivered-server status/header/body codec parity, including
independent offline re-execution of all eleven records. These bounded positives
are not a mounted-controller or clean lifecycle pass.

The failed screenshot was independently opened and visually reviewed: **Native
selected session: None**, disconnected controller, empty sessions/messages and
**execution unknown**, not accepted idle hydration. Start is disabled; admission
was never reached. This is not ChatView/composer/new-chat qualification or
qualification of the later `691cd5a` chat repair.

## Frozen identities and ownership

Stage/evidence directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-f50f5e6f-037b-48ac-9a14-5542b35c9e9a`

| Item | Actual identity |
| --- | --- |
| Archived toolkit source | `874e759ae83b26224ae165c14c2e8c2a193d1aed`, ancestry `55ae98c`, not later repair |
| Source archive SHA-256 | `e4307babf53e2eb09aa6148e58b7e9ebeebca02a688fc33bb48b982623f008fa` |
| Served consumer SHA-256 | `1643ee95328e6c1b45750108ca049d3f993c8cab858923e3557215dd950c1259` |
| Delivered SK server SHA-256 | `648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5` |
| Baseline server (not executed) | `1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929` |
| Runtime revision | `e35eab4af7a53ff08eb70c09df59c40b78bfdd67` |
| Runtime/payload version | `bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e` |
| Fresh OS-assigned origin | `http://127.0.0.1:60643/` |
| New Browser Control session | `sk-foundation-qa-20260930-1936` |
| Initiator / host OS PIDs | `85822` / `85823` |
| Guest PID / PPID / listener | `1` / `0` / `4096` |
| Guest command / cwd | `/bin/node.js /bin/bun.js /app/server.js` / `/app` |
| Listener identity | `9d952017-b76d-47a0-bf71-6827173b8181:1` |
| Initial A0 source marker | `sk-mounted-A0-7ace72b7-f08c-4923-a484-12e43213c196` |

Before host launch, independently hashed all **9,588 frozen receipt files**, all
**63 generated/source entries**, frozen receipt, and manifest file/image/bundle
bytes and lengths. Re-created `git archive` in memory and compared its digest to
the staged archive. The source and generated hashes plus 9,588 frozen files were
independently rechecked after failure. No existing bytes were changed.

Exact authorized host command, executed once as owned background shell
`sh_0f3d180b3001rzjn2FFnbLk1aj`:

```sh
SK_OPENCODE_AUTHORIZE_HOST=yes bun examples/todo-app/tests/sk-opencode-live-host-owner.ts \
  /Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-f50f5e6f-037b-48ac-9a14-5542b35c9e9a
```

Browser Control **0.8.2**, Bun **1.4.0**; all browser operations used
`bun /Users/kkrausse/.nvm/versions/node/v24.7.0/bin/browser-control`.
The actual visible browser reported Chrome/154.0.0.0 in its user agent. This used
the existing extension-connected profile, not a pristine profile or headless run.
No MCP, relay restart, user-tab adoption, profile/storage clearing or browser switch.

## Inspect / act / verify and first failure

1. Verified new session `about:blank`, then navigated to `/inspect-empty`.
   OPFS, IndexedDB databases, caches, Service Worker registrations and localStorage
   were empty. Session storage contained **`__darkreader__wasEnabledForHost`**;
   this extension marker was honestly recorded and not removed. It is outside the
   candidate's app-storage preflight. A favicon 404 was recorded, not hidden.
2. Navigated to `/`, inspected the semantic snapshot: no autostart, selected root
   None, unmounted snapshot, ordinary enabled Start and disabled admission.
3. Clicked **Start one owned qualification** exactly once through a normal locator.
   Actual attempt count was one. Short serial read-only status observations followed.
4. Owned server reached listener readiness (9,628 ms) and connect readiness
   (2,318 ms); health was `{healthy:true,version:"2.0.3",pid:1}`. Actual startup
   stdout includes database bootstrap, `OPENCODE_SERVER_PROCESS_READY`, a startup
   unauthenticated `/` readiness probe returning 401, location boot, and real plugin
   loading. No guest stderr was recorded before failure; neither guest output
   drain was joined. These are observations, not absence-of-errors proof.
5. Source/config/plugin hashes were collected before launch and rechecked by the
   candidate's first identity census after launch. Census showed exactly one guest
   process/listener, no worker errors, no pending HTTP, single-kernel topology.
   Initial native inventory was empty; real JavaScript/model-header plugins were
   active, configured proxy marker/catalog admission passed. Later after-mount
   source recheck, final health/PID stability and root inheritance checks were **not run**.
6. Controller bootstrap consumed catalog/inventory/default-model responses and
   opened global SSE. Its fresh-root create request failed in the harness's body
   validator. Full nested error is retained, with underlying
   `Error: Unexpected root create settings` at staged consumer line 49660.
   The controller became disconnected; no native session ID was selected.
7. Candidate exported terminal `status:"failed"`; observed `exported:true`.
   No confirmation click or wait-to-green was used. Screenshot and full observed
   state were saved before destruction of the owned page.

## Raw response and network evidence

`codec-0.json` through `codec-10.json` retain full original Fetch-visible status,
header pairs, base64 body bytes, SHA-256 and joined codec-process stdout/stderr/exit.
All eleven body digests were independently checked. All eleven actual pinned
HttpApi executors exited zero; each was independently re-executed offline with
joined output drains, retaining results in `qa-independent-codec-recheck.json`.
No parity claim relies only on a caller boolean. Actual serializer compares status,
complete body bytes and every serializer-owned header against the guest record.

| Finite route | Count | Status / body lengths |
| --- | ---: | --- |
| GET health | 1 | 200 / 42 |
| POST plugin await-activation | 2 | 204 / 0 each |
| GET session inventory | 2 | 200 / 50 each |
| GET project/current | 1 | 200 / 99 |
| GET config | 1 | 200 / 1,010 |
| GET plugin | 1 | 200 / 10,299 |
| GET model | 2 | 200 / 5,699 each |
| GET model/default | 1 | 200 / 1,360 |

Codec stderr contains Node's experimental SQLite warning, retained verbatim.
These are normalized Fetch bytes, not TCP bytes/original header casing/order.
Global SSE returned 200 and remains `locallyJoined:false` in failed evidence.

Additional Browser Control network capture started **after launch**, at
19:37:51.630Z, and stopped before failed-state preservation: 8 entries, 7 responses,
1 failure, 242,755 body bytes, zero truncated/dropped entries. `qa-network.har`
uses redacted secret references and its separately owned secret profile is named
`sk-foundation-qa-20260930-1936`; no secrets are copied into the report.
This is a partial capture, not full startup coverage. Capture-time execute output
was automatically redacted until capture finalization; subsequent inspection
observed the terminal failure, not a second start.

**Evidence gap:** the staged validator consumed but did not retain the rejected
request's raw body. Because rejection happened before guest/network transport,
there is no guest POST response or recoverable live request body in these records.
Do not fabricate one or call the following offline reproduction recovered bytes.

## Precise repair proposal — not applied

Staged SDK `EndpointSessionCreate` constructs all optional payload fields even
when undefined; the actual pinned schema encodes them as explicit **null**. A
pure offline schema encode of the staged SDK-shaped input reproduced:

```json
{"id":null,"title":null,"agent":null,"model":null,"location":{"directory":"/workspace"},"metadata":null,"permissions":null}
```

`qa-offline-create-schema.json` explicitly labels this **offline-schema-only**, not
live-request recovery. The staged location-only key allowlist rejects this pinned
wire representation. Proposed follow-up: capture complete request bytes before
validation, validate the actual pinned request schema and explicit directory/no
workspace routing, and require optional setting fields to represent absence while
still rejecting non-null ID/title/agent/model/metadata/permissions and unknown keys.
Protect this concrete failure with an actual SDK/pinned-wire fixture. Do not merely
remove the allowlist or accept arbitrary root settings. No fix or new test was made
by this QA agent; a reviewed fix must create a **new stage and new cohort**.

## Failure cleanup and ownership release

After terminal state, full error/response records, screenshot and network capture
were preserved, only the newly owned Browser Control session was deleted. This
**destroys the page/guest ownership; it is failure cleanup**, not stdin-EOF shutdown
or joined guest execution/stdout/stderr/SSE/zero-work proof. Guest lifecycle
acceptance remains unrun; page absence cannot supply it.

The host's `/host-join` was **not requested**, because failed evidence cannot pass
its positive guest-cleanup gate. Verified exact host PID command and stage ownership,
then sent **SIGTERM to owned host PID 85823**, not the relay or another host.
The initiator joined child stdout/stderr and recorded **host exit 143**, then
reported `Owned host failed` and completed with **exit 1**. Its actual background
completion notification was observed and copied to `qa-initiator-completion.txt`.
This is forced failure cleanup, not clean host acceptance.

Independent final receipt `qa-failure-absence.json` verifies both OS PIDs absent
(`ESRCH`), listener 60643 absent (`ECONNREFUSED`), own session absent and own target
absent. Other sessions/origins were not adopted, navigated, modified or deleted.
**Visible Browser Control ownership is released.** No further live operations are
pending from this agent. Retained app-origin storage is not cleared.

## Evidence index and unqualified scope

Within the absolute stage directory above:

- `qa-preflight.json`, `owned-origin.json`, `host-initiator.json`.
- `qa-empty-origin.json`, `qa-browser-journal.jsonl`, `qa-network.har`.
- `live-evidence.json`, `qa-observed-state.json`, `qa-observed.png`.
- `codec-0.json` … `codec-10.json`, `qa-codec-review.json`,
  `qa-independent-codec-recheck.json`, `qa-offline-create-schema.json`.
- `qa-failure-cleanup.json`, `host-process-join.json`,
  `qa-initiator-completion.txt`, `qa-failure-absence.json`.

No model inference/provider invocation, prompt, tool/execution RPC, source
replacement, API DELETE, reset, reuse, paid operation or dependency/pin mutation.
Catalog/default-model reads are not model inference. Root inheritance, message/
permission/form hydration, rendered idle admission, after-mount identity stability,
guest normal EOF exit/output drains/zero work, clean host join, retention, headless,
ChatView, later chat repair and combined workspace switching remain **unqualified**.
Headless Browser Control launch is unsupported by this CLI; no shared-browser
switch or invented option was used. A separate isolated runner may be proposed
after repair/review, but none was run here.

Only this new report is committed; QA evidence is retained locally in the ignored
diagnostics directory. No staged/client/source, app/chat/cache/runtime/audit/parent
document changes and no push.
