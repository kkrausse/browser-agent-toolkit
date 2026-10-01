# Effect loader: independent visible browser / combined app qualification

2026-09-30 assignment; execution receipts are dated 2026-10-01 UTC.
**Two bounded real-loader browser cases PASS. Combined full app FAILS at
`apps-1`; focused acceptance UNRUN. Overall pilot/full-app acceptance is not green.**
No phase2 authorization, full Effect migration, all-writer guarantee, retention
acceptance, pin promotion or performance gain follows.

Absolute report:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-loader-browser-full-app-qa.md`.

## Denominators / first failure

| Selected visible workload | Outcome |
| --- | --- |
| Manual real-guest normal tsgo load + public Runtime stop | 1 PASS |
| Manual native held-vendor-header load + concurrent public Runtime stop | 1 PASS |
| Original combined full app | 11 foundation stages PASS; `apps-1` FAIL; remaining 7 of original 19 stages UNRUN |
| App generation/hydration/todo/PDF/HMR/SSE | 0/5 generations completed; interactive verification UNRUN |
| Separate persistence reload/check/final close acceptance | UNRUN |
| Original focused contracts | 0/10 cases, 0/14 steps; UNRUN |

The unchanged combined driver ran **once** and stopped on
`TypeError: Failed to fetch`. Vite reached listener/connect-ready on port5173;
the first preview HTTP readiness fetch did not complete successfully. The iframe
remained empty. No successful `apps-1` stage or chat launch is recorded. At failure
the actual diagnostic had Vite PID1 and WASI child PID2, one listener, one pending
HTTP request, and no lazy-loader operations/failures. The evidence does not establish
the underlying fetch failure's cause; it is not attributed to Effect by inference.
No retry, increased budget, forced click, production repair, or editor recovery run.

The eleven passed foundation stages are: open, child-sync, binary capture boundaries,
filesystem, minimal async spawn, minimal spawnSync, minimal execSync, fetched-body
evicted pin, concurrent watch/flush, HTTP backpressure, persistence recreate.
Their original results, binary-output counts, guest channels and syscall diagnostics
are retained in `failure-app.json`. Focused origins/sessions were allocated by the
original driver but no focused client was navigated or case initiated.

## Immutable admission / delivery

Read both complete repaired preparation/independent-Node reports and phase1 gate
before activation. Did not rerun the already qualified 31 Node cases/URL gate.

Frozen source:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-full-app-UMORaL/frozen`.

| Identity | Value |
| --- | --- |
| Runtime | `3ee918522c1233a1f8e10a9b798c09b6c3e30c81` |
| Toolkit | `9814c715cfca42309c581440577976833f4326e6` |
| Effect | exact `4.0.0-rc.118`; chat rc.112 unchanged |
| Distribution | `bd39000ff5bbc334f836ad65a4433e627525070413f810d7169132102f49b9f9` |
| Frozen receipt | `42d8ba68c2f0c972c7c5bdabe82e5fc112c75af3005d39fcf77693219563ae2a` |
| Actual worker | `kernel-worker-CvW5AR9j.js` |
| Worker SHA-256 | `c4193ae0cba8419149738ed2b3a74d79d5f59f5e447eff129106ca2f3532fecb` |
| Compiled core SHA-256 | `211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070` |
| SDK host SHA-256 | `14e5b1e965c4645ccbed41a93536db8b941b5ed076225dfea9288d9a0b5dfc87` |
| Vendor pack SHA-256 | `f318c6ec229471e1f53be8363e90e2ecdc55faf6549a9e696ee825689129c465` |

Before launching, independently rehashed 107 input candidate files, 1,020 owner
freeze files, 12 native inputs and 37 reused native outputs. The actual run-copy
script verified 9,721 files and the exact receipt for each newly nonexistent
normal/held/combined output path. Never activated frozen output. Postflight rechecked
all three 9,721-file copies, all input/native counts and the full 9,728-file freeze;
zero mismatches. No native rebuild. `delivery-receipt.json` preserves **all artifact
hashes**, including prepared data/application/native closure, not just the worker.
Qualified OpenCode output reuse remains preparation provenance, not a new build.

Independently reversed the actual client/driver adaptations to byte-identical
originals: driver `5511c3882c6c6802f7cce9fae2cff7127bace103fa6708cf15ce8029e546b662`,
client `5f22429299fa653695954d068940dac06200b13f16c1ac069a2db3466751fb36`.
Only source revision/root checks, runtime source revision field and public guest
host alias differ. Actions/assertions/deadlines remain unchanged. Recounted exactly
one Workspace WeakMap in all six emitted clients; focused observer reexports the
same built index. Compiled-core identity is source/build delivery evidence; no
separate live core-response hash or fresh compiler reproducibility claim.

## Real manual browser receipts

Used only `bun $(which browser-control)` CLI and explicit own session
`quiet-falcon-123`; no MCP, relay restart or shared-session adoption. Visible CSS
viewport was 1890×1135. Read actual six buttons/guest command before trusted clicks.
Minimal client exposes concurrent Stop without a busy gate. All workload initiation
was through real UI; no access to lexical owner/private kernel fields.

