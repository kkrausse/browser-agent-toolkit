# wasm-term

Run real terminal programs (TUI clients) entirely in the browser: no server-side
PTY. The display is the [`ghostty-web`](third_party/ghostty-web/README.md)
package (official Ghostty WASM + WebGL2; a snapshot under `third_party/`). The program runs in a Web Worker
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

The project is self-contained in this directory and is not part of the
toolkit's Cargo or bun workspaces; the rest of the repository does not build
or test it. It uses one thing from the repository, the `bat-sh` shell
(`../crates/bat-sh`), and one thing uses it: `../examples/terminal-app` embeds
its opencode guest. It was developed in another repository (`random`, as the
directory `wasm-term/`) and moved here with its history on 2026-10-10; commit
hashes in the notes (`156426a`, `ac36686`, ...) are that repository's, and the
notes call this repository's Rust runtime "bat-rust", the name of its checkout.

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
- **Commands**: a guest can run shell commands as child processes
  (`proc_spawn` and friends). The shell is this repository's `bat-sh` (`../crates/bat-sh`: bash-like,
  coreutils and `rg` built in) in its own Worker, on the guest's own
  filesystem. There are no other programs: no git, python or node.
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
| `host/` | TypeScript: worker runtime, WASI + custom imports, vfs, net bridge, persistence; `host/node/` runs JavaScript programs on the same machine (node-style `process`, `fs`, ...); `host/proc.ts`, `host/sh/`, `host/shell-worker.ts` are child processes: the shell (`host/sh/build.sh` builds it from `../crates/bat-sh`) |
| `web/` | Bun dev server (COOP/COEP), the launcher and the page wiring ghostty-web to a program; `web/verify/` browser checks |
| `guests/` | Test programs built for the guest ABI |
| `mock-llm/` | Scripted model server + isolated opencode/codex server configs |
| `ports/opencode/`, `ports/codex/` | Per-client port work and notes |
| `third_party/` | Snapshot of the `ghostty-web` package and of three `bun-web-terminal` files, from the repository `random`; `third_party/README.md` says what and how to refresh it |
| `vendor/` | Upstream checkouts and toolchains, gitignored |

## Ports

| Port | Use |
| --- | --- |
| 4790 | `web/` dev server |
| 4791 | mock model server (container); also the fake sign-in endpoints |
| 4792 | `opencode serve` (container) |
| 4793 | `codex app-server` (container) |
| 4796 | browser-facing codex proxy (container); strips `Origin`, which `codex app-server` rejects |

## Run it

Needs bun, cargo with the `wasm32-unknown-unknown` and `wasm32-wasip1`
targets, and network access once (to clone the crossterm fork). The shell is
built from `../crates/bat-sh` of this checkout; `host/sh/bat-sh.lock` records
which source tree and what module came out (`host/sh/build.sh --record` after
the crate changed).

```sh
cd wasm-term/kernel && cargo test          # line discipline against termios behaviour
cd ../web && bun install
bun run build                               # kernel wasm + guests -> guests/dist/*.wasm, the shell -> host/sh/dist/bat_sh.wasm
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
| `proc` | child processes: checks and timings of `proc_*` (`&shell=worker` or `&shell=inline&arg=inline`; `&arg=quick` skips the timings) |
| `js-demo` | a JavaScript program on the node-style shim (`host/node/demo-guest.ts`) |
| `opencode` | the real opencode 2.0.26 TUI, attached to a remote `opencode serve` |
| `codex` | the real codex-cli 0.162.0 TUI (Rust, `wasm32-wasip1`), attached to a remote `codex app-server` |
| `codex-local` | codex-cli 0.162.0 entirely in the tab: TUI, app-server and agent core in one module; model and sign-in requests go out through the page server's HTTP relay |

Page parameters: `&arg=...`, `&env=K=V` (`&env=WASM_TERM_TRACE=1` logs
syscall rates, and stretches in which the program computed without reading
input, to the console), `&persist=0` (no saved files), `&reset=1` (forget the
guest's saved files first), `&signout=1` (forget only its stored credentials first), `&renderer=canvas|webgl` (the terminal renderer;
by default WebGL, or the 2D canvas when the browser only emulates WebGL in
software), `&shell=worker|inline|off` (how a guest with a shell runs commands:
in shell Workers, inside its own Worker, or not at all; default Workers, inline
on a machine with at most two cores). Each guest's home directory is kept in IndexedDB across reloads;
opencode keeps its config and state directories, codex its `CODEX_HOME`, codex-local its
`CODEX_HOME` and its project directory.

In the page's console, `await wasmTerm.readFile(path)`, `wasmTerm.listFiles(dir)`
and `wasmTerm.download(path)` read files out of the program's filesystem (its
log, the configuration it wrote), also after it has exited.
`wasmTerm.program.procs` lists the commands the program has run (status, how
long each waited for a shell and ran, how many host calls it made).

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
| `/proxy/http/<host>/<path>` | the named host, only if allowlisted | the pass-through relay for programs that make their own HTTP requests ("codex-local", below) |

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

The module is 11.3 MB over the wire (brotli) and 38.4 MB to compile
(`ports/codex/NOTES.md`, "Module", has the table); the page shows a progress bar while it arrives and compiles, and the
browser caches it for good: its URL contains its hash, so a rebuild is a new
URL. `scripts/ship.sh` is `build.sh` for the two profiles plus `wasm-opt` and
`package.ts`; the server reads `dist/site/manifest.json` on every load, so a
rebuilt module is picked up without a restart.

### codex-local: codex with nothing behind it

The same TUI with codex's app-server and agent core in the module too: the agent loop, the
tools and the model calls all run in the tab. What is left on the server is a relay for its
HTTP requests.

```sh
cd wasm-term/ports/codex
scripts/setup.sh                            # once, as above
BIN=local scripts/ship.sh                   # dist/site-local/: the module to serve and a build with names

