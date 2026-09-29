# Repeated reset filesystem investigation — 2026-09-29

## Outcome

**The IRS-selected runtime still fails a naturally occurring full reset.** On a
fresh isolated origin, A→B→A→B passed, then B→A failed with `ENOTEMPTY` while
clearing `/workspace/node_modules`. No retry/recovery was attempted. Both owned
services had exited/drained and the guest process/listener tables were empty
before clear. This is evidence against a still-listed service writer in this
instance, **not proof of no host-side filesystem work or of a writer race**.

A separate no-service filename control demonstrated deterministic `ENOTEMPTY`
for a newline filename. It does not establish the cause of the natural failure:
the first residual package's deepest listed directory contained the ordinary
`helpers-generated.js.map` filename. Runtime deletion errors still omit the
deepest failing operation/path. No runtime fix or performance optimization was
made; repeated full-reset qualification remains failed.

## Consumed artifacts and environment

Canonical toolkit working tree was clean before this work. No IRS files, runtime
sources, pins, archive contents, licenses, or provenance were edited.

- Exact archive: IRS `vendor/toolkit/kkrausse-browser-agent-runtime-0.1.0-alpha.1-4f00341.tgz`.
- Archive SHA-256: `0cedf3c033de665b0d65d95d52d493b0241712785e526222908b3383bf54d53f`.
- Recorded clean runtime source commit: `e998de62a10e5382104b51e0b860ee9d4d7a2401`.
- Distribution version: `232a03809dc425a31b620864569789ca9c73c97b389d4138b7cf6554e3641e04`.
- `distribution.json` SHA-256: `8c29bfa623a190b623ce25749b8de7af3c796ab1d91570300775de1aaeeda0da`.
- FS worker `fs-worker-BY3WKtYX.js`: `77b47d3dc99b7fee3ad04d96947be48a633f0a383d85ad11fbfc7d3671f79cb5`.
- Kernel worker `kernel-worker-B14IFoWX.js`: `e6e84015cb08ee6579c636fd3b3c312cd550a2a3fb66e16a97093a22841981d1`.
- Process worker `process-worker-BNtwFfrJ.js`: `368aae7bcec2a5d6db25bbcc25f7b4baa40d515aa383ae5b106dcee3cb5a05da`.
- Delivered `assets/sw.js`: `68cb2b42e086c0bce03ba8f3a96344d5b1fba66ad3d295c84a098c700f89075d`.
  The source build receipt's SW hash differs, as expected for the packaged
  adapter; the consumed SW is the unchanged archive's SW, not the old experiment's.
- Fresh prepared manifest SHA-256: `6d0bf4e43f79ddba4ecc3b610d274b17b1677f16dfe8c4c1e446cfa5e13e82cd`.
  Both manifest runtime identity and backend-policy identity match the archive.
  Preparation verified 12,305 entries; the baseline image is 44,123,335 bytes,
  SHA-256 `434336bff35c19f8a47a66d9802423ce86a5e18f3cd3c649025c939569e9c41e`.
- OpenCode receipt SHA-256: `40789e37d00c5bfbfc9dad88012d7fe3c88a6054df7a2cbd340e1bd2bd676112`.
- Bun 1.4.0; Bun-backed Browser Control 0.8.2; Chrome 154.0.0.0 on macOS.
  Browser confirmed `crossOriginIsolated: true`.

The canonical generated preparation/runtime inputs were absent. The documented
ignored `vendor/vivari` symlink now points to the exact historical pinned checkout;
no runtime build was run. Initial default OpenCode library build refused a local
receipt mismatch. Rebuilding with explicit
`OPENCODE_PACKAGE_DIR=/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-upstream/opencode-chat/dist/application`
passed its existing integrity checks. Dependencies were freshly prepared using
`RUNTIME_DIR=/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase1/runtime/package`
and the verified Tailwind receipt documented in the previous handoff. Nothing was
silently relabeled from a previous manifest.

## Cohorts and first-attempt results

