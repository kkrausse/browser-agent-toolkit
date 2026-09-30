# TODO workspace browser acceptance — September 30, 2026

## Outcome and evidence ownership

**Bounded live acceptance passed after UI commit `98c91a6`:** source/session/model
isolation, workspace switching, same-origin restart/reload and real TODO CRUD.
The parent operated the browser; this worker only records the supplied results.
No code, browser, runtime or host-process operation was performed for this report.

- Live origin: **http://127.0.0.1:54770/**; unchanged host PID **88406**.
- Browser Control session: **quiet-panda-336**.
- Journal: `~/.browser-control/sessions/quiet-panda-336/journal.jsonl`.
- Activated UI staging:
  `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-ui-98c91a6`.
- Backed-up previous UI copies:
  `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/todo-startup-order-backup-1790783990967`.
- Screenshot supplied by parent:
  `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/todo-workspaces-verified.png`.

Only UI copies were activated. Origin/runtime/host remained untouched, and all
existing user work was retained. This report does not independently inspect the
journal or screenshot and does not claim a separate worker verification.

## Chronological observations

1. Initial UI activation exposed terminal null cursor validation failure.
   `9ad44ec` corrected the pagination schema. That correction did not prove startup
   or switching readiness: cold parallel Vite/OpenCode startup failed its 30-second
   listen bound before a retry succeeded.
2. New SmokeA failed twice before `98c91a6`. **Recover outgoing workspace**
   successfully restored Current. Previously injected failure recovery was also
   verified; failures are not omitted or retroactively relabeled as passes.
3. After sequential startup staging in `98c91a6`, Current boot passed, followed
   by Current → SmokeA. SmokeA initially had no native sessions. The parent fixture
   changed only the heading to **Workspace Smoke A**, preserving baseline source;
   New chat created one native session and the workspace was saved. Ordinary
   pointer selection later set **Big Pickle**.
4. The user manually reloaded the base origin/switched to Current mid-test.
   The parent paused and observed success, but this intervention is not counted
   as a controlled automated transition.
5. A repeated parent Current → SmokeA transition preserved the heading. With
   Big Pickle selected, **Exit → page.reload → Open editor** at the same port
   preserved both heading and model. The original named Current chat was absent
   from SmokeA's native session picker.
6. The native **New workspace** prompt accepted SmokeB. Fresh B showed baseline
   **Todos**, **Start a conversation**, and no A native sessions. New chat created
   one native B session; ordinary pointer selection set **MiMo-V2.6-Flash Free**.
7. B → A restored **Workspace Smoke A** plus Big Pickle. A → B restored **Todos**
   plus MiMo. B → Current restored the original named chat and actual native
   session listbox with **six sessions**, without alerts. The original
   three-character unsent draft was preserved in parent state and restored;
   its contents are deliberately not recorded.
8. Back in Current, the parent created, completed and deleted its own
   **Workspace round-trip verification** TODO without errors. Current remains
   restored and active; SmokeA and SmokeB remain saved for user exploration.

## Status and counting discipline

- **Workspace UI:** no source editor panel (count zero); bounded source/session
  switching and same-origin restart/reload passed.
- **Model picker/styles:** ordinary pointer selection and model retention across
  session reselection, switching and full restart/reload passed. This verifies
  compiled CSS integration beyond unit/build readiness.
- **Native isolation:** each smoke workspace had exactly one native session after
  New chat. Global option counts 3 (two workspace choices + one A session) and
  4 (three workspace choices + one B session) are not counts of native chats.
- **Recovery:** previously injected failure recovery and observed pre-fix outgoing
  recovery passed; no storage wipe or loss of existing user work was used.
- **Sequential startup:** the post-change bounded pass supports the improvement
  hypothesis. It is not root-cause proof, a controlled parallel/sequential
  comparison, comparative performance evidence or a startup SLA.

## Caveats and remaining scope

A browser screenshot during Current hydration logged an attributes mismatch
including `caret-color: transparent`. Automation instrumentation is a possible,
unproven explanation. Subsequent real CRUD passed; this does not justify hiding
the console error or claiming a wholly clean browser console.

No model inference was attempted. The catalog was public-only; no private provider
key was configured, and defaults for a paid model remain unconfigured. No full E2E
worker census, performance SLA, remote save or IRS authentication was qualified.
TODO items are still in host memory and shared across workspaces. This bounded
pass does not supersede the separately recorded failed full E2E cleanup result.

Implementation/activation handoff:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-todo-workspace-ui-handoff.md`.