cd ../.. && mock-llm/up.sh                  # the scripted model server on :4791 (and the fake sign-in endpoints)
cd web && bun run dev
```

Open <http://127.0.0.1:4790/?guest=codex-local>, or the launcher.

| Parameter | Default | |
| --- | --- | --- |
| `backend` | `mock` | `mock`: the scripted model server, no sign-in, no tokens. `openai`: the real service; the TUI asks you to sign in. `mock-auth`: codex's real sign-in flow and ChatGPT-style requests against mock-llm's fake auth server (what `web/verify/codex-local.js` uses) |
| `relay` | `/proxy/http` | where the program's HTTP requests go: this page's server, which forwards them to an allowlist of hosts. Empty = the browser fetches directly (only servers that allow this origin by CORS) |
| `dir` | `/home/user/project` | the project directory, in the tab's own filesystem |
| `seed` | `1` | write the sample project (`ports/codex/main/sample/`: a README, three Python files in `src/`, a test, a CSV, notes) into the project directory if it is empty |

The project and `CODEX_HOME` (`/home/user/.codex`: `config.toml`, `auth.json`, `history.jsonl`,
`sessions/`) are kept in IndexedDB across reloads. Look at them from the page's console:
`await wasmTerm.listFiles("/home/user/project")`, `await wasmTerm.readFile("/home/user/project/hello.txt")`,
`wasmTerm.download(path)`. `/resume` in the TUI lists earlier sessions.

**Your own files.** On the launcher, under codex-local: "Import folder" and "Import .zip" copy
a folder or an archive into `/home/user/project` in this browser's storage (nothing is uploaded;
`.git`, `node_modules`, `target` and files over 8 MB are left out, at most 5,000 files and 64 MB;
"replace what is there" empties the project first). Then run codex-local. "Forget saved state"
empties everything, and the sample project comes back on the next start. Files come out again
with `wasmTerm.download(path)`.

The module is 20.3 MB over the wire (brotli) and 70.4 MB to compile, against 11.3 and 38.4
for the remote `codex` guest; the shell is another 0.86 MB (`/bat_sh.wasm`).

**What works**: prompts and streamed replies, sessions and resume, sign-in, `apply_patch`
(edits land in the tab's filesystem), and **commands**: the model's `exec_command` and
`write_stdin`, and your own `!command` in the composer, run in the page's shell
(`host/proc.ts`; `ports/codex/main/src/shell.rs`) on the same files. A model here can list,
search and read a project (`rg`, `rg --files`, `grep`, `find`, `ls`, `tree`, `cat`, `nl -ba`,
`sed -n`, `head`, `tail`, `wc`, `diff`), edit it (`apply_patch`, `sed -i`, redirects,
`mkdir`/`mv`/`cp`/`rm`) and check its edits. Output streams, exit statuses are real, a command
can be interrupted (Ctrl-C through `write_stdin`, `/stop` for one left running), and files a
command writes are persisted like any other.

**What does not**: running anything that is not in the shell. There is no `git`, `python`,
`node`, `npm`, `cargo`, `make`, compiler or network tool, so an agent can read and change code
but not run or test it; those commands fail at once with "command not found" (127) or the
shell's "not available" message. Codex is told so in a short developer message
(`ports/codex/main/src/environment.md`). `tty: true` gets pipes with a minimal line discipline,
not a terminal. `ports/codex/NOTES.md`, section 8, has the details, the coverage against real
bash and the numbers. `&shell=off&env=CODEX_WASM_SHELL=0` runs without a shell (the model's
commands then get a "no shell in this build" error it can read).

**The relay** (`/proxy/http/<host>[:port]/<path>` on :4790) forwards a request to
`<origin of host>/<path>` if the host is one of: `127.0.0.1:4791` and `mock-llm.test` (both the
mock), `api.openai.com`, `chatgpt.com`, `auth.openai.com`; `HTTP_RELAY_ALLOW="host[=origin] ..."`
in the server's environment adds more. It is stateless and adds nothing of its own. It sends
upstream only the headers the program wrapped as `x-wasm-term-fwd-<name>` (the browser's own
`User-Agent`, `Origin`, cookies, and a front proxy's `X-Forwarded-*`/`Tailscale-User-*` are
dropped), streams the response back, and logs method, host, path and status
(`journalctl --user -u wasm-term-web | grep relay`), never header values or bodies. Anyone who
can open the page can use it to reach those hosts with their own credentials.

**Signing in with ChatGPT** (`&backend=openai`):

1. Open `/?guest=codex-local&backend=openai`. The TUI shows "Sign in with ChatGPT", "Sign in
   with Device Code", "Provide your own API key".
2. Press Enter on the first. In a browser tab there is no localhost callback, so this is the
   device-code flow: the TUI shows `https://auth.openai.com/codex/device` and a one-time code.
