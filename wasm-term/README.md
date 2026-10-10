# wasm-term

Run real terminal programs (TUI clients) entirely in the browser: no server-side
PTY. The display is the sibling [`ghostty-web`](../ghostty-web/README.md)
package (official Ghostty WASM + WebGL2). The program runs in a Web Worker
against an emulated "local machine": a PTY with a line discipline, a
filesystem, clocks, env, and network access bridged to browser APIs.

Targets, in order:

1. **Local terminal functions** - the emulated machine itself, proven with
   small real programs (cooked-mode line editing, raw-mode ratatui app, resize,
   colours, mouse, paste, alternate screen).
2. **opencode TUI client** in the browser, connected to a remote
   `opencode serve` (`opencode --server <url>` natively).
3. **codex TUI** in the browser, connected to `codex app-server --listen ws://…`
   (`codex --remote <addr>` natively).

Testing never calls a real model: `mock-llm/` serves scripted responses.

## Shape

```
 browser main thread                 Worker (one per program)
 ┌──────────────────────┐           ┌─────────────────────────────────┐
 │ ghostty-web Terminal │  bytes    │ kernel                          │
 │  onData ─────────────┼──────────▶│  pty master ⇄ line discipline   │
 │  write  ◀────────────┼───────────│            ⇄ pty slave (fd 0/1/2)│
 │  onResize ───────────┼──────────▶│  winsize + SIGWINCH             │
 └──────────────────────┘           │  vfs, clocks, env, random       │
                                    │  net: fetch / WebSocket / SSE   │
                                    │ ─────────────────────────────── │
                                    │ guest: wasm32-wasip1 module     │
                                    │   or JS program on node/bun shim│
                                    └─────────────────────────────────┘
```

- **Guest ABI**: WASI preview1 for everything it covers (fd_read/fd_write,
  poll_oneoff, clocks, random, args/env, path_* on the vfs), plus one small
  custom import module for what WASI lacks: termios get/set, window size,
  signal delivery (SIGWINCH/SIGINT), and outbound network. The exact ABI is
  documented in `docs/abi.md` and is the contract between host and guests.
- **Blocking syscalls**: the guest blocks in the Worker with
  `SharedArrayBuffer` + `Atomics.wait`; the page is served cross-origin
  isolated (COOP/COEP). This works in Safari/iOS, unlike JSPI.
- **Rust where it earns it**: the PTY/line discipline (termios semantics) is a
  Rust crate compiled to wasm so it can be unit-tested against real termios
  behaviour; glue that only calls browser APIs stays TypeScript.
- JS-side stack: bun + TypeScript, functions and interfaces, no classes unless
  they fit.

## Layout

| Path | What |
| --- | --- |
| `kernel/` | Rust crate(s): pty + line discipline, compiled to wasm |
| `host/` | TypeScript: worker runtime, WASI + custom imports, vfs, net bridge, persistence; `host/node/` runs JavaScript programs on the same machine (node-style `process`, `fs`, ...) |
| `web/` | Bun dev server (COOP/COEP), the launcher and the page wiring ghostty-web to a program; `web/verify/` browser checks |
| `guests/` | Test programs built for the guest ABI |
| `mock-llm/` | Scripted model server + isolated opencode/codex server configs |
| `ports/opencode/`, `ports/codex/` | Per-client port work and notes |
| `vendor/` | Upstream checkouts and toolchains, gitignored |

## Ports

| Port | Use |
| --- | --- |
| 4790 | `web/` dev server |
| 4791 | mock model server (container) |
| 4792 | `opencode serve` (container) |
| 4793 | `codex app-server` (container) |
| 4796 | browser-facing codex proxy (container); strips `Origin`, which `codex app-server` rejects |
| 4799 | per-port dev server in `ports/codex` (opencode is served by `web/` on 4790) |

## Run it

Needs bun, cargo with the `wasm32-unknown-unknown` and `wasm32-wasip1`
targets, and network access once (to clone the crossterm fork).

