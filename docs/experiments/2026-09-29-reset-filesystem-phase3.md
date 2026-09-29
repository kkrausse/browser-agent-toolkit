# Matched-payload bounded filesystem comparison — 2026-09-29

## Outcome

**Both variants reproduced natural dependency-tree `ENOTEMPTY`.** The packaged
runtime passed four switches and failed its fifth; the lower-overhead diagnostic
runtime passed five and failed its sixth. Both cohorts stopped on their first
deletion failure, below the 12-switch-per-variant ceiling. No retry, recovery,
replacement cohort or runtime correction was attempted.

The diagnostic failure supplies the previously missing immediate failure chain:
an ordinary filename's lstat response was the empty string; JSON parsing failed;
recursive removal swallowed that error and skipped the file; its parent rmdir
then failed `ENOTEMPTY`. The FS owner independently reported the exact surviving
file. **The reason for the empty response is not established by this browser run.**
This is not the newline framing control and does not retrospectively prove the
mechanism of phase 1's uninstrumented failure.

### Continuation boundary

The bounded browser execution and runtime diagnostic commit were already present
when this delegated continuation inspected the filesystem. This continuation
verified the existing receipts, served artifact identities and live failed trees;
it made **zero additional workspace switches**. This distinction prevents counting
the same receipts twice or retrying a stopped cohort. Browser Control journals
record startup at 23:27–23:28 UTC and switch execution through 23:35 UTC;
read-only continuation checks were captured at 23:46 UTC.

## Exact cohorts and counts

Both used the local todo performance harness, `variant=baseline`,
`candidate=baseline`, `fsEvidence=1`, actual Vite and OpenCode services, and origins
separate from phases 1/2 and application stores. Each successful readiness check
verified exact bytes of 26 fixture source files, outgoing A/B-only file removal,
generation hydration with an enabled input, and a generated 876-byte PDF.

| Runtime / fresh origin | Startup | Switches attempted | Passed | First failure |
| --- | --- | --- | --- | --- |
| Packaged / `http://127.0.0.1:43222` | 1 pass, not a switch | **5** | 4 | A generation 5 → B generation 6 |
| Diagnostic / `http://127.0.0.1:43223` | 1 pass, not a switch | **6** | 5 | B generation 6 → A generation 7 |

All 11 switches have their own after-stop observations: empty process/listener
tables, zero pending HTTP, and both owned output drains joined. OpenCode exited
0, unforced; Vite exited 143/SIGTERM with `forced: true`. These are fully joined
service shutdowns, **not graceful-Vite-exit claims** or proof that every possible
host-side write has ceased. Both origins are cross-origin isolated.

Failure receipts under `.diagnostics/phase3/`:

- Packaged: `baseline/reset-1790724839725.json`.
- Diagnostic: `diagnostic/reset-1790724946930.json` (four complete diagnostic
  console records, including the 2,048-event circular history).

OpenCode checks establish server health/config/plugin/model-catalog readiness,
not a mounted usable chat client or model/session isolation. No model requests
were made. This is a reliability comparison, not a performance distribution.

## Consumed artifact identities

Packaged archive is unchanged:
`../irs-tools/vendor/toolkit/kkrausse-browser-agent-runtime-0.1.0-alpha.1-4f00341.tgz`,
SHA-256 `0cedf3c033de665b0d65d95d52d493b0241712785e526222908b3383bf54d53f`.