All candidates used the full **baseline** payload, not maps/native pruning.
Fixtures alternate A/B identity, generation-specific hydrated source, a binary
file, and an A-only/B-only file whose outgoing removal is checked. Successful
service runs verified exact bytes for 26 source files and generated a PDF before
and after each switch. Each invocation made one switch, stopping on failure.

| Cohort/origin | Service history | Bounded result |
| --- | --- | --- |
| `http://127.0.0.1:43219` | Actual Vite + OpenCode, fully stopped before clear | Startup A passed; switches A→B, B→A, A→B passed; fourth switch B→A failed |
| `http://localhost:43219` | Install/flush only; services never started | Four switches A→B→A→B→A passed; not editor-readiness passes |
| `http://127.0.0.1:43220` | Independent actual-service replicate, read-only entry diagnostics available | Four switches A→B→A→B→A passed; does not negate the preserved failure |

`localhost` and `127.0.0.1` are separate browser origins. These stores are unrelated
to application or saved-workspace origins. No model calls, authentication state,
application saves, retry restores, or deployments were involved.

### Natural failure evidence

Primary receipt: `.diagnostics/phase1/evidence/reset-1790722003428.json`.

- Exact error: `Workspace clear failed while removing /workspace/node_modules: ENOTEMPTY`.
  This is the requested top-level removal path, not a proven deepest failing path.
- Before stop: Vite PID 1, OpenCode PID 2, Vite child PID 3; listeners 4096/5173;
  no inflight/queued/active fetches or pending HTTP.
- After stop: `procs: []`, `listeners: []`, `pendingHttp: 0`; Vite exit
  `{exitCode:143, signal:"SIGTERM", forced:true}`, OpenCode exit
  `{exitCode:0, signal:null, forced:false}`; both output drains joined.
- Before clear VFS file count 10,630; after failed clear 10,017. Removal was partial,
  not transactional. Snapshot counters stayed identical in the delayed observation.
- Bounded immediate/delayed listings each visited 500 manifest-known directories,
  listed 2,505 entries, and retained 166 pending directories: **truncated**, not a
  full-tree inventory. Generated `.vite-temp` was listed but not traversed.
- A targeted follow-up fully listed the first remaining `.bun` package,
  `@babel+helpers@7.29.7`, without mutation. Its deepest remaining directory was
  `/node_modules/.bun/@babel+helpers@7.29.7/node_modules/@babel/helpers/lib`, with
  exactly `helpers-generated.js.map`. Its parent still contained `package.json`;
  outer sibling links `template`/`types` were retained. File-as-directory inspection
  returned `ENOTDIR`. These classifications are manifest-derived, **not live lstat**
  for this first cohort; the read-only lstat helper was added afterward.
- Prepared map entry: 174,603 bytes; SHA-256
  `0ef17cf609ddca8930f62065dbd49579d504b128756a6c86c956973172effca2`.
  Live file content/hash was not captured on that original page. Prepared asset
  destinations contain zero newlines. The map's role in the failure is unproven.

### Filename control and investigator attribution

The independent read-only investigator identified a candidate mechanism in the
exact pinned source: `fs-server.js` newline-joins directory names;
`kernel-fs.js` newline-splits them; `rmRecursive` suppresses **all** lstat errors
before calling rmdir. This was tested against the unchanged archive, not a
diagnostic worker build, using the healthy no-service cohort after its four resets:

| Control | Exact created filename | Single removal result | Live lstat after |
| --- | --- | --- | --- |
| Plain | `/reset-plain-control/plain.txt` | Success | `ENOENT` |
| Newline | `/reset-newline-control/line\nbreak.txt` | `ENOTEMPTY` | Same regular file, size 13, inode 12394 |

Both controls had empty process/listener/fetch tables. Newline file remained with
the same metadata before/after failure; no retry was attempted. This establishes
a deterministic filename-framing deletion defect without services. It is a
**separate control**, not a claimed diagnosis of the natural dependency-tree error.
`diagnoseWorkspaceEntry` lstat accepts the exact newline path; readdir remains
framed through the same runtime and is not an independent raw-name oracle.
A follow-up read-only check returned directory metadata `size: 1` but framed
names `["line", "break.txt"]`; the exact `line\nbreak.txt` path still lstat/read
successfully returned the 13-byte file, SHA-256
`218729319297ff74e921f6e2ecb337eb2d8f57d0e00a5d59632352caabc1960a`.
The helper also verified a real dependency symlink's lstat/readlink without
following it. These observations are in `install-only/read-only-entry-checks.json`.

