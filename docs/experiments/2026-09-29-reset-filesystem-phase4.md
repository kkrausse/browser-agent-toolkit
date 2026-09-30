# Clean completion candidate qualification — 2026-09-29

## Outcome

**Clean candidate prepared; bounded browser qualification remains incomplete.**
The deterministic transport regression fails on exact pinned `e998de62` and
passes on the clean candidate. Four install-only switches and the existing OPFS
root-recreation reload contract pass. The service cohort stopped at its second
switch on a Browser Control execution-context error, not a runtime `ENOTEMPTY`.
No switch was retried and no replacement service cohort was started. Newline
removal remains expected-red. No production promotion or speed claim is made.

## Clean source and headless checks

Runtime worktree:
`/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean`.
Branch: `candidate/kernel-fs-completion-clean-20260929`.
Commit: **`446df00f86d5d6d5d856a2e5deec0fac49f242fa`**, directly based on
`e998de62a10e5382104b51e0b860ee9d4d7a2401`.

Only six files differ: kernel-fs's completion predicate, the deterministic test,
its package command, and relevant AGENTS/architecture/roadmap documentation.
No inherited diagnostic instrumentation or newline correction is included.
The historical checkout, `9ee2b88` diagnostic branch and `0af7375` candidate
remain unchanged. The diagnostic's pre-existing untracked probe is preserved.

`bun run test:kernel-fs-completion` was run once with `VIVARI_TEST_SOURCE` pointing
at the exact historical checkout and once on clean candidate source. Baseline
exits 1: both kernel cases consume REQUEST/RES_LEN=0 and fail empty JSON; both
process controls pass. Candidate exits 0: all four client/metadata-or-errno cases
pass, with two waits for lstat. This proves the source defect, not attribution
of any retained natural browser failure.

Host Node **24.7.0**, Bun **1.4.0**, Browser Control **0.8.2**. Qualified Node
24.18.0 was not available and is not claimed. Focused `fs-remove`,
`fs-permissions`, `fs-native-realpath` pass, plus eight explicitly selected
contracts: `ts-module-alias`, `package-self`, `esm-export-comments`,
`net-backpressure`, `node-entry`, `stream-consumers`, `vm-import`, `sea`.
That is **11/15 runtime contracts**, not a full-suite pass. The full entrypoint
fails first at `worker-uncloneable` (`markAsUncloneable is not a function`) on
both exact pinned baseline and candidate. Individually rechecked `brotli`,
`shell-quoting`, and `process-warning` also fail on both; their earlier reported
signatures remain. No claim that all failures share a Node-version cause is made.

## Isolated build and delivered identities

Private recipes/evidence, absolute:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase4-clean-completion/`.
This distinct directory was created after inventorying phases 1–3; none of their
ignored recipes, receipts, payloads or served distributions were overwritten.

`build.ts` follows the prior verified native-reuse recipe, records schema-2
source/build receipts, runs fresh frozen `npm ci` and the normal `build:core`,
and produces a clean-source candidate receipt. wasm-pack is absent: native
artifacts were **reused, not rebuilt or freshly toolchain-qualified**. All
native crate source inputs, `.cargo`, present root Cargo/toolchain files, and
all native output hashes were checked against exact pinned source and its
original build receipt. Native toolchain fields identify the inherited receipt;
current Bun is recorded separately. Reuse provenance and recipe hash are explicit.
No shared integration receipt/cache was replaced.

The isolated distribution recipe retains the normal packaging integrity/ABI
checks and preview-query SW transform, with only its receipt location/import
paths redirected. `identity.ts` fetched and verified every packaged served
asset against the candidate receipt (SW against the delivered transformed
bytes). Root SDK declaration files are build outputs, not served distribution
assets. Key SHA-256 identities:

| Item | Identity |
| --- | --- |
| Distribution version | `4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a` |
| Served distribution.json | `9d2bf835ae9227df6ac37192ba7e6bdaf1276965912875f53e3ccce5f7a58f27` |
| FS worker `fs-worker-BY3WKtYX.js` | `77b47d3dc99b7fee3ad04d96947be48a633f0a383d85ad11fbfc7d3671f79cb5` |
| Kernel worker `kernel-worker-60kzmiNY.js` | `4af82cfbd5cea9578c2876c548213d672565b2c08409dfa5e94bc742063c1746` |
| Process worker `process-worker-BNtwFfrJ.js` | `368aae7bcec2a5d6db25bbcc25f7b4baa40d515aa383ae5b106dcee3cb5a05da` |
| Delivered SW adapter | `68cb2b42e086c0bce03ba8f3a96344d5b1fba66ad3d295c84a098c700f89075d` |
| Served prepared manifest | `4098a3a521627837bdcafd2461127f245c6d59cd92d49b4c12953ef0437e4f21` |
| Staged pretty-JSON manifest | `bb0041ee9bc8bab2cf731f68a70dd28ca1ee895efa5d1b4a7e7f99bcad92c7f8` |
| Served client | `874e0cfe71460dba6baec2fe242630ccc88f475761143bd3109da4f4bd60b9d5` |

FS/process workers and delivered adapter remain baseline-identical; the predicate
correction lives in the separately hashed kernel worker. Candidate manifests
identify the actual distribution in both runtimeVersion fields. The only parsed
manifest changes from phase 3's original baseline are these two fields.
All **12,305 entries** (bodies, lengths, modes, link targets), project source,
backend/alias policy, bundle and image remain matched to phase 1/3 originals:

- Image 44,123,335 bytes:
  `434336bff35c19f8a47a66d9802423ce86a5e18f3cd3c649025c939569e9c41e`.
- Bundle 42,664,752 bytes:
  `4593820adf8f9de512767b6c594cb023c84f20ab9b01093d96cd054e993ad401`.

Preparation initially tried to copy nonexistent `project.json`; source project
is embedded in the manifest. This setup-only mistake was corrected before serving.
Identity verification initially included unserved root SDK declarations and was
corrected to check the packaged assets. Neither caused browser reset attempts.

## Predetermined browser budget and results

Budget fixed before execution: **up to 12 actual-service A/B switches, four
install-only switches, one ordinary/symlink/newline control set, and one existing
three-step OPFS reload contract**. First failure stops each cohort; no extension.
All automation used the Bun-backed Browser Control CLI, not MCP.

| Fresh origin / cohort | Startup | Switch attempts | Fully verified passes | Stop reason |
| --- | --- | --- | --- | --- |
| `http://127.0.0.1:43224`, actual Vite/OpenCode | Ready | 2 | **1** | Switch 2 post-switch verification: execution context destroyed |
| `http://localhost:43224`, no services | Ready | 4 | **4** | Budget exhausted |