3. Open that link (any device), sign in, enter the code. The TUI polls meanwhile and moves on
   by itself; press Enter through the two notices that follow.
4. The tokens are in `/home/user/.codex/auth.json` in the tab's filesystem, saved in this
   browser's IndexedDB for this origin. Reloading keeps you signed in.

To sign out: `/logout` in the TUI (revokes the token and deletes the file), or
`/?guest=codex-local&signout=1` / "Clear stored credentials" in the launcher (delete the stored
file without contacting anyone), or `&reset=1` (forget everything, project included).

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
code (`web/mobile.ts`; the three files are in `third_party/bun-web-terminal/`):

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

`web/verify/run.sh [terminal-functions|opencode|opencode-perf|codex|codex-local]` drives the
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
approval dialog and `/quit`; `codex-local` runs the embedded build through the relay against the
mock: plain, markdown and long replies, `apply_patch` edits read back from the filesystem, then
the shell: a command's output and status reaching the model, a turn of six reads (`rg --files`,
`rg -n`, `nl -ba | sed -n`, `sed -n`, `cat`, `ls -la`), a read / `apply_patch` / verify turn,
failing commands and missing programs (`git`, `python3`), 60,000 lines of output, `timeout`, a
running command interrupted by the model (Ctrl-C through `write_stdin`), an interactive process
typed into with `write_stdin`, Esc during a running command and `/stop`, the user's `!command`,
persistence of a shell-written file across a reload, history and `/resume`, the no-shell error
with `&shell=off`, the inline shell, the launcher's zip and folder import and "Forget saved
state", then the whole device-code sign-in against mock-llm's fake auth server (code shown,
approval, tokens stored, refresh, authenticated model request), `/logout`, the API-key path and
`&signout=1`. It also returns what the commands cost (`numbers`). Nothing in it reaches a real
host unless `CODEX_LOCAL_REAL_AUTH=1` is set, which adds one unauthenticated request for a
device code to the real `auth.openai.com`. `WASM_TERM_BUILD=names` runs the codex guests' build
with wasm names. `terminal-functions` also runs the `proc` guest in both shell modes. Screenshots land in
`docs/screenshots/`.

`cd web && bun verify/profile.ts '<page URL>&build=names'` profiles a guest's
Worker in a private headless Chrome (wasm function names from the module) and
prints the longest stretches in which it did not go idle, and with `--blocked`
where it waits.

Both run against another base URL with `WASM_TERM_URL`, e.g. the tailnet one:
`WASM_TERM_URL=https://<machine>.<tailnet>.ts.net:4790 web/verify/run.sh opencode`.

`web/webkit/smoke.sh [base URL]` runs the page headless in Playwright's WebKit
build, at a desktop viewport and with an iPhone device profile (`PROFILE=desktop`
or `iphone` for one; `GUESTS=opencode,codex,proc,codex-local` to choose guests): isolation,
the Worker, the opencode home screen, a prompt and its reply; in the iPhone
profile also the keys row, focus, swipe scrolling and refitting to a
keyboard-sized viewport. Then the codex guest: that the module downloads,
compiles and starts at all, a prompt and its reply, `/quit`, and in the iPhone
profile the keys row against codex (arrow up, Shift+Enter, Ctrl, Esc). Then
child processes: the `proc` guest's checks in both shell modes, and codex-local
taking two turns whose tool calls run in the shell. Once before:
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
  may share a worktree. Branch `wasm-term` of this repository; never `main`.
- `third_party/` is a snapshot: change those packages in `random` and refresh
  it with `third_party/sync.sh`.