## Performance baseline, not a speedup claim

| Cohort | Startup total | Successful switch totals | Cached image reinstall |
| --- | --- | --- | --- |
| Primary services | 30.70 s | 13.75, 49.71, 50.78 s | 1.44–1.76 s |
| Replicate services | 31.24 s | 14.01, 48.92, 51.89, 48.78 s | 1.40–1.73 s |
| No services | 3.12 s | 9.01, 7.95, 7.14, 7.50 s | 1.66–1.85 s |

The failed primary attempt took 3.06 s but produced **no replacement/readiness**:
it is never included as a fast pass. Service preview timings require generation
hydration plus an enabled input (not SSR/port alone); later previews took about
38.73–42.23 s and OpenCode qualification about 25.29–26.18 s, running concurrently.
OpenCode qualification covers health, plugin/config/model catalog readiness, not
a mounted chat client, session isolation, or a usable model conversation.

These diagnostic totals include before/after-stop diagnostic round trips and
are not a clean performance distribution. No speculation explains the first
warm switch versus later slowdown. Process/kernels were restarted; source-only
reuse, Vite retention, and OpenCode retention were not tested here.

## Implementation, validation, retained state

- Harness now guards runtime/manifest identity, captures stop/clear evidence,
  preserves failure status, and offers distinct install-only and filename controls.
- Added targeted read-only `diagnoseWorkspaceEntry` using existing lstat/readlink
  RPC, with safe workspace path checks and no deletion behavior changes.
- Remaining-tree bounds and manifest-versus-live classifications are explicit.
  A new first-entry descent uses live lstat but does not claim to identify causality.
- Workspace library build/typecheck, todo typecheck, and 34 workspace unit tests passed
  with `umask 022`; the Browser Control execute body parses and `git diff --check` passes.
  All eight JavaScript worker assets match the consumed build receipt. An intentionally
  mismatched private manifest was refused by the server before listening.
  Unit tests mock host RPC and do not prove runtime deletion behavior.

Private evidence root (absolute):
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase1/`.
It contains `artifact-identity.json`, `summary.json`, primary `evidence/`,
`install-only/filename-controls.json`, and `replicate/` receipts. These ignored
artifacts do not travel with commits. Browser journals retain the execute bodies.

The healthy replicate workspace was closed after evidence capture. The original
natural-failure page (`calm-otter-581`) and newline-failure page (`gentle-otter-722`)
are intentionally retained with no guest services: closing their kernels would
discard unpersisted failure trees. **Do not reload or switch those pages.** The
retained pages belong to this investigation, not to a production workspace.
Both owned loopback benchmark servers were stopped after receipt capture. The
healthy replicate Browser Control session was deleted; retained failure pages
can still be inspected without a server, but reload would discard their live state.

## Recommended next boundary

1. Keep the exact-archive failure receipt separate from the deterministic newline
   control. A runtime owner should capture the swallowed lstat error and deepest
   removal operation using a separately identified diagnostic runtime build,
   alongside independent FS-worker/raw-name evidence. Do not turn broad retries or
   suppression into a “fix.” This harness cannot supply that missing worker evidence.
2. Gate any runtime correction on both ordinary dependency-tree resets and
   newline/dangling-symlink controls, with no-service versus stopped-service cohorts.
   Existing symlink and OPFS recreation fixes remain distinct contracts.
3. Then collect clean repeated cached-image fallback measurements with actual usable
   chat-client readiness and isolated session/config semantics. Test matching-environment
   source-only switching first with services restarted, then retained Vite; avoid
   the existing full-tree digest-verification fast-path cost only with a justified
   immutable/mutation-tracked ownership model.

No root-cause claim, runtime repair, production performance qualification, push,
deployment, or IRS integration is implied by this phase.
