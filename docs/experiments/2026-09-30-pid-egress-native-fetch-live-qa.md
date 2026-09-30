# PID egress native-fetch live QA

## Scope correction and finite evidence plan

The earlier preparation blocker report and frozen inputs remain unchanged.
Parent authorization narrows this cohort to actual native-fetch cancellation and
public execution/runtime joins, not controlled abort-ignoring work or failed
rollback. Libraries/assets are copied from the verified 33fa135 / d0eec346 input
snapshot, then a separate minimal browser consumer is bundled and typechecked.

Before browser execution: create and list the named Bun-backed Browser Control
CLI session; launch only an owned host on a new loopback port/origin. Inspect its
new tab, click Start, wait for actual guest PID/stdout plus two owned backend
requests (nine held headers and one held streaming body), plus public kernel
diagnostics proving ten active / one queued request, click Confirm, inspect screenshot
and public diagnostic census. Trusted Stop joins actual execution stop/exit, both
output readers and public runtime stop; require native backend cancellation and
unchanged guest source hash. Inspect terminal screenshot/receipts, then trusted
Close joins workspace close. Stop at first assertion failure, preserve cohort,
and label any forced cleanup separately. Headless is optional after visible
success, using a prechecked installed Playwright version and isolated browser.
Cleanup only exact owned page/session/host, join host output/exit, verify PID and
listener absence, release visible slot.

Queued suppression requires the concrete ten-active/one-queued public checkpoint
and exact server counters after stop. Public diagnostics also expose pinned-body
and cached-entry counts; require zero after joined stop, without claiming private
per-generation write tracing. Shared-owner survival remains a separate case.
No production
instrumentation, callback injection, model calls, source/pin/shared output changes
or existing origin/profile mutation.

## Actual result — first admission assertion failed; stopped

**Visible: 1 failed prerequisite cohort, 0 accepted cohorts. Headless: 0.**
This is a fixture routing failure, not evidence of a repaired-kernel cleanup
regression or a positive native-fetch qualification. No retries-to-green and no
other live cohorts were launched.

The Bun-backed CLI session `sk-pid-egress-native-xjima9` was explicitly created
and verified in `session list` **before** the first execute. Its fresh owned tab
used `http://127.0.0.1:55163/`; host PID was `74499`. Start and Confirm were normal
trusted `getByRole(...).click()` interactions after semantic UI inspection.

Start passed fresh-origin checks, served-source/client identity checks, real
workspace open and runtime/node launch. Observed actual worker creation events:

- `/runtime/assets/kernel-worker-5EzLFeOC.js?opfs-disable=`
- `/runtime/assets/process-worker-ZQRq3H73.js`

Guest stdout reported `NATIVE_GUEST_PID:1`, then eleven individual issue markers
(`header-0` through `header-8`, `body`, `queued`). Each actual `node:http` request
returned `connect ECONNREFUSED 127.0.0.1:55163` in the guest. The owned HTTP
backend's request/event arrays were **empty**, not ten active / one queued.
Confirm failed the first backend-admission assertion:

```text
Error: Ten actual held native requests for exact guest PID; queued request not dispatched
```

Failure state `failed-owner-retained` and its raw guest logs/backend arrays were
persisted as `browser-0.json`. Stop and Close stayed disabled. No execution
exit/stop, public runtime stop, output-reader join, public fetch/pin census,
source-unchanged result or normal workspace close was obtained. Neither request
count nor queue admission was inferred from issue markers. An observer wait call
did not supply backend evidence; the actual trusted Confirm assertion determined
the result.

`failed.png` was opened and visually inspected: it shows the failure state,
empty backend receipt, eleven ECONNREFUSED lines, disabled buttons and
`stop/runtimeStop: not-requested`. `browser-driver-events.json` preserves actual
worker and console observations. There were initialization deprecation warnings
and one 404 console resource error, not a recorded uncaught browser exception.

### Concrete routing explanation / future correction, not applied

The fixture used `location.origin` directly in the guest's `http.get()` URL.
Actual source `packages/runtime/node/internal/http-egress.js:20-35` deliberately
keeps `127.0.0.1` on the **guest's virtual loopback** route and says it must return
ECONNREFUSED for an unserved guest port, rather than egress to the host. Thus these
requests did not establish the intended guest `OP_FETCH_ASYNC` native route.

The existing supported host escape is addressing, not injection:
`http://host.vivari.internal:<owned-port>/...`, rewritten by
`packages/core/src/workers/kernel-fetch.ts:28-49` to the browser host. A separately
authorized future cohort should use that guest destination (with appropriate
CORS/CORP for its actual fetch origin). This failed frozen consumer was **not**
changed and rerun, and its absence of backend traffic must not be relabeled as
queued-request suppression.