| Identity | Packaged | Lower-overhead diagnostic |
| --- | --- | --- |
| Source commit | `e998de62a10e5382104b51e0b860ee9d4d7a2401` | `9ee2b88b06f034391d114a8db29b542fc5cff614` |
| Distribution version | `232a03809dc425a31b620864569789ca9c73c97b389d4138b7cf6554e3641e04` | `86b9fc5aebddf073caa5ef292bce0f505cf814f6f0038c0841ad534ad2dd9a48` |
| `distribution.json` SHA-256 | `8c29bfa623a190b623ce25749b8de7af3c796ab1d91570300775de1aaeeda0da` | `e605e2fb4d24e12c25672a804cd1d4d76da2b0f13cafd35cac91e945a0dd2a00` |
| Served manifest SHA-256 | `6d0bf4e43f79ddba4ecc3b610d274b17b1677f16dfe8c4c1e446cfa5e13e82cd` | `a9c3141b78a05548a1ad978fe9086bf4637ce7ed18abaf5c28ede12d5f095801` |
| FS worker | `fs-worker-BY3WKtYX.js` | `fs-worker-kaowoVNz.js` |
| FS worker SHA-256 | `77b47d3dc99b7fee3ad04d96947be48a633f0a383d85ad11fbfc7d3671f79cb5` | `7ca81460b754c30bca0e8ac30a4bb973dda2c96e2b59ea57b3c4fe0eb1fc3bb4` |
| Kernel worker | `kernel-worker-B14IFoWX.js` | `kernel-worker-DGOQc5Go.js` |
| Kernel worker SHA-256 | `e6e84015cb08ee6579c636fd3b3c312cd550a2a3fb66e16a97093a22841981d1` | `f2e19f719db459ae7eee0a3d8dab264afe680f26b3090ec26cea8521ff3b55de` |

Diagnostic source is confined to the isolated worktree
`/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-diagnostic`.
Commit `9ee2b88` removes verbose successful-lstat logging and uses circular metadata
history rather than shifting an array; it retains failure-only parse/path/raw-name
diagnostics and existing deletion control flow. It builds on phase 2's `727af5d`.
This continuation made no runtime source edits or builds. Existing build/verify
receipts remain in `.diagnostics/phase3/`; no fresh full-suite qualification is
claimed. Phase 2's native-reuse and full-contract-suite limitations still apply.

Both delivered service workers hash to
`68cb2b42e086c0bce03ba8f3a96344d5b1fba66ad3d295c84a098c700f89075d`:
the unchanged packaged adapter, not the source receipt's SW. Delivered worker/
asset hashes were rechecked against their respective build receipts, with that
adapter distinction explicit. The process worker remains unchanged.

### Matched dependency payload, separately identified manifests

The cohorts consume **identical dependency entries, file bodies, modes, symlink
targets, source project, bundle and VFS image**: 12,305 entries, no pruning.
Every file body's length/hash was reverified from the staged content-addressed
payload. The payload is phase 1's original image, not phase 2's changed image:

- VFS image: 44,123,335 bytes;
  `434336bff35c19f8a47a66d9802423ce86a5e18f3cd3c649025c939569e9c41e`.
- Bundle: 42,664,752 bytes;
  `4593820adf8f9de512767b6c594cb023c84f20ab9b01093d96cd054e993ad401`.

The only manifest semantic differences are `runtimeVersion` and
`dependencies.policy.runtimeVersion`; both match the runtime actually served.
The alias/backend policy bytes and SHA-256 remain equal. The staged diagnostic
manifest hashes to `b4deb5e96fb676b4c300f5dc486864d33b4bc34b2f56defa8e9a2ce534ce4959`;
the harness's compact JSON serialization produces the separately listed served
hash. Their parsed JSON is identical. This is verified re-identification of an
unchanged compatible payload, not reuse of a falsely labeled runtime manifest.

Compared with phase 2, the workspace dependency's `index.js`, map and
`workspace.d.ts` bodies revert to phase 1's versions; all other entry content is
unchanged. The host harness still has phase 1's read-only entry helper, independent
of the guest workspace dependency's installed bytes.

## Natural error evidence

Both top-level errors are exactly:
`Workspace clear failed while removing /workspace/node_modules: ENOTEMPTY`.
Removal was partial, not transactional.

### Packaged failure

- First residual descent reaches
  `/node_modules/.bun/lodash@4.18.1/node_modules/lodash/differenceWith.js`.
- Live regular file: inode 6230, 1,395 bytes, SHA-256
  `3963f2e27bad30274bf94a54a9a3b1d27122d5e92a2ef22a52b8b906b9ac975c`.
- VFS file count fell from 10,630 before clear to 5,003 afterward; immediate,
  delayed and continuation process/VFS counters remained equal.
- Bounded manifest-directed remaining-tree listing reported 5,675 entries and no
  pending manifest directories. Unknown generated paths are not recursively
  inspected; this is not an independent exhaustive raw-name inventory.
- No instrumented deepest-operation attribution exists for this variant.

### Diagnostic failure

