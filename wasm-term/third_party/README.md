# third_party

Code wasm-term uses that is developed elsewhere, copied in so the project builds from this
repository alone. Both packages are by the same author and live in the repository `random`
(`git@github.com:kkrausse/random.git`). Do not edit the copies here: change them in `random`
and refresh the snapshot.

| Here | From `random` | What | Used by |
| --- | --- | --- | --- |
| `ghostty-web/` | `ghostty-web/`, the whole package as committed (no `node_modules`, no `dist`) | the terminal: official Ghostty VT WebAssembly behind an xterm.js-style interface, WebGL2 and canvas renderers. Package name `@random/ghostty-web`, unchanged | `web/package.json` (`file:../third_party/ghostty-web`), so `web/client.ts`, `web/embed.ts`, `web/mobile.ts`, and `web/server.ts` for `ghostty-vt.wasm` |
| `bun-web-terminal/src/touch.ts`, `viewport.ts`, `scroll.ts` | the same three files of `bun-web-terminal/src/` | touch gestures, `visualViewport` fitting and wheel steps for a phone | `web/mobile.ts` |

## The snapshot

Taken from `random` at commit `fae38631b15ad4d979d859088f9ca2656e2b424f` (branch `wasm-term`,
2026-10-10), the commit wasm-term itself moved here from. That branch is `random`'s `main`
plus, for these paths, one commit: `75ed11e` "ghostty-web: literal Ctrl+V option, focus
reports, hover motion code, mouse-tracking read", which wasm-term needs (the same commit is
`random`'s branch `ghostty-web-fixes`). The three `bun-web-terminal` files are as on `main`.
`snapshot.lock` has the commit and the git object ids of what was taken; `ghostty-web/` here
has the same git tree id as `ghostty-web/` there.

To refresh it:

```sh
third_party/sync.sh <a checkout of random> [ref]   # default HEAD; rewrites snapshot.lock
git diff --stat                                    # review
cd web && bun install                              # bun copies file: dependencies into node_modules
```

then the checks in `../README.md`. The script takes files with `git archive`, so only what is
committed at that ref.

## Licences

- `ghostty-web/LICENSE`: MIT, Copyright (c) 2025 Coder, Copyright (c) 2026 kkrausse (its
  browser layer keeps MIT-licensed code from Coder's ghostty-web; `ghostty-web/README.md`).
- `ghostty-web/vendor/`: `ghostty-vt.wasm` and `headers/` are the unmodified upstream Ghostty
  release artifact and C headers, MIT, Copyright (c) 2024 Mitchell Hashimoto, Ghostty
  contributors (`ghostty-web/vendor/LICENSE`; `ghostty-web/vendor/README.md` pins the source
  revision and the sha256). The wasm is checked in on purpose.
- `bun-web-terminal/`: see `bun-web-terminal/README.md`.
