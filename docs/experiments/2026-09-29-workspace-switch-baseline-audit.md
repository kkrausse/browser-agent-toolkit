# Workspace switching baseline audit — 2026-09-29

## Outcome

No missing merge explains the outstanding `ENOTEMPTY` failure. IRS Tools added
interrupted-switch recovery, not a demonstrated elimination of the deletion bug.
The next performance target is fast switching between dependency-compatible
workspaces. Payload pruning is deprioritized; cached-image reinstall remains the
fallback. This audit did not run new browser experiments or diagnose the deletion
failure's filesystem-level cause.

## Source and artifact checks

- Fetched origin refs for toolkit, IRS Tools, and the existing Vivari checkout.
  No newer IRS-consumed baseline was found in those refs.
- Canonical toolkit `main` and `integration/upstream-runtime` were both `5999e54`.
  `git merge --ff-only integration/upstream-runtime` returned “Already up to date.”
- IRS Tools local `main` is `dda2e4a`, ahead of `origin/main` by 25 commits.
  Toolkit's origin integration ref is `05e183f`; local main includes later work.
  Do not replace local source with these older remote tips.
- Toolkit main contains IRS's workspace source revision `05e183f`, chat revision
  `971ff97`, runtime adapter revision `4f00341`, symlink-clear fix `ca20d8a`,
  runtime pin `e93fb95`, and interrupted-clear browser contract `5821c8e`.
  The old managed-image branch tip `5fa3c38` is also an ancestor of main.
- IRS selects local tarballs in `irs-tools/package.json`, not sibling source.
  Runtime archive `kkrausse-browser-agent-runtime-0.1.0-alpha.1-4f00341.tgz`
  records Vivari revision `e998de62a10e5382104b51e0b860ee9d4d7a2401` and
  distribution version `232a03809dc425a31b620864569789ca9c73c97b389d4138b7cf6554e3641e04`.
- Compared actual archive bytes to the former experiment worktree's
  `workspace-api/dist/runtime`: all eight JavaScript worker assets match, including
  fs/kernel/process workers. The service-worker adapter differs. Experiment
  distribution version is `beca8fc930d48adbf0e9e59c6c3f62efb1653e61207079645a57fef31a1862d7`.
  Matching workers is not a claim that the entire distributions match.
- IRS workspace tarball `index.js` and `react.js` are byte-identical to the
  former experiment worktree's `workspace-api/dist/lib` bundles. These bundles
  include the clear and shutdown/controller paths.
- The old upstream directory is a worktree of the same toolkit repository, not
  another repository. Its gitignored runtime checkout/builds remain local to it.
  The managed-image worktree registration points at a missing directory. Neither
  was deleted or pruned in this audit; future tracked edits stay in the canonical
  `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit` checkout.

## What was actually fixed

| Change | What it fixes | What it does not prove |
| --- | --- | --- |
| Vivari `cb665cd`; toolkit `ca20d8a` | Recursive deletion classifies directory symlinks without traversing their targets | Every populated dependency tree clears repeatedly |
| Vivari `e998de6`; IRS `0a59582` | OPFS delete-then-recreate retains subtree deletion so stale descendants do not return on reload | The live `node_modules` deletion no longer throws `ENOTEMPTY` |
| IRS `375b931` | Retains a validated restore snapshot and allows retry after chat detaches | Underlying runtime deletion is repaired; its isolated fixture simulates clear/start |
| Toolkit `5821c8e` | Real-browser interrupted-clear recovery contract, with injected `ENOTEMPTY` | A fix for naturally occurring deletion failures |
| IRS `dda2e4a` | Save-before-switch and logical workspace identity | Faster switching or a runtime removal fix |

Direct evidence: `irs-tools/docs/packaged-preview-verification-2026-09-29.md:22`
records the packaged editor failing with `ENOTEMPTY` on initial replacement and
succeeding through **Retry interrupted restore**. Its line 31 explicitly calls
this recovery, not elimination. The todo experiment independently failed on a
subsequent reset with matching workers. Successful later IRS switches do not
establish that the intermittent failure disappeared.

## Next experiment sequence

1. Reproduce repeated deletion against the exact IRS-selected runtime archive in
   an isolated benchmark origin. Record runtime version/asset hashes, process
   diagnostics before and after stop, and the failing subtree/remaining entries.
   Do not count retry recovery as a first-attempt pass or assume a writer race.
2. Establish repeated full-reset/cached-image-reinstall measurements, with fully
   hydrated preview and separately usable chat readiness. Preserve failures.
3. For matching dependency environments, test source-only switching while retaining
   dependencies and Vite's optimization cache, first with restarted services and
   then with Vite kept alive. Avoid the existing 12-second full-tree verification
   on the fast path; safe reuse requires immutable ownership or reliable mutation
   tracking, not a persisted marker or matching source provenance alone.
4. Treat OpenCode reuse independently: prove project/config/session isolation and
   no old tools/readers operating on new source. Preview-only speed is not complete
   workspace-switch speed.
5. Test A/B/A repeated switches, removed/renamed files, binaries, stale modules,
   config changes requiring restart, dependency changes forcing cached-image
   reinstall, and failed replacement recovery. Keep IRS autosave semantics intact.

Before new browser runs, use the IRS-selected archive via the harness's explicit
`RUNTIME_DIR` override, with matching prepared manifest runtime identity, rather
than assuming a generated sibling distribution is identical. Continue library
development on toolkit main, which already contains the IRS-consumed source.
No IRS edits, runtime source/pin changes, pushes, or deployments in this audit.
