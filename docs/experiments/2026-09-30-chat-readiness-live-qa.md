# Independent chat readiness live QA — blocked / failed, not acceptance

## Scope and frozen identity

Fresh stub lab only, no combined runtime/workspace application and no paid inference.
Candidate `55ae98c72437d27ff683c65dbb79f3b3f9e31572`; shared checkout HEAD at
inspection was `3b42a10628a525458f9c0dc297d1f6e0d9de8be1`. Diff against the
candidate was empty for controller, React view, fixture, lab, and lab server.
Sibling workspace/library changes were neither staged nor changed by this QA.

Started `bun scripts/serve-chat-readiness-lab.ts` once from `opencode-chat/`.
Owned origin: `http://127.0.0.1:53945/`; owned server PID `27215`, shell
`sh_0f3a13759001vWopuDra7W8bAA`. The server builds once and serves the retained
bundle/stylesheet bytes, not a rebuilding development server.

SHA-256:

| Artifact | Hash |
| --- | --- |
| Actual served `lab.js` | `332455a344edaa030ea72757de4dd2495a7c823b504f75ae70e472e82f5345ec` |
| Actual served HTML | `e291b4a734b336a80e4aa71027f26ec5e0cc08db2406a8014e9ca6810c7e7de3` |
| `src/controller.ts` | `b084cfb4ef0c8462c289b4c4067b67e73576990ed402467156aa2ba14d2431ff` |
| `src/react.tsx` | `cb54f8459f5ba6a12441830fa94c8e88289d53a6e661f5519bf8308af529662f` |
| `test-ui/readiness-lab.tsx` | `2e5d77c2377ea480a865160f5a53a2b04463ceb8c8c0b96ac99decc020dae5c7` |
| `scripts/serve-chat-readiness-lab.ts` | `3334adbacd12bb927938043ed8acfebbf597f8bb34db612fb6bc07db663b0ca8` |
| `test/fixture.ts` | `8c365d7722fe132c6f80918e5430f19331c664a524db2747b621798e16fc06b4` |

Evidence directory (local, not published):
`/Users/kkrausse/Documents/opencode/chat-readiness-qa-20260930/`.
Frozen HTML and JS are retained there. All typed data was new deterministic QA
text; no user page, profile, existing evidence origin, persistent storage, provider,
or model call was adopted or modified. Source inspection confirms that API calls
use the injected fixture's in-memory `fetch`, not native network fetch.

## Visible/manual cohort — blocked

Used Bun-backed Browser Control CLI **v0.8.2**, fresh owned session
`cosmic-sparrow-334`; never MCP and never relay restart. Ordinary trusted
`pressSequentially` typed `qa-old-first`, and a normal click opened Session & model.
Verified `ses1`, `session:ses1`, Ready, zero prompts, and the typed old draft.

The next ordinary inspection, `page.getByRole("button").allTextContents()`, failed:

```
locator.allTextContents: TypeError: target.addEventListener is not a function
    at addEventListener (http://127.0.0.1:53945/lab.js:65634:10)
    at InjectedScript._setupGlobalListenersRemovalDetection
```

**Causal lab blocker:** the served HTML uses `<script src="/lab.js"></script>`
without module isolation. The bundle contains a top-level Base UI helper:

```js
function addEventListener(target, type, listener, options6) {
  target.addEventListener(type, listener, options6);
}
```

This replaces the native global event-registration function. Two installed browser
extensions also produced the same error during initial page load. These were initially
retained as console diagnostics; the later locator failure establishes that this is
not merely an irrelevant extension warning. A favicon 404 was also recorded.
The cohort stopped at the first failed QA command: no repaired globals, forced clicks,
alternate selector bypass, or retry-to-green. A final read/screenshot preserved state.

Evidence: `visible-journal.jsonl`, `visible-final.json`, `visible-blocked.png`.
The screenshot was read and visually inspected: First selected, old draft intact,
Ready, Send enabled, zero prompts. Network observations contained only this loopback
document/bundle and extension-local scripts; no remote HTTP/provider traffic.

**Coverage:** initial state / old draft / trusted details opening only. No New chat,
release gate, retry, late-result, send, or controller-isolation acceptance in this cohort.

### Browser Control project todo

- [ ] Preserve native browser globals in the lab's served bundle integration, then
  authorize a new independent visible cohort. Reproduction and expected/actual are
  recorded above. CLI v0.8.2; safe context is the fresh offline origin/session only.
  Expected: ordinary locator inspection returns button text. Actual: native-global
  collision causes a locator exception. Recovery attempted: evidence capture and
  deletion of only the owned session; no relay changes or candidate repairs.

## Isolated headless real-Chromium cohort — first assertion failed

