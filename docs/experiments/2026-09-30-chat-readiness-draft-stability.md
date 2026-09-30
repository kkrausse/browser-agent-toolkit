# New chat readiness and draft stability — candidate, live QA pending

## Reproduced root causes

Baseline: `262c51a9ebc9bb82b289988d197046d07881aca3`. Acceptance report
`2026-09-30-zen-paid-browser-acceptance.md:43–46` records the original failure.
An archived baseline in a fresh temporary directory, using the new deterministic
tests and injected in-memory HTTP/SSE fixture, independently reproduced:

- While session creation is held, the Send button is **enabled**, but the same
  controller rejects a send with **Chat is not ready**. Private `mutation` was not
  represented in the React readiness state (also affected model mutations).
- Text entered before the create response becomes **empty** after the server ID
  arrives. `ChatView` keyed `Composer` by `sessionID`, remounting its local state.

Baseline command: `bun test test-ui/chat-readiness.test.tsx -t 'send control is disabled|text entered before'`.
Both fail at the behavioral assertions above, without inference.

## Candidate fix

- New chat immediately selects a new *logical draft*, with no selected server
  session, before waiting for creation. Its stable controller-local `draftKey`
  survives server ID assignment, hydration, and revisiting that session.
- Snapshot `sessionOperationPending` exposes creation/model mutation admission to
  Send, New chat, model controls, and the preparation status. Hydration cannot
  accidentally advertise readiness before the creation operation completes.
- Composer retains per-conversation drafts in memory, resets on controller change,
  and clears only the originating draft after accepted send. No persistent storage
  or send queue is introduced. Enter/submit while pending does nothing.
- Creation failure retains the uncreated draft for explicit New chat retry, never
  sending it into the prior session. Explicit selection abandons that pending draft;
  a late creation response cannot change selection or migrate its text.
- Unknown execution/preparation shows disabled Send, not an inappropriate Stop.
  Existing local request/disposal ownership is retained.

## Offline checks

From `opencode-chat/`:

```
bun test test-ui/chat-readiness.test.tsx test/controller.test.ts test/markup.test.tsx test/reducer.test.ts test/reader-fence.test.ts test/location-fence.test.ts test/transport.test.ts
```

**62 pass, 0 fail.** Seven new DOM/controller tests cover readiness, early typing,
both pending gates, rejected creation/retry, abandonment races, session/controller
isolation, rejected send, late accepted completion, and model mutation. Prompt
request counters prove no implicit send and exactly one explicitly accepted send
to the intended new session.

One repeat hit the inherited tick-based `disposing during handshake interrupts
readiness and releases the stream` assertion (`cancelled: 0` instead of `1`);
the next full targeted rerun passed 62/62. That unrelated disposal test was not
changed; this record does not claim it is timing-stable.

Changed code, tests, and lab independently typecheck:

```
bun x --no-install tsc --noEmit --target ESNext --module Preserve --moduleResolution Bundler --jsx react-jsx --skipLibCheck --strict src/controller.ts src/react.tsx test-ui/chat-readiness.test.tsx test-ui/readiness-lab.tsx scripts/serve-chat-readiness-lab.ts
bun scripts/serve-chat-readiness-lab.ts --check
```

Lab browser bundle build passes; `--check` starts no server. Full-package
`bun run typecheck` and existing `test-ui/controls.test.tsx` are blocked by the
checkout's unavailable `@kev-browser-agent-kit/workspace` peer exports. No workspace
package, runtime, existing browser, storage, or frozen evidence was modified.

## Reproducible visible QA handoff — NOT RUN

Parent owns the only visible browser. After candidates are frozen, start:

```
cd /Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/opencode-chat
bun scripts/serve-chat-readiness-lab.ts
```

The printed random-port loopback URL is a fresh isolated origin. The served page
uses an **in-page injected fixture**: OpenCode requests never leave the page, no
model/provider API is invoked, and nothing is persisted. Do not substitute a real
endpoint. Use Browser Control **CLI**, not MCP, in a new tab at this URL:

1. Type an old-session draft. Open **Session & model → New chat** and immediately
   type a distinct new prompt. Check disabled Send, enabled typing, **Preparing
   chat**, `sessionID: null`, and `promptCount: 0`. Press Enter and try Send: still 0.
2. Click **Release creation**. Check assigned `ses_lab_N`, unchanged `draftKey`
   and text, disabled Send; Enter still produces 0 requests.
3. Click **Release hydration**. Check Ready and preserved text. No request should
   occur automatically. Explicit Send/Enter once: counter becomes 1, records the
   exact intended session/text, and composer clears. This is stub acceptance only.
4. New chat with another draft; reject creation. Draft remains and Send stays
   disabled. Explicit New chat retry → release both gates: draft remains; no send
   until explicitly requested. Check the counter does not increment on retry.
5. While another creation is held, type a pending draft, select **Second** session,
   type its own draft, then release creation. Selection/text must remain Second;
   no automatic prompt. Revisit First/created chats: drafts must not migrate.
6. Capture visible screenshots plus counters at each gate and after explicit Send;
   inspect console/network for errors and absence of provider requests. A fresh
   page reload resets this nonpersistent lab; do not use user workspace storage.

Real Chromium visible/manual QA of this lab, and separately integration QA of the
combined packaged application on an isolated origin, remain **pending**. Offline
tests and browser bundling are not whole E2E acceptance. No paid inference is
authorized or needed for this gap's stub acceptance.
