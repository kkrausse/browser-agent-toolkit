# Browser Agent Toolkit (Rust rewrite branch)

- Read `docs/design/rust-rewrite.md` first; its "Working rules" section binds every agent.
  Then `docs/experiments/2026-10-10-rust-rewrite-summary.md`: what works, the measured
  numbers, and the ranked list of what is missing.
- Design changes go in `docs/design/decisions.md` (append-only); measurements and status
  reports go in `docs/experiments/`. The previous toolkit and its Vivari runtime are
  only in git history (up to `44dcd92`).
- One command builds and serves the example: `PORT=<port> bun run editor` (`bun run setup`
  is the build alone, incremental). Generated output is gitignored: `target/`, `target-*/`,
  `runtime/dist`, `packages/toolkit/dist`, `examples/todo-app/.editor`, `.runtime/`.
  Three Wasm files are committed on purpose: `runtime/src/sqlite/sqlite3.wasm`,
  `packages/guest-shims/esbuild/lib/bat_esbuild.wasm`,
  `packages/guest-shims/tailwindcss-oxide/tailwindcss-oxide.wasm`.
- After a change, verify with the real thing: `runtime/harness/check.sh` (12 guest scripts
  in Chrome; `BAT_HARNESS_PORT`, `BAT_HARNESS_SESSION`), `bench/startup/run.ts` for
  startup, and `examples/todo-app/demo/run.ts` for the README scenario (one paid model
  conversation per run; the key is in the gitignored `examples/todo-app/.env.local`).
- Toolkit API: `prepare` (with the optional `startupModules` and `startupOrder`
  recordings), `createEditorHandler`, `openEditor` / `preloadEditor` / `resetWorkspace`,
  the React components, the Vite plugin; the runtime contract is
  `packages/toolkit/src/runtime-host.ts`.
- Code taken from elsewhere keeps its notice in `third_party/NOTICES.md` or
  `packages/toolkit/NOTICES.md`.
- Commit only your own paths. Do not push.
- Browser automation uses the Bun-backed `browser-control` CLI.