**Normal:** fresh copy `effect-loader-visible-normal-20260930`, OS origin63150,
host PID5392. Boot created the actual worker with
`?opfs-disable=&vivari-asset-base=http%3A%2F%2F127.0.0.1%3A63150%2Fruntime%2F`.
Actual guest `child_process.spawn('tsc',['--version'])` produced `Version 7.0.2`,
`tsgo-exit 0`, and `Execution.exited={exitCode:0,signal:null,forced:false}` without
cleanupError. Worker native resource timing records the public
`/runtime/vendor/tsgo-pack.bin` fetch, encoded body **10,793,012 bytes**, and actual
process-worker delivery. This is not a QA-side pack read or copied URL resolver.
433 actual syscall trace events and nextPid3 establish guest parent/child execution;
the retained final trace includes PID2 FS read/close and both unregisters.
Public Runtime stop resolved, output readers were already joined by the client's
`Promise.all`, and no processes/operations/failures remained.

**Held:** separate fresh copy `effect-loader-visible-held-20260930`, origin63284,
host PID7597. Empty OPFS/databases/caches/localStorage/service-worker inspection
preceded Boot. Hold then Load admitted **one** actual native vendor request:
`held:true,pending:1,maxPending:2`. Before Stop, real guest PID1 was blocked at
opcode26 `spawn-async-load-before`, command `tsc`; loader generation4 was Open with
one interest. nextPid2 means no compiler child had been allocated.

Trusted concurrent Stop resolved inside the 15s receipt deadline, before Release.
The real host reported `pending:0` while still `held:true`: native request abort
removed the admitted waiter, rather than a release pretending cancellation passed.
Load's joined Execution/output receipt was exit143/SIGTERM/**forced:true**, without
cleanupError. This is native forced process stop, **not forced page destruction**.
Kernel trace reached unregister/dispatch-settled, total60; no processes, live loader
generation or failures remained. VFS stayed exactly 115,766 bytes /29 files /
320,571 logical bytes; nextPid stayed2 and `tsc`/`tsgo` remained lazy. After explicit
Release and another public Inspect, trace/VFS/nextPid were unchanged: no late child
or shim installation in this observed cohort. It does not prove all arbitrary writers.

Each manual Runtime stop leaves the Workspace kernel and `vivari-vfs-owner` lock
open by design. Minimal UI has no public Workspace close control. Normal CLI session
reset closed only the owned tab; immediate CDP census showed zero old-origin targets
within 15s. **No standalone post-tab-close same-origin lock query was captured for
these two manual cohorts**, so do not present tab teardown as a Workspace.close
receipt. Normal origin fresh storage was not separately inspected before Boot;
its OS-assigned origin and newly created copy were fresh, with no prior activation.
Pack/worker hashes above are verified served-file hashes; live resource timing
confirms native transfer size/URL, not an independently hashed browser response body.

## Failure retirement / cleanup

Combined third copy `effect-loader-visible-combined-20260930`, app origin63491/PID11018,
contracts origin63492/PID11019. Original sessions `single-kernel-app-0ae9956e` and
`single-kernel-cases-790b6794`. Driver's rejected `result.json` remains unchanged.

After preserving natural failure, used the existing explicit `retireFailure`
cleanup entrypoint (its authorization token), **not another acceptance action**.
It joined public controller Runtime stop/output/service drains and Workspace close.
Retirement completed; stopped diagnostics had zero processes, HTTP, listeners,
fetch bodies, spills and loader operations/failures. Actual post-close CDP targets
and native same-origin Web Locks were both empty, within the maintained 15s close
observation. Failure status stayed failed. This successful cleanup is not app acceptance.

Deleted exact three owned CLI sessions normally, detached CDP readers, signalled
only the four exact host PIDs with SIGTERM (no SIGKILL/page target destruction),
removed only the empty owned evidence lock. Native connect/PID checks found no
owned listener/process; final CDP found no targets for any four origins. No origin
storage, shared relay, other session, source or frozen artifact was cleared.
Exclusive visible Browser Control slot **released**.

## Evidence / limits

Manual/provenance/cleanup receipts and five native screenshots:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-visible-evidence-20260930`.
Original combined evidence:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-visible-combined-evidence-20260930`.
Both evidence directories archived at
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-visible-qa-evidence-20260930.tar.gz`,
SHA-256 `c07ca9fa573e4d97f1e7b2b086a5dd232a08c141b4e312c7f9126410860f41cc`.
Screenshots preserve the actual minimal UI and failed empty preview, not successful
app interactions. The tall JSON viewport does not show every later receipt; raw
JSON is authoritative. Two extra broad observer returns exceeded CLI's 32KiB JSON
limit (`valueUnavailable:true`); these are **not** counted as receipts. Original
driver retained full failure data; a new bounded passive retirement read preserved
the actual cleanup/locks/targets. No workload was repeated to recover serialization.

Manual logs contain one favicon404 and two deprecated WASM-initializer warnings per
cohort, no pageerror. Combined retained browser log has favicon404 and four such
warnings, zero dropped entries. Guest Vite warnings are retained, not suppressed.
Model count0; routes prohibit inference. No retention/process-reuse flag, pin/cache
promotion, provider call or headless cohort. Original source/runtime/client/driver,
plan and master status were not edited; only this new report is owned.

Shared-interest, ignored-abort and rollback failure injections remain qualified
offline, not falsely claimed as visible callback tests. Known guest
`markAsUncloneable` omission, editor busy-close/recovery and lazy `/bin` ancestor
confinement limitations remain. Historical pilot worker cost is +621,609 raw /
135,365 gzip bytes before URL repair; no new overhead measurement or performance
benefit is claimed. Phase1 bounded browser loader qualification is positive;
integrated pilot acceptance remains blocked on the first app preview fetch failure.
