# Two immutable source roots, shared config — runnable preparation

Absolute report path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-stable-root-shared-config-toy-preparation.md`

## Outcome

**Runnable offline-prepared; not live executed.** `runnablePrepared:true`,
`liveRuns:0`, `retentionAccepted:false`, `remoteZeroRef:false`.
Parent explicitly approved shared server config responses with unchanged actual
648 config/artifact identity. The earlier blocked root-varying config variant in
commit `6184166` and its report/preflight remain unchanged historical evidence.
This is a bounded alternative experiment, not a refactor decision or full editor
acceptance. No browser, host listener, guest/server, inference or native session
was started during preparation.

## Fresh frozen stage

Stage:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-stable-opencode-91f64fd6-4875-4412-a9f9-17371316f930`

- Committed toolkit source: `653bee9dc21f2f89e7b366f73b4f8b908d64bb67`.
- Frozen guest runtime: `e35eab4af7a53ff08eb70c09df59c40b78bfdd67`.
- Committed repaired host SDK: `724909bff00c9c0994ecde7c767a218ae2af25a0`.
  Toolkit ancestry includes `7713686`; new host declarations were emitted and
  consumed, not e35 declarations lacking `Endpoint.settled`. The preparer checks
  kernel-worker and kernel-filesystem source parity between e35 and this host
  revision. No shared runtime source or generated output was changed.
- Runtime/payload version:
  `bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`.
- Actual server:
  `648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5`.

The preparer verifies existing frozen receipt hashes and each managed payload's
hash/length read-only, archives committed library/consumer source into a new
directory, extracts committed host source, builds libraries separately from the
consumer, emits declarations and performs strict checks. Existing installed
dependencies are read-only resolution inputs with package manifest pins; this is
not a new whole-dependency-tree provenance claim. No archive, `.runtime`, vendor,
dist, prepared asset or existing stage was overwritten. Failed intermediate new
stages remain intact; none is the handoff stage above.

| Stage artifact | SHA-256 |
| --- | --- |
| committed-source.tar | `934b20e46c5a73e051bd60f92bcc37a4ba234ad9e716d2b40e0d8b985569b7db` |
| client/sk-stable-opencode-client.js | `efe1c8dad0be219e21968178e480b75271fefc3fa0866daa1f07dae799c65a6c` |
| pinned-codec.mjs | `8ae896cd21951fd8370239d0de61b0e61ea470cc9196f32c40df7c72000fca61` |
| sk-stable-opencode-codec.mjs | `735828989e9fb80dff50bed6cff2991e6fba7847a5d0cf043a51b51fbd4b81b8` |
| codec-fixtures.json | `f9f5e45f812ce091a2b82601bd22e85d7c605374a241ad4e4f41ad6829772dd0` |
| workspace/index.js | `afd411154f18099196ff73a754bfac8d764307e8887de2717a23652ae70074b1` |
| workspace/react.js | `089646f25473492f4fc268188f91073efb68ba7e6c01cd09169f886d35912483` |
| chat/browser.js | `de9c993c3e7fdf0ecad773b6a3fae809a0221e16f96b1aeba0503c8be7fd845e` |

Complete source/build/host hashes are in `stage.json`. The host verifies them and
frozen payload hashes before serving a new owned origin. No live evidence or host
join receipt exists yet.

## Exact experiment surface

New owned `examples/todo-app/tests/sk-stable-opencode-*` consumer/preparer/host/
codec files only; existing root-repair harness and shared libraries are read-only.

Trusted buttons are **Start A0 → Activate B → Return to A → Finish and join**.
Each action disables all buttons synchronously. Exactly one Workspace, Runtime,
managed delivery invocation and OpenCode launch precede activation. No Vite or
ChatController is created. Server cwd/code/DB and shared config paths retain the
existing qualified launch recipe; source roots are physically distinct
`/workspace/projects/A` and `/workspace/projects/B`.

Before launch, native origin storage must be empty, `/projects` must not exist,
and the client creates both owned roots through supported Workspace fs methods.
Each has a unique ordinary marker file plus distinct immutable `opencode.json`
bytes. Those root-local config files are **not discovered by 648**. Their bytes
are source-preservation evidence, not config API routing evidence. File/directory
types, exact root path sets and SHA-256s for both roots and shared config/plugin
files are rechecked at every transition, including the return to A. No rename,
remove, replacement, eviction, redelivery or old-path clear occurs.

Only these guest routes exist in the private transport:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Native process PID/version; not remote drain. |
| GET | `/api/config` | Actual shared frozen config bytes, expected unchanged. |
| GET | `/api/project/current` | Actual bare project response: ID/directory/canonical. |
| POST | `/api/plugin/await-activation` | Location activation barrier; not global background completion. |
| GET | `/api/debug/location` | Read-only cached location directory keys; never DELETE. |

Actual 648 protocol `455032–455052` defines optional nested location.directory
and OpenAPI deepObject query encoding. Middleware `555263–555282` reads exactly
`location[directory]`, before header/cwd fallbacks. The client uses one exact
absolute spelling for each root, explicitly on **every** request, with no workspace
ID, location header or omitted-location request. Codec checks scoped endpoints'
actual query schema using the nested representation and verifies the emitted
explicit URL directory. Group middleware ownership is in `519075–519079`.

