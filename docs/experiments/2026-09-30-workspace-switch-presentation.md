# Workspace switch checkpoint presentation — 2026-09-30

Healthy app-owned switches now show neutral **Switching to X…** status, not an
interrupted-switch alert or recovery controls. An idle pending checkpoint, including
one discovered at startup, still exposes the existing recovery actions. An explicit
retry/recovery returns to neutral progress while its action is running.

Chat hydration no longer clears local pending early: it only releases the restoring
gate so the client can connect. Pending continues blocking chat interaction and
workspace admission until the durable final catalog commit. Pending also masks the
startup helper's early Ready footer; failed final commit retains recovery.

Verification: **26 tests, 116 assertions pass** across presentation, switching,
native session transfer and TODO procedures; compiled styles and frozen-asset
staging pass. The focused strict UI typecheck passes with the committed startup
source (including the new presentation tests). No browser automation or activation
was performed; parent owns `quiet-panda-336` and host port 54770.

## Parent-only activation

Copy only `single-kernel-live-client.js` and `.css` from:

`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-ui-switch-presentation-20260930-isolated`

Use the existing backup/atomic UI-copy procedure, same host/origin and retained
storage. Runtime, prepared assets, credentials and caches are untouched.

Concurrent default-model work changed `start-editor.ts` during staging and currently
fails against the frozen chat declarations (`defaultModel` is not in that frozen
API). This isolated artifact substitutes the committed startup source from
`79c1667cdae089517e9cc3c1ba0dc158416b7c8d` without changing the working tree. Its
receipt records the override/hash. Do **not** activate the earlier non-isolated
`.diagnostics/single-kernel-ui-switch-presentation-20260930` artifact, which picked up
those concurrent startup edits.

Local reproducibility helpers (ignored diagnostics, absolute paths):

- `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/stage-switch-presentation-isolated.ts`
- `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/typecheck-switch-presentation-isolated.ts`

Parent acceptance remains pending: observe a normal switch mid-transition without
warning/recovery controls, then completion; retain the actual failure/startup journal
recovery checks. Unit coverage does not claim live browser acceptance.