New script: `opencode-chat/scripts/chat-readiness-browser-qa.ts`. It imports a
locally available Playwright Core, verifies the frozen served bundle hash, launches
a fresh ephemeral headless Chromium context, and uses trusted keyboard/pointer controls.
DOM evaluation is read-only evidence gathering, not fixture mutation. Requests outside
the owned loopback origin are denied and logged. Cleanup closes context and browser.

Initial launcher prerequisite failed because Google Chrome was not installed:
`Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
No browser or test ran in that attempt. Rather than install or modify a user profile,
the independent executed cohort selected the already installed Brave executable.
This launcher adjustment is recorded; it is not a retry of the failed functional cohort.

Executed command (from `opencode-chat/`):

```sh
QA_ORIGIN=http://127.0.0.1:53945/ \
QA_OUTPUT=/Users/kkrausse/Documents/opencode/chat-readiness-qa-20260930/headless-brave \
QA_PLAYWRIGHT_MODULE=/Users/kkrausse/Documents/repos/kkrausse/random/skills/excalidraw/scripts/node_modules/playwright-core/index.mjs \
QA_CHROMIUM_EXECUTABLE='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' \
QA_BUNDLE_SHA256=332455a344edaa030ea72757de4dd2495a7c823b504f75ae70e472e82f5345ec \
bun scripts/chat-readiness-browser-qa.ts
```

Playwright Core **1.62.1**, real headless Chromium **154.0.8037.58**, viewport
1280×1100. The visible session was deleted before launching headless; no concurrent
visible/headless stress or performance work.

**Result: 0 completed checkpoints, 1 failed assertion; process exit 1.**
Initial readiness settled. The script then typed the old draft, clicked the details
summary and New chat, and immediately typed `qa-new-intended` without waiting for
the creation response or a draft transition. The first pending-state assertion failed:
`'ses1' !== null`.

Exact recorded states:

| Gate | sessionID | draftKey | pending | text | promptCount |
| --- | --- | --- | --- | --- | --- |
| initial | `ses1` | `session:ses1` | false | empty | 0 |
| immediately after New chat + typing | `ses1` | `session:ses1` | false | `qa-old-firstqa-new-intended` | 0 |
| subsequent first-failure capture | null | `new:1` | true | empty | 0 |

The initial failed-gate screenshot confirms First remained selected, Send enabled,
Ready, and concatenated old/new text. The subsequent failure screenshot confirms
Preparing chat, disabled Send/New chat/model, enabled release/reject creation gates,
and an empty new draft. Both screenshots were read and inspected, not merely saved.
Counter reads and screenshots are sequential observations, not claimed atomic captures.

**Admission/transition race remains unresolved:** trusted immediate typing reached the
old logical draft before the new draft became selected. The controller's New chat
selection is performed inside the asynchronously run Effect; this is consistent with
the observed delay but does not alone prove its scheduling root cause. A test/event
synchronization issue versus a user-visible admission defect needs further diagnosis.
This run is not proof that text typed after an already-observed pending state is lost.
It is also not a passing readiness test. No waiting adjustment, repair, replay, or
rerun was used to turn this failed functional cohort green.

Evidence: `headless-run.log`, `headless-brave/result.json`, `headless-brave/gates.json`,
and its three gate screenshots. Headless console/page errors: **0**. Network:
**2 GETs**, only `/` and `/lab.js`; no provider requests or unauthorized network
attempts. Local/session storage keys: empty at all captured gates. The injected
fixture prompt counter remained **0** with an empty prompt list throughout.

The script contains follow-up assertions for hydration, explicit single send,
rejection/retry, late-create selection and session revisits, and a separate-page
controller baseline. Those were **not reached**, are not claimed verified coverage,
and a separate-page baseline would not prove a same-view controller-prop switch.

## Cleanup and remaining gaps

Deleted only Browser Control session `cosmic-sparrow-334`. Sent SIGTERM only to owned
server PID `27215`; the background shell completion confirmed termination. Follow-up
`lsof` found no listener on 53945, `ps` found no PID 27215, and the owned Browser Control
session was absent (`cleanup.json`). Headless context/browser close completed before
the script exited. No resources intentionally retained; only evidence files remain.

Pending: visible pending-create typing, admission/Enter blocking, server-ID draft/text
preservation, held hydration, Ready without automatic send, exactly one explicit send
to intended session/text followed by clear, creation rejection/retry, late-result
abandonment, session revisits, and same-view controller isolation. All require a new
authorized cohort after addressing/diagnosing the blockers. Whole-app packaged
integration remains pending and was not authorized here.

The inherited offline tick-based handshake-disposal flake is not evaluated by these
lab browser cohorts. Owned server/tab cleanup evidence does **not** establish that
disposal test or the whole suite is stable. No existing controller, React source,
candidate tests, runtime, application startup, or sibling retention files were changed.
