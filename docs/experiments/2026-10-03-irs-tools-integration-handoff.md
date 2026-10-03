# IRS tools on the current toolkit: handoff (2026-10-03)

For the session that brings IRS tools up to the current browser editor. Everything it
needs is on `main` of this repository and of the runtime fork; nothing lives only in a
worktree or a chat.

## State

| Repo | Where | Commit |
| --- | --- | --- |
| Toolkit | `/home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit`, `main` | this handoff; 60+ commits ahead of GitHub, not pushed (owner's decision) |
| Runtime fork | GitHub `kkrausse/vivari` `main`, pushed | `6c1759a` |
| Runtime pin | `vivari/runtime-source.json` | `main` at `6c1759a` |
| IRS tools | `/home/kkrausse/devfs/repos/kkrausse/irs-tools`, `main` | `e70a608`, 26 ahead of GitHub, not pushed |

- Every toolkit branch is contained in `main` except `compare/baseline-matched`, the
  deliberate comparison branch on the pre-consolidation runtime.
- The live demo (https://diesel2.guineafowl-truck.ts.net:10000/, proxying
  `127.0.0.1:3000`) runs in tmux session `todo-editor` from the worktree
  `/home/kkrausse/devfs/repos/kkrausse/bat-startup-combined`, same code as `main`. Do
  not restart or rebuild it without the owner knowing; use another port (`PORT=3100`).
- Worktrees `bat-startup-measure` and `bat-startup-fixes` hold nothing that is not on
  `main`; their evidence was copied to the main checkout's `.diagnostics/`.

## Read first

| Document (`docs/experiments/`) | For |
| --- | --- |
| `2026-10-03-startup-performance.md` | Today's startup work in one place: results, each fix and its off-switch, what is left, where the evidence is |
| `2026-10-02-diesel2-migration-handoff.md` | Machine setup (Xvfb, Chrome, browser-control), the IRS tools checkout, secrets, Clerk |
| `2026-10-01-single-kernel-adoption-handoff.md` | Why the consolidated single-kernel runtime is the line; build and run |
| `2026-10-01-retained-opencode-switch.md` | The switch that keeps OpenCode running: eligibility, steps, fallbacks |
| `2026-10-01-runtime-sqlite-and-module-load-fixes.md` | The SQLite persistence and module-load fixes |
| `../RELEASING.md` | The three packages and how tarballs are staged (`scripts/release.ts`) |

In IRS tools: `docs/browser-editor-handoff.md`, `docs/browser-editor-startup-handoff-2026-09-18.md`,
`docs/browser-editor-isolation-plan.md`, `docs/editor-snapshot-restore-plan.md`,
`docs/editor-workspace-switch-profile-2026-09-24.md`.

## Where IRS tools is

- `package.json` pins three vendored tarballs in `vendor/toolkit/`:
  `@kev-browser-agent-kit/opencode-chat` and `@kev-browser-agent-kit/workspace` built from
  toolkit commit `971ff97` (2026-09-29, 314 commits behind `main`), and
  `@kkrausse/browser-agent-runtime` `0.1.0-alpha.1-4f00341`.
- That runtime predates the single-kernel adoption, the 10-01 SQLite and module-load
  fixes and everything in `2026-10-03-startup-performance.md`.
- Its editor code is its own, about 4,900 lines with tests: `src/editor/startEditor.ts`
  (source install, Vite and OpenCode launch, session import), `src/editor/EditorPanel.tsx`,
  `src/editor/SavedWorkspacesDialog.tsx`, the save/restore flows, and server-side saved
  workspaces in `src/server/editorWorkspaces.ts`. `scripts/prepareEditor.ts` prepares.
- Imports it uses, all still exported under the same names on toolkit `main` (checked by
  name only, not by signature): `createBrowserEditorHandler`, `browserEditorHeaders`,
  `runEditorLogs`, `createFileDiagnosticSink`, `readEditorDiagnostics`,
  `readRuntimeAssets`, `readRuntimeBackendPolicy`, `installSource`,
  `installOpenCodeConfig`, `startOpenCode`, `diagnoseWorkspace`, `clearWorkspace`,
  `browserPreviewBase`, `browserEditorBoundary`, `attachChat`, `EditorPreview`,
  `PreparedBrowserWorkspace`, `useWorkspaceChat`, `useWorkspace`, `createDiagnosticScope`,
  `ChatView`.
- Two unmerged branches: `feat/browser-workspace-editor` (11 ahead of `main`, 143 behind;
  its last commit preserves an abandoned experiment) and
  `feat/browser-editor-library-integration` (2 ahead; a draft of a library-owned editor
  API with an IRS-local mock). Read the draft for the owner's earlier thinking; do the
  upgrade on a new branch from `main`.

## The work, in two parts

### 1. Swap in the current libraries

Build tarballs from toolkit `main`, replace the three in `vendor/toolkit/`, fix what the
typecheck and the tests show, open the editor.

Comes with the libraries, no IRS code needed: the single-kernel runtime; SQLite
persistence only when the database changed; the module plan cache; module resolution
remembered per process; the watch-after-timers event loop fix; the OPFS restore fix;
per-file delivery verification skipped after the image digest passed; delivered trees
out of the OPFS mirror; an editor chat with no session opening on a new one
(`attachChat` now sets `autoCreateSession`).

Unknown, find out first:

- **Packaging.** `bun scripts/release.ts <version> [--check-pack]` stages the three
  packages under `.release/`. It has not been run since the single-kernel runtime became
  the default; `RELEASING.md` describes a known contract failure at the time. The
  existing IRS tarballs carry a commit suffix in the file name, added by hand or by an
  earlier procedure.
- **Signatures.** Names match; `workspace-api/src/react.tsx` grew by about 440 lines
  since `971ff97`, `opencode-launch.ts` by about 100, `delivery.ts` by about 60.
- **Live check.** Clerk dev accepts only localhost origins: use Chrome on Xvfb on
  diesel2, or tunnel from another machine
  (`ssh -N -L 5173:localhost:5173 -L 3001:localhost:3001 diesel2`). Sign-in on diesel2
  has not been tried. `bun dev` serves the API on :3001 and Vite on :5173.

### 2. What lives in the TODO example, not in the libraries

These are in `examples/todo-app/src/` and do not arrive with a tarball:

| Behaviour | TODO example | IRS tools today |
| --- | --- | --- |
| Keep OpenCode running across a workspace switch | `workspace-switch.ts` (orchestration, eligibility), `workspace-editor.tsx` (`retainedBlocker`, `resume`), library pieces `clearWorkspaceSource` and `detachChat` | full stop / clear / restart |
| Start order | `start-editor.ts`: OpenCode starts when the preview listens ("overlap"); `?startup=serial\|parallel` | Vite and OpenCode fully parallel (`Promise.allSettled`), the order that once left Vite silent on the Mac |
| Optimizer runs once | `vite.config.ts` sets `optimizeDeps.include` when `BROWSER_AGENT_GUEST=1` | not checked; IRS has its own dependency list |
| Exit without a full save | `workspace-editor.tsx` `saveForExit` | own save flow |
| Stage timings | `editor-timings.ts`, `window.__editorTimings`, Debug · Timings | diagnostics stream only |

## Direction the owner gave (2026-10-03)

Not decisions on an API; the wishes a design has to meet.

- **Starting should be fast enough that keeping things running matters less.** After
  today a reopen on diesel2 is 7.2 s and a retained switch 4.9 s, so keeping OpenCode
  warm now buys little over reopening. What a retained switch still pays is the Vite
  restart (about 3.9 s spawn → app ready, as measured on a reopen) and the session
  delete and re-import.
- **OpenCode is tooling, the preview is the application; they should have separate
  life cycles.** OpenCode should be the one current version whatever workspace is open.
  A workspace's dependencies are a preview-side matter. Today a dependency mismatch
  restarts OpenCode only because managed delivery lays down all its roots as one unit.
- **A per-process setting for whether a workspace change requires a restart**, for
  OpenCode and for Vite, rather than one hard-coded path. Keeping Vite up across a
  switch (replace the source under it) is the largest remaining saving.
- **Workspace switching and its infrastructure could move into the library, and some
  UI with it, but it must stay flexible.** IRS tools keeps saved workspaces on its
  server and has its own panel; the TODO example keeps them in IndexedDB. A library
  version has to take storage, capture and UI from the app.
- An agent installing a dependency inside a workspace is the one real case where
  `node_modules` differs between workspaces. It still forces a full switch, and the
  installed package does not survive a switch, because saved workspaces do not include
  `node_modules`.

## Suggested order

1. Part 1 as a spike on a new IRS branch: it shows whether packaging works and what
   breaks, and brings most of the speed-up.
2. Measure IRS open, reopen and switch the way `2026-10-03-startup-performance.md` does
   (`window.__editorTimings` is in the libraries' controller; IRS has its own
   diagnostics stream and `bun editor:logs`).
3. Then decide what of part 2 moves into the library before IRS adopts it.

## Things that cost time today

- The TODO example consumes built copies of the packages. After editing `opencode-chat`
  or `workspace-api`, run `bun run build:example` at the toolkit root; `bun run build`
  alone leaves the example on the old copy.
- `bun run setup` never moves an existing `vendor/vivari` checkout. After the pin
  changes, check the pinned commit out there yourself, then run setup; the built
  runtime's revision is in `vivari/.runtime/patched-build.json`. The main checkout was
  brought to `6c1759a` this way on 2026-10-03.
- The runtime runs in the visiting browser. Timings in a server's event log from a
  remote device are that device's, not diesel2's.
- Two tabs cannot both be visible and focused in the one Chrome on Xvfb; hidden tabs are
  throttled. Measure with one browser user at a time.
- `?viteTrace=fs` replaces `fs` functions and so disables the resolution memory in the
  traced process.
- diesel2's HTTPS remote for the fork cannot push; use
  `git@github.com:kkrausse/vivari.git`. Never push to the upstream.
- Known test state: three toolkit test failures that are portability bugs, 23 typecheck
  errors under `experiments/` and test drivers; IRS tools `bun test` 114 pass, 5 fail
  (`makeEncryptedStorage`, same on the Mac).
