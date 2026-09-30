# DONE: bounded single-kernel working fork acceptance on e35eab4

Handoff: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-working-fork-e35eab4.md`.

## Outcome and exact scope

**The requested bounded working-fork criteria are now complete on one identified
runtime version.** Combine the **19 completed Chrome client stages** in the first
e35eab4 attempt with **2 standalone reload actions and 10 focused cases / 14 steps**
in the explicitly authorized remaining-only attempt. All evidence below uses the
same runtime distribution and worker hashes. No f545699 or headless result is
substituted for a final-version Chrome pass.

The original e35eab4 attempt remains labelled failed at its immediate post-close
target census. A later read-only census showed zero workers; the separately
labelled remaining attempt qualified bounded target-removal observation and the
previously missing cases. This is criterion-level completion across explicitly
authorized same-version runs, **not** a retroactive all-green first-cohort claim.

## Final immutable identity

- Runtime repository: `/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel`.
- Runtime branch: `experiment/single-kernel-runtime`.
- Source: **`e35eab4af7a53ff08eb70c09df59c40b78bfdd67`**.
- Distribution: **`bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`**.
- Kernel: `kernel-worker-1aDiRZSX.js`, SHA-256
  `1316335f08db867e269b43dc324163b5449487ee9ca14588d8b5ca2ff2aead09`.
- Guest: `process-worker-ZQRq3H73.js`, SHA-256
  `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7`.
- Toolkit repository: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`.
- Toolkit branch: `experiment/single-kernel-runtime`; earlier harness milestones
  `b5a22d3` (SSE mount repair), `74f45fb` (bounded census), plus the completion
  commit containing this handoff and remaining-only runner.

Kernel and guest JS/declaration build actually ran together from the clean
checkpoint. **37** native outputs and their tracked inputs were verified against
clean donor `446df00f86d5d6d5d856a2e5deec0fac49f242fa`; wasm-pack was **not** rerun.
Build receipt retains **40** emitted assets, licenses and source provenance.
Matching app preparation contains **12301** verified dependency/runtime entries.

Remaining-only preparation verified and copied the receipted final artifacts,
then built only new reload/focused consumers against the frozen libraries. It did
not rebuild/read runtime source or relabel a different distribution. Driver source
hashes and every served artifact hash were checked before browser initiation.

## Actual Chrome criterion checklist

| Criterion | Final-version evidence / result |
| --- | --- |
| One kernel plus guest processes only | PASS: active Chrome census and runtime counters agree; no FS/fetcher/HTTP/LSP/SQLite auxiliary workers |
| Synchronous FS, newline names, metadata, symlinks, rename | PASS in 19-stage run |
| Original child execSync fixture, binary >1 MiB | PASS once first after open: 1048583 byte-by-byte guest checks, maxBuffer 2097152, independent host readback |
| Binary capture/encoding/error boundaries | PASS: 0/255/700000/800000/1048583 bytes, both streams at 1048583, latin1, default and 16-byte ENOBUFS cases |
| Spawn capture ownership cleanup | PASS: ownedSpills=0 after live capture stages, all application checkpoints, joined shutdown, reload and focused stopped checkpoints |
| Minimal async spawn/spawnSync/execSync | PASS, same existing-file child, natural exits |
| Fetched-body pin eviction/fd fallback | PASS: held body survives eviction, exact bytes, reclamation after read/exit |
| Host watch/concurrent flush | PASS, persisted renamed files and deletion |
| HTTP credit/backpressure/exact bytes | PASS: 16 MiB stream, unread stall at 2/256 chunks, 256 drains; independent focused slow-reader case |
| Before-header abort / reader cancellation | PASS focused cases 0–1 |
| Stale endpoint / reused port | PASS focused cases 3–5: replacement listener inaccessible through stale endpoint, execution/runtime stop clean child listener, reuse works |
| Handler/shutdown sync filesystem | PASS stream health after cancellation, graceful EOF shutdown marker and zero-work |
| Vite fresh hydration/todo/PDF | PASS all five generations (startup plus exactly four A/B switches) |
| Generation-specific freshness | PASS generation/workspace markers, fresh submitted todo/PDF, removed obsolete switch module; no extra generation replay |
| HMR | PASS same preview document and fresh marker |
| OpenCode health/plugins/config/model catalog | PASS five generations, no inference calls |
| Correctly mounted SSE handshake/cancel | PASS server.connected, abort, pendingHttp=0, healthy service afterward |
| Joined app shutdown | PASS retained zero-work/zero-spill result; asynchronous Chrome target disappearance separately observed |
| Real document reload / durable binary and deletion | PASS new page seed, flush/close, actual page.reload, reopen marker + exact 1048583-byte renamed file and deleted-file absence |
| Managed root recreate/removal absence | PASS focused case 6, three real document steps; unrelated data preserved, old descendants and removed /.server do not resurrect |
| OPFS exclusive lease/release | PASS focused case 7: competing Web Lock excluded while live, released on orderly close |
| Concurrent OPFS writes/rename/delete/truncate | PASS focused case 8: backing files/manifest verified, real reload preserves exact final bytes/absence |
| SQLite pathname owner/process-exit release/rollback/reopen | PASS focused case 9, two real document steps |
| Close target propagation | PASS new bounded read-only census: 42 observations, 4 initially nonzero samples, all required boundaries reach zero within 15 seconds; no stop/close replay |

