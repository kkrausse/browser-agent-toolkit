# Minimal native PID-egress public-stop live QA

## Finite plan before launch

New explicit parent authorization after `8b58f12`; previous reports/evidence are
unchanged. Reverify exact frozen 33fa135 runtime / d0eec346 toolkit assets, copy
built exports/assets separately and build/typecheck only the new minimal consumer.
Native artifacts reused, not rebuilt. Create/list named Bun-backed Browser Control
CLI session before its owned fresh tab/origin.

Trusted clicks: single tokenized `node:http` POST preflight through supported
`host.vivari.internal:<exact-owned-port>` → require exact backend/PID/body/200
payload and real worker/public opcode-30 evidence → send guest stdin once to
issue **exactly one held-header and one open-body request**, no fanout/retries →
require actual two backend admissions and body chunk enqueue, plus public fetch
active=2/queued=0 → inspect viewport screenshot → trusted Stop joins actual
Execution.stop/exited, both output readers and Runtime.stop → require native
header/body cancel receipts, zero public process/fetch/pin/cache counts, no extra
backend dispatch and unchanged source → inspect joined screenshot → trusted
Workspace.close joins normally. First assertion/observer failure stops and
preserves this cohort. Control requests have 5-second observation-only abort
deadlines; driver state observer is separately bounded. No ownership timeout is
treated as a join. Viewport screenshots only.

Counter derivation: unchanged kernel `_scheduleFetch` increments `_fetchActive`
before awaiting `doFetch`, whose native fetch+arrayBuffer remains pending for both
the held headers and open body. Distinct GET URLs are distinct operations; no
cache hit/shared-owner fanout. Thus the two held operations should report active
2 without pool saturation. Public diagnostics record opcode 30 from real guest
http transport; no native-global-fetch/mock substitution.

Queue suppression/shared owners and abort-ignoring/failed rollback remain
**offline** regressions, not this bounded live gate. Optional fresh headless only
after visible pass and prechecked actual Playwright/engine version. Cleanup exact
owned session/host, join exits/output and verify PID/listener absence. Forced page
destruction is explicitly not normal acceptance. Release exclusive visible slot.

## Outcome — bounded visible gate PASS

**Visible: 1 passing cohort, 0 failed cohorts in this authorization. Headless: 0.**
Routing, actual header/body admission, public Execution.stop/exited and both output
readers, public Runtime.stop, unchanged guest source and normal Workspace.close
all completed. No retries, timeout increases, late gate releases, source changes
or forced page cleanup were used. This does not replace the preserved failures of
the earlier independently authorized cohorts.

### Actual owned cohort and routing

Bun-backed Browser Control CLI (installed 0.8.2): session
`sk-pid-egress-minimal-fj6cch`, explicitly created and listed with `no page yet`
before first execute. Fresh owned page/backend origin:
`http://127.0.0.1:63710/`; host PID **94378**; real guest PID **1**.

Token: `c37e4ae2-65e7-46f5-a34a-b078e865e202`. Exactly one actual guest preflight:

```text
guest destination: http://host.vivari.internal:63710/route?token=c37e4ae2-65e7-46f5-a34a-b078e865e202&pid=1
backend observed: POST http://127.0.0.1:63710/route?token=c37e4ae2-65e7-46f5-a34a-b078e865e202&pid=1
body: ROUTE_REQUEST:c37e4ae2-65e7-46f5-a34a-b078e865e202
guest status: 200
guest payload: ROUTE_OK:c37e4ae2-65e7-46f5-a34a-b078e865e202:1
```

Fresh-origin/served-client/source-revision checks passed. Actual worker events
recorded the exact kernel `kernel-worker-5EzLFeOC.js?opfs-disable=` and process
`process-worker-ZQRq3H73.js`, under this owned `/runtime/assets/` origin.
Guest ran `/bin/node.js /workspace/minimal-egress.cjs`. No mock kernel, injected
receipt, public-global-fetch substitute or private callback was used.

