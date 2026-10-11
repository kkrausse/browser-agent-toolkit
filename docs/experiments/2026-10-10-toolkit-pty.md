# Terminal on the toolkit runtime: result (2026-10-10)

Branch `toolkit-pty` (from `origin/opencode-2.0.26`). `examples/terminal-app` now runs the
OpenCode 2.0.26 terminal client as an ordinary process of the toolkit runtime, on a pty of
the runtime's kernel, talking to the OpenCode server over a kernel socket. wasm-term's
program host is not on the page any more (its code is untouched and still builds). Spike:
`2026-10-10-toolkit-pty-spike.md`; decisions: `docs/design/decisions.md`, last entry.

Everything marked **[ran]** was run on diesel2 in Chrome 154 (headed on Xvfb, canvas
renderer), page served by `examples/terminal-app/server.ts` on port 4410, scripted model
(`mock-model.ts`) on 4411, driven by `browser-control`. Load average 4.7–5.3 throughout.

## The pieces

| | Where | State |
| --- | --- | --- |
| pty + line discipline | `crates/bat-pty` (moved from `wasm-term/kernel`, 51 tests pass) | **[ran]** `cargo test -p bat-pty` |
| kernel device | `crates/bat-kernel/src/tty.rs`, ABI section 18 | **[ran]** in the harness page: canonical echo and line read, raw mode, resize as `resize` + SIGWINCH, exit status, master end of file |
| page handle | `RuntimeHost.spawnTerminal` (`runtime/src/host/host.ts`, optional in `packages/toolkit/src/runtime-host.ts`) | **[ran]** by the example |
| Node stand-ins | `runtime/src/node/process.ts` (stdio on a terminal), `misc.ts` (`tty`), `worker_threads.ts` (`Worker` as a forked process) | **[ran]** by the client |
| display | `wasm-term/web/display.ts`; `embed.ts` uses it for wasm-term's own machine | **[ran]** in the example; `embed.ts` only typechecked |
| client program | `wasm-term/ports/opencode`, `bun run build:tui:node` → `dist/node/`; in the image at `/app/tui/` | **[ran]** |
| example | `examples/terminal-app` | **[ran]**, below |

## What was checked in the page

