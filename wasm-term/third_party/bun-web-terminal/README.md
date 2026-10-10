# bun-web-terminal (three files)

`src/touch.ts`, `src/viewport.ts` and `src/scroll.ts` are copied unchanged from
`bun-web-terminal/src/` of the repository `random` (`git@github.com:kkrausse/random.git`),
a web terminal by the same author (Copyright (c) 2026 kkrausse; that package is private and
carries no licence file of its own). Nothing else of it is here: no server, no page, no tests.

`../../web/mobile.ts` imports them for the phone controls. `touch.ts` imports only the
`Terminal` type of `@random/ghostty-web`.

Commit and object ids: `../snapshot.lock`. Refresh: `../sync.sh`.
