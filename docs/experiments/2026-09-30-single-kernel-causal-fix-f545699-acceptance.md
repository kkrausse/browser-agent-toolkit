# f545699 Chrome acceptance: binary fix passes; harness SSE mount blocker

Report: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-causal-fix-f545699-acceptance.md`.

## Outcome

**Functional acceptance advanced, not complete.** Actual Chrome passed the exact
formerly hanging 1,048,583-byte execSync binary fixture **once**, first after open,
with guest byte-by-byte validation and independent host FS byte-by-byte readback.
Both natural process completion and zero-work diagnostics were observed. This is
not a substituted headless or tiny-output result.

The driver continued into application acceptance as authorized. It stopped at the
first error: the test's OpenCode SSE call resolves `/api/event` outside its preview
endpoint mount. No runtime hang or capture-publication failure was observed. The
failed stage was not retried, nor were remaining stages launched. No final working
fork milestone or complete acceptance is claimed.

## Actual pass/fail/missing criteria

Thirteen client stages completed: open, child-sync, binary-capture-boundaries,
filesystem, minimal-async-spawn, minimal-spawnSync, minimal-execSync,
fetched-body-evicted-pin, concurrent-watch-flush, http-backpressure,
persistence-recreate, apps-1, hmr.

| Criterion | Actual result |
| --- | --- |
| Original binary execSync, maxBuffer 2097152 | PASS: 1048583 exact bytes, guest and host, natural completion |
| Binary capture inline/spill-sized cases | PASS: 0, 255, 700000, 800000, 1048583 bytes, byte-by-byte |
| Both capture streams | PASS: stdout and stderr each 1048583 exact bytes |
| Capture limits/error completion | PASS: default overflow ENOBUFS, SIGTERM/null status, 1048576 exact captured bytes; execSync/execFileSync maxBuffer 16 throw ENOBUFS with exact prefix; latin1 preserved |
| Tiny spawn API variants | PASS: async spawn, spawnSync, execSync, existing-file completion markers |
| Sync FS/newline/symlinks/stat/rename | PASS, including 1048583-byte binary readback |
| Evicted fetched-body pin | PASS: held body survives 16 MiB cache eviction, exact fd fallback, reclamation after read/exit |
| Concurrent writes/watch/flush | PASS, including persisted rename/deletion on recreate |
| HTTP stream credit/backpressure | PASS: unread producer stalls at 2/256 chunks; exact 16777216 bytes; 256 drains |
| HTTP cancel/shutdown/stale endpoint | PASS: cancel followed by healthy sync-FS handler; natural exit, shutdown file, stale endpoint rejected, zero-work |
| OPFS close/recreate | PASS: durable markers, renamed files/concurrent writes/deletion preserved |
| Actual Chrome topology | PASS at driver census checkpoints: one kernel, only expected process workers; registry agrees, no auxiliary workers |
| Vite app generation 1 | PASS: hydration, actual new todo submission appears, generation-specific PDF click produces bytes |
| OpenCode readiness | PASS: health, plugin activation/list, config, model catalog; no model inference calls |
| Vite HMR | PASS: fresh marker in the same preview document |
| OpenCode SSE abort | FAIL before request dispatch: harness URL rejected by endpoint boundary |
| Four subsequent A/B switches | NOT RUN |
| Final reload persistence | NOT RUN |
| Separate 10 focused HTTP/process/storage cases | NOT RUN; includes before-header abort, port reuse, bulk delete/recreate, Web Locks and SQLite rollback/reopen |
| Spill staging-fault rollback/ownership cleanup | NOT claimed; parent reports known P2 issue under repair, with offline fault-injection owned by runtime agent |

## Concrete blocker: test URL, not runtime publication

Retained client error: `Error: URL belongs to another endpoint`.
`single-kernel-client.ts` used `service.connection.fetch('/api/event', ...)`.
The authenticated connection in `opencode-chat/src/browser.ts` constructs
`new URL(input, endpoint.url)`: a leading slash selects the host origin root.
The host endpoint correctly rejects absolute URLs outside `/preview/4096/` in
`packages/core/src/host-sdk/browser/endpoint.ts`. Its readiness path works because
that code calls the lower-level workspace-relative `Endpoint.fetch` directly.

Prepared offline repair adds `connectionApiURL`: resolve `api/event` and
`api/health` under the connection's preview mount, and test the resulting URLs.
This changes test source only, not the production connection or runtime. It is
**not** in the frozen running consumer and was not hot-injected. Further live
continuation/replay or a replacement cohort requires parent coordination after
this first-failure pause. The old attempt remains a failed attempt.

Failure diagnostics remain responsive: one kernel, three processes (Vite PID 1,
its wasi-worker PID 2, OpenCode PID 3), listeners 5173 and 4096, pendingHttp=0,
fetch active/queued/inflight=0, no reported worker errors. The full latest-64 ring
is retained, but no SSE dispatch trace exists because the URL was rejected first.

## Frozen source/build/provenance

Source: `f5456996d511225d0147682cccddbf16adab4b4e`.
Distribution: `4a096c95810757190f1489c8f77c2f4200f2d77f8c1e3f3755863eec9a9567e4`.

- `kernel-worker-6WnygoCT.js`, SHA-256
  `140c7ad738515d48279a6d29367ff02233f05f9079d067da95cd615641f2789d`.
- `process-worker-ZQRq3H73.js`, SHA-256
  `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7`.

Both changed worker bundles were actually rebuilt together via core Vite and
declaration build from the clean checkpoint. Native inputs and 37 native outputs
were verified against clean donor `446df00f86d5d6d5d856a2e5deec0fac49f242fa`; no
wasm-pack rerun is claimed. Receipt contains 40 emitted assets.

Frozen libraries/consumer:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-2026-09-30T06-52-21-541Z`.
Matching app preparation generated **12301** verified dependency/runtime entries.
Qualified unchanged UI was a read-only input, replacing runtime-facing libraries;
no guest worker from the earlier cohorts was mixed into this distribution.

