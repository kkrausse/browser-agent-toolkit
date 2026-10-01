# URL-repaired Effect loader: matching full-app preparation

2026-09-30. **Ready for parent-assigned qualification, not browser acceptance.**
The old URL blocker is resolved in a newly built matching cohort. No browser,
listener, guest worker/server or inference was started. This is Phase1 preparation,
not a full Effect migration, phase2 authorization, pin promotion or timing claim.

## Exact fresh handoff

Root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-full-app-UMORaL`

Frozen stage: `<root>/frozen`. Machine handoff: `<root>/delivery-handoff.json`.
**9,721 artifact hashes** verified, including a separate new
`<root>/offline-copy-check`. Prepared manifest: **12,303 assets**, plus the newly
prepared full dependency bundle and managed WASM filesystem image.

| Item | Identity |
| --- | --- |
| Runtime source | `3ee918522c1233a1f8e10a9b798c09b6c3e30c81` |
| Toolkit library/app source | `9814c715cfca42309c581440577976833f4326e6` |
| Owned preparation/checker commits | `515d0e9`, `56828b2` |
| Effect | exact `4.0.0-rc.118`; chat rc.112 unchanged |
| Distribution version | `bd39000ff5bbc334f836ad65a4433e627525070413f810d7169132102f49b9f9` |
| Distribution manifest | `9fa3e1dd22309289da3de03550118b2f914c5d53201c16890f48264368ff75fd` |
| Worker | `kernel-worker-CvW5AR9j.js` |
| Worker SHA-256 | `c4193ae0cba8419149738ed2b3a74d79d5f59f5e447eff129106ca2f3532fecb` |
| SDK host SHA-256 | `14e5b1e965c4645ccbed41a93536db8b941b5ed076225dfea9288d9a0b5dfc87` |
| Unchanged compiled Effect core | `211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070` |
| Frozen stage receipt | `42d8ba68c2f0c972c7c5bdabe82e5fc112c75af3005d39fcf77693219563ae2a` |
| Delivery archive | `cf52e9f97a46a205fa6c5352cf97243763815239e5895a1f52b226648719d02f` |
| Freeze manifest | `1e78bbc914259053e6b96dfd95822bfb582e9ea325f7e8a541248663555fcc17` |
| Source digest inventory | `cf54f5431865ef458510cae04d942c7b218739f6735b2460a2c61f230963bedc` |
| Prepared dependency bundle | `7491461177dc0c827643885e1d61b758a1fcb0eca0e78f827ec1f3ed2dc3000f` |
| Prepared WASM image | `781f680722ff32bce616a7c7b058d7b53b75bf6462db7f5af0c700a1e102c18a` |

`delivery.tar.gz` includes frozen bytes/QA sources, exact runtime/toolkit source
archives, runnable runtime/source/core/native archive, source digest inventory,
adaptation evidence, handoff and **9,728-file** freeze inventory. Linked local dev
dependencies are not shipped. Command logs/configs remain in the fresh root.
The compiled full driver retains its original source checks against this local
committed archive; moving the whole delivery elsewhere needs a new explicit
source-path-only adaptation, not skipping those checks.

## Repaired input and application closure independently checked

Read-only input:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-vendor-url-repair-l9k65fzh`.

Its candidate receipt remains
`e242092e6a920b88a6a2ae7eb76654f1f61773a3bcf99ee4bcbe61f6b85ee6e6`.
All **107 candidate / 1,020 freeze hashes** were verified before preparation and
again after final freeze. All **12 native inputs / 37 reused outputs** rechecked;
no native rebuild is claimed. `<root>/final-offline-verification.json` records the
final independent delivery-owner pass.

Application recovery uses the same read-only actual qualified donor as before:
`conservative-full-app-Yb8T8p/qualified-opencode` under the approved temporary root.
The verifier from exact toolkit `9814c715` accepts receipt
`40789e37d00c5bfbfc9dad88012d7fe3c88a6054df7a2cbd340e1bd2bd676112`,
published `@opencode/server@2.0.3`, upstream revision
`d44b52ca66b6bf69626c0384626d1a9cd9555977`, and all five actual output bytes.
The actual server is hash
`648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5`.
All four actual recipe files (`package.json`, `bun.lock`, `server.ts`, `build.ts`)
again match the canonical receipt's hashes. Exact files/outputs and verifier digest
are retained in `qualified-application/`, `chat/application/` and
`application-closure.json`. This is verified application reuse, **not** a new
OpenCode build or relabelled old chat payload.

Workspace/chat JS, declarations and styles were freshly built from the exact
committed source against the **new SDK** before separate consumers and dependency
preparation. Current configuration/plugins/codecs come from that source and are
covered by source, built-library and prepared receipts. The normal preparer verifies
the application again. No old 5c4 prepared manifest, library or client was reused.

## Real emitted URL, actual host mounts and native bytes — offline

`frozen/offline-vendor-route-verification.json` records three passing checks:

| Consumer/actual handler | Public asset base | Actual tsgo URL |
| --- | --- | --- |
| Minimal real-loader pilot | `/runtime/` | `/runtime/vendor/tsgo-pack.bin` |
| Original full/focused host | `/runtime/` | `/runtime/vendor/tsgo-pack.bin` |
| Todo editor, `createBrowserEditorHandler` | `/editor/runtime/` | `/editor/runtime/vendor/tsgo-pack.bin` |

The checker imports the **new built SDK Host**, supplies the actual distribution
manifest and controlled Worker leaves, and verifies its generated
`vivari-asset-base` absolute-root query. It parses/evaluates only `vendorUrl` from
the **actual emitted worker** using that generated worker URL. It does not evaluate
the worker entry module or start a Worker.

The minimal and full/focused fetch methods are extracted from their actual emitted
`Bun.serve` bodies without evaluating their entry modules or starting listeners.
The editor uses the actual newly built `createBrowserEditorHandler`, with its
existing `/editor/runtime/` mount. No URL hacks, runtime repair or manifest relabel
is applied. Both root and editor mounts already serve the exact runtime directory;
no QA route rewrite was necessary.

For each mount, actual `fetchLoaderVendorBytes` reads the real **10,793,012-byte**
pack in one native-adapter call through the handler. SHA-256:
`f318c6ec229471e1f53be8363e90e2ecdc55faf6549a9e696ee825689129c465`.
The worker fetched through each generated URL also matches its exact hash and
COOP/COEP headers. These checks establish static delivery compatibility, **not**
browser cancellation, shared-install or successful stop receipts.

The unchanged committed vendor producer prepared real `tsgo-wasm@7.0.2`; package,
installed lock integrity, launcher, license and producer digest are included. Normal
application preparation reports **34 resolved/downloaded/extracted entries** and
the normal tsgo producer installed its input. Registry downloads are recorded:
this was **no-live-execution preparation**, not a network-offline build.

## Original workload/graph preservation

- Declaration builds and original consumer typecheck pass; command logs retain
  exact invocations/output/exits. No original QA assertions/deadlines were edited.
- The read-only conservative preparer is taken from exact commit `1fb7efe`.
  Private adaptations change only exact source revisions/paths, actual source
  revision field, guest native-host alias and matching built graph wiring.
- `qa/reverse-adaptation-verification.json` independently reverses permitted
  full-client/driver substitutions and obtains **byte-identical originals**.
- All six built client bundles have exactly **one Workspace WeakMap**; focused
  observer access reexports the same built index. Counts/core/worker identity are
  in `consumer-graph-verification.json`. Observer access remains test-only.
- Default retention stays off; no production source/default behavior changed.
  The historical blocked stage/report at `efee448`, previous freezes and their
  failure evidence remain untouched.

## Ready commands — no activation performed

From `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`:

```sh
# Always produces a new private stage:
bun examples/todo-app/tests/effect-loader-full-delivery-prepare.ts

# Verify only; add a separate NONEXISTING output path to create a run copy:
bun examples/todo-app/tests/effect-loader-full-delivery-run-copy.ts /private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-full-app-UMORaL/frozen
```

**After parent assigns sole visible-browser QA**, create a fresh run copy. The
following commands were prepared, not executed:

```sh
# Manual real-kernel loader UI; OS-assigned fresh origin, no inference:
bun <run-copy>/qa/effect-loader-full-delivery-host.js <run-copy>

# Original full + focused hosts (the original combined driver expects both):
bun <run-copy>/qa/serve-single-kernel.js <run-copy>
bun <run-copy>/qa/serve-single-kernel.js <run-copy> --contracts
SINGLE_KERNEL_AUTHORIZE_RUN=yes bun <run-copy>/qa/effect-loader-full-app-driver-qa.js <run-copy> <new-evidence-directory>

# Alternatively, actual todo/editor UI with model routes prohibited:
bun <run-copy>/qa/live-host.ts <run-copy>
```

Do not run the different cohorts concurrently under different visible owners.
The minimal UI has explicit Boot, Load (`tsc --version` from a real guest), Stop
(public Runtime joined receipt), Inspect, Hold headers and Release buttons.
It performs no automatic boot/load/inference. Host admission allows at most two
held native requests, preserving control-request capacity. Main-page controls are
same-origin; original guest backend QA uses `host.vivari.internal`, not virtual
guest loopback. Each loader cohort requires a fresh origin; this is intentionally
a finite pilot rather than an expanded migration test harness.

## Limits

Both repaired preparations succeeded; the first `effect-loader-full-app-ZvuBJ4`
is retained as intermediate evidence, and the final `UMORaL` additionally includes
reverse-adaptation proof. No failed repaired preparation, retry-to-green browser
cohort or runtime workaround was needed.

Qualified Node and expanded independent review are owned separately; their outcomes
are not claimed here. Live full/focused workloads, native hold/shared-interest/stop
and editor behavior remain pending. Existing known failures stay in their original
denominators. No phase2+, all-writer guarantee, cache retention, process reuse or
promotion is inferred. Previously reported worker cost remains **+135,365 gzip
bytes**; no new runtime performance claim is made.