Project response handler `558323–558330` is bare `{id,directory,canonical}`.
No ID or UI label alone is considered isolation. Non-VCS project resolution at
`523507–523537` ordinarily resolves the requested directory, but ancestor VCS can
group roots. Therefore the independent mandatory observable is actual read-only
debug Ref[] (`518459–518472`, handler `557374–557379`): after A0, exactly A's owned
directory key must be present; after B and the return, exactly A+B must remain,
with no workspace IDs or unrelated keys. These are actual server map keys, not
browser marker files or invented callbacks. Listing keys says nothing about
reference counts, detached generations, inactivity, drain or tenant sandboxing.

Every successful finite response is fully buffered, preserved as raw base64 plus
headers/status/hash, then decoded and **re-encoded using the exact 648 extracted
success serializer**. Status, complete body bytes and all serializer headers must
match. Codec-result and raw-response files are exported independently by the host;
aggregate evidence includes parity and epoch receipts. No session route regex,
arbitrary session IDs, session creation, SSE, inference, tool or PTY route exists.

## Ownership and finite-request limits

Dispatch requires current epoch and owned candidate/selected root. Only one
finite call can be in flight; stale dispatch/results, timeout/abort, codec mismatch,
unexpected directory, source/config changes, process/output failure or identity
mismatch poison admission. Selection is published only after serial activation,
project/config/key-list/continuity calls and codec qualification complete normally.
No rejected result is applied to selection.

`finite(root, token, path)` accepts only closed route literals and has **no body,
Request or RequestInit argument**. Its sole endpoint.fetch construction supplies
method, private Basic auth headers and bounded signal, without body. GETs and the
activation POST therefore have zero upload bytes. This exact type/source boundary
excludes caller-held ReadableStream upload producers for this toy; it does not
prove generic Endpoint/Runtime stop safety for arbitrary async uploads. Responses
must finish via arrayBuffer normally and pass actual codecs. Source inference is
limited to these finite values; no remote ref/finalizer receipt is invented.

Continuity receipts conjunctively require the same retained execution and endpoint
objects, unchanged endpoint URL with `__vv_listener` generation, an execution-exit/
output failure observer, same native health PID, unchanged sole process diagnostic
row, sole port 4096 listener, zero pending HTTP, one start/delivery, and freshly
re-read exact exclusive host owner/stage identity. Sampling is not atomic kernel
proof; it is bounded exclusive-owner/object continuity evidence. Health PID alone
is explicitly insufficient. No server stop occurs during route switches.

Finish is a separate final full teardown, not a switch or location eviction:
freeze admission, join finite completion, use the committed public service
shutdown/Endpoint.settled owners, require clean non-forced EOF exit/output drain,
require guest zero-work, close the Workspace and export bounded evidence. Failures
retain ownership with preserved diagnostics; no forced stop, automatic retry,
unsupported wrapper join or timeout-as-success fallback is supplied. Parent owns
failure escalation, particularly uncertain startup or shutdown.

## Offline checks and live handoff

Completed: separate library/client builds, new repaired-host declarations, strict
library/client/preparer/host checking and five concrete external actual-648 schema
fixtures. Fixtures cover bare project response, debug Ref[], shared config array,
health and NoContent activation with actual serializer headers. They are explicitly
**not live response fixtures** and run only the extracted codec, not core/server.
An initial fixture omission of content-length was corrected; no generic unit-test
scaffold was added.

Parent must first review background scope and finish independent hardened-candidate
QA, then assign sole browser ownership. This preparation starts nothing now.
When separately authorized, from the repository root launch the **archived owner**:

```sh
SK_STABLE_OPENCODE_AUTHORIZE_HOST=yes bun .diagnostics/sk-stable-opencode-91f64fd6-4875-4412-a9f9-17371316f930/source/examples/todo-app/tests/sk-stable-opencode-host-owner.ts .diagnostics/sk-stable-opencode-91f64fd6-4875-4412-a9f9-17371316f930
```

It prints its exclusively owned fresh-origin receipt. QA must operate ordinary
trusted buttons sequentially and verify rendered selections plus exported raw
receipts. After Finish and join produces `bounded-toy-only`, POST `/host-join` on
that origin, await the owner initiator completion, and inspect
`host-process-join.json` and `host-listener-absence.json`. Do not restart an owned
stage, change credentials/artifacts, or reuse its origin. Failure blocks successful
host join and requires separately owned escalation; do not claim acceptance.

## Explicit non-acceptance

Actual `models.fetch:true` remains unchanged. The still-running server owns the
global ModelsDev refresh/cache/network work and both retained location subscribers.
No `backgroundWork:false`, background inactivity, no-egress, remoteZeroRef or drain
claim is made. Source immutability is checked over the run, not enforced as a kernel
filesystem sandbox. Arbitrary plugin side effects remain outside qualification.

Even a future passing bounded run cannot accept native ChatView/session/tool/full
workspace execution, deletion/eviction, changed config/dependencies, large-cohort
resource bounds or long-term production retention. Eventual removal still needs a
real remote reader/execution/plugin/finalizer drain contract. Parent retains the
high-level design and final refactor decision; this only prepares an actual-server
bounded comparison with same-root reset/restart.