After the parent announced runtime source-only cleanup work, **no runtime rebuild
or source-based re-preparation occurred**. Added `attach-single-kernel-prepared.ts`
to verify frozen receipt hashes and matching app assets, then copy them into a new
fully prepared output without reading the changing source checkout. All final
artifact hashes were verified again before browser initiation.

Served frozen artifact:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-f545699-full-attempt1`.

## Evidence and ownership

Evidence directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-live-f545699-attempt1`.
`failure-app.json` contains full client stage results and failure diagnostics,
exported in 8000-character SHA-256-verified chunks. `result.json` records the failed
cohort; **143** CLI command receipts retain initiations, polls, UI checks/census
and evidence reads. Console logs are retained separately. No ambiguous or pending
driver command remains (`expired=false`, `actionPending=false`, `commandPending=false`).

- App origin `http://127.0.0.1:51587/`, server PID **85735**,
  session `single-kernel-app-489b4798`.
- Reserved unused cases origin `http://127.0.0.1:51586/`, server PID **85736**,
  session `single-kernel-cases-6cc7e8c0`.
- Distinct lock:
  `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-acceptance-f545699.lock`.

The third cohort's resources remain retained. Neither earlier failed cohort,
its ownership lock, pages, nor servers was touched. No retries, runtime source
edits, production pins/archive edits, performance comparisons, model requests,
pushes or deployments occurred.

## Corrections and next boundary

The earlier report's inference that no live child meant failure before child FS
was too strong: absence from the later registry cannot rule out already-exited
children. The parent's causal capture-overflow diagnosis and 3e390d4 child-exit
trace supersede that localization. f545699 now demonstrates byte-exact completion
in actual Chrome. Its known staging/orphan cleanup issue remains a separate gate;
this functional pass does not erase it.

Offline post-attempt verification: **25 tests pass, 0 fail, 137 assertions** across
six suites, including fail-fast sequencing and URL/binary contracts. Generated
consumer strict typecheck passes. The mount repair is offline-only at this point.
Next live work must be explicitly coordinated: preserve this failure, choose the
clean cleanup checkpoint and repaired consumer, then complete SSE, four switches,
reload and focused cases without relabeling skipped criteria as passing.
