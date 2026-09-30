# PID egress native host-routing followup

## Finite plan, before launch

This is a newly authorized cohort after `267e01c`, not a retry/rewrite of that
failed frozen cohort. Original reports/evidence remain unchanged. Read actual
`node/internal/http-egress.js:114-123`, `node/bindings/net.js:141-149` and
`kernel-fetch.ts:28-49`: `host.vivari.internal` is external to guest loopback;
kernel native fetch rewrites only its hostname, preserving scheme/port/path.
Use the fresh owned HTTP server's explicit port with that alias. Native target
then equals the page origin; no DNS/proxy/injection configuration or CORS bypass.

1. Verify every original snapshot hash; separately copy exact built libraries,
   SDK and assets, then bundle/typecheck a new minimal consumer. Native artifacts
   are reused, never rebuilt. Generate a unique stage token and fresh origin.
2. Explicitly create/list a named Bun-backed Browser Control CLI session before
   operations; use only its newly owned tab. Inspect UI, trusted preflight click.
3. **Single** real Node guest `node:http` POST through host alias must reach the
   exact owned backend with token/PID/body, then receive exact tokenized payload
   and status. Persist raw route and guest/worker evidence. Failure stops here;
   never issue eleven requests after failed routing or assert shutdown success.
4. Only after preflight success, trusted held-request click sends guest stdin to
   issue nine held-header requests, one open response body and one queued request.
   Public diagnostics must show ten active/one queued for the real guest PID,
   while exact backend counters confirm ten requests and no queued dispatch.
5. Inspect held screenshot; trusted Stop joins actual Execution.stop/exited,
   both output readers and public Runtime.stop. Require actual native backend
   cancellation/body cancel, queued non-dispatch, zero public process/fetch/pin/
   cache counters, and unchanged guest source. Inspect joined screenshot/receipts.
   Trusted Close then joins Workspace.close. Stop on first assertion failure;
   observer deadlines fail, never manufacture ownership joins.
6. Shared-owner/exotic rollback cases remain separate/offline, not this bounded
   gate. Headless optional only after visible pass with engine/version prechecked.
   Cleanup exact owned resources; forced page destruction is not normal acceptance.
   Join owned host exit/output, verify exact PID/listener absence, release slot.

## Outcome — genuine route proved; held-checkpoint observer failed

**One visible cohort: routing preflight PASS; held-request checkpoint FAIL;
normal stop/close acceptance not reached. Headless cohorts: zero.** This is not
a repaired-kernel regression claim or an all-green/full-app/cache/workspace claim.
The first failed observation stopped the cohort. No live retry, increased timeout,
server release, source change or replacement consumer was used to turn it green.

### Actual route proof

Before browser operations, named CLI session `sk-pid-egress-routing-2ooqyd` was
created, then verified by successful `session list` with `no page yet`. The
Bun-backed Browser Control CLI (installed package **0.8.2**) opened only its new
owned tab at `http://127.0.0.1:55973/`. Host PID: `82893`.

After semantic UI inspection, trusted **Prove single guest route** clicked once.
The runtime's fresh-origin/identity checks passed and it started actual kernel
and process workers. Guest source hash:
`f1ba47e72cbb8bf762bea5153cb3f5c8c5236c25de5c5366464c24a832b81b7d`.
Guest PID **1** ran `/bin/node.js /workspace/routing-egress.cjs`.

Alias destination: `http://host.vivari.internal:55973/route`. Token:
`b4683674-6a3d-46ca-bc47-e92722b7fd0c`.

Exactly **one** real owned backend preflight request was observed:

```text
POST http://127.0.0.1:55973/route?token=b4683674-6a3d-46ca-bc47-e92722b7fd0c&pid=1
body: ROUTE_REQUEST:b4683674-6a3d-46ca-bc47-e92722b7fd0c
response: ROUTE_OK:b4683674-6a3d-46ca-bc47-e92722b7fd0c:1
```

