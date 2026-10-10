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
| `host/` | TypeScript: worker runtime, WASI + custom imports, vfs, net bridge |
| `web/` | Bun dev server (COOP/COEP) and the page wiring ghostty-web to a program |
| `guests/` | Test programs built for the guest ABI |
| `mock-llm/` | Scripted model server + isolated opencode/codex server configs |
| `ports/opencode/`, `ports/codex/` | Per-client port work and notes |
| `vendor/` | Upstream checkouts and toolchains, gitignored |

## Ports

| Port | Use |
| --- | --- |
| 4790 | `web/` dev server |
| 4791 | mock model server |
| 4792 | isolated `opencode serve` |
| 4793 | isolated `codex app-server` |
| 4794 | egress trap (refuse-and-log HTTP proxy) |
| 4795 | logging tap in front of opencode |
| 4796 | logging tap in front of codex; also strips `Origin`, which `codex app-server` rejects, so browsers connect here |

## Rules for working here

- Never touch the user's real opencode/codex state or background service. Run
  both with isolated homes under `wasm-term/.state/` (gitignored):
  `CODEX_HOME`, `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`,
  and `opencode --standalone` / `opencode serve`.
- Never call a real model provider. No real API keys in configs.
- Toolchains that are not installed (zig, wasi-sdk, …) go under
  `wasm-term/vendor/tools/`, not system-wide.
- Commit only your own paths (`git add wasm-term/<your-dir>`); several agents
  share this worktree. Branch `wasm-term`; never `main`.
