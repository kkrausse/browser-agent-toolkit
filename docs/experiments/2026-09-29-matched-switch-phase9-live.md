# Phase 9 — concrete validated-reuse client and stopped live pair

## Outcome

**Actual live progress, but no matched speed result.** The fixed pair stopped on
its first failure: the source-only condition's cold startup missed the existing
Vite listener deadline. Counts: **2 cold-startup attempts, 1 qualified startup
pass, 1 startup failure; 0 measured switches, 0 qualified switch passes**.
The ten-switch ceiling was not consumed, replaced, extended or retried.

Baseline generation 1 verified all **27 source/binary fixtures**, the outgoing-only
filename's absence, hydrated enabled title input, and one freshly armed/completed
PDF (**876 bytes**) through the unchanged approved serial verifier. The added
fixture imports the alternating A/B-only module through `src/switch-import.ts`;
both conditions use identical fixtures. Source-only failed at `hydration` after
source verification, before PDF arm/click; no completed startup receipt is claimed.
Both OpenCode servers completed health/plugin/config/model-catalog readiness.
**Mounted chat/delegation remains unqualified; model requests: 0.**

## Concrete implementation

Example-only additions, not library/runtime changes:

- `examples/todo-app/tests/installed-tree-audit.ts`: executable, read-only guest
  audit with bounded process lifetime and joined stdout/stderr/exit. Every managed
  entry's kind, mode, file size/SHA-256 and symlink target is checked; unexpected
  or missing installed paths fail closed. No marker or attestation skips hashing.
- `examples/todo-app/tests/performance-client.ts`: opt-in `matched=phase9` path
  using the existing actual workspace/service client as the concrete adapter.
  It does not wire the phase-8 mock `Adapter` interface or declare its ownership
  booleans proven. Both services stop/drain/restart. Full reset clears, closes,
  reopens and performs normal verified managed delivery. Source-only binds a fresh
  runtime wrapper, validates the stopped tree, replaces source and preserves cache
  bytes; **it never invokes the existing cache-deleting reuse installer**.
  No retained Vite/OpenCode process is implemented.
- `examples/todo-app/tests/matched-switch-live.ts`: separately builds the example
  client and serves the frozen phase-4 runtime/manifests/payload on two new origins.
  It refuses an existing phase-9 evidence directory. No frozen client is overwritten.
- `examples/todo-app/tests/installed-tree-audit.test.ts`: host-filesystem controls
  for immutable mutation, unexpected entries, unsafe cache links and non-destructive
  cache inventory. Existing phase-8 incompatibility/failure-stop controls still pass.

The final source additionally checks fixed package/lock/Vite/router/TypeScript
inputs before retaining and consolidates mandatory full-reset fallback for an
untrusted installed tree/input. A completed fallback stops the cohort without
incoming services; it is not a reuse pass. **This small post-failure hardening was
offline checked, not rebuilt into or exercised by the frozen live client.** No
measured transition reached either version's retention/fallback branch. Browser
incompatibility/partial-replacement controls were not run after the first failure.

## Writer and mutation boundaries

This is **validated reuse**, not proven lifetime package immutability. The audit
can prove the current guest VFS matches the immutable manifest at its inspection
boundary. It cannot prove absence of all host/kernel writers, detect a transient
write restored before inspection, prove persisted OPFS byte identity, or make
unrestricted production reuse safe. No hidden writer-exclusion claim is used.

Reviewed workload boundaries:

| Writer | Scope and handling |
| --- | --- |
| Normal managed delivery | Manifest roots `/workspace/node_modules`, `/workspace/.browser-editor-backends`, `/opencode-v2`, `/app`; initial verification and full-tree audit, never a receipt shortcut |
| Source replacement | Removes outgoing workspace source/state except dependencies/backends/toolkit cache; regenerates exact fixture bytes; clears root `/.server`; partial failure stops without incoming services |
| Vite | Optimization at `/workspace/.browser-editor-cache/vite`, temporary bundled config at `node_modules/.vite-temp`; optional `node_modules/.vite` conservatively inventoried; no deletion during validation |
| OpenCode config installer | Public workspace `/.server` maps to guest `/workspace/.server`; plugin/config/home/XDG state/temp paths there (`opencode-chat/src/browser.ts`, `opencode-launch.ts`) |
| OpenCode server | Fixed SQLite state `/runtime-probe/opencode.sqlite` and its adjacent files; guest `/runtime-probe` and both server-state roots inventoried separately from cache content |
| JavaScript plugin | Would write `/workspace/.server/javascript`; no tool/model action invokes it in this catalog-only workload (`javascript-runner.ts`) |
| PDF fixture | Memory/preview DOM completion only; exclusive serial verifier is the sole PDF initiator |
| Audit/replacement tooling | Content-addressed scripts under `.browser-editor-cache/experiments`; these are known benchmark-generated bytes, outside installed package roots |
| Kernel/OPFS persistence | Runtime-owned state/flush/close remains a separate asynchronous writer boundary; joining service exits alone does not prove it absent |

Cache roots must not overlap declared immutable entries and cannot contain
symlinks/special files. Their exact inventory digest is compared immediately
before/after source replacement. Managed symlinks use `lstat/readlink`, never
traversal into outgoing source. The gate joins actual service exits and output
drains, detaches previews through normal controller shutdown, and requires zero
processes/listeners/pending HTTP/fetch inflight/queued/active before replacement.
It does not infer this from `stopRuntime()` fulfillment alone.