### Held request receipt — exactly two, no fanout

The second trusted click sent stdin once; guest issued exactly two requests:
`/backend/headers` and `/backend/body`, each with the exact cohort token and PID.
The server kept headers unresolved for the first. For the second it returned a
native streaming HTTP response, enqueued the **26-byte**
`MINIMAL_NATIVE_BODY_MARKER` chunk and left the stream open (no EOF). Actual raw
backend request/body-enqueued events were acknowledged through bounded control
fetches. Guest had no response/end/error marker before Stop.

Public held diagnostics:

```json
{"inflight":2,"queued":0,"active":2,"cachedEntries":0,"cachedBytes":0,"pinnedBodies":0}
```

Actual public syscall trace includes PID 1 opcode-30 worker/kernel dispatch and
acknowledgment sequences 52–57 (preflight), **70–75 and 76–81** (the two held
requests). Census showed the real process; no ten-request saturation or queued
request was constructed. This confirms real `OP_FETCH_ASYNC` browser-worker
transport, rather than inferring kernel admission from a host-only counter.

`held-viewport.png` was opened and visually inspected: held state, exact source
hash/token and enabled Stop. Raw held diagnostics/body events are in
`browser-1.json` / `held-driver.json`, including offscreen details.

### Actual trusted Stop / joined receipts

The trusted Stop action awaited **Execution.stop()**, **Execution.exited**, both
stdout/stderr readers, then **Runtime.stop()**. No deadline resolves any of these
ownership promises. Actual exit receipt:

```json
{"exitCode":143,"signal":"SIGTERM","forced":true}
```

`cleanupError` was absent. `stop` and `runtimeStop` were `fulfilled`,
`readersJoined: true`. The SDK labels a signaled stop `forced:true`; this is the
intentional **public Execution.stop** behavior, not page/profile destruction,
natural exit-zero or a fabricated cleanup receipt. We claim signal-stop cleanup
qualification only, not graceful stdin-EOF guest termination.

Raw backend events after the trusted Stop:

- Body request abort, timestamp `1790806611633`.
- Body stream `cancel`, timestamp `1790806611634` (reason string `undefined`).
- Header request abort, timestamp `1790806611634`.
- Both exact request records `cancelled: true`; total held requests remains **2**.

The server never released successful header/body responses to fake a join.
Actual native transport cancellation triggered these server-side events. The
consumer waited for their observed settlement separately from public stop;
request abort notification alone was not used as its ownership receipt.

After both public stops, diagnostics showed `procs: []` and all fetch active,
queued, inflight, cache entries/bytes and pinned-body counts **0**. Source hash
read back unchanged:
`951a2e30cc2db5df81f5a0a432b1942d7f74d328b5a1dffb7478793a312733df`.
`joined-viewport.png` was opened and inspected: joined state, unchanged source,
and enabled Close. `browser-2.json` / `joined-driver.json` preserve full receipts.

The final trusted Close awaited real **Workspace.close()** and produced
`phase: complete`, `workspaceClosed: true`, both stops fulfilled, readers joined,
source unchanged and `errors: []`. Exact complete state persisted as
`browser-3.json`; its existence/content was independently read after the action,
not inferred from a prior persistence flag. `complete-driver.json` retains raw
worker/console events. Two native initialization deprecation warnings were
recorded, with no captured pageerror or guest request error.

Final server counters were independently reread after owned cleanup: **one
preflight route, exactly two held requests, both cancelled**. No extra late backend
dispatch or cached/pinned publication was observed at the supported checkpoints.
This is not private per-generation VFS tracing or an indefinite stress claim.

## Exact candidate / separate consumer provenance

Consumer stage:

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/sk-pid-egress-minimal-fj6CcH`

Raw live evidence:

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/sk-pid-egress-minimal-visible-fj6CcH`