| Check | Result |
| --- | --- |
| Page loads, client runs as a toolkit process | process list of the kernel: `node --import /tmp/opencode-client/tap.mjs /app/tui/main.js` (pid 7) and its tree-sitter worker `node /tmp/.worker-7-1.mjs` (pid 8); `process.stdout.isTTY` true, 70x62 |
| `hello` (typed with the keyboard) | the scripted reply, streamed, to `SCRIPTED-PLAIN-DONE` |
| ``run `echo hi-from-sh && ls src \| wc -l` `` | the shell tool ran without a dialog: `hi-from-sh`, `11` |
| `set the heading to "Tasks"` | read + edit shown with the diff, the app in the frame hot-reloaded to `Tasks` |
| Panel resized (560 → 856 px) | display 70 → 107 columns, the client's `process.stdout.columns` 107, the screen relaid out |
| Reload | the workspace is kept; the session's tab is back and a click on it (a mouse report through the pty) shows the transcript; heading still `Tasks` |
| Paste (the browser's paste event) | arrives in the prompt |
| ctrl+c twice | the client prints its epilogue and exits 0; the page shows `[process ended: exit code 0]`; its worker process is gone |
| Sign-in bar | the client's own `fetch` of a sign-in route is recorded by the tap (a 401 for made-up ids); a made-up "attempt started" line shows the bar with link and placeholder, a "cancelled" line hides it. **Not run: the client's real dialog** (it would open OpenAI's page) |
| `?tunnel=` | title, log line and the server's `BAT_FETCH_TUNNEL*` environment as before. Nothing was tunnelled |
| Diagnostics | stages, log lines and screens arrive at the collector |
| `runtime/harness/check.sh` | 12 of 12 as before (`cjs.cjs` exits 7 on purpose) |
| `bun run typecheck`, `tsc` in `examples/terminal-app` and `wasm-term/web` | pass |
| `cargo test -p bat-kernel` | pass |

## Numbers

| | Here | wasm-term's host (its NOTES, load 15–25) |
| --- | --- | --- |
| Key press to the program's next output reaching the display | median **12.7 ms**, p90 15.9, min 9.1, max 17.8 (n = 43 keys, 120 ms apart) | median 13 ms, p90 19 ms |
| Client start → its first output | **394–417 ms** (n = 4 reopens) | not recorded |
| Client start → home screen on the display | about 470–480 ms (polled every 150 ms) | "navigation to the prompt" 0.55–0.9 s on its own page |
| Page navigation → client started | 2.2 s (reopen; the client starts after the server answers `/api/info`) | |

The key latency is measured as before: from the display handing the key to the page until
the next bytes are written to the display. One run each; the machine was not idle.

## bat-sh on a terminal

`bat-sh` has no interactive mode (no prompt, no line editing, no `isatty` check). With no
script argument it reads its whole stdin and then runs it. **[ran]** on a pty: `echo hi`,
Enter, `ls / | head -3`, Enter are echoed by the line discipline and nothing runs; after
^D both run and the shell exits 0. An interactive shell is a prompt loop in `bat-sh`, not
built.

## Open problems, in order

**Update, later the same day: 1 and 3 are closed.**

- **1 is the client's own behaviour, and the same on wasm-term's host.** [ran] The keys arrive:
  `hello` is drawn and `\r` is written to the pty 3 to 30 ms after the home screen. The
  client draws its home screen and takes keys before the agents of its location have come
  from the server ("Ask anything" on the display at 2312 ms, the agent's name `Build` at
  2974 ms on a fresh workspace; 2201 and 2545 ms on a reopen), and its `submitInner`
  (`packages/tui/src/component/prompt/index.tsx`) returns silently when there is no current
  agent. An Enter sent 2 ms after `Build` appeared submitted, 3 of 3; sent at once, 0 of 3.
  The page of branch `opencode-2.0.26` (wasm-term's host) drops it the same way (1 of 1).
  Fixed in the port's bundle, not on the page: `wasm-term/ports/opencode/build/opencode-edits-plugin.ts`
  makes a submit wait until the agent list is loaded. After: 6 of 6 on `?reset=1`.
- **3: the display serves the clipboard.** [ran] The client's copies come out as OSC 52
  (ghostty answers the `Ms` capability query, so the client uses it); ghostty-web's core
  ignores the sequence, so `wasm-term/web/display.ts` picks it out of the output
  (`osc52.ts`) and writes the browser's clipboard. Dragging over transcript text: the
  client shows "Copied to clipboard" and the X clipboard of Chrome's display holds the text.
  Paste: the example mounts the display with `ctrlVPaste`, so ctrl+v is the browser's paste
  like ctrl+shift+v, cmd+v and the paste event, and reaches the client as a bracketed paste;
  ctrl+v and ctrl+shift+v pasted the X clipboard's text into the prompt, two lines included.
  Not run: cmd+v (no Mac here), Safari and Firefox (they allow a clipboard write only
  shortly after a user gesture; the mouse release that ends a selection is one), images.
  OSC 52 queries are not answered: a program cannot read the clipboard.

1. **On a fresh workspace, an Enter in the first half second after the home screen appears
   is not acted on.** `?reset=1`, type `hello` and Enter at once: the prompt stays, the
   client makes no request, client and server both sit idle in their event loops (looked
   at through the workers: timers running, nothing ready). A second Enter three seconds
   later submits. Not seen on a reopen, nor when the first key comes 1.5 s after the home
   screen, nor with a client started later in the same page. Cause not found; whether
   wasm-term's host behaves the same was not checked.
2. **The sign-in was not run end to end on this path** (no account is used here). The bar's
   source changed from the page's own relay to a preload module in the client.
3. **Clipboard through the page is gone.** wasm-term's host gave the client the page's
   clipboard (ctrl+v, copy on select). Here the client falls back to OSC 52 through the
   terminal; not exercised. The browser's paste event works.
4. **`worker_threads.Worker` is JSON over a socket to another process.** Fine for
   tree-sitter; transfer lists, `SharedArrayBuffer`, ports and non-JSON values are not
   carried. `process.execArgv` in a process started with `--import x` reads `['--import']`.
5. **Signals go to one process per terminal**, the newest started on it. A `VTIME` timer is
   not an event for an event-driven reader. No `/dev/tty`, no `TIOCGPGRP`.
6. **`tty.ReadStream` / `WriteStream` are factories**, not classes.
7. **Not run: the other consumers of the moved code.** wasm-term's kernel builds against
   `crates/bat-pty` and its web directory typechecks; its dev page and `web/verify` were
   not run after `embed.ts` was changed to use `display.ts`.
8. **The client build needs wasm-term's vendored checkouts** (`wasm-term/vendor/opencode`,
   `opentui`, 3 GB), as the browser build did; `bun run terminal` on a fresh clone stops at
   `prepare.ts` with the command to run. Here `wasm-term/vendor` is a symlink to the
   `browser-agent-toolkit-wasm-term` worktree's.
9. Renderer memory of the tab grew about 0.2 MB/s over a minute of idling; not followed up.