```sh
cd wasm-term/kernel && cargo test          # line discipline against termios behaviour
cd ../web && bun install
bun run build                               # kernel wasm + guests -> guests/dist/*.wasm
bun run dev                                 # http://127.0.0.1:4790/
```

`http://127.0.0.1:4790/` is a launcher listing every guest; `/?guest=<name>`
runs one directly.

| Guest | What |
| --- | --- |
| `repl` | cooked mode, the line discipline, a raw-mode key dump |
| `tui` | ratatui on crossterm, raw mode, mouse |
| `async-tui` | tokio + crossterm `EventStream` + WebSocket |
| `net`, `events` | network descriptors; raw event dump |
| `js-demo` | a JavaScript program on the node-style shim (`host/node/demo-guest.ts`) |
| `opencode` | the real opencode 2.0.26 TUI, attached to a remote `opencode serve` |

Page parameters: `&arg=...`, `&env=K=V` (`&env=WASM_TERM_TRACE=1` logs
syscall rates to the console), `&persist=0` (no saved files), `&reset=1`
(forget the guest's saved files first). Each guest's home directory is kept in
IndexedDB across reloads; opencode keeps its config and state directories.

### opencode in the browser

```sh
# once: checkouts, toolchain and dependencies under wasm-term/vendor (see ports/opencode/NOTES.md)
cd wasm-term/ports/opencode
bun run build:native                        # dist/opentui.wasm, OpenTUI's Zig core (about 2.5 minutes)
bun run build:tui                           # dist/site/: the TUI bundle, tree-sitter worker and grammars (3 s)

cd ../.. && mock-llm/up.sh                  # token-free backend in Docker: opencode serve on :4792
cd web && bun run dev
```

Open <http://127.0.0.1:4790/?guest=opencode>, or the launcher to change the
settings. The parameters and their defaults (the mock backend):

| Parameter | Default | |
| --- | --- | --- |
| `server` | `http://127.0.0.1:4792` | an `opencode serve` the browser can reach; origins other than `localhost`/`127.0.0.1` need `opencode serve --cors <page origin>` |
| `password` | `wasm-term-mock` | the server's `OPENCODE_SERVER_PASSWORD` (user `opencode`) |
| `dir` | `/tmp/wasm-term-workspace` | project directory, a path on the server; empty = where the server runs |

`mock-llm/down.sh` stops the backend. Prompts that select scripted replies
(`please use a tool`, `show me markdown`, `long scroll`, ...) are listed in
`mock-llm/README.md`.

### Checks

`web/verify/run.sh [terminal-functions|opencode|opencode-perf]` drives the
page in Chrome through `browser-control` (dev server up; the opencode ones
also need `mock-llm/up.sh`). `terminal-functions` checks each terminal
function with the Rust guests and the JavaScript shim with `js-demo`;
`opencode` runs the TUI through connect, prompts, the permission dialog,
markdown, scrolling, palette, sessions, clipboard, reload and exit, comparing
screens with the native client's captures; `opencode-perf` prints load and
input-latency numbers. Screenshots land in `docs/screenshots/`.

The guest ABI, the page-side API and the JavaScript shim are `docs/abi.md`.
How crossterm/ratatui/tokio run on it, and what the codex port should reuse,
is `guests/README.md`.

## Rules for working here

- Never touch the user's real opencode/codex state or background service, and
  never run the host's opencode/codex as a server. The servers run in Docker
  with their own pinned installs: `mock-llm/up.sh` / `mock-llm/down.sh` (see
  `mock-llm/README.md`). The project directory clients must send is
  `/tmp/wasm-term-workspace`. Host binaries are only used as native clients
  for baseline comparison, with isolated homes under `wasm-term/.state/`.
- Never call a real model provider. No real API keys in configs.
- Toolchains that are not installed (zig, wasi-sdk, …) go under
  `wasm-term/vendor/tools/`, not system-wide.
- Commit only your own paths (`git add wasm-term/<your-dir>`); several agents
  share this worktree. Branch `wasm-term`; never `main`.
