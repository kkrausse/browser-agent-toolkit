# Effect loader: concrete vendor URL packaging repair

2026-09-30. **Source repair committed; matching SDK/worker/distribution frozen;
offline emitted-URL and real-pack delivery checks pass.** No browser, host/guest
server, inference, promotion or push. Phase2 remains unauthorized.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-loader-vendor-url-repair.md`.

## Cause and bounded repair

Read the full independent delivery report and preserved its exact original blocker.
Old runtime `5c4b1c5` worker `kernel-worker-BXNXoz3O.js` compiled Vite `BASE_URL`
to `./`, then concatenated it with an origin. Actual emitted function evaluation
produces `http://127.0.0.1:54321./vendor/tsgo-pack.bin`; native `new URL` rejects it.
The original frozen 106-hash pilot and full-app stage were not edited.

New runtime commit **`3ee918522c1233a1f8e10a9b798c09b6c3e30c81`** on
`experiment/effect-loader-pilot` changes only SDK host URL handoff, worker resolver,
architecture note and concrete emitted-worker regression. `Host.open` already
resolves `Distribution.assetBaseUrl` against the page. It now passes that absolute
public root in the worker URL's `vivari-asset-base` query parameter. Worker
`vendorUrl` uses native `new URL(name, publicRoot)`, rather than string joining.
This retains configured root/subpath/relative/absolute mounts even if a manifest
hosts the worker on a separate origin. Absolute asset names retain their own URL.

Direct Vite app hosts still use their configured BASE_URL. For the SDK's unchanged
relative `./` build and existing `assets/` worker layout, the no-query fallback
resolves the worker's parent distribution directory. **Vite base was not changed.**
No lifecycle/loader installer/abort/receipt/core/SAB/WASM code was changed; compiled
Effect rc.118 core hash remains
`211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070`.

## New frozen delivery and identities

Root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-vendor-url-repair-l9k65fzh`.

| Item | Identity |
| --- | --- |
| Toolkit library archive | `9814c715cfca42309c581440577976833f4326e6` |
| New actual worker | `kernel-worker-CvW5AR9j.js` |
| Worker SHA-256 (SDK and distribution identical) | `c4193ae0cba8419149738ed2b3a74d79d5f59f5e447eff129106ca2f3532fecb` |
| SDK `host.js` SHA-256 | `14e5b1e965c4645ccbed41a93536db8b941b5ed076225dfea9288d9a0b5dfc87` |
| Runtime distribution version | `bd39000ff5bbc334f836ad65a4433e627525070413f810d7169132102f49b9f9` |
| Distribution manifest SHA-256 | `9fa3e1dd22309289da3de03550118b2f914c5d53201c16890f48264368ff75fd` |
| Candidate receipt SHA-256 | `e242092e6a920b88a6a2ae7eb76654f1f61773a3bcf99ee4bcbe61f6b85ee6e6` |
| `delivery.tar.gz` SHA-256 | `6b459be8a32041c9e996a7f339cc9a8abc8895720c5ec46b6e2d0ab810cd2bfa` |

`candidate/` contains **107** hashed SDK/workspace/runtime/vendor files. The SDK/core
were rebuilt after commit; the workspace library was independently rebuilt from
the exact archived toolkit source against the new SDK. Distribution packaging used
the unchanged toolkit packager with a new explicitly experimental build receipt.
All archived runtime tracked bytes were verified; no canonical dist, `.runtime`,
source pin, delivery-owner preparation script/report or library source was edited.
Native reuse reverified the same **12 inputs / 37 output hashes**, not a rebuild.
Licenses and source archives are retained. `freeze-manifest.json` covers 1,020 files;
the portable runtime source/core/native archive excludes linked dev dependencies.

## Concrete negative/positive and route evidence

`scripts/test-vendor-url.mjs` inspects and evaluates ONLY the actual bundled
`vendorUrl`, using the actual built SDK `Host.open` with controlled Worker/manifest
leaves. It covers port 54321, `/runtime/`, `/editor/runtime/`, relative `runtime/`,
an absolute CDN distribution root, and an independently located manifest worker;
it also checks the real relative-build fallback. No worker entry module is booted.
Final emitted results are in `emitted-vendor-url-check.json`.

`offline-vendor-delivery.ts` separately evaluates the **old actual emitted** function
and preserves native-parser rejection. It extracts the prepared consumer's exact
fetch-handler body, **without importing/running its Bun.serve entry**, and supplies
the fresh candidate root/manifest. The new URL is
`http://127.0.0.1:54321/runtime/vendor/tsgo-pack.bin`. Actual
`fetchLoaderVendorBytes` reads the real **10,793,012-byte** pack through that handler;
SHA-256 is `f318c6ec229471e1f53be8363e90e2ecdc55faf6549a9e696ee825689129c465`.
No listener, worker, guest compiler or browser is executed. Result:
`offline-vendor-delivery.json`; original blocker copy: `old-vendor-url-blocker.json`.

The independent prepared host's actual route is **`/runtime/vendor/`**, not
`/editor/runtime/vendor/`. Configuring `assetBaseUrl: '/editor/runtime/'` correctly
produces that latter URL, but the host must mount/remap its public runtime there;
URL construction does not invent an unsupported host route. No old app policy or
prepared version manifest was relabelled to match the new distribution.

## Regression and application-input qualification

On **Node 24.7.0 / Bun 1.4.0**, against this new source/SDK/workspace output:
**10 expanded lifecycle + 4 loader + 6 PID-fetch + 8 endpoint cases pass**; workspace
build/declarations/typecheck and three close cases pass. `run-regressions.py` calls
the unchanged independently authored fixtures directly and retains every stdout,
stderr, exit, exact argument and fixture digest. The independent outer runner is
hard-pinned to the old 5c4 receipt, so it was not edited or falsely reused as new
delivery verification. New receipt/manifest verification is implementation-owner
evidence, pending independent handoff qualification.

The current archived application verifier accepts the read-only recovered
OpenCode receipt **`40789e37d00c5bfbfc9dad88012d7fe3c88a6054df7a2cbd340e1bd2bd676112`**
and all five actual application outputs. Exact recipe copies and vendor metadata
are retained under `reused-inputs/`, individually checked against the independent
full-app donor receipt; old chat/workspace/client bundles were not reused.
This is input recovery/route compatibility, **not** a new application/consumer build.

Remaining: a separately prepared full app/chat/consumer against the **new** SDK and
distribution version; independent new delivery identity checks; qualified Node
24.18 on this new revision; parent-assigned visible browser/native hold/stop QA.
The active qualified-Node agent's old 5c4 results cannot qualify this changed host
and emitted worker. No phase2+, performance or all-writer guarantee is inferred.
