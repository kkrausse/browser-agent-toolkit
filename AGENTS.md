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
  in Chrome; `BAT_HARNESS_PORT`, `BAT_HARNESS_SESSION`), `bench/startup/run.ts` for
  startup, and `examples/todo-app/demo/run.ts` for the README scenario (one paid model
  conversation per run; the key is in the gitignored `examples/todo-app/.env.local`).
- Layout: `crates/`, `runtime/`, `packages/toolkit` are the toolkit; `packages/react`
  (`@kkrausse/browser-agent-toolkit-react`) is everything that imports React or a UI
  library, and the stylesheet. `react` imports `toolkit`, never the reverse:
  `packages/toolkit/src` has no React import. `packages/terminal`
  (the ghostty-web display, with its snapshot), `packages/relay` (the TCP relay of the
  tunnel) and `ports/opencode` (the OpenCode 2.0.26 terminal client as a Node program, and
  the 2.0.26 server bundle; its source checkouts are the gitignored `ports/opencode/vendor/`,
  see its README) serve `examples/terminal-app` (`bun run terminal`). That page takes the app it
  shows as a parameter (`BAT_APP`, `examples/terminal-app/app.ts`); `bun run fullstack` is it with
  `examples/start-app` (TanStack Start, an Effect RPC API, SQLite). wasm-term and the
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
