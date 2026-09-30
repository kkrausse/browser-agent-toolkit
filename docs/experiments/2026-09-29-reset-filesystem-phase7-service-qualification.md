# Phase-7 bounded service qualification — 2026-09-29

## Outcome

**Approved isolated service cohort passes its complete fixed budget.**
Startup: **1 attempt, 1 pass**. Actual-service A/B switches: **12 attempts,
12 qualified passes, 0 failures**. Generations 1–13 are verified. No action,
deletion, install or PDF-click retry, replacement cohort, or budget extension.
The cohort stops because its predetermined budget is exhausted.

Parent supplied independent read-only approval of verifier commit `b2b9c55`,
limited to a fresh isolated page, one exclusive initiator, sequential awaited
commands, and first-failure stop. No additional review was required or claimed.
Browser Control CLI only; one browser owner; no manual/external clicks or
overlapping runs. The fixture internally launches its two services concurrently;
this is not overlapping qualification commands or workload initiation.

## Delivered identity and preparation

Used unchanged clean runtime `446df00f86d5d6d5d856a2e5deec0fac49f242fa` and the
phase-4 distribution, original matched payload, and frozen served client. No
runtime rebuild, source modification, pin update, or generated-runtime edit.
Candidate worktree was clean before the run.

Fresh origin `http://127.0.0.1:43225` was free before allocation. Newly owned
session `quiet-tiger-613` first visited a script-free inspection path: IndexedDB
databases, Cache Storage, service-worker registrations and localStorage keys
were all empty. No old page was adopted or targeted. Inspection-path/favicon
404s are setup observations, not runtime failures.

Before startup, fetched and hashed all **14 packaged served identities**, verified
both manifest runtimeVersion fields and all **12,305** payload entries, and
compared the complete served-identity receipt exactly with phase 4. Independently
rehashed the original image and bundle and checked their lengths:

| Item | SHA-256 / identity |
| --- | --- |
| Distribution version | `4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a` |
| Served distribution.json | `9d2bf835ae9227df6ac37192ba7e6bdaf1276965912875f53e3ccce5f7a58f27` |
| Served manifest | `4098a3a521627837bdcafd2461127f245c6d59cd92d49b4c12953ef0437e4f21` |
| Served client | `874e0cfe71460dba6baec2fe242630ccc88f475761143bd3109da4f4bd60b9d5` |
| Image, 44,123,335 bytes | `434336bff35c19f8a47a66d9802423ce86a5e18f3cd3c649025c939569e9c41e` |
| Bundle, 42,664,752 bytes | `4593820adf8f9de512767b6c594cb023c84f20ab9b01093d96cd054e993ad401` |

The new ignored static-serving recipe maps these unchanged files and the original
todo API, without rebuilding the client. Its initial import path was one directory
too deep; corrected before the server bound and before any browser startup.
The failed setup log remains retained. This was not a runtime/action retry.

## Qualification evidence

The freshly bundled b2b9c55 v2 body performs **25 source verifications and 25
fresh PDF completions**: one startup check plus outgoing/incoming checks for
each switch. Each compares exact bytes of **26 source/binary fixtures**, requires
the outgoing A/B-only filename absent, verifies the expected source generation,
and requires generation-matched hydrated preview with enabled title input.
Completed PDF lengths were **875–876 bytes**; no fixed-length assertion.

Before each single PDF click the verifier invalidates previous bytes and arms
the exact hydrated document/button with a unique token. Every receipt records a
fresh positive completion on that same generation/document/button/token before
shutdown or the next command. **The token is verifier-owned, not job-produced.**
Attribution relies on this cohort's exclusive initiator and awaited sequential
workloads. This proves neither general concurrency safety nor exact PDF-content
identity; the fixture exposes only completed byte length.

All **13** generations have successful OpenCode health, plugin activation,
plugin list, config, and model-catalog readiness requests. This is server/catalog
readiness, **not a mounted usable chat client**. No model request occurred.

All **12** after-stop receipts join both service exits and drains before deletion:
OpenCode exits 0/unforced; Vite exits 143/SIGTERM/forced. Every after-stop process
and listener table is empty; pending HTTP and fetch inflight/queued/active are
zero. These observations do not prove graceful Vite exits or exhaustive exclusion
of every possible host write. Final live diagnostics preserve generation-13
process/listener state before cleanup. Frame evidence has one main navigation
(initial startup) and 65 child navigations; no host navigation during switches.
No context-read errors or recoveries occurred.

Switch observation remained 120 seconds, hydration/PDF reads 30 seconds each,
and outer call watchdog 240 seconds. Every switch token was initiated once.

## Timings — diagnostic only

Startup total: **37,650.98 ms**. Runtime `switch.total` samples, in attempt order:

`13,653.56; 54,477.51; 58,950.18; 59,451.74; 56,005.77; 45,644.63;
43,493.50; 46,738.98; 50,776.60; 49,492.07; 49,792.84; 50,152.41 ms`.

These are instrumented baseline clear/reopen/install/service/flush observations,
not clean performance measurements. They exclude outer source/PDF verification,
have retained-page/shared-browser and cache/order effects, and are not a matched
comparison with alternative switching strategies. **Speed remains unqualified.**

## Retention and cleanup

Distinct ignored evidence directory, absolute:

`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase7-service-qualification-20260929/`

Includes server/identity recipes, original failed setup log, served identity,
fresh-origin inventory, startup plus twelve driver outputs and stage receipts,
cohort/summary JSON, journal, final live diagnostics/navigation, cleanup receipts,
and before/after Browser Control inventories. Ignored evidence does not travel
with this report's commit; old recipes/distributions/receipts were not overwritten.

After final capture, initiated owned healthy `api.stop()` once in the host and
awaited its completed status. Final events record both services' exits/stdout and
stderr drains and workspace flush/close. Deleted only session `quiet-tiger-613`
and terminated only owned server PID **99484**. No failure tree was produced.
Did not delete origin storage. Server 43225 no longer listens; preexisting servers
43222/43223 retain PIDs **6885/7042**. All seven retained sessions' before/after
inventory records are byte-equivalent: `quiet-falcon-568`, `clever-badger-501`,
`calm-otter-581`, `gentle-otter-722`, `amber-badger-702`, `lucky-walrus-901`,
`lucky-tiger-691`. No target/reload/switch/close of these pages occurred.

No runtime/pin/IRS/archive edits, model calls, push, deployment or promotion.
No-service and OPFS evidence was not repeated. Newline remains a distinct
**expected-red** gate; old phase-4 switch 2 remains unverified.

## Next gate

The bounded isolated actual-service reliability gate is now satisfied for this
candidate and matched fixture. **Recommend parent approval for the next bounded
switching-strategy experiments**, with explicit budgets, matched workloads and
identities, separate diagnostic/performance collection, and first-failure stop.
Do not extrapolate this sample to unrestricted deletion, concurrency safety,
production readiness, usable chat, or performance qualification. Newline framing,
qualified Node/native-build provenance, and baseline-contract disposition remain
separate gates; no additional cohort is authorized by this report.
