# Terminal display

A terminal for a page, and nothing behind it: `display.ts` mounts a
[ghostty-web](ghostty-web/README.md) terminal that fills an element and follows its size. It
takes bytes to draw and reports what was typed and how many cells fit. Paste is input (ctrl+v
with `ctrlVPaste`, ctrl+shift+v, cmd+v, the browser's paste event); a program's copy (OSC 52,
`osc52.ts`) becomes a clipboard write. It knows nothing of the toolkit runtime: the terminal
example joins it to a pty of the runtime's kernel (`examples/terminal-app/src/main.ts`).

```ts
const display = await mountDisplay({
  container, wasmUrl: "ghostty-vt.wasm",        // ghostty-web/vendor/ghostty-vt.wasm, served by the page
  onInput: data => program.write(data),
  onResize: size => program.resize(size),
})
program.onOutput = bytes => display.write(bytes)
```

A page takes it as one bundled module, not by importing the source: ghostty-web's sources do
not pass stricter TypeScript settings than this package's. `examples/terminal-app/display.ts`
does that (`Bun.build` of `display.ts`, plus a copy of `ghostty-vt.wasm`). `tsc --noEmit` here
is the check; nothing is installed for the snapshot (it has no runtime dependencies, and
`display.ts` imports `./ghostty-web/src/index.ts` directly).

Came from wasm-term (`wasm-term/web/display.ts`, `osc52.ts` and `wasm-term/third_party/`),
which is now only on the branch `wasm-term`.

## The ghostty-web snapshot

`ghostty-web/` is developed elsewhere and copied in so this repository builds alone: the
package `ghostty-web/` of the repository `random` (`git@github.com:kkrausse/random.git`, same
author), whole as committed (no `node_modules`, no `dist`): official Ghostty VT WebAssembly
behind an xterm.js-style interface, WebGL2 and canvas renderers. Do not edit the copy here:
change it in `random` and refresh the snapshot.

Taken from `random` at commit `fae38631b15ad4d979d859088f9ca2656e2b424f` (branch `wasm-term`,
2026-10-10). That branch is `random`'s `main` as of `851e4e2` plus, for this path, one commit:
`75ed11e` "ghostty-web: literal Ctrl+V option, focus reports, hover motion code,
mouse-tracking read", which the display needs (`ctrlVPaste`). `snapshot.lock` has the commit
and the git tree id of what was taken; `ghostty-web/` here has the same git tree id as
`ghostty-web/` there.

`random`'s branch `ghostty-web-fixes` carries that commit on a newer `main` (`8dbc0e0` on
`20cf565`). It is not what this snapshot is: `main` has since changed `ghostty-web` (scrollback
bounded by lines, not bytes). Refreshing from that branch, or from `main` once it is merged,
brings that in; run the checks afterwards.

To refresh it:

```sh
packages/terminal/sync.sh <a checkout of random> [ref]   # default HEAD; rewrites snapshot.lock
git diff --stat                                          # review
bun run --cwd packages/terminal typecheck
```

then build and open the terminal example. The script takes files with `git archive`, so only
what is committed at that ref.

## Licences

- `ghostty-web/LICENSE`: MIT, Copyright (c) 2025 Coder, Copyright (c) 2026 kkrausse (its
  browser layer keeps MIT-licensed code from Coder's ghostty-web; `ghostty-web/README.md`).
- `ghostty-web/vendor/`: `ghostty-vt.wasm` and `headers/` are the unmodified upstream Ghostty
  release artifact and C headers, MIT, Copyright (c) 2024 Mitchell Hashimoto, Ghostty
  contributors (`ghostty-web/vendor/LICENSE`; `ghostty-web/vendor/README.md` pins the source
  revision and the sha256). The wasm is checked in on purpose.
