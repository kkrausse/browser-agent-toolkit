# Conservative editor switch/recovery — stopped before first switch

## Outcome

**One independent visible editor cohort attempted; ordinary switches completed: 0/4.**
The first explicit Save workspace action failed with **`Chat became busy; workspace
was not replaced`**. The success assertion timed out after 30 seconds; a fresh page
read confirmed the actual application alert. The cohort stopped immediately: no
save retry to continue qualification, no B creation, switch, recovery fixture,
reload, forced click, assertion relaxation, production patch or headless substitute.
This is **not** an editor acceptance pass or consolidated full-suite green result.

A single public **Exit** was subsequently used only for cleanup. Its built-in save
succeeded and retained A's exact source and native session in the real catalog.
That later save does not erase the failed acceptance action. Public close returned
to Open editor, but a same-ID kernel target remained in a later actual CDP census
roughly 32.5 seconds after the close command began. Empty Web Locks did not imply
worker termination. **Orderly close/census acceptance is not established.**

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-conservative-editor-switch-recovery-live-qa.md`.

## Immutable input and owned origin

- Frozen input:
  `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-full-app-Yb8T8p/frozen`.
- New, previously nonexistent run copy:
  `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-editor-live-20260930-once`.
- Evidence:
  `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-editor-evidence-20260930-once`.
- One `bun "$RUN/qa/live-host.ts" "$RUN"` launch, OS-assigned origin
  `http://127.0.0.1:49633/`, PID **15093**, background host job
  `sh_0f478872d001LQatzjuFAw0ZHe`; joined after exact-PID SIGTERM.
- Explicitly created and successfully verified CLI session
  `conservative-editor-20260930-once`, then navigated its own page to
  `/?workspaceFixture=1`. No user tab adoption, storage clearing, shared relay
  restart, MCP, browser installation, canonical-pin change or paid provider.
- Bun-backed Browser Control **0.8.2**, existing relay **0.8.2**, extension **0.0.25**.
  Providers remained empty and host `/editor/model/` remained prohibited (403).
  Prompts and inference calls: **0**. Catalog background refresh is not inference.

