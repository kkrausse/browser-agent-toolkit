# URL-repaired Effect loader — independent qualified-Node QA

2026-09-30. **PASS for this bounded offline repaired-delivery cohort.** No browser,
server, full-app or overall pilot acceptance; phases2+ remain gated.

Absolute report:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-loader-url-repaired-independent-qa.md`.

## Exact denominator

| Unchanged regression set / new bounded gate | Result |
| --- | --- |
| Independent expanded lifecycle/native/rollback/Runtime cases | **10 PASS** |
| Preserved loader vendor/write/shared/failure cases | **4 PASS** |
| Preserved PID-egress/fetch cases | **6 PASS** |
| Preserved endpoint cases | **8 PASS** |
| Preserved close cases | **3 PASS** |
| Independently authored actual Host.open/emitted URL/native body delivery gate | **1 PASS** |

**31 unchanged cases + one new URL gate, 0 failures, 0 selected checks unrun.**
Runner has 18 subprocess gates (PID/endpoint/close contain multiple original cases),
all pass. Admission and separate postflight provenance checks pass. No retry,
assertion weakening or production repair performed. Read full repair handoff
`c711c03`; implementation-owner logs/scripts informed exploration but were not
executed or counted as independent acceptance.

New runner explicitly validates **this new receipt**, then calls unchanged original
fixtures directly. Old outer runner's `5c4` hardpins remain unchanged and were not
executed against/relabelled as this delivery. Original fixture/runner bytes match
accepted `a401707` digests:

- `effect-loader-fixture.ts`: `e94c74e0da00d36e85d2e706b008d0607e61ef40c7cb2063b722918e0e284fa8`
- `effect-loader-expanded-fixture.ts`: `ec29b6e96f81b5a92b283b9a8513a07d397642a33b4cfef0ea2c8c49f338cd8a`
- Old expanded runner: `556b9e3d88c8397de21e06e3c6b31df6d94bacdc5b369f79f60c4419653e0ffd`

Same shared-interest/last-interest/native held settlement and original+rollback
failure assertions passed over actual Kernel, tsgo installer/transaction and Rust
VFS. Same built SDK cleanupError/rejecting stop and separately built workspace
Runtime retained-attachment/refused-replacement contracts passed. Four old loader
callbacks retain their original non-signal registration shape; ten expanded cases
qualify context/signal/native joins separately. No replacement Effect supervisor,
private future API, mocked lifecycle or imported application boot was substituted.
Close suite imports the repaired committed SDK **source** through its original TS
hooks, with real Node thread fixture; URL gate imports actual **built** `Host.open`.
Neither is a browser/OPFS/native Chrome close observation.

## Actual Node and immutable delivery

Project `vivari/DEVELOPMENT.md` specifies Node **24.18.0** for headless qualification.
Reused isolated official darwin-arm64 binary verified in `71ddbe3`; before tests
asserted actual `process.version = v24.18.0`, `process.platform = darwin`,
`process.arch = arm64` and exact real executable path. All child Node commands use
`process.execPath`, not PATH Node24.7. Thread workers inherit this executable.
No new downloads, global install, PATH/profile/package changes or native/build work.

Executable:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-qualified-node-toolchain-20260930/node-v24.18.0-darwin-arm64/bin/node`.

Executable SHA-256:
`ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a`.
Official archive rehashed and matched retained official SHASUMS256.txt:
`e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1`.
Official HTTPS manifest verification; no GPG verification claim (see `71ddbe3`).

Frozen input, read-only:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-vendor-url-repair-l9k65fzh`.

| Verified identity | Exact value |
| --- | --- |
| Runtime source | `3ee918522c1233a1f8e10a9b798c09b6c3e30c81` |
| Toolkit archive | `9814c715cfca42309c581440577976833f4326e6` |
| Effect / unchanged compiled core | `4.0.0-rc.118` / `211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070` |
| Distribution | `bd39000ff5bbc334f836ad65a4433e627525070413f810d7169132102f49b9f9` |
| Candidate receipt SHA-256 | `e242092e6a920b88a6a2ae7eb76654f1f61773a3bcf99ee4bcbe61f6b85ee6e6` |
| Delivery archive SHA-256 | `6b459be8a32041c9e996a7f339cc9a8abc8895720c5ec46b6e2d0ab810cd2bfa` |
| Runtime committed tar SHA-256 | `82ec90a5075a89bf35753ef2e5bf51e0cb1bbc13e9af18727879ee0a2a9a4bc0` |
| Toolkit tar SHA-256 | `24f2da161708256b46db6e7507926e2665588902704a0ef231a62955e435ab1d` |
| Freeze manifest SHA-256 | `1cec74d220b0e035948adb7ae8330fa5174593c324b612d38345b4018fdd13a4` |
| Actual emitted worker | `kernel-worker-CvW5AR9j.js` |
| Worker SHA-256 (SDK/distribution identical) | `c4193ae0cba8419149738ed2b3a74d79d5f59f5e447eff129106ca2f3532fecb` |
| SDK host SHA-256 | `14e5b1e965c4645ccbed41a93536db8b941b5ed076225dfea9288d9a0b5dfc87` |
| Separately built workspace SHA-256 | `2676b568a393d6738441b0e55af2839da9dac9114b810621bc6aa1e67c219da7` |

**107 candidate + 1,020 freeze entries** independently rehashed at admission and
postflight, zero mismatches. Reverified **12 native inputs + 37 outputs**, reuse not
rebuild. All **766 regular tracked runtime archive members** match imported frozen
source; toolkit archive regular members likewise match frozen toolkit source.
`git archive 3ee9185` independently produces the exact delivered runtime tar digest.

Read-only old/new committed archive comparison finds exactly:

1. `ARCHITECTURE.md` — URL handoff documentation.
2. `packages/core/src/host-sdk/host.ts` — pass resolved public root via worker URL query.
3. `packages/core/src/workers/kernel-worker.ts` — native URL resolution/public root fallback.
4. `scripts/test-vendor-url.mjs` — owner regression (read, not run as independent proof).

Reviewed actual production diff and preserved it in evidence. Kernel/lifecycle,
installer/native adapter/transaction/SAB/native source/dependency pins are unchanged.
Actual Node imports the same compiled core; production browser imports unchanged
Kernel/core wiring, in a newly hashed worker with the declared resolver repair.
This is static source/delivery identity, not fresh compiler reproducibility or
executed browser same-core behavior. No canonical dist/source/build receipt edits.

## Independently exercised public URL and native-body path

New gate parses the **actual hashed emitted worker** using delivered Acorn, extracts
its unique `vendorUrl` function, and evaluates only that function with a native
`self.location` URL. No worker entry/module boot. `import.meta` is syntax-bound, so
the isolated evaluation supplies the same emitted literal relative build environment;
it is not a copied/reimplemented resolver.

Old actual `kernel-worker-BXNXoz3O.js` function independently reproduces:
`http://127.0.0.1:54321./vendor/tsgo-pack.bin`; native `new URL` rejects it. Old frozen
bytes remain untouched. New actual built SDK `Host.open` resolves the distribution
root from page `/editor/index.html`, requests the exact manifest URL/version, and
creates a controlled Worker handle. Asserted `opfs-disable` and the exact absolute
`vivari-asset-base` query. Real manifest features/version are used; only worker
placement is varied. Controlled fetch/ready/Worker leaves do not constitute live QA.