Actual guest stdout included `ROUTING_GUEST_PID:1`, `ROUTE_STATUS:200`, the exact
`ROUTE_PAYLOAD` above and `ROUTE_READY`. The trusted action verified response,
backend token/PID/body and request count before enabling held requests.
`browser-0.json` is the persisted **routing-proved** checkpoint.

This is not a host-only/native-global-fetch substitution: the actual public
`diagnoseWorkspace` receipt recorded PID 1's kernel syscall trace sequences
52–57 with **opcode 30 (`OP_FETCH_ASYNC`)**, including kernel-dispatch-before,
response acknowledgment and kernel-dispatch-after. Public census showed the real
booted process with zero worker errors; preflight fetch active/queued/inflight,
cache and pin counts were zero after payload consumption. The noncacheable POST
does not contaminate the later zero-cache assertion.

Actual Browser Control worker events:

- `http://127.0.0.1:55973/runtime/assets/kernel-worker-5EzLFeOC.js?opfs-disable=`
- `http://127.0.0.1:55973/runtime/assets/process-worker-ZQRq3H73.js`

Two native initialization deprecation warnings were recorded; no pageerror or
guest request error was present in the preserved receipt.

### First failed checkpoint

After successful routing, trusted **Start held native requests** sent stdin to
the same real guest. All eleven `HELD_ISSUE` markers were observed. Backend raw
events admitted only **six** headers requests (`header-0` … `header-5`), all for
exact token/PID, still pending. No body request/body-enqueued event arrived and
no public ten-active/one-queued checkpoint was obtained.

The driver's correctly parameterized observer failed:

```text
page.waitForFunction: Timeout 25000ms exceeded.
```

The page remained in `holding`, `stop/runtimeStop: not-requested`, with no exit,
output-reader join or source-unchanged receipt. `observer-timeout.json` preserves
that exact public page snapshot, guest logs and actual worker/console events.
The UI's backend-state read was still pending. Its internal 15-second loop check
does not bound an awaited fetch that itself has not returned; the driver's finite
25-second observer therefore determined failure, not a manufactured success.

Six same-origin held HTTP/1 requests are consistent with browser per-origin
connection contention blocking further backend/control requests. This is a
**fixture-staging diagnosis**, not proven kernel queuing, worker death, early stop
or lack of real egress. No network-native active-count inference was made from
backend count alone. The queue/body gates cannot be called passed, and Stop/Close
remained disabled. A future separately authorized minimal gate should avoid
saturating the control origin (e.g. start with only a header and body request),
leaving queue qualification separate; that correction was not applied here.

### Screenshot / Browser Control evidence-capture todo

The first full-page diagnostic screenshot failed with
`Page.captureScreenshot: {"code":-32000,"message":"Unable to capture screenshot"}`.
No screenshot file/success is claimed from that call. A separate **viewport-only
evidence capture** succeeded; `timeout-viewport.png` was opened and visually
inspected. It shows `holding`, exact token/PID/source hash, the proved route and
disabled Stop/Close. This was media capture only, not a test retry or second
cohort. Raw JSON contains the remaining offscreen data.

Browser Control project todo (0.8.2, safe owned origin/session above): full-page
capture of a page rendering the public diagnostic syscall trace failed, while
viewport capture worked. Reproduction: after this one-shot held-state timeout,
`page.screenshot({fullPage:true})` returned the exact protocol error; expected a
full-page diagnostic image, actual none. Recovery attempted: viewport-only
capture, with no relay/profile/session replacement. Investigate bounded capture
dimensions/large diagnostic rendering before claiming full-page recording
support. No browser-control source or configuration was modified.

## Exact frozen input/consumer identity

New consumer stage (preserved):

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/sk-pid-egress-routing-2OOQYd`

New raw live evidence (preserved):

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/sk-pid-egress-routing-visible-2OOQYd`

