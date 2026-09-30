# Persistent single-kernel live exploration

## Running origin

Current working origin on September 30, 2026, after wrapper fix `24c9042` and
parent-operated Bun Browser Control CLI smoke verification:

- URL: **http://127.0.0.1:54770/**
- Bun server PID: **88406** (leave running; live browser/editor remains active).
- Owned output: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-interactive-1790778679425`.
- Ownership receipt: `live-origin.json` in that output directory.
- Frozen input: `.diagnostics/single-kernel-e35eab4-full-attempt1`.
- Runtime source: `e35eab4af7a53ff08eb70c09df59c40b78bfdd67`.
- Distribution: `bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`.

All 9,587 frozen receipt entries were verified before launch. Runtime, prepared
application and frozen browser workspace/delivery/OpenCode startup libraries are
reused unchanged. The interactive React/chat UI and server adapter are compiled
from this checkout into new ignored output. This is an exploratory consumer,
not a new browser-qualified production build or an E2E pass.

The previous origin **http://127.0.0.1:53971/** / PID **82790** remains serving,
but its old browser workspace exited orderly. It contains the pre-fix wrapper
and is **not recommended** for exploration. Use the current origin above.

## Bounded live verification

Parent-owned CLI session `quiet-panda-336` verified chat **Ready**, a hydrated
preview, TODO creation/completion, explicit `/src/home.tsx` load/save and Vite
HMR, stable **Session & model** disclosure, and **New chat** hydration completion
(`ses_f0d43c5f2ffeoENBgXI9XWrE0E`; no model call). After resetting the observer,
CRUD/HMR produced **zero preview navigations**. Exit → Open editor button →
full page reload → Open editor reached Ready; the edited heading and completed
TODO survived that reload. The heading was then restored to **Todos** with
Save and flush/HMR verified, and only the owned smoke-test TODO was deleted,
returning the preview to **No todos yet**.

This is a **fresh wrapper boot + manual CRUD/HMR/persistence bounded pass**,
not full E2E/model inference, worker-census, or performance qualification. The
separate fresh full E2E worker-cleanup failure below remains unresolved. Detailed
chronology and the asynchronous checkbox assertion caveat are in
`2026-09-30-single-kernel-live-wrapper-24c9042-verification.md`.

## Use

**September 30 UI update:** the same origin/PID now serves the workspace UI
activated from `98c91a6`, with no raw source editor panel. The parent verified
bounded source/session/model switching, same-origin reload and TODO CRUD; Current
is restored and active, with SmokeA/B saved for exploration. Use Workspace,
New workspace, Save workspace and the native session/model selectors. The source
panel instructions below describe the earlier wrapper, not the active UI.
Paid model defaults remain unconfigured and no inference was attempted.
Chronology, earlier failures and the hydration console caveat are recorded in
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-todo-workspace-browser-acceptance.md`.

1. Open the URL above in Chromium and choose **Open editor** once.
2. Wait for the TODO iframe to hydrate and OpenCode chat to connect. Debug ·
   Activity shows boot status and guest logs. No automated switch/test stages run.
3. Expand **Source editor (explicit local save)**. Keep `/src/home.tsx`, choose
   **Load file**, edit the text, then **Save and flush**. The existing workspace
   filesystem write drives Vite HMR; the flush persists source locally. Other
   textual workspace-relative paths may be loaded explicitly.
4. For chat exploration choose **New chat** if needed. Standard example model
   proxy routing to OpenCode Zen exists, with its public fallback. This process
   has **no private credential configured**. Model inference was not tested or
   called during preparation; authenticated/provider availability is unqualified.
5. Use **Exit** for orderly workspace/service close, then **Open editor** again.
   Saved source and chat are browser-origin-local. Source installation preserves
   existing browser edits. TODO data is separate in-memory Bun server state and
   is lost if the server restarts. Unsaved source text is not persisted.

Only one live editor tab should own this origin at a time. Do not clear browser
storage or run qualification drivers on this user exploration origin. Browser
boot and HMR/chat behavior received only the bounded parent observation above;
initial preparation did not automate a browser. Source-mode Studio/Python LSP
are not enabled or newly qualified.
The source panel is a small explicit-save host utility, not a Studio parity claim.

## Restart safely

From `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`:

```sh
bun examples/todo-app/tests/serve-single-kernel-live.ts
```

The server verifies frozen inputs, creates an exclusive ignored output directory,
builds only UI/adapter code, and picks a fresh loopback port. The printed JSON
contains its exact URL/PID/receipt, without credentials. Optional arguments are
the frozen full prepared input and a **new** output directory. There is no runtime
build, dependency installation, E2E driver, browser automation or model request in
this launch command. SIGTERM/SIGINT stop only this serving process; close the
browser workspace using Exit before deliberately stopping it. A fresh port means
a fresh browser origin, not restoration of the old origin's saved workspace.

## Latest independent full E2E result

Harness commit `17ef8e3` successfully ran a fresh full consumer cohort but its
aggregate status is **failed**, not passed. Retained definitive evidence:

`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-live-e35eab4-full-fresh-2026-09-30-independent-17ef8e3/definitive-summary.json`.

- All 19 application stages, five hydrated TODO/PDF generations, HMR, SSE abort,
  app shutdown, and reload/persistence checks completed.
- Focused HTTP cases 0 and 1 passed their runtime checks; only case 0 passed its
  post-close browser census. After case 1, a kernel target persisted beyond the
  15-second bound (34 nonzero observations, later read-only capture also nonzero).
- Cases 2–9 were not reached. Browser-target cleanup remains a reliability blocker.
- New failed-cohort sessions/servers were cleaned up after preserving evidence;
  cleanup is not orderly-close acceptance. Prior locks/receipts remain untouched.
- The earlier separately qualified remaining-only run still exists; it does not
  retroactively turn this fresh full run green. No comparison/performance conclusion
  follows from either result.

Preparation checks: strict TypeScript consumer check passed; HTTP 200 confirmed
for HTML, JS/CSS, prepared manifest, distribution, diagnostics configuration,
editing policy and TODO API. HTML/JS/CSS carry COOP/COEP isolation headers. No
runtime rebuild, inference call, canonical pin change or push. These preparation
checks precede the parent-operated browser follow-up recorded above.