Preparation verified every original snapshot file against its exact verification
receipt `3e72b0bff5328a752897e284db60245d2410498ae17bfe55c64e8473b5722dd9`.
That independent provenance receipt verified 111 candidate files, 758 source
files, 40 built assets, 37 reused native outputs and source archives. Libraries,
SDK and runtime were copied unchanged; only this consumer was bundled. Strict
built-declaration typecheck passed first try. All **78** new stage file hashes
passed post-run verification. Native artifacts were verified reuse, **not rebuilt**.

| Identity | Value / SHA-256 |
| --- | --- |
| Runtime source | `33fa1359a003ca9c50cb3bc49699b99bc1a063f1` |
| Toolkit source | `d0eec346dbc749db1c0cd82dd8aad0b27c1da363` |
| Runtime version | `3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62` |
| New stage receipt | `6f75b52adc75642b7902c01b4a5b1c5f1e582982bda2b57ffca93c27f9edfcc9` |
| New browser consumer | `1875327df1e2cbcaaf9ec8abd3284e099d2881e0e33e69fdaf5967bbfeef551d` |
| Kernel worker | `1901f5b19c06cfea796a84395a7e46d0159690c61deeba4451ffaaf672aeea7c` |
| Process worker | `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7` |
| Host SDK | `34aec10efcd40f28d58d6c2a58084e2476cc157c1f0269aec8cd9d76094bd660` |
| Workspace index | `cb7bb81bab08e5d993962456df1219abfafd5a5cfdbefb45743ade7d284e243c` |

`summary.json` hashes all raw backend/browser/driver/screenshot/cleanup evidence
and records final counters and stage verification. No canonical pins, shared
outputs, app switch, runtime sources, old frozen stages/reports, user-origin
storage/profile/relay or unrelated parent full-app preparation were modified.

## Coverage boundary

| Contract | This visible cohort | Offline / remaining |
| --- | --- | --- |
| Real guest host-alias route / exact payload / OP_FETCH_ASYNC | PASS | Real new browser evidence |
| One held headers + one native open body | PASS, actual 26-byte stream admission, two public active ops | No pool saturation |
| Native cancellation + public execution/output/runtime joins | PASS, actual SIGTERM exit and fulfilled joins | Not natural guest exit-zero |
| Public process/fetch/pin/cache quiescence and source unchanged | PASS at post-stop checkpoints | No private per-generation tracing or indefinite late-work/stress proof |
| Normal public Workspace.close | PASS before page destruction | Not OPFS target destruction or persistence/reload/full-workspace acceptance |
| Queued dead owner / shared live owner | Not attempted | Existing controlled source regressions only |
| Abort-ignoring backend / rollback cleanupError / CLEANUP_FAILED retention | Outside live scope | Existing offline real-source/built SDK regressions only |
| Headless engine qualification | Not attempted (optional) | No Playwright/engine version claim |
| Full app/cache admission/retention, HTTP stream-credit, persistence/reload, stress | Not attempted | Remain separately outstanding |

This bounded visible gate is complete; optional headless was not launched to
avoid expanding the parent's conservative full-app handoff. Full contracts still
retain `TypeError: markAsUncloneable is not a function`. No all-green/full-app,
cache-retention or broad drain claim.

## Owned cleanup / slot release

Only after actual public stop/output/runtime/workspace joins, the owned CLI
session/tab was deleted. **No forced page cleanup** occurred in this cohort.
The deliberately signaled Execution exit above is not confused with the earlier
failed cohorts' forced page destruction.

Only host PID **94378** received SIGTERM; its shell completed and joined output
was copied to `host-output.txt`. `cleanup.json` records:

- `ps -p 94378`: exit 1, empty stdout/stderr (PID absent).
- Listener-only `lsof` for TCP **63710**: exit 1, empty stdout/stderr (port absent).
- Successful CLI session list: exact owned session absent.

No browser installation, existing-tab adoption, storage clearing, relay restart,
OpenCode session change or model/inference call. Frozen inputs, old failure
evidence and this successful raw cohort remain retained. **Exclusive visible CLI
slot released.**
