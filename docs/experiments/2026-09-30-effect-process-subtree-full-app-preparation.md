# Effect Phase2A process/subtree: matching full-app preparation

2026-09-30. **Fresh delivery ready for parent-assigned qualification.** No browser,
host listener, guest worker/server or inference was started. This is delivery
preparation, not Phase2A acceptance. Earlier Phase1 full-app PASS `8593093` does
not qualify these changed worker/core bytes. Independent 17-gate qualification
and parent review remain separate; no Phase2B, fetch Phase3, persistence or cache
work is claimed or authorized here.

## Fresh frozen handoff

Root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-process-subtree-full-app-Ct6lIy`

Stage: `<root>/frozen`. Machine handoff: `<root>/delivery-handoff.json`.
**9,720 stage hashes** verified, including a fresh independent
`<root>/offline-copy-check`; **9,727 freeze hashes** verified. Prepared manifest
contains **12,303 assets**, freshly built dependency bundle and managed WASM image.
The preparation/checker source is committed as `2f3469a`.

| Item | Identity |
| --- | --- |
| Runtime source | `cc5a932bf4f9a1da4bf8b5d16f6c6c7e4aec573d` |
| Toolkit library/app source | `9814c715cfca42309c581440577976833f4326e6` |
| Effect | exact `4.0.0-rc.118`; chat rc.112 unchanged |
| Distribution version | `446021ba611932b0c531570ecc5739255e8d97f608dcc8c53ad1ca07eeceb6a6` |
| Distribution manifest hash | `4d6bc7247472eeddd32768bd86f32d4577befb6c17d0320781ec06d700ac44ad` |
| Worker | `assets/kernel-worker-a6UDx747.js` |
| Worker hash, SDK/runtime identical | `7d21c5bfe263b047c1113d219623dcba50c47001624939448ae0d3d191926cea` |
| Compiled core | `05859327b72d924b3533fc5b35c6b3db5a3c6ca429339a20da6abe1f5f2ebed5` |
| SDK host | `14e5b1e965c4645ccbed41a93536db8b941b5ed076225dfea9288d9a0b5dfc87` |
| Frozen stage receipt | `cb2a2a686ccad1e0f1f0da17848e4d3d1b29a27ce8c2b61da02109b221219d88` |
| Portable delivery archive | `ffd1a90755b06ed4fe10e9cf5395ada86a8362876713330afa9b0b356a0befdf` |
| Full-app freeze manifest | `14e3acf401b953e9ec5d1361e7fe093e38bd9f97fcbf30bc94cd779473e7f5e3` |
| Source digest inventory | `1ff42461e7129b99dba82f167ca789ba015591be1050cc5d9a556a7e34dc9ccb` |
| New dependency bundle | `58669b9ed74ec62c68116d8b39e959a42367bf6687590889af7b94241bf9893a` |
| New WASM dependency image | `618a91d725d3e4c136c69a00cbe4c14e489d45800c333dacd5e52cc68b647dd3` |

`delivery.tar.gz` includes exact source archives, newly made runnable runtime
source/core/native/SDK archive, frozen libraries/consumers/prepared image, QA source,
adaptation evidence, handoff and source/freeze inventories. No linked development
dependencies are shipped. Commands, stdout/stderr, configs and exits are retained
in the fresh root. No preparation failure or browser retry-to-green occurred.

## Input verification and build separation

Read-only candidate:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-process-subtree-candidate-atw4whjs`.

- Candidate receipt hash:
  `838195f4fed09e75ce83e9991f57d89e3001dd7990b5225e12466ea64f49a1f3`.
- Candidate freeze hash:
  `59b394fab8d6773863f54435e2489b282f10429ad2603f9aebd86d1f3efa9fc8`.
- All **103 candidate / 1,475 freeze hashes** checked before preparation and again
  after full-app freeze. All **12 tracked native inputs / 37 reused output hashes**
  verified. Native rebuild is not claimed. Final evidence:
  `<root>/final-offline-verification.json`.

Workspace/chat JS, declarations and editor styles were built afresh from the exact
toolkit archive against the new SDK before separate clients and normal app dependency
preparation. Declaration builds and original consumer typecheck pass. No old
workspace/chat/client bytes or 5c4/3ee prepared manifests were relabelled as Phase2A.
All six client bundles contain **one Workspace WeakMap**; focused observer access
reexports that same built workspace index. `consumer-graph-verification.json`
records counts and actual new worker/core identity. Observer access is test-only.

Vivari/Effect/SQLite/vendor licenses are included. The input candidate omits standalone
Vivari/SQLite license files from its runtime assets; preparation adds unchanged
Vivari license bytes from the new runtime archive and the independently hash-checked
SQLite license from the previous repaired delivery. No old executable/library bytes
are taken through that license-only copy. Runtime distribution manifest is unchanged.

## Exact qualified application closure

The existing read-only application donor remains
`conservative-full-app-Yb8T8p/qualified-opencode` under the approved temporary root.
The exact current committed application verifier accepts canonical receipt
`40789e37d00c5bfbfc9dad88012d7fe3c88a6054df7a2cbd340e1bd2bd676112`,
published `@opencode/server@2.0.3`, upstream revision
`d44b52ca66b6bf69626c0384626d1a9cd9555977`, and all five actual outputs.
Actual server hash:
`648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5`.

