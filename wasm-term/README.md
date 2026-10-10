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
| `codex` | the real codex-cli 0.162.0 TUI (Rust, `wasm32-wasip1`), attached to a remote `codex app-server` |

Page parameters: `&arg=...`, `&env=K=V` (`&env=WASM_TERM_TRACE=1` logs
syscall rates, and stretches in which the program computed without reading
input, to the console), `&persist=0` (no saved files), `&reset=1` (forget the
guest's saved files first), `&renderer=canvas|webgl` (the terminal renderer;
by default WebGL, or the 2D canvas when the browser only emulates WebGL in
software). Each guest's home directory is kept in IndexedDB across reloads;
opencode keeps its config and state directories, codex its `CODEX_HOME`.

In the page's console, `await wasmTerm.readFile(path)`, `wasmTerm.listFiles(dir)`
and `wasmTerm.download(path)` read files out of the program's filesystem (its
log, the configuration it wrote), also after it has exited.

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
| `server` | `/proxy/opencode` | a path means this page's own origin: the dev server's reverse proxy (below). Or the URL of an `opencode serve` the browser can reach directly, e.g. `&server=http://127.0.0.1:4792`; origins other than `localhost`/`127.0.0.1` then need `opencode serve --cors <page origin>`, and an https page cannot call an http server |
| `password` | `wasm-term-mock` | the server's `OPENCODE_SERVER_PASSWORD` (user `opencode`) |
| `dir` | `/tmp/wasm-term-workspace` | project directory, a path on the server; empty = where the server runs |

The dev server is also a reverse proxy to the backends, so the page reaches
them same-origin: no CORS setup, no mixed content, one port to expose.

| Path on :4790 | Goes to | |
| --- | --- | --- |
| `/proxy/opencode/...` | `OPENCODE_UPSTREAM`, default `http://127.0.0.1:4792` | streamed as it arrives (the `/api/event` stream), no idle timeout; method, query (`?auth_token=` too), body and `Authorization` unchanged; `Origin` dropped going up, the Basic challenge header dropped coming down |
| `/proxy/codex` | `CODEX_UPSTREAM`, default `ws://127.0.0.1:4796` | WebSocket relay, text and binary frames, subprotocols passed on |

`mock-llm/down.sh` stops the backend. Prompts that select scripted replies
(`please use a tool`, `show me markdown`, `long scroll`, ...) are listed in
`mock-llm/README.md`.

### codex in the browser

```sh
# once: checkouts, patches and the C toolchain under wasm-term/vendor (see ports/codex/NOTES.md, section 7)
cd wasm-term/ports/codex
scripts/setup.sh
scripts/ship.sh                             # builds and packages dist/site/: the module to serve and a build with names

cd ../.. && mock-llm/up.sh                  # token-free backend in Docker: codex app-server on :4793, its browser proxy on :4796
cd web && bun run dev
```

Open <http://127.0.0.1:4790/?guest=codex>, or the launcher to change the
settings. The parameters and their defaults (the mock backend):

| Parameter | Default | |
| --- | --- | --- |
| `remote` | `/proxy/codex` | a path means this page's own origin: the dev server's WebSocket relay (below), as `ws://` or `wss://` to match the page. Or `ws://HOST:PORT[/path]` of a proxy in front of `codex app-server --listen` that the browser can reach. Never the app-server itself: it refuses every request that carries an `Origin` header, and it cannot be given the bearer token a browser cannot send |
| `dir` | `/tmp/wasm-term-workspace` | project directory, a path on the server: the TUI reports it as its working directory, as the native client does with its own |
| `sandbox` | `danger-full-access` | passed as `-c sandbox_mode="..."`. The mock backend's container cannot run codex's sandbox, so anything else fails there, except that `workspace-write` with the prompt `run with approval` shows the approval dialog. Empty = the server's own setting |
| `build` | (the shipped module) | `names`: the build that kept its name section, for `web/verify/profile.ts` and readable traps |

The module is 11.4 MB over the wire (brotli) and 38.7 MB to compile
(`ports/codex/NOTES.md`, "Module", has the table); the page shows a progress bar while it arrives and compiles, and the
browser caches it for good: its URL contains its hash, so a rebuild is a new
URL. `scripts/ship.sh` is `build.sh` for the two profiles plus `wasm-opt` and
`package.ts`; the server reads `dist/site/manifest.json` on every load, so a
rebuilt module is picked up without a restart.

### From other devices: tailnet HTTPS

The page needs cross-origin isolation, which needs a secure context, so from
another machine it has to be https. `web/serve-up.sh` sets that up on a
machine with Tailscale and leaves it running:

```sh
web/serve-up.sh                  # backend + dev server + one tailscale serve entry; prints the URL
web/serve-down.sh                # takes all three down again
web/serve-down.sh --keep-backend # ... but leaves the Docker backend
```

What `serve-up.sh` starts, and `serve-down.sh` removes:

| Piece | What | Look at it |
| --- | --- | --- |
| Docker backend | `mock-llm/up.sh` (skipped when :4792 already answers), ports on loopback only | `docker compose -f mock-llm/compose.yaml ps` |
| dev server | systemd user unit `wasm-term-web.service`: `bun server.ts` on `127.0.0.1:4790`, enabled, restarts on failure, survives logout (lingering) | `systemctl --user status wasm-term-web`, `journalctl --user -u wasm-term-web` |
| tailnet HTTPS | one `tailscale serve` entry, HTTPS port 4790 (`WASM_TERM_HTTPS_PORT`) -> `http://127.0.0.1:4790`; tailnet only, never funnel | `tailscale serve status` |

Then, from any device on the tailnet: `https://<machine>.<tailnet>.ts.net:4790/`
(launcher), `.../?guest=opencode` or `.../?guest=codex`. Only that one port faces the tailnet; the
backends stay on loopback behind the proxy paths. `serve-down.sh` removes the
serve entry only if it still points at the dev server and never touches other
entries. Changing the serve config needs root unless the user is tailscale's
operator; the scripts try plain `tailscale serve` and fall back to `sudo` for
that one command. The unit file is written to `~/.config/systemd/user/` with
this checkout's path, so run `serve-up.sh` again after moving the checkout.

Anyone on the tailnet who opens the page can drive the backend behind it. With
the mock backend that is scripted shell commands in a container with no
internet and no host mounts; point `OPENCODE_UPSTREAM` at a real server only
with that in mind.

### On a phone

On a touch device (or a window narrower than 600px) the page adds what
`bun-web-terminal` uses on a phone, importing its touch, viewport and wheel
code (`web/mobile.ts`):

- a row of keys under the terminal: keyboard, Esc, Ctrl, Tab, arrows,
  Shift+Enter (a new line in the prompt of codex and opencode, where the
  on-screen keyboard's Enter submits). Ctrl is sticky for one key: Ctrl then
  `p` on the on-screen keyboard is ctrl+p;
- the keyboard key opens and closes the on-screen keyboard. A tap on the
  terminal is a click for the program and does not open it;
- the page follows `visualViewport`, so with the keyboard open the terminal
  is refitted above it and the prompt and keys row stay visible;
- a swipe scrolls (as wheel steps: mouse reports, or scrollback); a long press
  then drag selects.

### Checks

`web/verify/run.sh [terminal-functions|opencode|opencode-perf|codex]` drives the
page in Chrome through `browser-control` (dev server up; the opencode and
codex ones also need `mock-llm/up.sh`). `terminal-functions` checks each terminal
function with the Rust guests and the JavaScript shim with `js-demo`;
`opencode` runs the TUI through connect, prompts, the permission dialog,
markdown, scrolling, palette, sessions, clipboard, reload and exit, comparing
screens with the native client's captures; `opencode-perf` prints load and
input-latency numbers; `codex` runs the codex TUI through how its module is
served, the loading indicator, connect, plain and tool turns against the
native captures, markdown, a long reply with wheel scrolling, resize, the
slash popup, `/status`, the warnings viewer, paste, Shift+Enter, the
filesystem helpers, history across a reload, a line typed in one burst, the
approval dialog and `/quit`. Screenshots land in `docs/screenshots/`.

`cd web && bun verify/profile.ts '<page URL>&build=names'` profiles a guest's
Worker in a private headless Chrome (wasm function names from the module) and
prints the longest stretches in which it did not go idle, and with `--blocked`
where it waits.

Both run against another base URL with `WASM_TERM_URL`, e.g. the tailnet one:
`WASM_TERM_URL=https://<machine>.<tailnet>.ts.net:4790 web/verify/run.sh opencode`.

`web/webkit/smoke.sh [base URL]` runs the page headless in Playwright's WebKit
build, at a desktop viewport and with an iPhone device profile (`PROFILE=desktop`
or `iphone` for one; `GUESTS=opencode` or `codex` for one guest): isolation,
the Worker, the opencode home screen, a prompt and its reply; in the iPhone
profile also the keys row, focus, swipe scrolling and refitting to a
keyboard-sized viewport. Then the codex guest: that the module downloads,
compiles and starts at all, a prompt and its reply, `/quit`, and in the iPhone
profile the keys row against codex (arrow up, Shift+Enter, Ctrl, Esc). Once before:
`web/webkit/install.sh`, which puts the browser under
`vendor/playwright-browsers` and the system libraries it lacks under
`vendor/webkit-syslibs` (downloaded Ubuntu packages, unpacked; nothing
installed system-wide). It is WebKit's engine on Linux, not Safari: it shows
that the page's JavaScript, wasm, SharedArrayBuffer and Worker use run on
JavaScriptCore/WebCore, and nothing about iOS itself (the real on-screen
keyboard and how `visualViewport` moves with it, real touch input, memory
limits, WebGL on Apple GPUs, clipboard prompts).

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