Every counted pass checks exact bytes of **26 source/binary fixtures**, outgoing
A/B-only filename absence, and, for services, hydrated enabled input and nonzero
PDF generation. Initial service readiness was first incorrectly rejected by an
added fixed 876-byte PDF-size assertion (actual 875). Generated PDFs vary with
metadata/compression; the original nonzero-length workload check was restored.
Readiness was checked again on the same untouched generation, **before any
switch**. The rejected receipt is retained, not counted as a runtime failure or
extra startup. PDF byte content is not exposed by this fixture; no exact PDF
content-identity claim is made. Observed lengths range 874–876 bytes.

Service switch 1 passes completely. Switch 2's receipt captures exact generation
2 source before switching, then reports:
`page.evaluate: Execution context was destroyed, most likely because of a navigation.`
No top-document navigation or runtime error is reported. A bounded read-only
follow-up finds `ready:true`, error empty. A later final observation verifies
exact generation **3** source/binary bytes and outgoing-file absence. Thus the
second deletion/install completed, but missing post-switch hydration/PDF proof
means **it is not promoted to a qualified switch pass**. No deletion retry,
workspace switch, page reload or replacement cohort followed it.

Both attempted service switches have after-stop receipts: empty process/listener
tables, zero pending HTTP, and both drains joined. OpenCode exits 0/unforced;
Vite exits 143/SIGTERM/forced. These are joined shutdown observations, not
graceful-Vite-exit claims or exhaustive host-write exclusion. The five no-service
ready generations establish installation/source retention, not editor readiness.
OpenCode checks establish server/config/plugin/model-catalog readiness, not a
mounted usable chat client or model/session isolation. No model calls occurred.

### Controls and OPFS

- Directory and dangling symlink removal passes; guest fixture exits 0/unforced,
  drains join before removal, original links are independently classified, root
  becomes ENOENT, and external target sentinel remains `outside target`.
- Ordinary filename removal passes, with original regular-file metadata and
  subsequent ENOENT; process/listener tables are empty.
- Newline is **expected-red**: first removal returns ENOTEMPTY; exact
  `/reset-newline-control/line\nbreak.txt` remains inode 12400, 13 bytes,
  SHA-256 `218729319297ff74e921f6e2ecb337eb2d8f57d0e00a5d59632352caabc1960a`.
  It was not retried or corrected. The full deletion gate is not green.
- Existing `bulk root replacement coalesces delete and recreate without restoring
  stale descendants` passes **all three steps across real document reloads** on
  separate disposable `http://127.0.0.1:59298`. Both recreated and absent managed
  roots, old source/chat descendants, and unrelated sentinel persistence are
  checked. Its healthy kernels/storage/session/server were cleaned up. Only this
  filter ran; no wider browser contract suite is claimed.

## Retention, remaining gates, recommendation

All original five pages (`quiet-falcon-568`, `clever-badger-501`, `calm-otter-581`,
`gentle-otter-722`, `amber-badger-702`) were not targeted, reloaded, switched or
closed. Pre-existing servers 43222/43223 were untouched. No production pins,
IRS/archive files, deployments, pushes or model requests changed.

New **newline failure page `lucky-walrus-901` is retained with its kernel and no
services**. Do not reload/switch/close it. Service automation-error page
`lucky-tiger-691` is retained for DOM/journal context, but its independently healthy
kernel/services were orderly closed after final evidence capture. Owned server
43224 (PID 61970) was terminated; no pre-existing server was stopped. Reopening
that server is not authorization to retry either cohort.

Evidence includes `services/reset-1790727182324.json`, `failure-followup.json`,
`final-observation.json`, `no-services/newline-expected-red.json`, both cohort
journals, `served-identity.json`, build receipt/logs, contract logs and `opfs.log`.
Ignored private evidence/recipes do not travel with this documentation commit.
No shared harness source change was required. Runtime and toolkit diff checks
are required before committing their own changes.

**Next recommendation:** review the Browser Control interruption and its bounded
reproduction before authorizing another fresh service cohort; do not silently
resume or enlarge this one. Keep the candidate isolated. It still owes complete
actual-service browser reliability evidence, qualified Node/native-build checks,
resolution or explicit disposition of baseline contracts, and a separate newline
framing correction before any unrestricted deletion/production qualification.