All four actual recipe files (`package.json`, `bun.lock`, `server.ts`, `build.ts`)
were rehashed against the canonical receipt; exact copies/output bytes and verifier
source digest are frozen in `qualified-application/`, `chat/application/` and
`application-closure.json`. The normal app preparer verifies the application again.
**Application outputs are reused, not newly built**; configuration/plugins/codecs
and library implementations are newly built from toolkit `9814c715`. No old chat
payload, fake receipt or skipped verifier is involved.

## Actual emitted URL/native routes verified without activation

`offline-vendor-route-verification.json` covers the newly built SDK/worker and actual
handlers for all three consumer mounts:

| Handler | Asset base | Real vendor path |
| --- | --- | --- |
| Minimal pilot | `/runtime/` | `/runtime/vendor/tsgo-pack.bin` |
| Original full/focused host | `/runtime/` | `/runtime/vendor/tsgo-pack.bin` |
| Todo editor `createBrowserEditorHandler` | `/editor/runtime/` | `/editor/runtime/vendor/tsgo-pack.bin` |

The actual built Host supplies `vivari-asset-base` with the absolute configured
root. Evaluating only the actual emitted worker resolver against that generated
query produces the matching vendor URL. The actual emitted minimal/full fetch
methods are extracted without evaluating their Bun.serve calls; the new built
editor handler is directly invoked without a listener. The existing mounts work:
no runtime URL hacks, host route remapping or distribution relabelling was needed.

Actual `fetchLoaderVendorBytes` consumes **10,793,012 real pack bytes** in one call
through each handler, digest
`f318c6ec229471e1f53be8363e90e2ecdc55faf6549a9e696ee825689129c465`.
Each handler serves the exact new worker bytes via its generated query URL with
COOP/COEP headers. This is real native-adapter/handler delivery evidence, not
worker execution, browser process/subtree cleanup or platform-fault qualification.

The unchanged normal vendor producer builds `tsgo-wasm@7.0.2` in private scratch;
producer/package/installed lock/launcher/license evidence is included. Normal app
preparation reports **34 resolved/downloaded/extracted entries**. Registry downloads
are truthfully recorded; “offline preparation” does **not** mean network-offline.

## Original workloads and executable source preflight

The original full **19-stage / five-generation** and focused **10-case / 14-step**
clients/actions/assertions/deadlines remain unchanged. Independent reverse-adaptation
proof restores byte-identical original full-client and driver source after reversing
only authorized revision/path, source revision field and guest-native-host alias
substitutions. Original host/guest addressing uses `host.vivari.internal` for the
native backend, not virtual loopback. Original 20-second probe, 15-second read/close
and other budgets are not expanded. No generic process fixture was added.

The compiled driver contains this **existing** root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-process-subtree-full-app-Ct6lIy/toolkit-source`.

Preparation checks the path in the actual emitted driver and verifies all required
source files exist. Final verification independently extracts that emitted root
and checks all **three** `receipt.driverSources` hashes against the actual files.
Evidence: `qa/source-preflight.json`, `qa/reverse-adaptation-verification.json` and
`<root>/final-offline-verification.json`. The compiled driver's own source checks
remain intact. Use this local cohort for the next run; archive relocation requires
a new explicit path-only adapter, not an invented directory or skipped preflight.

## Commands and later browser handoff

From `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`:

```sh
# Preparation only; always creates a fresh stage:
bun examples/todo-app/tests/effect-loader-full-delivery-prepare.ts

# Verify only; append a separate NONEXISTING output directory to create a run copy:
bun examples/todo-app/tests/effect-loader-full-delivery-run-copy.ts /private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-process-subtree-full-app-Ct6lIy/frozen
```

**Only after independent gates/parent review and assignment of one visible owner**,
create a fresh run copy. None of these activation commands was executed:

```sh
# Original combined full/focused cohort expects both fresh owned origins:
bun <run-copy>/qa/serve-single-kernel.js <run-copy>
bun <run-copy>/qa/serve-single-kernel.js <run-copy> --contracts
SINGLE_KERNEL_AUTHORIZE_RUN=yes bun <run-copy>/qa/effect-loader-full-app-driver-qa.js <run-copy> <new-evidence-directory>

# Alternative manual finite real-kernel loader/process UI, no inference:
bun <run-copy>/qa/effect-loader-full-delivery-host.js <run-copy>

# Alternative actual todo/editor UI, model routes prohibited:
bun <run-copy>/qa/live-host.ts <run-copy>
```

The existing minimal UI supports explicit boot, real guest `tsc --version` child
launch, public joined Runtime stop and diagnostics, native header hold/release.
It does not automatically boot or infer acceptance. Held native requests are bounded
at two; control requests remain outside that bound. Full/focused public controls
already cover normal process behavior; partial worker/descendant fault injection
remains controlled-leaf independent evidence and is not falsely called browser QA.

## Boundaries and costs

Retention stays off and source/default behavior is unchanged. Old frozen stages,
reports, failures and original runners are preserved. Only owned preparation/checker
files and this report changed; no production runtime/library source, canonical pins,
shared dist/.runtime, master plan or independent fixtures were edited. No push.

The implementation-owner report's **16/17** new-gate result and its retained failure
require independent fixture-contract review; delivery success does not waive that
denominator. Actual live full/focused/native/process/subtree/editor outcomes remain
pending. Additional worker gzip cost is **+1,899 bytes** versus Phase1; its earlier
imperative comparison remains separately **+135,365 gzip bytes**. Runtime overhead
and performance are unmeasured. No broader ownership/quiescence claim is made.