Before activation and after cleanup, all **9,677** frozen receipt-listed files
reverified; frozen receipt SHA-256 remained
`9b4d37a89ff57943caa45a222951ba2788a9e5980a1960c1e89e17b8c488f64b`.
All **9,677** run-copy files also reverified after QA; run receipt SHA-256
`212be05ac5fbe95a012e9724f42baa0823f4efa0eb4a9c2c8cf67a6b140f680e`.
Runtime `33fa1359a003ca9c50cb3bc49699b99bc1a063f1`, toolkit
`d0eec346dbc749db1c0cd82dd8aad0b27c1da363`, version
`3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.
Native outputs were verified prepared reuse, not newly compiled here. Frozen and
shared generated assets were never edited.

## Actual visible actions and first failure

Read the actual editor, source fixture, native-session transfer and startup source
before acting. Open editor reached a hydrated TODO preview and connected, idle
chat; Save workspace became enabled. The native model/session controls were
initially collapsed: opened the real **Session & model** disclosure before using
them, then inspected the nav aria tree when compact snapshot omitted its controls.

1. Normal **New chat** created native ID `ses_f0b8630f1ffe7ZM6q1QIri7nAc`.
2. Inspected the actual model list, then selected **Nemotron 3.5 Lightning Free ·
   opencode** through normal controls. This is a native session-model update, not
   a prompt or provider call. The exported model is
   `nemotron-3.5-lightning-free` / `opencode` / variant `default`.
3. Filled Workspace name **QA owned A**. The existing opt-in, bounded public
   `__todoWorkspaceFixture.writeSource` wrote and flushed
   `/qa-owned-marker.txt` with exact text `editor-A-20260930\n`. It enforces the
   app's normal source safety and idle/action admission; no private controller,
   global callback replacement or direct catalog mutation was used.
4. Clicked the enabled normal Save workspace control once. The expected Saved
   QA owned A status never appeared. The first assertion failed at
   `2026-09-30T22:41:48.997Z` (journal completion), duration **30,199 ms**.
   A fresh aria read exposed the app alert **Chat became busy; workspace was not
   replaced**; the live marker, selected session and model still existed.

The application's `capture()` checks idle before flush/source/native exports,
then checks it again before persist. This alert identifies the latter rejected
checkpoint (`workspace-editor.tsx:57`, delivered bundle line 100020); it is not
evidence of lost source or a failed kernel switch. No precise causal timing
diagnosis is claimed: no chat-state subscription or public SSE trace was installed
before that action. In particular, do not relabel this finite failure as the focused
consumer's known dual-WeakMap observer defect.

## Raw source, native and journal evidence

Real IndexedDB database `todo-browser-workspaces-v1`, store `catalog`, key `current`
was read observationally and its structured-cloned `Uint8Array` source values
losslessly serialized as byte arrays. `catalog-failure-raw.json` retains the
pre-close failure catalog: active ID **56b6848d-3de6-4bd3-b570-85aa8cab4fb1**,
one **Current workspace**, 34 source files, zero native sessions, **no pending**.
This proves the failed save had not committed A to the catalog; no durable
outgoing-plus-incoming recovery journal was created.

Before close, `live-source-failure.json` captured all 34 actual source paths plus
the live marker through the existing fixture. After public Exit's built-in save,
`catalog-after-public-close.json` retains the same active ID, **QA owned A**, 35
source files, one native session, selected ID above and **no pending**. Every
captured live source file agrees with the saved byte digest; mismatches **[]**.
`finite-summary.json` retains every individual source SHA-256. Marker SHA-256:
`9319285373ca6dcf9e8bba793460309cb41b8bf44848a6820d22d449a1192b0e`.

`native-export-after-public-close.json` is the actual app's native export bundle
retained in its durable catalog, **not ChatController transcript export**. It
contains native session info, project ID
`bf309ff466f7bcd6b1ca4751d16d42627dbac2ee`, directory `/workspace`, model, zero
token/cost counters and one real `model-switched` native message. No prompt or
assistant completion was added. The single native session is **flat**; parent
hierarchy preservation and ID remapping are **not covered**. Semantic native-bundle
SHA-256 (recursively sorted object keys, array order retained):
`bba85f056b95366fcebdfa15b1cf3afe17d1517025a3e609db1620b84f3c4c36`.
These are lossless catalog source bytes and decoded native export objects, not a
claim to have captured original HTTP transfer response bytes. No restored-native
comparison or across-switch preservation is claimed.

The complete CLI `browser-control-journal.jsonl` retains actions, exact failed
assertion, timings and bounded browser diagnostics. `failure-page.json` retains
the fresh failure aria tree, activity logs, actual targets and Web Locks.
Request collection installed before New chat observed no ordinary browser network
requests for the native broker transport; **that empty list is not proof of no
native operations**. Normal startup logs show Vite readiness **10,268 ms** and
OpenCode server readiness; no performance comparison is claimed.

## Coverage and close boundary

| Condition | Result |
| --- | --- |
| Visible initial editor/preview/chat startup | Reached |
| Native create and model selection, bounded source marker | Reached |
| Explicit A save | **Failed**, retained alert |
| B creation, four ordinary A→B→A switches | **Unrun; 0/4** |
| Exact source/native preservation across switches; mapped selection | Unrun |
| Parent hierarchy | Unrun; only one flat session exists |
| Kernel continuity and both service restarts | Unrun; only initial services observed |
| Preview TODO add/toggle/delete and same-document HMR | Unrun |
| Durable pending + held incoming manifest + one reload + recovery | Unrun |
| Durable pending + isolated startup manifest 503 + Recover outgoing | Unrun |
| Public Exit cleanup | Returned to Open editor; implicit save retained A |
| Native termination / original 15-second zero-worker acceptance | **Not established** |
| Headless | Unrun |

Recovery was not attempted because the earlier save assertion failed, **not**
because a cached manifest checkpoint was experimentally found uninterceptable.
No manifest route hold/503 was installed, no reload occurred, and neither recovery
ordering condition was met. Actual read-only `loadPrepared` source fetches
`/editor/prepared/manifest.json`; this is not live interception qualification.

Failure census had one kernel (**4704204A3EC0F78B1AB5C905F5A05253**), process
workers PID 1/2/3 and kernel-held `vivari-vfs-owner` lock. Public Exit returned
to Open editor and the first close capture completed at **867 ms** with **the
same kernel and PID-2 worker still present**, locks empty. The second actual
census at `2026-09-30T22:44:19.600Z`, roughly **32.5 seconds** after command
start reconstructed from the journal, still showed **the same kernel** and no
process workers/locks. The helper did not implement continuous polling through
the original 15-second deadline; **neither immediate nor late observation is
substituted for a passing original census**. No native terminate-call observer,
separate public execution/output-reader/endpoint settlement receipt or registry
sample was exposed/captured for this editor close. Empty locks alone are not a
join receipt or all-writer proof.

Two actual **3780×2270-pixel viewport** screenshots were opened and manually inspected:
`failure-viewport.png` shows the hydrated empty TODO preview, expanded session/model
controls, selected native session/model and the actual save alert; `close-viewport.png`
shows the returned Open editor page. Neither is a full-page image or an HMR/CRUD
acceptance capture. Journal browser errors include the initial favicon 404; no
captured pageerror appeared in returned command diagnostics. No Browser Control
page replacement, relay malfunction or forced click was used; the timeout was
the actual failed application-state assertion.

## Cleanup and preserved limits

After preserving raw failure/close evidence, deleted only the owned CLI session
and page; this removes the lingering target as **failed-cohort page cleanup**, not
accepted native close. Exact host PID 15093 received SIGTERM, its background job
completed, and host output is retained. Independent `ps` and listener-only `lsof`
found the exact PID/port absent (both exit 1), and process enumeration found no
run-owned host/CLI/reader. Session list excludes the owned session; Browser Control
status shows **activeTargets:0, childTargets:0**. CDP read sessions detached in
`finally`; no shared clients were disconnected. There was no separately acquired
file lock to release. **Exclusive visible CLI slot is released.**

Evidence manifest hashes **21** retained files, including both source catalogs,
native export, scripts, journal, screenshots, host output and cleanup receipts.
Temporary observer scripts are QA-only evidence, not a new production harness.
This report is the sole owned repository change; unrelated staged/modified parent
reports were left untouched. Commit only this report; no push.

The independent full-app result remains: 19 stages/five generations/HMR/SSE/reload
completed, focused case 0 blocked by its separate dual-WeakMap observer identity
defect, no all-green cohort. Known lazy-loader/planted `/bin` ancestor limitation,
full `markAsUncloneable` contract failure, inherited disposal timing flake and
historical case-1 close-census failure remain. No pristine `/bin` audit was reached
here, no global all-writer proof, cache retention, long-lived OpenCode process
reuse, benchmarking, paid model setup or Effect migration was attempted.