The preparer verified every byte of the unchanged
`sk-pid-egress-qa-prep-vvua6O` snapshot against its exact receipt SHA-256
`3e72b0bff5328a752897e284db60245d2410498ae17bfe55c64e8473b5722dd9`.
That original independent receipt had verified 111 candidate files, 758 source
files, 40 built assets, 37 reused native outputs and both archives/provenance.
This consumer separately copied built workspace/SDK/runtime exports/assets;
only the new browser consumer was bundled, and strict built-declaration
typecheck passed first try. No native or library rebuild, source replacement,
production instrumentation, pin/shared-output/app-switch change or model call.

| Identity | Value / SHA-256 |
| --- | --- |
| Runtime revision | `33fa1359a003ca9c50cb3bc49699b99bc1a063f1` |
| Toolkit revision | `d0eec346dbc749db1c0cd82dd8aad0b27c1da363` |
| Runtime version | `3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62` |
| New stage receipt | `94ab15a6a053e3fb718fd4c63a16f7f0acdbdb6c4f4c36c115789fb7a51f57ac` |
| New browser consumer | `19d315529a4d81b592054e79b3677652a5d820180eb55f5efb0fc9256d564292` |
| Kernel worker | `1901f5b19c06cfea796a84395a7e46d0159690c61deeba4451ffaaf672aeea7c` |
| Process worker | `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7` |
| Host SDK | `34aec10efcd40f28d58d6c2a58084e2476cc157c1f0269aec8cd9d76094bd660` |
| Workspace index | `cb7bb81bab08e5d993962456df1219abfafd5a5cfdbefb45743ade7d284e243c` |

All 78 new stage file hashes passed post-run reverification. The stage receipt
hashes every copied/built file. Final `summary.json` records
the final stage/evidence hashes and post-run byte reverification. Prior reports,
failed consumer/evidence stages and the original candidate remain unchanged.

## Completed versus unreached / offline boundary

| Contract | This visible followup | Existing offline repair evidence |
| --- | --- | --- |
| Real kernel/process workers and Node guest | Observed, guest PID 1 | Built worker/source checks |
| Host-alias route, exact token response, genuine OP_FETCH_ASYNC | **PASS**, raw backend+guest+public opcode-30 trace | Not substituted for live evidence |
| Held native requests | Six actual header requests; intended ten/body gate **FAIL** | Controlled source cases pass |
| Public ten-active/one-queued and dead queue suppression | **Unreached**; no server-count inference | Existing controlled regression passes |
| Native body cancellation / Execution.stop/exited / runtime/output joins | **Unreached**; no stop receipt | Existing built SDK/source regressions pass |
| No late dead-owner pins/publication | **Unreached**; preflight zeros are not stop proof | Existing controlled regression passes |
| Shared live-owner survival | Not attempted | Existing shared active/queued regressions pass |
| Source unchanged / normal workspace close | Initial hash only; terminal checks **unreached** | No fresh live acceptance |
| Abort-ignoring backend / failed rollback | Outside this supported native gate | Offline source coverage only |
| Full app/cache retention/persistence/reload/stress | Not attempted | Still separately outstanding |

No headless browser launched after visible failure, so no Playwright/engine
qualification or version claim. Full contracts still have the documented
`TypeError: markAsUncloneable is not a function` baseline failure.

## Owned cleanup / exclusive slot release

After preserving raw receipts and inspecting viewport evidence, the exact owned
CLI session/page was deleted. This destroys a still-live failed workspace/guest:
**forced page cleanup, NOT normal Execution/output/runtime/workspace join
acceptance**. Subsequent server abort events caused by page destruction are
forced-cleanup evidence only, never relabeled as the unreached trusted Stop case.

Only owned host PID `82893` was sent SIGTERM. Its background shell completed;
the joined output is copied to `host-output.txt`. `cleanup.json` records
`ps -p 82893` and listener-only `lsof` for port 55973 both returning exit 1 with
empty stdout/stderr, plus a successful named-session list showing the owned
session absent. No existing tab adoption,
user-origin storage, browser profile, relay or OpenCode session was changed.
Frozen inputs and failed live evidence are retained. **Exclusive visible slot
released after owned cleanup.**