**Six Host.open placements:** `/runtime/`, `/editor/runtime/`, relative `runtime/`,
absolute CDN `/deploy/runtime/`, and independently located cross-origin worker with
both `/runtime/` and `/editor/runtime/` public roots. For each, native parsing of
actual emitted vendor result equals the configured public root plus pack name;
absolute asset names preserve their own origin. Two no-query relative-build fallback
checks resolve `assets/` parent correctly. All handles destroyed.

Concrete root result:

```text
http://127.0.0.1:54321/runtime/vendor/tsgo-pack.bin
```

Extracted the **actual prepared independent host fetch-handler body**, never importing
or evaluating its `Bun.serve` entry. Original host artifact SHA-256:
`bbabf1388f81cbc15c0d8658a88978d5a7f3cd56d094f501adf629ce2f533251`;
handler body SHA-256: `e957e6f1aa8f19855a9c3819319c35db97c4c2f95ff68371043a7d4777f24654`.
Its source is from retained original full-app donor; it is not a new app host build.

Invoked body verbatim using new candidate root/checked receipt hashes and an explicit
**Node Blob file leaf instead of BunFile**, with native Request/Response/ReadableStream.
The actual exported `fetchLoaderVendorBytes` receives the generated URL and exact
AbortSignal and consumes the native response body: **one fetch, 10,793,012 bytes**,
SHA-256 `f318c6ec229471e1f53be8363e90e2ecdc55faf6549a9e696ee825689129c465`.
No actual HTTP request, listener, compiler, worker boot or browser. Real pack is read,
not executed; original expanded gates separately prove held read/cancel/fetch joining.

Actual prepared route is **`/runtime/vendor/`**. Unremapped `/editor/runtime/` correctly
returns **404**. Four additional pack reads cover subpath/CDN/separately placed worker
public roots through **explicit QA-owned mount/remap leaves**, each producing identical
pack bytes. These prove URL/body delivery with declared mounts, not deployed CDN/CORS,
production route support, or magically adding routes through URL construction.

## Evidence, reproduction and remaining limits

New source only:
`examples/todo-app/tests/effect-loader-url-repaired-delivery-runner.ts`.
From `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`:

```sh
TEMP=/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode
"$TEMP/effect-loader-qualified-node-toolchain-20260930/node-v24.18.0-darwin-arm64/bin/node" \
  examples/todo-app/tests/effect-loader-url-repaired-delivery-runner.ts \
  "$TEMP/effect-loader-vendor-url-repair-l9k65fzh" \
  "$TEMP/effect-loader-url-repaired-NEW-evidence"
```

New evidence directory required. Admission rejects wrong identity/fixtures/toolchain;
first failed gate stops the cohort with command/stdout/stderr/exit/signal preserved.
Direct bounded subprocess watchdogs are failure only, never successful settlement.
No original results overwritten or evidence directories cleaned.

Evidence root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-url-repaired-independent-20260930`.
Archive:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-url-repaired-independent-evidence-20260930.tar.gz`.
Archive SHA-256: `c5087bc7e39541c8e7957d3284f01fe2a28fe2e053dd851341e70aa654d0de78`.
Contains source diff/comparison, actual emitted function/query/public routes/native
body observations, per-case original assertions/held handshakes and postflight.

Known baseline guest `markAsUncloneable` omission remains as qualified in `71ddbe3`:
native host API passed, guest module lacks export, baseline/pilot source identical.
Not rerun or excluded from a claimed full suite: **this is the explicitly selected
delivery cohort**, not full verify-node/runtime-contract/single-kernel green.
Full server-bearing suites, guest gap, visible browser/native stop/full-app/editor/close
remain pending. Concurrent full-app preparation is separate; no preparation/report,
pin, plan, master status, SDK/core or other-agent edits. Commit only new runner/report;
no push. `/bin` ancestor path security, all-writer/persistence quiescence, runtime
performance and phase2 authorization are not inferred from this PASS.
