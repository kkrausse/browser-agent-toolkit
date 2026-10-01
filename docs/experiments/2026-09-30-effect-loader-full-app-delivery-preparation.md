# Effect loader: matching full-app delivery preparation

2026-09-30. **Full-app preparation succeeded; live-loader staging is blocked by
the frozen worker's vendor URL construction.** Phase-1 candidate only; no full
Effect migration, performance, cache-retention or production-promotion claim.
No browser, host server, guest server or inference was started.

## Prepared handoff (not ready for live-loader qualification)

Fresh root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-full-app-Z4lmqt`

Frozen full-app stage: `<root>/frozen`. Receipt verifies **9,720 files**;
prepared application manifest has **12,303 assets**. A separate fresh
`<root>/offline-copy-check` verifies the same 9,720 bytes/hashes without execution.
`<root>/delivery-handoff.json` is the machine-readable handoff.

| Identity | SHA-256 / revision |
| --- | --- |
| Runtime source | `5c4b1c5655b54a840370fa6215e51fd661701591` |
| Toolkit library/app source | `9814c715cfca42309c581440577976833f4326e6` |
| Preparation scripts | `d64ed23` (earlier `fba397e`, `90e6c3f`) |
| Effect | exact `4.0.0-rc.118`; chat rc.112 unchanged |
| Runtime distribution | `15da540e2381261aa4d23b4bb8abbb4e27c66ec8943db535c81d4b62856c9c43` |
| Frozen receipt | `145b2ed2487324e6af6ef32d6055db4caf61084caafe73f6a8ddd23db7b4cce1` |
| Delivery archive | `ca4142b1a858c6af4173a9371802745da57864546a50a03811472f72a8b56b90` |
| Freeze manifest | `6e1a4e078a9e3a11bfe0cccdc8bcd3d765dd54e668a7ee38ccd7b9d444f3637b` |
| Source digest inventory | `03f380b905eb13927759f809c0c02921782a2fd1d6b93a1b700046fd3e569a2b` |
| Compiled shared core | `211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070` |
| Actual worker | `kernel-worker-BXNXoz3O.js`, `b9f92ede6d72ff791d1461855393368f7c3b7f21f951862a5bc0ff43008b68f3` |

`delivery.tar.gz` contains the frozen stage, exact committed source archives,
runtime runnable-source/core/native archive, source digests, preparer adaptation,
handoff and freeze manifest. Local command logs and declaration/typecheck configs
are retained in the fresh root. The original compiled full driver retains its
source-check path to this local committed archive; relocation needs a new explicit
QA path-only adaptation, not disabling its source checks.

## Qualified application receipt recovered, not manufactured

Read-only donor:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-full-app-Yb8T8p/qualified-opencode`.

The **current exact committed** `opencode-chat/src/opencode-application.ts`
verifier accepted the donor's actual receipt bytes and all five output files.
Canonical receipt hash is
`40789e37d00c5bfbfc9dad88012d7fe3c88a6054df7a2cbd340e1bd2bd676112`;
published input is `@opencode/server@2.0.3`, upstream revision
`d44b52ca66b6bf69626c0384626d1a9cd9555977`, with the exact integrity in that
current verifier. `server.js` is the actual 27,721,680-byte delivered application,
hash `648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5`.

All four receipt recipe inputs (`package.json`, `bun.lock`, `server.ts`, `build.ts`)
were independently hashed against their existing actual files at
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-upstream/vivari/experiments/opencode-release-server`.
Every hash matched the existing canonical receipt. Exact input copies and outputs
are frozen under `qualified-application/` and `chat/application/`;
`application-closure.json` records the verifier source digest and recipe hashes.
This restores precisely the application input demanded by current source; it is
**not** a new OpenCode application build or a relabelled old chat library.

Workspace/chat JS, declarations and editor styles were newly built from the
committed toolkit archive against the actual Effect SDK. Current config/model-header
and JavaScript plugin implementations and codecs come from that archive, not the
donor's chat payload. Their source digests and newly built/prepared bytes are
receipted. Libraries were built before the separate consumer/preparation builds.
The normal preparer checks the application receipt again before packaging it.

## Delivery checks and boundaries

- The unchanged normal preparer built the full dependency bundle and WASM image:
  bundle `cc265afca37a8c996c547c5f75c4ac28ee879a3833fdc7a776e1d5dc1aad4148`,
  image `c3a2386e6ec669eb1f23cdbdc8147cd32f2f5085bcfe7e422f8a30182d6d4b07`.
  Manifest and dependency policy carry the exact new runtime version.
- Workspace/chat declaration builds and original full/focused consumer typecheck
  pass (command logs 6, 7, 9). All six emitted client bundles contain exactly one
  `workspaceInternals = new WeakMap` graph. The focused observer reexports the
  same separately built workspace index; `consumer-graph-verification.json` records
  counts. Observer internals are test-only in this candidate, not a public release.
- The committed conservative preparer at `1fb7efe` is read-only input. Private
  adaptations change only exact revisions/paths, actual source revision field,
  host backend admission (`host.vivari.internal` for the **guest** fetched-body
  probe), and built graph wiring. Original actions/assertions/deadlines remain.
- Actual worker/core/native provenance is preserved from the verified 106-hash
  frozen Effect input. All 12 tracked native inputs and 37 reused native outputs
  were rechecked. No native rebuild or canonical release receipt is claimed.
- The real `tsgo-wasm@7.0.2` pack was made by the unchanged committed runtime
  vendor producer. Its pack hash is
  `f318c6ec229471e1f53be8363e90e2ecdc55faf6549a9e696ee825689129c465`.
  Producer/package metadata, installed lock integrity, launcher and license are
  included. Registry access occurred: normal app preparation reports 34 resolved/
  downloaded/extracted entries, and the normal tsgo producer installed its input.
  **Offline means no runtime/browser execution, not network-offline builds.**
- No canonical pins, shared dist, shared `.runtime`, previous frozen stage,
  production runtime/app source or old QA runner was changed. No push.

## Commands

From `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`:

```sh
# New preparation only, always a fresh stage:
bun examples/todo-app/tests/effect-loader-full-delivery-prepare.ts

