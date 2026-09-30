# Close-retention live QA: case 1 does not reproduce; historical cause unknown

**Diagnostic unchanged-runtime control, not a repair or release proof.** One live
`singleKernelCases.run(1,0)` completed and passed its original post-close boundary.
The previous failed cohort remains failed and unclassified: this fresh success
cannot distinguish a historical live leak from historical target-observation lag.
No runtime, app, chat, cache, sibling code or parent status was changed.

## Identity and retained evidence

Evidence directory (local, not committed):
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-close-retention-live-qa-930`.

- Frozen control: `.diagnostics/single-kernel-close-retention-control-2026-09-30`.
  All 9,588 receipt-listed inputs independently verified before starting the server
  and reverified afterwards. Receipt SHA-256
  `8ab9694867547b4d7f4a16f9dd64cb50b67d51bc8303ed045b3da8aab46405f0`.
- Runtime provenance remains `e35eab4af7a53ff08eb70c09df59c40b78bfdd67`;
  distribution `bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`.
  Runtime characterization commit `516ef37` and toolkit report `3b42a10` are not
  relabelled as new production runtime bytes. Zero builds in this QA.
- Exact observer installed with `page.addInitScript({content:source})` before
  origin boot, SHA-256
  `f1fe47126b2acd6e676c16be6d5fc002a5bad57131b4498e7ddf66338dfc6799`.
- Bun-backed Browser Control CLI/relay 0.8.2, build
  `2026-09-20T05:32:28.650Z`. Visible existing extension-connected Brave browser,
  Chromium 154 / page UA Chrome 154.0.0.0 on MacIntel. Browser context ID
  `DD2D403D1A8CF73E48F1DBA7466D698A`. New session-owned page/session
  `sk-close-retention-live-qa-930`, not a new clean browser profile. No user tabs
  were adopted, navigated, cleared or evaluated.
- Owned contracts origin `http://127.0.0.1:55466/`, server PID `46988`.
  `/inspect-empty`: empty OPFS, IndexedDB, caches, Service Worker registrations,
  local storage, held and pending owner locks. **Not literally zero storage:**
  Dark Reader inserted the sole session-storage key
  `__darkreader__wasEnabledForHost`. An additional strict session-storage assertion
  failed before runtime boot; retained in `fresh.json`. The diagnostic continued
  with that extension marker untouched, not by clearing/reusing application state.
  This is a stated freshness/profile limitation, not a retry of case 1.
- `Browser.getVersion` is shim-synthetic (`Browser-Control/0.0.0`); it is not
  presented as real engine evidence. `actual-browser-identity.json` retains the
  page's UA/client brands. `Target.getTargets` is Browser Control's scoped census
  of Chrome-announced target identities, not an independent browser-wide native
  query; matching kernel/guest creation and subsequent absence were observed.

## Exactly-once result and original bounds

| Observation | Retained result |
| --- | --- |
| Initiator | case 1, step 0, once; started wall ms `1790795031714` |
| Joined fixture / stop / workspace close | completed, case passed at `1790795032393` |
| Kernel | `4C0120D55F44DF64E9CA1E1182CB27AD`, exact new-origin `kernel-worker-1aDiRZSX.js?opfs-disable=` |
| Guest PID 1 | `1F8C817513263B9FF7BE2BC754CD23BE`, exact new-origin `process-worker-ZQRq3H73.js` |
| Live ownership | ready sample holds exclusive `vivari-vfs-owner`, client ID equals kernel target ID; no pending owners |
| Native termination | called once and returned at `1790795032388`; no worker error/messageerror event |
| Stopped registries | zero procs/process workers/listeners/pending HTTP/fetch active, queued, inflight, pins/filesystem clients/lazy inflight/owned spills; expected kernel=1 before close |
| Original 15-second window | deadline `1790795047393`; 91 joined lock+census samples, all empty |
| First empty sample | begin `1790795032534`, end `1790795032542`: 149 ms after joined close |
| Last original sample | end `1790795047274`: 14,881 ms after joined close |
| Observer completeness | dropped=0, lock query failures=0; browser log dropped=0 |

