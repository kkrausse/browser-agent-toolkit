# Requests to the wasm-term host from the codex port

Status of each expectation the port had of the emulated machine (`NOTES.md` section 6), after
running the real module on it, and what is still wanted. "Ran" means observed with
`web/harness.ts` (Bun, real kernel and Worker runtime) and on the dev page in Chrome.

## Nothing blocking

The codex TUI starts, renders, takes input, resizes, talks to the app-server and exits on the
ABI as documented in `docs/abi.md`. No host change was needed to get there. One bug in the
kernel side's crossterm backend did turn up later (`guests/crossterm-wasi`: events parsed from
one read were delivered one per keystroke) and is fixed; see NOTES, "The startup stall".

| Expectation | Outcome |
| --- | --- |
| `poll_oneoff` usable as mio's WASI selector (read + write subscriptions, one clock) | Ran. tokio's current-thread runtime parks in it; idle codex makes about 2 calls in 4 s, no spinning (`WASM_TERM_TRACE=1`) |
| `isatty` for fds 0-2 through `fd_fdstat_get` | Ran. `stdin().is_terminal()` / `stdout().is_terminal()` hold; the TUI refuses to start otherwise |
| Replies to `ESC[6n`, `ESC[?u`, `ESC[c` reach the program as input | Ran. ghostty-web answered `ESC[1;1R` and `ESC[?7u ESC[?62;22c`; kitty keyboard reporting is on (Shift+Enter arrives as a CSI-u key) |
| Filesystem: `$HOME` exists, rename over an existing file, `ENOENT` for missing paths, append | Ran: `config.toml` (the atomic first-run write) and `history.jsonl` (appends) read back with `readFile`, persisted in IndexedDB and found again after a reload |
| 16 MiB+ stack, large module | Ran. The module asks for a 32 MiB stack by linker argument. It was 202 MB unstripped when this was first written and Chrome compiled and started it in about 1.4 s on this machine; what ships now is a quarter of that (NOTES, "Module") |
| WebSocket: text frames, close/error events, connect failure as an event | Ran for open, text both ways, and a refused connection (`WebSocket error (ws://...)` surfaced as the TUI's connect error). Frames beyond a few hundred KB were not exercised |
| SIGWINCH on resize | Ran. 192x55 to 90x29 in Chrome re-laid out the screen |

## Requests

### 1. Local time zone: done

The host now puts the browser's zone in the default environment (`timeZoneEnv()` in
`host/index.ts`; `docs/abi.md`, "Time zone"): `TZ` (IANA name) and
`WASM_TERM_UTC_OFFSET_MINUTES` (minutes east of UTC at program start). The port reads the offset
in a chrono fork (`patches/forks/chrono`: `chrono::Local` on WASI is that fixed offset), which
covers every `Local` use in the graph, not only the turn footer.

Ran: the footer read `Worked for <1s • 12:40 AM` at 00:40 PDT in the harness, and
`web/verify/codex.js` compares the footer with the browser's own clock.

Limit: one offset for the life of the program. A session that runs across a DST change keeps the
old offset until the page is reloaded.

### 2. Reading a file back out of the vfs: done

`program.readFile(path)` and `program.listFiles(directory)` (`docs/abi.md`, "Reading files
back"), answered between host calls, and still answered after a wasm guest has exited (its
Worker stays, holding only the filesystem). On the page: `await wasmTerm.readFile(...)`,
`wasmTerm.listFiles(...)`, `wasmTerm.download(...)` in the console. In the harness: the
`cat:PATH` and `ls:DIR` steps.

Ran: it is how the lost-input bug (NOTES, "The startup stall") was found: temporary logging to
`/tmp/dbg.log` in the guest, read with `cat:/tmp/dbg.log`.

The caller-supplied persistence store suggested as an alternative was not done; `web/harness.ts`
still starts from an empty `~/.codex` every run.

### 3. Authentication for the app-server socket (bridge, not kernel)

Evidence: `codex app-server` only accepts `Authorization: Bearer ...` on the upgrade request
(`websocket-auth/src/lib.rs:288-319`) and a browser `WebSocket` cannot set headers. The port
therefore refuses `--remote-auth-token-env` on WASI with an explicit error rather than connect
without the token. mock-llm's proxy on 4796 has no authentication at all.

Request, for whoever productises the proxy: it is the component that must authenticate the
browser (cookie, or a token in the URL path that it strips) and add the bearer header towards
the app-server. Nothing is needed from the ABI: `ws_open` passing a URL through is enough.

### 4. Not needed after all

- A pipe/eventfd-like descriptor: crossterm's WASI backend (guests/crossterm-wasi) and tokio get
  by without self-pipes.
- File locks: the port treats the history file lock as held (one process per machine).
- `wasi_thread_spawn`: no blocking-wait deadlock turned up on the paths exercised.
- HTTP through `http_open` for the TUI's own requests: they fail fast through the socket
  stand-ins and the TUI tolerates it. Wiring them up is optional (NOTES, remaining work).

### 5. Observed, not requested: the page's main thread is the program's I/O path

Terminal input and every network event reach the Worker through the page's main thread (the
ring's single writer). When that thread is busy, the program is deaf. Measured in headless Chrome
with codex's animated start screen: software-emulated WebGL took 0.7 to 3.5 s per frame, tasks on
the main thread ran 1.4 s apart (median), and each of the roughly ten sequential RPCs of codex's
startup waited that long for its reply although the server had answered in 2 to 8 ms. The page
now picks the 2D canvas renderer when WebGL is software-emulated (6 ms between tasks in the same
measurement), which is the fix for browsers without a GPU. Not measured: a phone with a real
GPU under load. If that shows the same thing, the network bridge belongs in its own Worker
writing to a second ring, so that a slow frame cannot delay a reply.

### 6. `http_open` in real use (fourth session, `codex-local`)

The codex port's reqwest fork now sends every HTTP request through `http_open` / `http_head` /
`fd_read` (NOTES, section 8). Ran, in Chrome and under Bun: JSON requests and responses, a
zstd-compressed (binary) request body, server-sent event streams read as they arrive for
replies of 80 lines, several requests in flight at once, and non-2xx statuses. Nothing had to
change in the host. Not exercised: a transfer that fails half-way.

Two things a guest cannot do through it, both browser rules rather than host gaps, and both
handled by the relay convention in `docs/abi.md`: set `User-Agent`, `Cookie` and the other
forbidden request headers, and read `Set-Cookie`.

Wanted, not blocking:

- **Streaming request bodies.** `http_open` takes the body whole. Fine for codex (JSON, a few
  hundred KB at most); an upload of a large file would have to be buffered in the guest.
- **`cache: "no-store"` / `credentials: "omit"` on the `fetch`.** The host uses the defaults, so
  a GET may be answered from the browser's HTTP cache and same-origin requests carry the page's
  cookies. The relay answers `Cache-Control: no-store` and ignores cookies, which covers it for
  now.
- **The harness's persistence store** (request 2 above) would have let "reload and resume" be
  checked headless; it was checked in the browser instead.