## Frozen consumer / exact provenance

Consumer stage:

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/sk-pid-egress-native-XjIma9`

Live failed evidence:

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/sk-pid-egress-native-visible-XjIma9`

Preparation first verified every file in the unchanged original verified snapshot
against its exact receipt SHA-256
`3e72b0bff5328a752897e284db60245d2410498ae17bfe55c64e8473b5722dd9`.
The original verification had checked all 111 candidate hashes, 758 source files,
40 built assets, 37 reused native outputs and both source archive hashes. This
consumer independently copied built workspace/SDK/runtime files and bundled only
the client; libraries/native artifacts were **not rebuilt**. Strict built-export
consumer typecheck passed. All 78 new stage hashes were reverified after the live
failure. Original stages, prior report and native artifacts remained unchanged.

| Identity | Value / SHA-256 |
| --- | --- |
| Runtime revision | `33fa1359a003ca9c50cb3bc49699b99bc1a063f1` |
| Toolkit revision | `d0eec346dbc749db1c0cd82dd8aad0b27c1da363` |
| Runtime version | `3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62` |
| Stage receipt | `788ef16b3c5700734a1350f90e352c6f73f14b85e5f5cf68caa999f091d6c3c4` |
| New browser consumer | `4cea0fc9ce64f23ce139cca19f0ca20d8384d4ba21146b4adf08a2c5e37a04b9` |
| Actual guest source | `d10605a04d9a248a59f737ad31357a5660442c9297b8dd25935c372e2d721168` |
| Kernel worker | `1901f5b19c06cfea796a84395a7e46d0159690c61deeba4451ffaaf672aeea7c` |
| Process worker | `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7` |
| Host SDK | `34aec10efcd40f28d58d6c2a58084e2476cc157c1f0269aec8cd9d76094bd660` |
| Workspace index | `cb7bb81bab08e5d993962456df1219abfafd5a5cfdbefb45743ade7d284e243c` |

`summary.json` records hashes of raw evidence and the stage. An earlier **offline**
stage `sk-pid-egress-native-r2K2KL` failed typecheck because `Workspace.open`
requires `id/storage`, not a `distribution` option. That API error was corrected
before the sole live cohort; both offline stages are preserved. No generic tests
or production fixes were introduced.

## Coverage matrix — offline evidence is not live evidence

| Contract | This live cohort | Existing offline repair evidence |
| --- | --- | --- |
| Exact real workers / actual guest launch | Observed kernel/process workers and guest PID 1 | Built SDK/runtime checks |
| Genuine outbound OP_FETCH_ASYNC admission | **Failed prerequisite**; host received zero requests | Controlled source regression passes |
| Native header abort / body cancellation | Not reached | Signal/body-join regression passes |
| Execution exited/stop + runtime/output joins | Not reached | Built SDK/toolkit regression passes |
| Ten-active/one-queued, dead queued suppression | Not reached; never infer from zero host requests | Controlled kernel regression passes |
| Shared live-owner survival | Not attempted | Shared active/queued owner regression passes |
| No late pins/publication | Public counters not reached; no claim | Controlled write/pin regression passes |
| Abort-ignoring backend / failed rollback | Explicitly outside this native live scope | Existing source regressions only |
| Source unchanged / normal workspace close | Not reached | No fresh live claim |
| Persistence/reload, cache admission, stress/full workspace | Not attempted | Still separately outstanding |

Historical endpoint upload hold/reject/reentrant cases were not executed or
claimed as PID-egress evidence. The full-contract baseline
`TypeError: markAsUncloneable is not a function` remains unchanged. No all-green,
broad drain, cache retention or full-workspace acceptance claim.

## Cleanup and exclusive slot release

After failure evidence and screenshot inspection, only the owned CLI session was
deleted. This destroys the retained failed page: **forced page cleanup, not normal
guest/output/runtime/workspace join acceptance**. No user tab was adopted or
closed; no user-origin storage, profile or relay was changed. Guest PID 1 is a
virtual worker PID, not an OS process to kill.

The exact owned host PID 74499 received SIGTERM, wrote a `host-stop` event and
the background shell completed with its output retained. `cleanup.json` records:

- `ps -p 74499 -o pid=,command=`: exit 1, empty stdout/stderr (PID absent).
- `lsof -nP -iTCP:55163 -sTCP:LISTEN`: exit 1, empty stdout/stderr (listener absent).
- Named CLI session absent from a subsequent successful `session list`.

Frozen consumer and failed evidence remain available; no failed stage was
deleted or reused. Headless was not launched because visible prerequisite failed;
no Playwright/engine version claim is made. **Exclusive visible slot released.**