The unchanged HTTP fixture sends `[0,255,128,65]`; its passed browser assertion
checks a nonempty first chunk, **not exact chunk-byte equality**. Passed assertions
include reader cancellation closing the guest socket, natural fixture
exit (exit code 0, null signal, not forced), empty stderr and endpoint closure.
These are joined contract assertions; the observer did not independently capture
a guest exit payload or an individual flush reply. Successful joined workspace
close includes its flush/finally destroy path, not a separate flush receipt.
Lock and census queries are read-only and nontransactional; timestamps bound each
pair. No lock was acquired/stolen; no stop, terminate or run was replayed; no
worker liveness attachment was warranted because no post-close target survived.

`acceptance.json`, `samples.jsonl`, `result.json`, `logs.json` and server
`contract-events.jsonl` preserve the result. The original action took 679 ms.
Browser logs contain one favicon 404 and one Wasm initialization deprecation
warning, no page/lifecycle error. No inference calls occurred.

## Live/manual inspection and tooling failures

Inspected the actual rendered initial case list and later `ready` case output.
The contracts page has no case-launch button; the explicitly authorized bounded
entrypoint was used. `before.png`, `after-viewport.png` and snapshots show the
real page. Long JSON extends beyond the viewport. For readable manual inspection,
the postacceptance script prepended an explicitly labelled diagnostic view of
retained case/stop data plus a fresh read-only lock/census query. This DOM-only
observer presentation is **not** an acceptance-time runtime UI or changed app.
Both `manual-observer-view.png` and `manual-stopped-census.png` were opened and
visually inspected: passed case/completed action, one native terminate, empty
locks/targets and zero stopped work were visible. `rendered-result.png` landed
on started diagnostics and is not mislabelled as stopped evidence.

### Browser Control project todo (scoped here; legacy repository not modified)

- Safe context: CLI/relay 0.8.2 build above, new owned local contracts session
  `sk-close-retention-live-qa-930`; no credentials or user account data.
- Reproduction: after case 1 settles, retain JSON/snapshot, then
  `await page.screenshot({path:dir+'/after.png',fullPage:true})` on the long JSON
  document. Actual error: `page.screenshot: Timeout 30000ms exceeded`, after
  `taking page screenshot`, `waiting for fonts to load`, `fonts loaded`.
  Expected bounded screenshot completion or useful oversized-capture diagnostic.
  Root cause unproven; do not call this a runtime failure.
- `run-cli.json` retains the failed execute. Acceptance files had already been
  written and remain unchanged. Short page-health read succeeded with the same
  completed action; viewport screenshot with 10-second bound succeeded. No case
  replay, replacement page, safeguard bypass or relay restart. The run script's
  final CDP detach was skipped by the screenshot exception; session deletion later
  released only the owned page. Doctor was healthy before deletion.
- Separate CLI invocation mistake: `session new ... --json` is unsupported,
  returning `Unrecognized flag: --json in command browser-control session new`.
  Corrected by invoking session creation without that flag, before case initiation.
- The strict preflight `Origin not empty` script error was the known extension
  marker described above, not a CLI transport defect. Scope follow-up to capture
  bounds and document valid session flags; do not weaken origin isolation checks.

## Cleanup and qualification limits

After preserving and manually inspecting evidence, deleted only the new session.
Then SIGTERM to verified exact PID/command
`46988 bun examples/todo-app/tests/serve-single-kernel.ts .diagnostics/single-kernel-close-retention-control-2026-09-30 --contracts`.
Background server completion was joined and reported SIGTERM; this is host server
cleanup, not guest shutdown. `cleanup.json` verifies PID absent, port 55466 not
responding, owned session absent, owned page target absent. Kernel/guest absence
was already established while the page remained alive; page destruction was not
used to manufacture orderly shutdown. Frozen origin/storage was never cleared.

Case 0 optional independent-origin control was not run. No headless-browser claim,
full suite, stress/performance run or Node-as-browser-coverage claim. Visible
Browser Control ownership is released. Historical failure stays **bounded unknown**;
this cohort is **no retention observed**, not proof of target lag or repair.

Next qualification remains the original 19 application stages, five fresh
generations/reloads, focused cases 0–9 and each original post-close census. Parent
must integrate native-terminate/lock observations or label a separate diagnostic
cohort; any justified repair needs a new committed-source-matched build and fresh
frozen candidate, then live/manual QA before release/pin claims.