**Observed audit evidence here is initial only:** both audits checked all
**12,305** managed entries successfully; Vite caches were absent, and the only
initial `/runtime-probe` file was the normal candidate marker. Because startup
failed before any switch, post-service cache/state inventories, stopped-tree
retention validation and warm mutation boundaries remain **unexercised**, not
silently certified. Each origin had the same one catalog-readiness sequence and
no chat/database conversation history, but database byte equivalence was not
asserted. This workload does not require a speculative immutable environment
architecture to run; it does require validation on every future retention boundary.

## Exact live identity and plan

Fresh origins `http://127.0.0.1:43226` / `http://127.0.0.1:43227` were unused
listeners and had empty IndexedDB, Cache Storage, SW registrations and localStorage
on script-free inspection pages. Sessions were newly owned `brisk-walrus-102` /
`amber-wombat-160`; Browser Control Bun CLI was the only experiment browser owner.
All commands/workload initiations were awaited serially. App switch buttons were
disabled in this mode; no manual/external PDF or switch initiation occurred.

Runtime checkout remains clean at `446df00f86d5d6d5d856a2e5deec0fac49f242fa`.
Distribution remains `4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a`.
On both origins all frozen served identities except the deliberately new client
match phase 7; manifest runtime/policy identities match, all managed file blobs
were rehashed, and original image/bundle lengths/hashes were verified:

- Image **44,123,335 bytes**, `434336bff35c19f8a47a66d9802423ce86a5e18f3cd3c649025c939569e9c41e`.
- Bundle **42,664,752 bytes**, `4593820adf8f9de512767b6c594cb023c84f20ab9b01093d96cd054e993ad401`.
- New live example client **458,184 bytes**, `f626edec12c3bc3174a54fc2d8f7bd277734e1c77a39894079a0e5b8d628dcec`.

Predetermined plan was one generation-1 cold startup per condition, then five
generation-2–6 warm switches each; global pair order baseline/reuse, reuse/baseline,
baseline/reuse, reuse/baseline, baseline/reuse. First failure stops the entire pair.
The approved verifier retains 120-second observation, 30-second hydration/PDF
reads and 240-second outer watchdog. No deadlines were increased after failure.

## Timings and failure

Milliseconds; **cold fresh-origin startup**, not warm-switch comparison:

| Stage | Full reset startup (passed) | Source-only startup (failed) |
| --- | ---: | ---: |
| Workspace open | 415.45 | 565.20 |
| Initial clear | 12.57 | 9.16 |
| Source install | 69.98 | 47.29 |
| Runtime wrapper start | 39.86 | 30.62 |
| Dependency delivery | 2,293.35 | 2,232.52 |
| Delivery flush | 481.26 | 503.98 |
| **Separate initial full-tree validation** | **18,570.42** | **16,950.13** |
| Config install | 19.74 | 8.43 |
| Vite launch/listener | 15,055.54 | 30,046.14 (timeout) |
| Preview interactive, including launch | 35,465.52 | 30,047.03 (failed; not readiness) |
| OpenCode server/catalog readiness, including launch | 15,248.95 | 28,098.23 |
| Concurrent services wall span | 35,486.30 | 30,055.82 |
| Startup total, **including validation** | **57,871.25** | **50,768.38 (failed)** |

Stage spans overlap and must not be added. Totals exclude outer source/PDF
verification and include final flush/overhead. No subtraction of validation is
called user-visible time. **Warm shutdown, replacement, retained delivery/cache,
incoming preview and server timings: no samples.** Initial validation is material
overhead, but this sample establishes neither warm validation cost nor speedup.

Failure events identify `service.listen.failed` for Vite after **30,004 ms** with
`TimeoutError: signal timed out`; its stdout/stderr drained **0 bytes**. Read-only
failure diagnostics show only OpenCode PID 3/listener 4096 remaining, no Vite,
no iframe attachment and zero HTTP/fetch inflight/queued/active. No root cause
(including browser scheduling, package corruption or strategy regression) is
established. The source-only startup still performs the same normal installation;
the retained strategy had not begun when the failure occurred.

## Evidence, cleanup and checks

Distinct ignored evidence directory, absolute:

`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase9-matched-switch-20260929/`

Contains frozen live client, served identities, empty-origin receipts, the fixed
serial driver and verifier bodies, both startup outputs/receipts, timings/events,
failure diagnostics, cleanup receipts and before/after preservation inventory.
Ignored artifacts do not travel with the commit. No old evidence was overwritten.

Closed/flushed only the two owned workspaces after capture. Failure source/tree
was **not cleared, replaced or reinstalled**; origin OPFS storage remains retained.
OpenCode cleanup exits 0/unforced in both; baseline Vite exits 143/SIGTERM/forced
with joined output drains. Closed only the two new sessions and terminated only
owned serving PID **36179**. Ports 43226/43227 no longer listen. Preexisting
43222/43223 retain PIDs **6885/7042**. All eight preexisting target records are
byte-equivalent before/after: the seven retained experiment pages plus the newly
present unrelated `calm-falcon-584` page. None was targeted.

Offline checks after hardening: **29 tests pass, 0 fail, 225 assertions** across
audit/strategy/verifier tests; example TypeScript typecheck and `git diff --check`
pass. No runtime/pin/distribution/IRS/archive edits, push, deploy or model calls.

## Recommendation

**Do not implement retained Vite yet.** This pair supplies a real startup failure
and validation cost, not a matched transition result. Smallest viable next step
is read-only diagnosis of the existing Vite startup/listener deadline failure,
then a separately authorized fixed matched pair using this validated-reuse client
(same startup + five switches each), not a replacement run inside phase 9. The
validation/fallback and post-service mutation controls remain mandatory; mounted
chat, lifetime immutability and production-safe retention remain separate claims.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-29-matched-switch-phase9-live.md`
