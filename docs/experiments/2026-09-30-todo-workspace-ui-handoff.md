# TODO workspace UI implementation / activation handoff — 2026-09-30

## Chronology and scope

1. Read toolkit AGENTS and the actual IRS consumer (`irs-tools/src/editor/EditorPanel.tsx`,
   `sessionTransfer.ts`, `captureSourceZip.ts`) plus the older browser-editor integration.
   IRS composes preview and chat; native resumable sessions use the server export/import API.
2. Removed the live wrapper's **Source editor (explicit local save)** panel entirely.
   TODO now composes library `EditorPreview`, `useWorkspaceChat`, and `ChatView` with
   app-owned Workspace / Name / New workspace / Save workspace / Exit controls.
   Preview fills the left side; chat and controls fill a 420px right sidebar.
3. Added browser-local IndexedDB snapshots of source bytes and native session bundles.
   No filesystem snapshot/restore helper exists in this checkout's public workspace
   API; the app's bounded source walker uses library fs/lstat, and restoration uses
   library fs writes/flush. Runtime stop and durable clear use existing public APIs.
4. Switching validates incoming paths, file limits, native bundle structure, parent
   hierarchy, and selected session before touching the running workspace. It saves
   outgoing state and journals both images atomically, freezes local chat admission,
   awaits chat disposal, stops the owned runtime/services, clears, restores source,
   starts dependencies/preview/OpenCode, clears old native rows via server APIs,
   imports sessions parent-first with remapped IDs, then attaches/hydrates chat.
5. Interrupted replacement retains a durable pending image. Startup opens storage but
   refuses normal source seeding if that journal exists. UI offers **Retry interrupted
   switch** and **Recover outgoing workspace**; neither snapshots partial replacement
   over the outgoing saved image. Cleanup failure never advances to clear.
6. Integrated the independent model-styles fix by importing compiled public
   `opencode-chat/dist/editor.css` in the live bundler. No model API/controller/react
   library files, provider configuration, credentials, or runtime bytes were changed.
7. Built a new UI staging directory only. Did not automate any browser, activate the
   served assets, restart PID 88406, move ports, or modify qualification receipts.

## Verified here (not browser acceptance)

- 17 tests / 87 assertions pass across workspace switch, native session transfer,
  and existing TODO server procedures. They cover invalid incoming, busy admission,
  quota/save failure, failed shutdown/clear/start, durable recovery, hierarchy
  ordering, source additions, unsupported symlinks/secrets, API pagination, explicit
  old-row deletion, ID remapping, and post-import history reads.
- Focused strict live-consumer typecheck passes against frozen qualification
  workspace declarations and actual chat source. `noImplicitReturns` follows the
  library setting because existing library effects have conditional cleanup returns.
- UI staging build passes against all 9,587 verified qualification asset hashes.
  No runtime rebuild or server restart.
- Full example `bun run typecheck` / production package build are blocked by the
  pre-existing absence of generated workspace/chat peer packages (first error:
  `@kev-browser-agent-kit/workspace/vite`). The focused check/build do not claim
  to repair or replace that full package qualification.
- Native server A/B isolation and real pointer model selection are **not verified
  by this worker**. Parent exclusively owns the live browser acceptance below.

## Semantics and limits

- Initial activation adopts the existing durable working copy; never restores an
  old IndexedDB snapshot over the user's current source or native chats.
- Save captures agent-added source files, binary bytes, native session bundles, and
  selected conversation. Every switch saves outgoing changes first. Reload restores
  the active OPFS working copy and local catalog, without reseeding deleted source.
- New workspace starts from the same verified prepared TODO source with empty native
  chats. Native session IDs change on import, while logical workspace identity and
  resumable conversation content remain preserved. No inference call is required.
- This is origin-local storage, not IRS cloud archive/auth/fork policy. Clearing
  browser site data removes snapshots. TODO items remain shared in the existing
  host's in-memory map; they are not split by workspace or moved to IndexedDB.
- Managed dependencies, `.git`, generated build/type directories and OpenCode's
  directories are excluded from source images; native sessions are transferred
  separately. Source symlinks and `.env*` files refuse snapshot/switch explicitly
  before clear (secret contents are never read). Empty source directories, git
  metadata, runtime caches, unsent UI drafts and provider-wide UI preferences are
  not archived. No retained-runtime fast-switch optimization is claimed.

## Exact activation — parent only

Current live host: `http://127.0.0.1:54770/`, PID **88406**.

Live output:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-interactive-1790778679425`

Final UI staging:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/todo-workspace-ui-staging-20260930-final-v2`

1. Before reloading the old UI, preserve any unsaved raw textarea edits using its
   explicit save/flush; close its editor cleanly. Do not clear site storage or
   delete any existing workspace/source/chat/todos.
2. Back up live `single-kernel-live-client.js` and `.css` outside the served output.
   Copy only those two final staged files into that output (prefer temporary file
   then rename each). Keep `live-origin.json`, `server.js`, input, prepared and runtime
   artifacts untouched. Bun.file serves those assets per request, so **no restart
   is required** and TODO memory / origin stay unchanged.
3. Reload the same origin and choose Open editor. The existing working copy is
   adopted and initially snapshotted; it is not replaced by prepared source.
4. If a reload is needed after a failed/partial replacement, use the explicit recovery
   controls. Do not wipe OPFS to make the experiment pass.

Reproducible staging commands (new output directory required):

```sh
bun run --cwd opencode-chat build:styles
bun examples/todo-app/tests/stage-single-kernel-live.ts .diagnostics/single-kernel-e35eab4-full-attempt1 .diagnostics/NEW-UI-STAGING
bun examples/todo-app/tests/typecheck-live-workspaces.ts .diagnostics/single-kernel-e35eab4-full-attempt1 .diagnostics/NEW-UI-STAGING
bun run --cwd examples/todo-app test src/workspace-switch.test.ts src/workspace-sessions.test.ts src/server/trpcRouter.test.ts
```

## Parent's required browser acceptance

- Confirm no raw source panel, full-height preview left/chat right, usable Workspace,
  New workspace, Save workspace and library model/session selectors.
- Optional source fixture: load **the same origin** with `?workspaceFixture=1`, then
  Open editor. The opt-in `window.__todoWorkspaceFixture.readSource('/src/home.tsx')`
  and `.writeSource('/src/home.tsx', modifiedText)` operate only on safe source paths;
  writes reject concurrent workspace actions or non-idle chat and explicitly flush.
  This is an acceptance fixture, not a raw source-editor panel. Inspect source and
  change a visible heading to distinct A/B markers, preserving all other source.
- Name/save existing workspace A, create a native A chat via New chat (no prompt or
  model inference needed), then New workspace B. Confirm B starts from baseline and
  A sessions are absent. Modify B's visible heading via fixture/agent mechanism,
  create distinct B chat, and save.
- Switch A/B/A repeatedly: verify the actual preview headings and actual native
  session lists/conversations differ, not just dropdown/name text. Verify edited A
  returns unchanged and B has no A native session. Reload and repeat.
- Observe actions disabled during startup/chat loading. A malformed saved incoming
  snapshot or unsupported source symlink/environment fixture must fail honestly
  before replacement, retaining the active source/chat; unit-tested stop/clear/start
  failures must retain the journal and expose recovery, not fake readiness.
- Use an ordinary pointer click on the model selector and desired option; verify
  selected native session model persists after reconnect. Compiled CSS includes
  portal positioning/z-index utilities. No force-click or provider key change.
- Verify existing TODO items survived activation and remain shared after switches.

Only the parent may append actual browser results and claim live completion.