Exact path prefix:
`/workspace/node_modules/.bun/pdf-lib@1.17.1/node_modules/pdf-lib/es/core/interactive`.

1. Raw readdir history at sequence 9389 contains all four ordinary names:
   `ViewerPreferences.d.ts`, `ViewerPreferences.d.ts.map`, `ViewerPreferences.js`,
   `ViewerPreferences.js.map`.
2. Kernel-fs's lstat-parse record for `ViewerPreferences.d.ts.map` has **`raw: ""`**
   and `SyntaxError: Unexpected end of JSON input`.
3. rmRecursive logs the same exact path as **`suppressed-lstat`**. It continues
   walking without unlinking that file.
4. FS-owner rmdir reports `ENOTEMPTY`, raw names
   `["ViewerPreferences.d.ts.map"]`, and independent regular-file metadata for
   inode 7914, size 3,015. Client 0/opcode 9/request-state 1; registered clients
   `[0]`.
5. rmRecursive logs rmdir failure at that exact deepest directory.

The history records unlink mutations for the other three names, but no mutation
of the residual `.d.ts.map` between that readdir and rmdir. This supports a skipped
entry, rather than a file recreated within that observed interval. The history
is bounded and not an exhaustive audit of all host-side filesystem activity.
Transport/response completion is the next investigation boundary; a specific
stale-wake race is **not proven** by these browser records.

Read-only subsequent inspection returned the same inode, length and SHA-256:
`6cdaf676ad66e4715fbfa8855aa2f4e35be4660785fac60eb52515d667e245e7`, matching
the prepared file. VFS count fell from 10,630 to 4,016, then remained stable;
remaining-tree evidence lists 4,445 entries with no pending manifest directories,
subject to the same unknown-generated-path limitation.

## Evidence preservation and validation

Private original evidence root:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase3/`.
Independent continuation verification root:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase3-verification/`.
The latter contains `verified-summary.json`, full diagnostic console capture in
`diagnostic-live.json`, and `packaged-live.json`. Ignored artifacts do not travel
with this documentation commit; original browser journals retain execute bodies.

Browser automation used the Bun-backed Browser Control CLI, not MCP. Retain failed
pages **`quiet-falcon-568`** and **`clever-badger-501`** without reload/switch/close.
The three earlier evidence pages **`calm-otter-581`**, **`gentle-otter-722`** and
**`amber-badger-702`** were not targeted or altered by this continuation.
Pre-existing loopback servers on 43222/43223 were left running, rather than
terminating processes this continuation did not launch. Neither guest has live
processes/listeners. No pushes, deployments, published-package edits, IRS edits,
production pin edits, historical-source edits or model calls occurred.

Continuation setup initially collided with ignored phase3 setup-script names
before discovering the already-stopped cohorts. Additional fresh preparations
under `phase3/packaged/editor` and `phase3/diagnostic/editor` were **not served or
tested** and are excluded from all identities/counts above. The existing `run.js`
body was restored from its retained `block.js`; the displaced preparation recipe
was not recoverable and the replacement is kept as
`phase3-verification/unused-prepare.ts`. `phase3/prepare.log` now describes only
that unconsumed preparation, not the preserved matched-payload experiment.
Original manifests, payload identity, build receipts, failure receipts and live
trees remain intact. This setup collision produced no browser deletion attempts.

Toolkit git status was initially clean. The runtime worktree had the pre-existing
untracked `scripts/probe-kernel-fs-stale-wake.mjs`; it was neither edited nor
committed. Verification asserts payload equality, all staged file hashes, image/
bundle hashes, runtime/manifest-policy agreement, exact counts, stopped/drained
service receipts and first-failure termination. `git diff --check` is required
before the documentation commit. No new code-test or runtime-suite pass is implied.

## Recommended next decision

**Keep the natural reset reliability gate red; stop further reset cohorts now.**
Give the runtime owner the diagnostic response/skip/rmdir chain and pursue a
focused SAB response-completion investigation on an isolated candidate branch.
Require a deterministic transport regression test before proposing a correction;
do not add retries or suppress `ENOTEMPTY`. Any candidate still owes bounded
matched-payload dependency resets, newline and dangling-symlink controls, and
the existing browser OPFS recreation contract before a production pin changes.
