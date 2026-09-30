# Independent repaired chat live QA — lab passes; same-view qualification blocked

## Outcome and scope

- **Visible repaired lab:** 10 captured gates, no failed assertion. Native locator
  inspection/event registration, immediate New chat typing, both pending gates,
  explicit single send, rejection/retry, late-create abandonment, and draft revisits pass.
- **Independent headless Chromium:** unchanged committed script reports **6 completed
  checkpoints, 0 failed**, 9 captured gates. Its sixth checkpoint is only a separate-page
  baseline, **not** same-mounted-view controller isolation.
- **Separate optional controller-switch wrapper:** **2 passed guards, 1 failed
  assertion**, then stopped. Harness defects prevent qualification. Same-view isolation
  and held model-mutation browser acceptance remain **pending**.

No real model calls: all prompt records are injected local fixture counters. No paid
inference, persistence implementation, existing user tab/storage, relay restart, MCP,
production changes, sibling workspace/runtime/retention edits, or parent status edits.
Historical failed evidence/report remains untouched. Whole packaged workspace app and
inherited tick-based handshake-disposal stability remain unqualified.

## Frozen identity and isolation

Candidate code `691cd5aa0880349968773047402adec0bfeb16df`, repair report `6712c2b`;
previous failed independent QA `d8f2a49` is not relabelled.

Started `bun scripts/serve-chat-readiness-lab.ts` once from:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/chat-readiness-repair-0nXBtN/candidate-source/opencode-chat/`.
This builds once from archived source, retaining bytes for both cohorts. Owned random
origin `http://127.0.0.1:57539/`, PID **67989**, background shell
`sh_0f3bf8efb001XO7SSkiVykYFOX`. Actual fetched bytes were verified **before browser
actions**, retained, and matched the supplied manifest:

| Artifact | SHA-256 |
| --- | --- |
| Served `lab.js` | `16ae8532768e09441c458b07d255b9b88cabfd3af0a22a1b2ca3c134e9d83bb4` |
| Served HTML | `a866f88b894f599a1c92b0239eb906f9d5498ef65b3b60276e654259760109bb` |
| Frozen controller | `a918a42da0e525b1c84f5a18e834fc7cc130fb6ac0331b770e3aa46259cfe7d3` |
| Frozen React | `cb54f8459f5ba6a12441830fa94c8e88289d53a6e661f5519bf8308af529662f` |
| Executed headless script (also exact `d8f2a49` file) | `e4960c2b6d0ff2843dd05864de83112679542cb815982c000138146472b7fe62` |

All fresh evidence is under:
`/Users/kkrausse/Documents/opencode/chat-readiness-repair-qa-20260930/`.
`identity.json`, retained HTML/JS, per-gate PNG/JSON, Browser Control journals,
headless result, wrapper receipt, and `evidence-sha256.json` identify this new cohort.

## Visible / manual inspected cohort

Bun-backed Browser Control CLI **v0.8.2**, fresh owned session `quiet-raven-854`.
Ordinary `page.getByRole("button").allTextContents()` succeeds. Native
`window.addEventListener` string is `[native code]`; ordinary registration/dispatch/
removal yields event count **1**. No patched globals, forced clicks, dispatched DOM
clicks, or locator fallback. Used trusted `click`, `pressSequentially`, and `press`.
No pending-state wait between New chat click and immediate new typing.

| Captured gate | session / logical key | Draft | Prompt count |
| --- | --- | --- | --- |
| Initial | `ses1` / `session:ses1` | `qa-old-first` | 0 |
| Creation pending | null / `new:1` | `qa-new-intended` | 0 |
| Hydration pending | `ses_lab_1` / `new:1` | unchanged | 0 |
| Ready | `ses_lab_1` / `new:1` | unchanged | 0 |
| Explicit Send | `ses_lab_1` / `new:1` | empty | 1 |
| Rejected creation | null / `new:2` | `qa-retry-intended` | 1 |
| Retry Ready | `ses_lab_3` / `new:2` | unchanged | 1 |
| Late creation released after Second selection | `ses2` / `session:ses2` | `qa-second-only` | 1 |
| Revisit First | `ses1` / `session:ses1` | `qa-old-first` | 1 |
| Revisit sent chat | `ses_lab_1` / `new:1` | empty | 1 |

Creation pending is true with null server selection. Send, New chat and Model are
disabled; textarea stays usable. Enter at creation and hydration gates keeps zero
prompts. Hydration keeps pending true/loading true and Send disabled. Ready retains
text, with no queued/autosend. The one explicit Send records exactly
`/proxy/api/session/ses_lab_1/prompt`, text `qa-new-intended`. Revisits verify only the
originating draft cleared. Rejection keeps draft, null selection, disabled Send; retry
keeps the logical key/text without prompt increments. Second was empty before typing,
and late creation does not hijack it or leak the pending draft.

Actual manual image reads inspected `visible-creation-pending.png`, `visible-ready.png`,
and `visible-revisit-first.png`: text, counter, selection, and disabled/Ready controls
match those gates. The last screenshot also reveals the intentionally induced 503
creation error banner persists on First. That error-banner lifecycle was not an
asserted acceptance condition; this report does not claim it clears on selection.
Screenshots and reads are sequential observations, not atomic snapshots.

Console: one favicon 404, **zero page errors**. Observed requests: 2 loopback GETs
(`/`, `/lab.js`) and 2 extension-local injected scripts; no remote HTTP/provider
requests. Unlike historical QA, neither extension caused an event-global exception.
Application localStorage stays empty. SessionStorage contains extension/tool keys
`__darkreader__wasEnabledForHost` and `__browser_control_ghost_cursor_position__`;
these are classified, **not falsely claimed empty**. No app draft persistence and no
storage clearing. Model menu inspection exposes one model; pending-create Model
disablement passes, but a held model mutation is not qualified in this lab.