Focused cases are exactly **4 HTTP + 2 process + 4 storage**, **14 steps**. Each next
case starts only after prior workspace/runtime cleanup and zero-worker proof. OPFS
deletion between cases is restricted to the new owned case origin; multi-step
storage cases preserve backing data across their authorized document reloads.

## Evidence, run boundaries and cleanup

19-stage final-version app evidence:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-live-e35eab4-attempt1/failure-app.json`.
Its immediate census error and later zero census remain in that directory.

Remaining-only artifact:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-e35eab4-remaining-attempt1`.
Remaining-only evidence:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-live-e35eab4-remaining-attempt1`.

- `result.json`: **passed**, exact revision/version, case names/counts, no retries/models.
- `reload-seed.json`, `real-reload-verified.json`: durable marker/binary/deletion
  proof, stopped diagnostics with ownedSpills=0, post-close worker census.
- `case-0-0.json` through `case-9-1.json` (14 files): each step's completion,
  runtime topology/stopped diagnostics and actual post-close Chrome targets.
- **178** command receipts: one-shot actions, bounded read-only polls, document
  reloads, storage operations and digest-checked evidence export.
- `ownership.json`: frozen receipt, new origins, sessions, lock, deadline budget.
- `server-cleanup.json`: only the two new healthy servers signalled after success.
  Both background server processes subsequently completed with SIGTERM, joining
  their owned shutdown. Browser sessions were deleted after zero-worker proof;
  the remaining-only ownership lock was released.

Completed new origins: `http://127.0.0.1:55018/` (PID 96428),
`http://127.0.0.1:55019/` (PID 96429). Both servers now stopped.
Sessions `single-kernel-reload-45ff1a9b` and `single-kernel-remaining-b6f2a61d`
were deleted. The `.diagnostics/single-kernel-e35eab4-remaining.lock` is released
(independently checked absent after the run).
All four earlier failed cohort locks/pages/servers remain untouched and retained;
they must not be mistaken for resources leaked by the successful remaining run.

## Reproduce without changing canonical pins

From the toolkit root above, with a clean explicitly coordinated runtime checkout:

```sh
VIVARI_SOURCE=/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel bun vivari/scripts/receipt-single-kernel.ts /Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean
VIVARI_SOURCE=/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel VIVARI_WORKER_TOPOLOGY=single-kernel bun examples/todo-app/tests/prepare-single-kernel.ts
```

The complete app preparation pipeline is documented in
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-first-live-cohort.md`
(use the final checkpoint and current harness, not its old receipt). It uses
`build-single-kernel-app-preparer.ts`, `snapshot-single-kernel-app-input.ts`, and
`attach-single-kernel-prepared.ts` to avoid editing published/qualified inputs.

To reproduce just the remaining suite against frozen final runtime bytes, choose
**new** absolute output/evidence directories (never overwrite those listed above):

```sh
bun examples/todo-app/tests/prepare-single-kernel-remaining.ts .diagnostics/single-kernel-e35eab4-full-attempt1 "$NEW_OUTPUT"
bun examples/todo-app/tests/serve-single-kernel.ts "$NEW_OUTPUT" --reload
bun examples/todo-app/tests/serve-single-kernel.ts "$NEW_OUTPUT" --contracts
SINGLE_KERNEL_AUTHORIZE_REMAINING=yes bun examples/todo-app/tests/single-kernel-remaining-driver.ts "$NEW_OUTPUT" "$NEW_EVIDENCE"
```

Server commands run as separately owned long-lived processes; exact PIDs are in
the new origin receipts. Successful workspace/session cleanup is performed by the
driver; stop only those new servers afterward. No reproduction command here was
run against an old retained origin.

## Qualification limits

This is **bounded working-fork acceptance**, not all-feature production/release
certification. No performance comparison, model inference, production pin/archive
change, deployment or push occurred. Source-mode Studio, every unrelated browser
contract, arbitrary npm/application compatibility and fault-injected spill staging
are not newly qualified here. Runtime-owner fault-injection/node/TS tests remain
explicitly offline; previous unrelated/baseline failures are not silently marked
fixed by this selected suite. Binary byte-exact checks ran at foundation and real
reload, not separately inside every Vite generation.

Offline toolkit verification: 26 focused tests / 140 assertions pass; strict
consumer typecheck including remaining runner/preparer/reload client passes.
No runtime source edits were made by this acceptance owner.
