# Browser Agent Toolkit (Rust rewrite branch)

- Read `docs/design/rust-rewrite.md` first; its "Working rules" section binds every agent.
  Then `docs/experiments/2026-10-10-rust-rewrite-summary.md`: what works, the measured
  numbers, and the ranked list of what is missing.
- Design changes go in `docs/design/decisions.md` (append-only); measurements and status
  reports go in `docs/experiments/`. The previous toolkit and its Vivari runtime are
  only in git history (up to `44dcd92`).
- One command builds and serves the example: `PORT=<port> bun run editor` (`bun run setup`
  is the build alone, incremental). Generated output is gitignored: `target/`, `target-*/`,
  `runtime/dist`, `packages/toolkit/dist`, `packages/react/dist`, `examples/*/.editor`, `.runtime/`, `ports/opencode/dist`.
  Three Wasm files are committed on purpose: `runtime/src/sqlite/sqlite3.wasm`,
  `packages/guest-shims/esbuild/lib/bat_esbuild.wasm`,
  `packages/guest-shims/tailwindcss-oxide/tailwindcss-oxide.wasm`.
- After a change, verify with the real thing: `runtime/harness/check.sh` (12 guest scripts
  in Chrome; `BAT_HARNESS_PORT`, `BAT_HARNESS_SESSION`), `bun runtime/harness/persist-check.ts`
  after a change to persistence, the kernel's locks or its memory (a large overlay folded
  and restored, a write refused, the tab killed mid-snapshot, a trap under the lock; its
  own Chrome through Playwright, 2 minutes), `bench/startup/run.ts` for
  startup, and `examples/todo-app/demo/run.ts` for the README scenario (one paid model
  conversation per run; the key is in the gitignored `examples/todo-app/.env.local`).
- Layout: `crates/`, `runtime/`, `packages/toolkit` are the toolkit; `packages/react`
  (`@kkrausse/browser-agent-toolkit-react`) is everything that imports React or a UI
  library, and the stylesheet. `react` imports `toolkit`, never the reverse:
  `packages/toolkit/src` has no React import. `packages/terminal`
  (the ghostty-web display, with its snapshot), `packages/relay` (the TCP relay of the
  tunnel) and `ports/opencode` (the OpenCode 2.0.26 terminal client as a Node program, and
  the 2.0.26 server bundle; its source checkouts are the gitignored `ports/opencode/vendor/`,
  see its README) serve `examples/terminal-app` (`bun run terminal`). wasm-term and the
  Codex port are not in this tree: branch `wasm-term`.
- Toolkit API: `prepare` (with the optional `startupModules` and `startupOrder`
  recordings), `createEditorHandler`, `openEditor` / `preloadEditor` / `resetWorkspace`,
  the Vite plugin, and in the React package `useEditor`, `EditorPreview`, `ChatView`; the
  runtime contract is
  `packages/toolkit/src/runtime-host.ts`.
- Code taken from elsewhere keeps its notice in `third_party/NOTICES.md`,
  `packages/toolkit/NOTICES.md`, `packages/react/NOTICES.md` or `packages/terminal/README.md`.
- Commit only your own paths. Do not push.
- Browser automation uses the Bun-backed `browser-control` CLI.
- WebKit (branch `webkit-support`, `docs/experiments/2026-10-11-webkit.md`): `browser-control` is
  Chromium-only, so WebKit is driven with the `playwright` package (root dev dependency, 1.64.0 =
  WebKit build 2370). `BAT_HARNESS_BROWSER=webkit runtime/harness/check.sh` runs the same 12
  scripts there; `examples/todo-app/demo/webkit.ts` is the README scenario, free with the
  scripted model (`EDITOR_MODEL_BASE_URL`). It is the Linux WebKit port, not Safari.
  `examples/terminal-app/demo/run.ts --webkit` is the terminal example's scenario there.
  `runtime/harness/webkit/grow-crash/` crashes WebKit without the runtime (a shared-memory grow
  against worker teardown, report section 9.1): the reason the kernel heap grows in 64 MiB steps.
  `runtime/harness/webkit/preload-reuse/run.ts` shows WebKit running an earlier document's
  preloaded module without a request (report section 10): the reason the preview service worker
  sends `Vary: *`.
- `examples/todo-fullstack` is the React Router + tRPC TODO example that `examples/todo-app` was
  before it became a plain React app: kept as the full-stack test target, with the same
  `demo/run.ts` and `demo/webkit.ts`. The scripted model edits it when started with
  `MOCK_TODO=fullstack`. It has no root script: `bun run editor` in its directory, own `PORT`.