## Serialized isolated headless cohort

Deleted visible session before headless launch. Executed the exact frozen copy of
`opencode-chat/scripts/chat-readiness-browser-qa.ts` from `d8f2a49`, with unchanged
immediate assertion, against the same server/bundle:

```sh
QA_ORIGIN=http://127.0.0.1:57539/ \
QA_OUTPUT=/Users/kkrausse/Documents/opencode/chat-readiness-repair-qa-20260930/headless-brave \
QA_PLAYWRIGHT_MODULE=/Users/kkrausse/Documents/repos/kkrausse/random/skills/excalidraw/scripts/node_modules/playwright-core/index.mjs \
QA_CHROMIUM_EXECUTABLE='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' \
QA_BUNDLE_SHA256=16ae8532768e09441c458b07d255b9b88cabfd3af0a22a1b2ca3c134e9d83bb4 \
bun scripts/chat-readiness-browser-qa.ts
```

Playwright Core **1.62.1**, Chromium **154.0.8037.58**, ephemeral context/profile,
1280×1100 viewport, origin-only request allowlist (all others denied). Process exits
**0**, reports `passed: 6`, no failure, **0 console/page/network-denial errors**.
Two main-page loopback GETs; new-page baseline requests are not tracked by the
main-page request listener (context-wide deny still applies). All recorded headless
local/session storage key sets are empty. Prompt counter ends at **1**, with exact
intended path/text. No real inference. Context/browser close completes before exit.

Manually opened/inspected `headless-brave/2-creation-pending.png` and
`5-explicit-send.png`: null selection, intended text, disabled preparation controls;
then exactly one prompt, rendered intended user text, Ready and empty composer.

## Optional same-view cohort — first failure preserved, NOT acceptance

New QA-only files: `opencode-chat/test-ui/readiness-controller-swap-qa.tsx` and
`opencode-chat/scripts/serve-controller-swap-qa.ts`. The server resolves wrapper
controller/React/fixture imports only to frozen candidate source, validates hashes,
and writes a new receipt. Original frozen source and artifact files are unchanged.
Wrapper renders one unkeyed, unconditional `ChatView` with controller A/B props,
using trusted switch buttons and two independent local fixtures.

Fresh origin `http://127.0.0.1:58215/`, PID **77005**, owned session `calm-walrus-408`,
shell `sh_0f3c63fa70010a0yhS3Nm41oTs`. Wrapper server started after headless finished;
its browser session began after the original server exited (brief server overlap,
no browser-cohort overlap). New actual served hashes verified before action:

| QA artifact | SHA-256 |
| --- | --- |
| Bundle | `772e93644497729b9914c1cd5c5ce4ff040c24b72e87f08d710be03972567680` |
| HTML | `556c205051b185fea889370362a0ede699f74e27ee4fd7f008c3beaf0a056c28` |
| Wrapper source | `c99e84eb139d29707e41969eb1ea8bccac672181b3fceb55c4daffeb1a81020d` |
| QA server source | `007e3721623b8f22bf327672247c30c6f9f772ee477c988f465172a98f9fb000` |

Typed `qa-A-private`, switched A→B, observed B empty: two passed guards. Then an
overstrong QA assertion required the **textarea DOM node** to retain identity;
actual false, error `Same mounted textarea`. **Stopped immediately**: no B typing,
return switch, model mutation, release, repaired globals, or wait/rerun-to-green.
Preserved `controller-swap/result.json`, `gates.json`, three PNGs, and full journal.
Opened/inspected `first-failure.png`: B empty, loading/connecting, no prompts.

Diagnosis identifies two **QA harness defects**, not a demonstrated candidate bug:

1. Frozen `src/react.tsx:430–433` intentionally keys `SessionComposer` by
   `controllerIdentity(controller)`. A stable mounted **ChatView** does not imply
   stable child textarea identity. Requiring it was an incorrect test condition.
2. Wrapper's broad non-GET/non-prompt hold intercepts
   `/proxy/api/plugin/await-activation` on **both** fixtures, preventing readiness;
   neither had selected session IDs at captured gates. It must narrowly hold the
   actual model-switch route in a new authorized cohort, not plugin activation.

No prompt calls, one favicon console 404, zero page errors; requests only fresh
loopback and the same two extension-local scripts. The wrapper is retained verbatim
as failed experiment provenance, **not a ready acceptance harness**. No repaired
version was executed. Same-view isolation and held-model admission need a new cohort.

### Browser Control project todo / harness failure record

- [ ] New QA cohort must verify mounted ChatView identity, not the deliberately
  controller-keyed SessionComposer child; narrow the model fixture gate. CLI v0.8.2,
  fresh owned origin/session above, exact error and deterministic trusted A→B
  reproduction in journal. Expected correct contract: no A text in B, stable outer
  ChatView; actual mistaken guard: textarea changed. Recovery: evidence capture and
  owned cleanup only. No Browser Control transport exception or relay repair occurred.

## Cleanup / ownership release

Deleted only `quiet-raven-854` and `calm-walrus-408`. SIGTERM only PIDs **67989**
and **77005**. Both exact background shell completions joined and report SIGTERM.
`cleanup.json` independently records both PID absences and no listeners on **57539**
or **58215** (`ps`/`lsof` exit 1, empty output); both owned sessions absent. Other
sessions/tabs/storage untouched. Headless browser/context closed before wrapper run;
no concurrent visible/headless jobs. **Exclusive visible CLI ownership released.**
