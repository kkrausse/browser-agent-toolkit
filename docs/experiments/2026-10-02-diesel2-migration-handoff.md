# Move to diesel2: handoff (2026-10-02)

Work on the toolkit and the runtime fork moves from the Mac to `diesel2`
(Ubuntu 26.04.1, x86_64, headless). This checkout,
`/home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit`, is now the working copy.

## State

| Repo | Where | Commit |
| --- | --- | --- |
| Runtime | GitHub `kkrausse/vivari` `main`, pushed | `f9893bd` |
| Runtime | `vendor/vivari` here, cloned by setup | `f9893bd` |
| Toolkit | this checkout, `main` | `5d2fb22` plus this handoff |
| Toolkit | Mac `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit`, `main` | `5d2fb22` |
| Toolkit | GitHub `origin/main` | 33 commits behind `5d2fb22`, not pushed |

- Both `main` branches were fast-forwarded on 2026-10-02. The pin
  (`vivari/runtime-source.json`) names `main` at `f9893bd`.
- Every toolkit branch is contained in `main` except `compare/baseline-matched`,
  the deliberate comparison branch on the pre-consolidation runtime.
- The consolidated single-kernel runtime is the adopted line
  (`2026-10-01-single-kernel-adoption-handoff.md`); the SQLite-persistence and
  bundle-load fixes (`2026-10-01-runtime-sqlite-and-module-load-fixes.md`) are on it.
- diesel2 has a GitHub SSH key (added later on 2026-10-02): toolkit `origin` fetches
  and can push over SSH. The fork clones over public HTTPS, and `vendor/vivari` here
  has its push URL set to SSH. The `gh` CLI itself is not logged in.

## Machine setup

Bun 1.4.0, Node 24.18.0 (nvm), Rust 1.93.0 and 1.95.0 with the Wasm targets,
wasm-pack 0.13.1, Chrome 154, Xvfb, browser-control 0.8.2, Claude Code 2.1.287.
PATH and `BUN_INSTALL_CACHE_DIR` are set in `~/.zshenv`, so non-interactive shells
get them. Cargo and rustup caches are symlinked into `~/devfs/.cache/`.

Chrome runs headed on a virtual display, with the browser-control extension loaded
into the profile `~/devfs/browser/chrome-profile`. Neither survives a reboot:

```sh
tmux new-session -d -s xvfb 'Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -ac'
tmux new-session -d -s chrome "DISPLAY=:99 google-chrome --user-data-dir=$HOME/devfs/browser/chrome-profile --no-first-run --no-default-browser-check --password-store=basic --window-position=0,0 --window-size=1920,1080 about:blank"
browser-control status      # expect "Extension: connected"
tmux new-session -d -s todo-editor -c ~/devfs/repos/kkrausse/browser-agent-toolkit/examples/todo-app 'bun run editor:debug'
```

Helper scripts are in `~/devfs/browser/scripts/` (`open.js`, `exit-reload.js`,
`chat.js`, `extract.py`, `shot.sh <out.png>`). Chrome 154 ignores
`--load-extension`; the extension was loaded once through `chrome://extensions`.

## First results on Linux

`bun run setup` 3:10, `bun run build` 5 s, both exit 0.

| Suite | diesel2 | Mac |
| --- | --- | --- |
| workspace-api | 96 pass | not re-run |
| vivari | 4 pass | not re-run |
| opencode-chat | 155 pass, 2 skip, 2 fail, 1 error | not re-run |
| examples/todo-app | 187 pass, 16 skip, 1 fail | 186 pass, 1 fail |

Failures here:

- `examples/todo-app/tests/matched-switch-strategy.test.ts:217` assumes `readdirSync`
  returns sorted names; XFS returns `renamed.ts` before `main.ts`.
- `opencode-chat/test-ui/readiness-lab-bundle.test.ts:7` hard-codes a macOS temp path
  (`/private/var/folders/...`), ENOENT on Linux.
- `opencode-chat/test/opencode-launch.test.ts` cannot resolve
  `@opencode/schema/config/provider`. The Mac checkout has the same layout, so this
  is probably not Linux-specific; not confirmed.
- `tests/reuse-pilot-contract.test.ts`, the known Mac failure, passes here.
- `bun run typecheck` exits 2 with 23 errors under `examples/todo-app/experiments/`
  and `tests/single-kernel-driver.ts`, as on the Mac.

Native Wasm: the codec, crypto and vfs outputs hash differently from macOS arm64
(likely embedded absolute cargo paths; a wasm-opt difference is not ruled out). The
WASI demo is identical. No receipt or packaging check failed.

Live, headed Chrome on Xvfb, tab visible and focused, kernel not
service-worker-controlled:

| | diesel2 | Mac median |
| --- | --- | --- |
| OpenCode start, fresh | 3.2 s (1 sample) | 2.2 s |
| OpenCode start, reopen | 3.0 s (2.98, 2.96, 3.00) | 1.5 s |
| One-word chat reply | 2.3 s | not comparable |

The Linux samples used `http://127.0.0.1:3000/` without `?opencodeTrace=1` or
`?workspaceFixture=1`; the Mac runs used `localhost:3100` with both. Treat the Linux
numbers as a first baseline for this machine, not a like-for-like comparison.
Evidence: `.diagnostics/linux-baseline-2026-10-02/`. Mac evidence was copied to
`.diagnostics/` and `.diagnostics/from-mac-todo-editor-diagnostics*/`.

## Next

1. Service-worker-controlled kernels: still about five times slower (7.5 s reopen on
   the Mac). Not yet measured on Linux.
2. Keep Vite running across a workspace switch (4.3 s of a 4.8 s retained switch).
3. Integrate the editor into IRS tools, the remaining goal of the adoption handoff.
   irs-tools is on diesel2 too; see "IRS tools" below.
4. Housekeeping: the three test failures above are portability bugs in the tests.

## Needs the owner

- A decision on pushing toolkit `main` to GitHub.
- Whether Xvfb and Chrome should start at boot.

## Audit of what moved (later on 2026-10-02)

Every toolkit branch on the Mac is in `main` except `compare/baseline-matched`. The Mac
worktrees for the other branches (`bat-sk-track*`, `browser-agent-toolkit-single-kernel`,
`browser-agent-toolkit-upstream`, `.claude/worktrees/todo-editor-diagnostics`, and the
removed temp worktree for `perf/managed-vfs-image`) hold no unique commits.

Anything a clone would not carry is in `~/devfs/repos/kkrausse/from-mac/`. Its `README.md`
indexes it. It contains:

- Uncommitted work from the Mac single-kernel worktree: edits to
  `kernel-effect-migration-plan.md`, `2026-09-30-endpoint-owner-browser-qa-preparation.md`,
  and two `effect-remaining-loader-*` fixtures. It also has a patch,
  `single-kernel-uncommitted.diff`.
- `.diagnostics/` from `browser-agent-toolkit-single-kernel` (4.1 GB) and `bat-sk-track`
  (98 MB, the sk-live runs 1 to 4 and `compare-2026-10-01`). Older handoffs cite these
  paths relative to those worktrees.
- Untracked docs from the runtime fork:
  `vivari-upstream-rebase/{INTEGRATION-HANDOFF,UPSTREAM-REBASE,handoff,plan}.md` and
  `vivari-reset-diagnostic/scripts/probe-kernel-fs-stale-wake.mjs`.
- Git bundles of all local branches. The runtime bundle has `browser-runtime`
  (13 commits from 2026-09-15 that are not on GitHub). It is probably superseded by the
  consolidated `main`; this was not checked.

Not copied:

- `browser-agent-toolkit-upstream/.release/` (201 MB of 0.1.0-alpha.1 release output).
- The `pkg-node` build output in the Mac runtime worktrees.

The main checkout's ignored files did move: `.diagnostics/`, the
`docs/runtime-architecture.*` diagram sources and renders, and `examples/todo-app/.env.local`.

Known Mac-only paths: eight scripts under `examples/todo-app/experiments/` hard-code
`/Users/kkrausse/...`. They are one-off experiment drivers; fix the path before rerunning one.

## IRS tools

- Checkout: `~/devfs/repos/kkrausse/irs-tools`. `main` is 26 ahead of GitHub and not pushed.
- Worktrees:
  - `../irs-tools-browser-editor` (`feat/browser-workspace-editor`, 11 ahead of main)
  - `../irs-tools-editor-draft` (`feat/browser-editor-library-integration`, 2 ahead)
- It consumes this toolkit as tarballs in `vendor/toolkit/*.tgz`, not through a path link.
- Status: `bun install` and `typecheck` pass. `bun test` has 114 pass and 5 fail; the same
  5 `makeEncryptedStorage` tests fail on the Mac.
- Secrets: `conf.dev.yaml` is encrypted with SOPS. diesel2 decrypts it with the age key
  `~/.config/sops/age/keys.txt`. `.env.local` was copied over. Prod (KMS) secrets stay off
  this machine.
- `bun dev` starts the API on :3001 and Vite on :5173.
- Clerk dev only accepts localhost origins. Use Chrome on Xvfb here, or tunnel from the Mac
  with `ssh -N -L 5173:localhost:5173 -L 3001:localhost:3001 diesel2`. The sign-in flow
  through the tunnel has not been tested yet.
- IRS handoffs: `docs/browser-editor-handoff.md`, `docs/browser-editor-startup-handoff-2026-09-18.md`,
  `docs/browser-editor-isolation-plan.md`, `docs/editor-snapshot-restore-plan.md`.