# Verify; optional final argument creates a separate NONEXISTING run copy:
bun examples/todo-app/tests/effect-loader-full-delivery-run-copy.ts /private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-full-app-Z4lmqt/frozen
```

**Later only, after the packaging blocker below is owner-fixed and a new matching
cohort is frozen, and parent assigns exclusive visible QA**: create a fresh run copy,
then choose ONE host command. None below was executed during preparation:

```sh
# Real-kernel manual loader pilot, no inference:
bun <run-copy>/qa/effect-loader-full-delivery-host.js <run-copy>
# Preserved full-app stages, or focused cases (--contracts):
bun <run-copy>/qa/serve-single-kernel.js <run-copy>
bun <run-copy>/qa/serve-single-kernel.js <run-copy> --contracts
# Actual todo/editor UI, model endpoints prohibited:
bun <run-copy>/qa/live-host.ts <run-copy>
```

The manual pilot boots a real kernel only on click; a real guest spawns `tsc
--version` through the actual lazy-loader path. Independent Stop invokes the
public Runtime joined receipt, and inspection reports real diagnostics. Native
vendor headers can be held/released; host admission permits at most two pending
held requests, leaving control requests outside that bound. Main-page controls
are same-origin; the native host alias is used only in guest egress QA. This is a
prepared real-kernel pilot surface, **not** proof its live abort/join behavior
passed. Its loader cannot currently fetch the real pack because of the blocker below.

## Newly diagnosed worker packaging blocker — parent decision required

Final static delivery review inspected the **actual receipted**
`kernel-worker-BXNXoz3O.js` (not only runtime source). At emitted lines 36891–36893:

```js
function vendorUrl(name) {
  return (self.location && self.location.origin || "") +
    (typeof import.meta !== "undefined" && "./" || "/") + name;
}
```

The unchanged runtime source uses `origin + import.meta.env.BASE_URL + name`;
the SDK build compiled `BASE_URL` to `"./"`. With an ordinary numeric host port,
the composed URL is `http://127.0.0.1:54321./vendor/tsgo-pack.bin`, which the native
URL parser rejects as `TypeError: Invalid URL`. Evidence:
`<root>/vendor-url-blocker.json`. This is a static construction/parser proof;
no worker, browser or server was launched to manufacture a live result.

This affects the actual production loader adapter in the pilot worker. Returning
an import-smoke or preinstalling a shim would evade the intended first-load path,
so neither is substituted for acceptance. No runtime source, worker bytes,
distribution receipt or old frozen candidate was patched. The implementation/
packaging owner must review the URL seam, produce a new matching worker receipt,
and coordinate the host's explicit vendor route (currently `/runtime/vendor/`).
This preparation remains useful as an exactly receipted full-app package, but
**do not assign visible loader QA against it as ready**. No full app runtime outcome
is inferred from this static blocker or from successful preparation.

## Retained preparation failures and remaining qualification

The first adapter copy `effect-loader-full-delivery-preparer-vY0gKz` failed before
building due to generated string escaping. Early full stages `r8pQIb` and `Jb8wIL`
are retained but not the final handoff. `effect-loader-full-app-WDEgci` failed a
delivery graph check because Bun emits one live-client WeakMap assignment inside
an initializer without `var`; the actual graph was one, not zero. The check was
corrected to recognize that emitted form, not weakened to allow extra graphs.
Successful final adaptation is `effect-loader-full-delivery-preparer-PNbAlE`.

Expanded independent lifecycle review, real-browser full/focused qualification,
native hold/stop outcomes and qualified Node execution remain pending. Existing
known editor/save, `markAsUncloneable`, attachment and retained-target limits are
not erased by preparation. No phase2+ authorization is inferred. Matched owner
bundle comparison remains **+135,365 gzip bytes** for the worker; no runtime
performance improvement/overhead measurement is claimed here.
