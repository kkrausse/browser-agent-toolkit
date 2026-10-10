# Requests to the wasm-term host from the codex port

Status of each expectation the port had of the emulated machine (`NOTES.md` section 6), after
running the real module on it, and what is still wanted. "Ran" means observed with
`web/harness.ts` (Bun, real kernel and Worker runtime) and on the dev page in Chrome.

## Nothing blocking

The codex TUI starts, renders, takes input, resizes, talks to the app-server and exits on the
ABI as documented in `docs/abi.md`. No host change was needed to get there.

| Expectation | Outcome |
| --- | --- |
| `poll_oneoff` usable as mio's WASI selector (read + write subscriptions, one clock) | Ran. tokio's current-thread runtime parks in it; idle codex makes about 2 calls in 4 s, no spinning (`WASM_TERM_TRACE=1`) |
| `isatty` for fds 0-2 through `fd_fdstat_get` | Ran. `stdin().is_terminal()` / `stdout().is_terminal()` hold; the TUI refuses to start otherwise |
| Replies to `ESC[6n`, `ESC[?u`, `ESC[c` reach the program as input | Ran. ghostty-web answered `ESC[1;1R` and `ESC[?7u ESC[?62;22c`; kitty keyboard reporting is on (Shift+Enter arrives as a CSI-u key) |
| Filesystem: `$HOME` exists, rename over an existing file, `ENOENT` for missing paths, append | Ran as far as the import trace shows: startup does `path_create_directory`, `path_rename` and `path_unlink_file` (the atomic first-run `config.toml` write) and `fd_seek` on the history append, all without error. The resulting file contents were not read back (request 2) |
| 16 MiB+ stack, large module | Ran. The module asks for a 32 MiB stack by linker argument and is 202 MB unstripped; Chrome compiled and started it in about 1.4 s on this machine |
| WebSocket: text frames, close/error events, connect failure as an event | Ran for open, text both ways, and a refused connection (`WebSocket error (ws://...)` surfaced as the TUI's connect error). Frames beyond a few hundred KB were not exercised |
| SIGWINCH on resize | Ran. 192x55 to 90x29 in Chrome re-laid out the screen |

## Requests

### 1. Local time zone (cosmetic, wrong today)

Evidence: the turn footer reads `Worked for <1s • 6:26 AM` when the wall clock was 11:26 PM
local. WASI preview1 has no time-zone interface, wasi-libc has no zone database, so
`chrono::Local` (what `tui/src/clock_format.rs` uses) is UTC.

Request: put the browser's zone in the default environment, both forms, since nothing on the
guest side can discover it:

- `TZ` = the IANA name (`Intl.DateTimeFormat().resolvedOptions().timeZone`), and
- `WASM_TERM_UTC_OFFSET_MINUTES` = `-new Date().getTimezoneOffset()` at start.

The port will read the offset in `clock_format.rs` (not done yet; the IANA name alone is no use
without tzdata in the module). Until then times are UTC.

### 2. `Program` option to read a file back out of the vfs (debugging aid)

Evidence: codex writes its diagnostics to `$CODEX_HOME/log/codex-tui.log` and there is no way to
see that file from the page or from the Bun harness. While chasing a timing problem (NOTES,
"Open problems" 1) the instruments were `WASM_TERM_TRACE` call counts and a rebuild that printed
debug text inside a private OSC sequence.
`persist` already ships file contents to the page, but only into IndexedDB.

Request: either `program.readFile(path): Promise<Uint8Array | null>` (a frame to the Worker,
answered between syscalls), or let `persist` take a caller-supplied store
(`{ load(), save(path, data) }`) instead of always opening IndexedDB. The second would also let
`web/harness.ts` keep `~/.codex` across runs.

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
