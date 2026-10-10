# codex TUI in the browser: findings, recommendation, burn-down

Subject: codex-cli 0.162.0 (`openai/codex` tag `rust-v0.162.0`, commit `c138238`), the Rust
TUI in `codex-rs/tui`, running as a wasm guest of the wasm-term emulated machine and talking
to a remote `codex app-server --listen ws://IP:PORT`.

Paths below are relative to `codex-rs/` in the upstream checkout at
`wasm-term/vendor/codex` unless they start with `wasm-term/`.

How each statement was established is marked:

- **[ran]** I ran something and read the output (logs under `wasm-term/vendor/check-*.log`).
- **[read]** read in the source at the tag, by me or by a read-only sub-agent; not executed.
- **[inferred]** a conclusion drawn from the above, not directly observed.

## 1. Short answer

**Recommendation: approach (a)**: compile the real TUI crate to `wasm32-wasip1`
(single-threaded, on the ABI the kernel already has), with

1. local forks of a few foundational crates so that the rest of the graph compiles
   unmodified (crossterm with a WASI backend, tokio with `process`/`signal` stand-ins and an
   inline blocking pool, small third-party leaves), and
2. a thin `cfg(target_os = "wasi")` patch series on the codex workspace that cuts the
   embedded app-server out and stubs what cannot exist in a browser.

It is a large port, not a small one, but it is done as far as "runs": at this tag the TUI crate
type-depends on `codex-core` (through `codex_app_server_client::legacy_core::config`), so the
whole workspace graph is in play: 133 workspace crates, 928 packages. **All of them now build
for `wasm32-wasip1`, the port links to one module, and the real TUI runs in a browser Worker on
the wasm-term kernel**, connected to `codex app-server` through the Origin-stripping proxy:
start screen, prompt and streamed reply, tool call, approval prompt, resize, `/quit`.

What it took, all reproducible (section 7 has the commands, the burn-down table, what is
stubbed, what was observed and what is still open):

- 15 small crates.io forks (cfg arms and stand-ins; `scripts/forks.txt`) and a tokio fork that
  adds API-compatible `process` / `signal` / socket stand-ins and an inline blocking pool;
- crossterm from `wasm-term/guests/crossterm-wasi` (the kernel side's backend, used as is);
- a patch series of about 45 files on the codex workspace, mostly third `cfg` arms, plus one
  new file that carries the WebSocket;
- a 130-line `main` (`ports/codex/main`) and a wasi-sdk C toolchain for aws-lc, ring, sqlite,
  oniguruma, zstd, bzip2 and tree-sitter.

The first session's text below (sections 2-6) is kept as written; where later sessions found
otherwise it says so in section 7. In short: no part of the graph had to be cut out to make it
compile, single-threaded was enough, and one stub (the embedded server's entry point) halves
the module.

Since the third session it is a guest on the shared dev page:
`https://<machine>.<tailnet>.ts.net:4790/?guest=codex` (README, "codex in the browser").

## 2. Crate graph (question 1)

### Entry and shape

- **[read]** Binary and library: `tui/Cargo.toml` (`[[bin]] codex-tui`, `[lib] codex_tui`).
  `tui/src/main.rs:21-58` calls `codex_arg0::arg0_dispatch_or_else` then
  `codex_tui::run_main(cli, arg0_paths, LoaderOverrides::default(), /*explicit_remote_endpoint*/ None)`.
  `--remote` is parsed in the top-level `cli` crate (`cli/src/main.rs:2402-2563`), which calls
  the same `run_main` with `Some(endpoint)`. A browser build needs its own small `main` that
  passes the endpoint; the stock `codex-tui` binary cannot do remote mode.
- **[ran]** `find tui/src -name '*.rs' | xargs cat | wc -l`: 442,729 lines. `codex-core`: 250,253.
- **[ran]** `cargo tree -p codex-tui --target wasm32-wasip1 -e normal`: 928 packages, 133 of
  them workspace crates (989 packages on x86_64 linux). The wasm target only removes the
  platform-specific leaves (zbus, landlock, seccompiler, windows-sys, objc2).
- **[read]** The TUI is an app-server client: `codex-app-server-client` exposes
  `enum AppServerClient { InProcess, Remote }` (`app-server-client/src/lib.rs:345`) and the
  remote half is one file, `app-server-client/src/remote.rs` (1,064 lines).

### Why remote mode still links everything

- **[read]** `app-server-client/Cargo.toml` depends on `codex-app-server` and `codex-core`
  unconditionally. `app-server-client/src/lib.rs:30-36` re-exports in-process types
  (`EmbeddedNetworkPolicy`, `StateDbHandle`, `LogDbLayer`, ...), `:53` re-exports
  `codex_core::otel_init::build_provider`, and `:76-83` is

  ```rust
  /// Transitional access to core-only embedded app-server types.
  /// ... so clients can remove a direct `codex-core` dependency
  /// while legacy startup/config paths are migrated to RPCs.
  pub mod legacy_core { pub mod config { pub use codex_core::config::*; ... } }
  ```
- **[ran]** `grep legacy_core::` over `tui/src`: 29 distinct items, led by `Config` (52 uses),
  `ConfigBuilder` (42), `set_project_trust_level` (23), `ConfigOverrides` (19).
  `core/src/config/mod.rs` is 4,991 lines and imports from `codex_mcp`, `codex_exec_server`,
  `codex_sandboxing`, `codex_login`, `codex_http_client`, `codex_core_plugins`,
  `codex_rmcp_client`, `codex_models_manager`, `codex_network_proxy`, `codex_git_utils`.
- **[inferred]** So there is no small cut. The `Config` struct the TUI reads in 52 files is
  defined in the 250k-line core crate and names types from a dozen process- and
  network-heavy crates. Upstream is moving the TUI off it (the comment above says so); until
  that lands, a port has to make those crates at least type-check for wasm.

### Essential versus embedded-only, for `--remote`

Counted as files in `tui/src` (non-test) that name the crate. **[ran]**

| Role | Crates | Files |
| --- | --- | --- |
| Essential, pure UI | ratatui (235), crossterm (134), tokio (134), codex-app-server-protocol (176), codex-protocol (148), codex-config (72), codex-app-server-client (49), codex-utils-absolute-path (43), syntect, pulldown-cmark, textwrap, unicode-*, image | |
| Essential by type only (via `Config`) | codex-core and what `core::config` imports | 52 |
| Local-machine helpers, used in remote mode too | codex-terminal-detection (20), codex-message-history (7, local `history.jsonl`), codex-features (24), codex-login (9), codex-otel (9), codex-rollout (9), codex-state (6), codex-exec-server (11, `LOCAL_FS` + `EnvironmentManager`), codex-http-client (11), codex-backend-client (12), codex-feedback (12), codex-git-utils (11), codex-file-search (7), codex-cloud-config (2) | |
| Embedded / local-server only | codex-app-server (in-process), codex-app-server-daemon (3), codex-uds (2), axum + rmcp `server` (`tui/src/dynamic_tools_mcp.rs`, started only without a remote workspace: `tui/src/app/startup.rs:434-449`), codex-worktree (7), codex-sandboxing (2), codex-windows-sandbox (1), codex-arg0 PATH aliases | |
| Desktop integration, user action only | arboard (4), webbrowser (3), codex-realtime-webrtc (8), codex-utils-sleep-inhibitor (1), zbus (linux) | |

### Hostile to `wasm32-wasip1`, from the compiler

Commands: `scripts/check.sh` (wraps
`cargo check -p codex-tui --lib --target wasm32-wasip1 --keep-going`). `--keep-going` only
shows the failing frontier; everything downstream of a failure is not attempted, so each row
is a layer, not the total.

**Run 0, unmodified tree, no C cross-compiler, no `tokio_unstable`** **[ran]**
(`vendor/check-wasip1-0.log`): 36/133 workspace crates check. Failures:

| Crate | First error |
| --- | --- |
| tokio 1.52.3 | `src/lib.rs:478: error: Only features sync,macros,io-util,rt,time are supported on wasm.` (codex enables fs, io-std, net, process, rt-multi-thread, signal) |
| crossterm (fork) | `src/cursor.rs:52: error[E0432]: unresolved import sys::position`, `src/event/read.rs:10: unresolved import crate::event::sys::Waker` (12 errors; no non-unix, non-windows backend) |
| socket2 0.6.3 | `src/lib.rs:187: error: Socket2 doesn't support the compile target` |
| arboard 3.6.1 | `src/lib.rs:82: error[E0433]: cannot find Clipboard in platform` (8) |
| filedescriptor 0.8.3 | `src/lib.rs:162: error[E0425]: cannot find type RawFileDescriptor` (18) |
| serial2 0.2.33 | `src/serial_port.rs:12: cannot find type SerialPort in module sys` |
| gethostname 1.1.0 | `src/lib.rs:49: error[E0308]: mismatched types: expected OsString, found ()` |
| gix-fs 0.19.2 | `src/symlink.rs:8: cannot find unix in os` |
| rustls-native-certs 0.8.3 | `src/lib.rs:123: cannot find module or crate platform` |
| opentelemetry-http 0.31.0 | `src/lib.rs:96: error: future cannot be sent between threads safely ... Rc<RefCell<wasm_bindgen_futures::Inner>>` |
| wxc_common (microsoft/mxc) | `src/exec_stream.rs:62: cannot find interruptible_reader in the crate root` |
| codex-utils-path-uri | `src/lib.rs:142: cannot find value path_bytes` (only `cfg(unix)` and `cfg(windows)` arms) |
| C build scripts | aws-lc-sys, ring, libsqlite3-sys, onig_sys, zstd-sys, bzip2-sys, lzma-sys, openssl-sys, tree-sitter, tree-sitter-bash, tree-sitter-powershell: no C compiler for the target (`CC_wasm32-wasip1 = None`) |

**Run 1, adding wasi-sdk 34 and `--cfg tokio_unstable`** **[ran]** (`vendor/check-wasm32-wasip1-1.log`):
the C build scripts for aws-lc-sys, ring, libsqlite3-sys, onig_sys, zstd-sys, bzip2-sys and the
three tree-sitter crates now succeed. Still failing in C:

- lzma-sys 0.1.20: `signal.h:2:2: error: "wasm lacks signal support..."`,
  `mythread.h:146: call to undeclared function 'pthread_sigmask'`
- openssl-sys 0.9.111: `Could not find directory of OpenSSL installation` (pulled in by
  `native-tls`, a direct dependency of `codex-http-client`)

and tokio now compiles, exposing the next layer:

| Crate | Error |
| --- | --- |
| codex-file-search | `src/lib.rs:28: error[E0432]: unresolved import tokio::process` |
| process-wrap (via rmcp, via codex-app-server-protocol) | `src/tokio/core.rs:20: unresolved import tokio::process` |
| tokio-graceful 0.2.2 | `src/lib.rs:43: unresolved import shutdown::default_signal` |
| hickory-proto 0.25.2 | `src/runtime.rs:122: unresolved imports tokio::net::TcpSocket, tokio::net::UdpSocket` |
| sqlx-core 0.9.0, tokio-tungstenite (fork) | `no associated function connect found for struct tokio::net::TcpStream` |
| codex-uds | `src/lib.rs:25: cannot find module or crate platform` |

**Patterns** **[inferred from the runs]**: nearly every failure is one of five things.

1. A `cfg(unix)` / `cfg(windows)` dichotomy with no third arm (path-uri, uds, gethostname,
   gix-fs, rustls-native-certs, arboard, filedescriptor, serial2, crossterm).
2. tokio modules that do not exist on WASI: `tokio::process`, `tokio::signal`,
   `TcpStream::connect`, `TcpSocket`, `UdpSocket`, all of `tokio::net::unix`.
   `grep` finds roughly 60 workspace source files using `tokio::process`.
3. reqwest: on any `target_arch = "wasm32"` it selects its wasm-bindgen/`fetch` backend, WASI
   included. That backend has a different API (non-`Send` futures, no proxy/TLS builders) and
   would leave `__wbindgen_*` imports nobody provides. Direct users: codex-http-client,
   codex-otel, codex-code-mode, and third-party oauth2, opentelemetry-http, opentelemetry-otlp,
   rmcp (reqwest 0.13). **[ran: `cargo tree -i reqwest`]**
4. Sockets: socket2 (hyper-util, rama-net, codex-shell-escalation), hickory (rama-dns under
   codex-network-proxy).
5. `std::os::unix` extension traits with no WASI counterpart: `PermissionsExt::mode`
   (chmod 0600 on history, logs), `CommandExt`, symlinks (`std::os::wasi::fs::symlink_path`
   is unstable: `error[E0658]: use of unstable library feature wasi_ext`).

`wasm32-wasip1-threads` has the same Rust-level frontier **[ran]**
(`vendor/check-wasm32-wasip1-threads-6.log`: arboard, filedescriptor, hickory-proto,
opentelemetry-http, serial2, socket2, wxc_common, lzma-sys, openssl-sys; identical to
wasip1 run 5). One toolchain wrinkle: the `cc` crate passes `--target=wasm32-wasi` for the
threads target, for which wasi-sdk 34 has no headers (`fatal error: 'stdlib.h' file not
found`); `scripts/env.sh` adds the real triple. The target changes run-time behaviour,
not what compiles.

`wasm32-unknown-emscripten`, tried as a data point for approach (c) **[ran]**
(`vendor/check-wasm32-unknown-emscripten-0.log`, emsdk 6.0.12): fewer leaves fail because
`cfg(unix)` is true there, but the ones that do are foundational:

- mio 1.2.0: `src/lib.rs:44: error: This wasm target is unsupported by mio. If using Tokio, disable the net feature.`
- nix 0.28: `src/errno.rs:19: unresolved import self::consts` (no errno table for the OS)
- socket2: `src/sys/unix.rs:743: cannot find type IovLen`
- rustls / jsonwebtoken: `the trait bound ring::rand::SystemRandom: SecureRandom is not satisfied`
- wasm-streams (reqwest's wasm backend again), arboard, serial2, openssl-sys

## 3. What the TUI does locally in remote mode (question 2)

All **[read]** by a sub-agent tracing `run_main` -> `startup_orchestration::run_main_inner`
-> `run_ratatui_app` -> `App::run`; I spot-checked the manifest and client files only. The
mock-llm agent's native observations (`wasm-term/mock-llm/README.md`, "codex" section) agree
on config files, the cwd ancestor walk, `tmp/arg0`, and the outbound HTTP.

### Files

| What | Where | Remote mode |
| --- | --- | --- |
| `$CODEX_HOME` must exist and be a directory if set; else `$HOME/.codex` | `utils/home-dir/src/lib.rs:13-63` | always |
| `$CODEX_HOME/.env` read; `$CODEX_HOME/tmp/arg0/` created, lock file, symlinks to `current_exe`, PATH prepended; failure only warns | `arg0/src/lib.rs:303-448`, `:184-192` | always (drop in the port's own `main`) |
| Config layers: `/etc/codex/{config,requirements,managed_config}.toml`, `$CODEX_HOME/config.toml`; project-layer walk up from **local** cwd looking for `.git` and `.codex/config.toml` | `config/src/loader/mod.rs:80,113,362-380`, `core/src/config/mod.rs:1529-1533` | always; `getcwd` must work |
| All config I/O goes through `codex_exec_server::LOCAL_FS` = `tokio::fs` + `spawn_blocking` | `exec-server/src/local_file_system.rs:595-1026` | always |
| First-run write of `tui.screen_reader_detection_done` to `config.toml` (atomic: temp + rename) | `tui/src/screen_reader.rs:59-99` | always unless user config ignored |
| `$CODEX_HOME/history.jsonl`: metadata read per thread start; append per prompt with `File::try_lock`, mode 0600 | `tui/src/app_server_session.rs:2546-2550`, `tui/src/app/thread_routing.rs:557-575`, `message-history/src/lib.rs:91-163,285-385` | always (local even when remote) |
| `$CODEX_HOME/auth.json` via `AuthManager` | `cloud-config/src/bundle_loader.rs:102-119` | always (read; absent is fine) |
| `$CODEX_HOME/log/codex-tui.log`: removed at start; written only if `log_dir` is configured | `tui/src/lib.rs:405-409`, `startup_orchestration.rs:744-834` | conditional |
| state sqlite: opened only if the DB file already exists | `tui/src/lib.rs:398-400`, `rollout/src/state_db.rs:208-217` | not on a fresh fs |
| `$CODEX_HOME/version.json` update cache | `tui/src/updates.rs` (`#![cfg(not(debug_assertions))]`), `updates_cache.rs:18-27` | release builds |
| `/dev/tty` opened by crossterm `window_size()` before falling back to stdout | crossterm `src/terminal/sys/unix.rs:86-96` | always (absent is fine) |

### Environment

`CODEX_HOME`, `HOME`, `PATH`; terminal detection reads `TERM`, `TERM_PROGRAM`,
`TERM_PROGRAM_VERSION`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`, `GHOSTTY_RESOURCES_DIR`,
`KITTY_WINDOW_ID`, `WEZTERM_VERSION`, `ITERM_*`, `VTE_VERSION`, `WT_SESSION`, `TMUX`,
`TMUX_PANE`, `ZELLIJ*`, `SSH_TTY`, `SSH_CONNECTION`, `STY`, `DISPLAY`, `WAYLAND_DISPLAY`
(`terminal-detection/src/lib.rs:253-357`, `tui/src/terminal_probe.rs:285-286`). Also
`CODEX_EXEC_SERVER_URL`, `CODEX_SQLITE_HOME`, `CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT`,
`CODEX_TUI_RECORD_SESSION`, `RUST_LOG`, `VISUAL`/`EDITOR`. Leave `TMUX`, `SSH_*`, `WSL_*`
unset in the emulated machine: each one enables a process spawn or an extra probe.

### Processes

None on the default path if `TMUX`/WSL are absent and `TIOCGWINSZ` succeeds. Otherwise:
`tmux display-message` (`tui/src/tui/tmux.rs:35-135`), `cmd.exe` on WSL, `tput cols/lines`
when the winsize ioctl fails (crossterm `src/terminal/sys/unix.rs:99-104`). During a turn the
sleep inhibitor is a no-op on non-linux/mac/windows targets. Git and shell commands run on
the server (`WorkspaceCommand`). User actions that spawn: external editor, `webbrowser::open`,
clipboard helpers.

### Terminal I/O at startup

- Precondition: stdin and stdout are terminals (`tui/src/tui.rs:464-469`), else exit.
- `tui::init()` runs inside `tokio::task::spawn_blocking` (`startup_orchestration.rs:283-287`).
- Modes: `ESC[?2004h`, raw mode (termios), `ESC[>4;0m`, `ESC[>7u` (flags 5 for Ghostty and
  iTerm2), `ESC[?1004h` (`tui.rs:244-265`, `tui/keyboard_modes.rs:223-259`).
- One probe write: `ESC[6n`, `ESC]10;?ESC\`, `ESC]11;?ESC\`, `ESC[?u`, `ESC[c`
  (`tui/src/terminal_probe.rs:277-310`). One shared 250 ms deadline; finishes early only when
  the cursor report, both colours and the keyboard answer have arrived; DA1 without a flags
  reply means "no enhancement". No reply at all degrades gracefully (cursor 0,0, no colours).
  It is implemented with `libc::dup`, `fcntl(O_NONBLOCK)`, `libc::poll`, `libc::read` and
  re-injects leftover bytes with the fork-only `crossterm::event::buffer_input`.
- Later: every draw wrapped in `ESC[?2026h/l`; OSC 8, OSC 0, OSC 22, OSC 52, OSC 9/BEL;
  inline mode uses scroll regions (`ESC[a;br`, `ESC M`); alternate screen and mouse
  (`?1000h ?1002h ?1003h ?1006h`) only for overlays unless `tui.fullscreen_transcript`.
  `ESC[6n` again on resize in the legacy draw path (crossterm `position()`, 2 s timeout).
- Input: `crossterm::event::EventStream`, which on unix parks a dedicated OS thread in
  `mio::Poll` over the tty fd, a SIGWINCH signal pipe and a waker (crossterm
  `src/event/stream.rs:42-61`, `src/event/source/unix/mio.rs`).
- Signals: SIGWINCH through crossterm only. No SIGINT handler (raw mode, Ctrl-C is a key).
  Ctrl-Z calls `kill(0, SIGTSTP)` and waits for SIGCONT (`tui/src/tui/job_control.rs:204-279`).

### Threads and runtime

- `arg0_dispatch_or_else` spawns thread `codex-main` with a **16 MiB stack** and builds a
  multi-thread tokio runtime with 16 MiB worker stacks (`arg0/src/lib.rs:233-243,290-295`,
  `async-utils/src/lib.rs:9`). The code leans on deep stacks.
- Other OS threads on the remote path: tokio workers, tokio blocking pool (every `tokio::fs`
  call, `tui::init`, history lookups), the crossterm reader thread. Conditional: tmux probe
  and size monitor, clipboard worker (first copy), tracing-appender (if `log_dir`), sqlx.
- No `block_in_place`, no rayon in `tui/src`.

### Timers

Frame scheduler actor on `tokio::time::sleep_until`, clamped to 120 fps
(`tui/src/tui/frame_requester.rs:39-127`); streaming commit interval; 10 s connect and
initialize timeouts in the remote client (`app-server-client/src/remote.rs:65-66`).

### Other network use

| What | Remote mode |
| --- | --- |
| Announcement tip: GET `raw.githubusercontent.com/openai/codex/main/announcement_tip.toml`, 2 s timeout (`tui/src/tooltips.rs:193-267`) | every start; failure tolerated. mock-llm found no switch for it |
| Update check (GitHub releases / npm) | release builds; off with `check_for_update_on_startup = false` |
| Cloud config bundle refresh, OTEL export, security-setup prefetch, analytics | conditional on local auth or config; off with `[analytics] enabled = false` |
| `ensure_rustls_crypto_provider()` (aws-lc-rs) before connecting, even for `ws://` (`remote.rs:734`) | always |

## 4. The app-server WebSocket from a browser (question 4)

**[read]** by a sub-agent in `app-server-transport`, `websocket-auth`, `app-server-client`,
`app-server-protocol`; **[ran, by the mock-llm agent]** where noted
(`wasm-term/mock-llm/README.md`).

- **A browser cannot connect to `codex app-server` directly.** Middleware rejects any request
  carrying an `Origin` header, by presence, with no allow-list and no flag:
  `app-server-transport/src/transport/websocket.rs:89-103,152`. Browsers always send `Origin`
  on a WebSocket. Observed natively by the mock-llm agent: the upgrade fails for any origin,
  and the same connect through a bridge that drops the header completes `initialize`.
- **Auth is header-only**: `Authorization: Bearer <token>` on the upgrade
  (`websocket-auth/src/lib.rs:288-319,383-401`), modes `capability-token` and
  `signed-bearer-token` (HS256 JWT). No query parameter, cookie, subprotocol or first-message
  alternative. A browser `WebSocket` cannot set it. A non-loopback bind without auth refuses to
  start (`websocket.rs:135-142`). `--listen` takes `ws://IP:PORT` only; no TLS in the server.
- **So a bridge is required regardless of approach**: same machine as the app-server,
  terminates the browser's WebSocket (and TLS, and whatever authenticates the browser), drops
  `Origin`, adds the bearer token, forwards to the loopback listener. `mock-llm/tap-proxy.ts`
  already does the `Origin` part. The alternative is a two-line patch to the server, which
  means running a patched server.
- **Framing**: text frames only, one JSON object per frame; binary frames are dropped with a
  warning (`websocket.rs:375-377`). No `"jsonrpc"` member (`app-server-protocol/src/rpc.rs:1-2`):
  request `{id, method, params?}`, notification `{method, params?}`, response `{id, result}`,
  error `{id, error:{code,message,data?}}`; `id` is a string or integer. The server also sends
  requests (approvals, user input, MCP elicitation). No subprotocol, no compression offered or
  accepted, no pings required. Limits: 64 MiB per message into the server (tungstenite
  default), 128 MiB into the native client (`remote.rs:67`). A client that stops reading is
  disconnected after 32,768 queued messages (`app-server/src/transport.rs:160-173`).
- **Handshake**: request id `"initialize"` with
  `{"clientInfo":{"name":"codex-tui","title":null,"version":"..."},"capabilities":{"experimentalApi":true,"requestAttestation":false,"optOutNotificationMethods":null}}`
  -> result `{userAgent, codexHome, platformFamily, platformOs}`; then notification
  `{"method":"initialized"}`. Messages arriving before the response must be buffered
  (`remote.rs:820-966`). Then `account/read`, `model/list`, `configRequirements/read`,
  `collaborationMode/list`, `thread/start`, `turn/start` (`tui/src/app_server_session.rs`).
- **Nothing but the one WebSocket** is needed by the protocol. File and config access on the
  server side are RPCs on the same socket. The TUI's other outbound HTTP (section 3) is
  unrelated to the app-server and optional.
- **Client seam**: no trait. `remote.rs:239-247` `connect_with_stream<S>(.., stream: WebSocketStream<S>, ..)`
  plus `initialize_remote_connection` and `write_jsonrpc_message` are generic over the byte
  stream under tungstenite, and only use `stream.next()`, `stream.send(Message::Text)`,
  `stream.close(None)`. Re-typing those three functions over a message-level
  `Stream + Sink` is the patch that substitutes the host WebSocket. The rule that forbids
  `--remote-auth-token-env` on non-loopback `ws://` is `tui/src/lib.rs:440-448`.

## 5. Approaches compared (question 3)

| | a. real TUI crate -> `wasm32-wasip1`, patched | b. same, `wasm32-unknown-unknown` + wasm-bindgen | c. fuller POSIX layer (emscripten or WASIX) | d. emulate the native Linux binary |
| --- | --- | --- | --- | --- |
| What runs | upstream TUI code; forks of crossterm, tokio and a handful of leaves; cfg patches on roughly 20-30 workspace crates | same code, but every OS touchpoint rewritten onto JS | upstream TUI code with fewer cfg patches | the unmodified release binary |
| Effort to first frame | weeks: about 90 workspace crates still to get through the type checker, then run-time bring-up | more than (a): no fs, no clock (`Instant::now` panics), no blocking; tokio `time` unusable | comparable to (a): mio, nix (4 versions), socket2, ring, reqwest all still need forks **[ran]**, plus adopting a second runtime | days, if an emulator fits |
| Fidelity | high; same widgets, same protocol code. Local-only features stubbed | same | high | exact |
| Upgrade cost | re-apply patches each release. The crossterm/tokio/leaf forks are stable; the workspace cfg patches will conflict regularly because the TUI churns | worse: patches are rewrites, not cfg arms | fewer workspace patches, but the forked foundations are larger and not ours | none for codex; a cross-build per release if the emulator's ISA has no upstream binary |
| Performance | native-speed wasm; module likely tens of MB | same | same | interpreter or JIT emulator under a ~100+ MB binary plus a Linux boot; slow start, poor on phones |
| Fits wasm-term | yes: the kernel's ABI as is | no: bypasses the kernel entirely | no: replaces the kernel's ABI with emscripten's syscall layer or WASIX | no: brings its own kernel and tty |

Notes on the rejected ones:

- **(b)** loses exactly what WASI and the emulated machine provide: a filesystem for config and
  history, clocks, blocking calls. Its one attraction, reqwest's `fetch` backend, is the wrong
  API shape for the rest of the graph (section 2, pattern 3).
- **(c), emscripten** was worth measuring because `cfg(unix)` is true there and emscripten
  already has pthreads, MEMFS and termios hooks. The measurement says the foundations still
  fail (mio refuses every non-WASI wasm target outright), so it trades forks we control for
  forks of mio/nix/ring, and it discards the kernel being built here. **WASIX** has the forks
  (tokio, mio, socket2, libc) but needs its own Rust toolchain and a ~100-syscall host, and
  `cfg(unix)` is still false there, so pattern 1 remains.
- **(d)** is the honest fallback, and the only option with zero patch maintenance. Real
  obstacles: no browser emulator runs x86_64 or aarch64 Linux at usable speed (v86 and
  CheerpX are 32-bit x86; Bochs/TinyEMU-class interpreters are far slower), so it means
  building codex for i686 or riscv64 first; the guest speaks TCP, so the browser side needs a
  TCP-terminating shim that turns the guest's HTTP upgrade into a browser `WebSocket`; and it
  contradicts the project's point of emulating the terminal semantics itself. Not tried.

### Single thread or `wasm32-wasip1-threads`

Both compile the same set. The difference is run time:

- **With threads** (`wasi_thread_spawn`, one Worker per guest thread, shared memory) the TUI's
  runtime shape works unpatched: `codex-main` thread, multi-thread tokio, blocking pool,
  crossterm reader thread. The cost is in the kernel: today it lives inside the program's one
  Worker; with guest threads it must be reachable from several Workers at once (thread A
  blocked reading the tty while thread B writes to it), which means moving the kernel out and
  making every syscall an RPC.
- **Single-threaded** needs four contained changes instead: tokio's blocking pool runs
  closures inline (done, in the tokio fork); the port's `main` builds a current-thread runtime
  on the main stack with a large `-z stack-size`; crossterm's `EventStream` parks a waker
  instead of a thread (done, in the crossterm fork); the WebSocket and tty descriptors are
  registered with tokio's WASI I/O driver, which parks in `poll_oneoff`. That last point is
  why the kernel's "everything is a pollable descriptor" design fits: mio's WASI selector is
  `poll_oneoff`.

I recommend single-threaded first because it needs nothing new from the kernel. The risk is a
class of bug I cannot rule out by reading: code that blocks the only thread waiting for
another task (a `std::sync::mpsc::recv`, a `Condvar`, `Handle::block_on` inside what used to
be a blocking-pool thread). The inline blocking pool turns those into deadlocks or panics.

### What would change the recommendation

- **To threads**: more than a couple of such blocking-wait sites turning up during bring-up.
  Then the kernel work is cheaper than chasing them release after release.
- **To (d)**: the workspace patch series not rebasing in under a day or two per codex
  release, or a requirement for local (non-remote) mode, which needs processes and sandboxes
  that no wasm port will have.
- **To a much smaller version of (a)**: upstream finishing the `legacy_core` removal. Once the
  TUI no longer names `codex_core::config::Config`, `codex-app-server-client` can be built
  remote-only and most of the 133 crates drop out of the graph. Worth checking at each
  upgrade before rebasing anything: `grep -c legacy_core tui/src -r`.

## 6. What the emulated machine must provide

(First-session expectations. What happened when the module ran on the machine, and what is
still requested, is in `HOST-REQUESTS.md`.)

Already in the ABI (`wasm-term/guests/wasm-term-sys/src/lib.rs`; `docs/abi.md` was not
written yet when this was) and used by the port: `wasm_term.tcgetattr/tcsetattr/winsize_get`,
`sig_action` + `sig_fd`, `ws_open/ws_send/ws_recv/ws_close`, `poll_oneoff` over terminal,
signal and network descriptors, `fd_fdstat_set_flags` for `O_NONBLOCK`.

Additional requirements, in order of how certain I am that the port needs them. All
**[inferred]** from sections 2-4; none exercised against the kernel yet.

1. **`poll_oneoff` compatible with mio's WASI selector**, since tokio's I/O driver will be the
   one event loop: any mix of `FD_READ` and `FD_WRITE` subscriptions plus one relative
   monotonic clock; level-triggered; a writable subscription on a terminal or WebSocket
   reports ready immediately; a bad descriptor is reported in that event's `error` field
   rather than failing the whole call. Zero-timeout polls must be cheap (crossterm does one
   per `EventStream::poll_next`).
2. **`isatty` must hold for fds 0, 1, 2 through plain WASI**: `fd_fdstat_get` returning
   filetype `CHARACTER_DEVICE` with no seek/tell rights, which is what wasi-libc's `isatty`
   and Rust's `IsTerminal` test. The TUI exits otherwise (`tui/src/tui.rs:464-469`).
3. **Terminal replies** to `ESC[6n`, OSC 10/11 queries, `ESC[?u` and `ESC[c` delivered as
   input within 250 ms, or startup stalls for the full deadline and runs without colours and
   enhanced keys. Synchronized output (`?2026`), bracketed paste, focus events, scroll
   regions, OSC 8/52. These are ghostty-web's job; the kernel must pass them through raw mode
   untouched.
4. **Filesystem semantics the config and history code relies on**: an existing `$CODEX_HOME`
   directory; `getcwd` returning an existing directory (config walks its ancestors);
   `path_rename` over an existing file (atomic config writes); `path_filestat_get` on missing
   paths returning `ENOENT` (the `/etc/codex/*` probes); append mode; `fd_filestat_set_size`.
   Persistence of `config.toml` and `history.jsonl` across page loads is a product question
   (IndexedDB/OPFS behind the vfs), not a porting one.
5. **A big stack and a big module**: main stack of at least 16 MiB (linker `-z stack-size`,
   so the memory import/initial size must allow it), memory growth, and a module of tens of
   megabytes (streaming compilation, HTTP caching).
6. **WebSocket descriptor details**: text frames up to tens of megabytes without truncation
   (thread history replays are large; the native client allows 128 MiB), non-blocking
   `ws_recv` returning `EAGAIN`, distinct close and error events with a reason string (the TUI
   shows it and offers reconnect), and connect failure surfaced as an event within the
   client's 10 s timeout.
7. **Environment**: `HOME`, `CODEX_HOME`, `PWD`, `TERM`, `COLORTERM=truecolor`,
   `TERM_PROGRAM=ghostty` (selects OSC 9 notifications and keyboard flags 5). No `TMUX`,
   `SSH_*`, `WSL_*`.
8. **The bridge in front of the app-server** (section 4) with a URL the page may open. Not
   part of the kernel, but nothing connects without it.
9. Not required, would remove patches: **file locks** (`File::try_lock` on history; std
   returns `Unsupported` on WASI, the port must treat that as "locked by me"); **a pipe or
   eventfd-like descriptor** (lets mio-style wakers work instead of the 20 ms slicing the
   crossterm backend uses under threads); **`wasi_thread_spawn`** (see above);
   **`http_open` wired into a reqwest replacement** so the announcement tip and update check
   work rather than fail.
10. Not needed at all: processes, Unix sockets, inbound network, job control (the port
    should swallow Ctrl-Z).

## 7. Build, burn-down, and how to run it

State at the end of the third session: **the TUI crate compiles, the port links to one
`wasm32-wasip1` module, and it runs as the guest `codex` on the shared dev page** (4790, also over
tailnet HTTPS), against mock-llm through the page's own `/proxy/codex` relay: prompt/reply, tool
call, approval prompt, markdown, long replies with scrolling, resize, paste, overlays, history
across reloads, `/quit`, checked by `web/verify/run.sh codex` against the native captures. It also
still runs headless under Bun on the real kernel (`web/harness.ts`). Approach (a),
single-threaded, held; nothing forced a move to threads.

### Layout

```
wasm-term/ports/codex/
  NOTES.md, HOST-REQUESTS.md
  main/                      the browser `main` (crate codex-wasm-term, a member of the patched codex workspace)
  web/guest.ts               how the shared dev page (wasm-term/web, port 4790) offers the guest: parameters, defaults, persisted directories
  web/harness.ts             headless run of any guest under Bun on the real kernel, xterm-headless as the terminal
  dist/                      (gitignored) codex.wasm (names), codex-small.wasm, codex-ship.wasm, codex-ship-opt.wasm
  dist/site/                 (gitignored) what the page serves: codex-<hash>.wasm with .br and .gz, manifest.json
  scripts/env.sh             build environment (target, wasi-sdk, tokio_unstable, jobs=6)
  scripts/setup.sh           recreate vendor/ trees from upstream pins + patches/
  scripts/check.sh <label>   cargo check the TUI lib for wasm, log to vendor/check-<target>-<label>.log
  scripts/errs.sh <label>    the errors of that log, paths shortened
  scripts/count.sh           how many workspace crates have checked
  scripts/build.sh           link the module into dist/ (PROFILE=wasm | wasm-small | wasm-ship)
  scripts/ship.sh            build.sh for the names and ship profiles, wasm-opt, package.ts: everything the page needs
  scripts/package.ts         content-hash, brotli and gzip a build into dist/site/ and point the manifest at it
  scripts/sizes.ts           section sizes of a module and, with names, code size per crate
  scripts/commit-vendor.sh   commit dirty vendor trees to their port branches and re-export patches/
  scripts/export-patches.sh  regenerate patches/ from the port branches
  scripts/fork-crate.sh      start a crates.io fork under vendor/forks/ (records it in forks.txt)
  scripts/forks.txt          "<crate> <version>" for every fork
  scripts/unixify.sh, unixify-line.sh   cfg(unix) -> cfg(any(unix, target_os = "wasi")), whole file or given lines
  patches/codex/             against openai/codex rust-v0.162.0
  patches/tokio/             against tokio 1.52.3 (crates.io)
  patches/forks/<crate>/     against the crates.io version in forks.txt
wasm-term/vendor/            (gitignored) codex/, tokio/, forks/*, tools/wasi-sdk, tools/binaryen, codex-target/, check-*.log, build-*.log
```

Each tree under `vendor/` is a git repo with a pristine base (`upstream` branch or the upstream
tag) and a `wasm-term-port` branch; `patches/` is `git format-patch` of the difference.
**[ran]** at the end of the second session, and again at the end of the third: every series was
applied to a fresh worktree of its base with `git am` and compared equal to the port branch
(codex, tokio, 15 forks). The crossterm backend is not one of them: it is
`wasm-term/guests/crossterm-wasi` (`wasi.patch` plus `overlay/`, regenerated there).

### Reproduce each stage

```sh
cd wasm-term/ports/codex
scripts/setup.sh                       # only on a machine without vendor/
scripts/check.sh mylabel               # type-check: ~1 min warm, ~10 min cold, 6 jobs
scripts/count.sh                       # "131 of 133" (the other two are proc macros, built for the host)
scripts/build.sh                       # link dist/codex.wasm (names kept): 16 min cold, 15 s after a change to main/,
                                       # 2 min after a change to codex-tui, 4-8 min after a change to a low workspace crate
PROFILE=wasm-small scripts/build.sh    # dist/codex-small.wasm
scripts/ship.sh                        # names build + wasm-ship (fat LTO, 27 min cold) + wasm-opt + package into dist/site/
scripts/ship.sh --names-only           # only the names build, repackaged (the quick loop; open the page with &build=names)

../../mock-llm/up.sh                   # backend in Docker (re-read mock-llm/README.md first)

# headless, on the real kernel (Bun): prints the screen as text
cd web && bun install
bun harness.ts --env CODEX_WASM_CWD=/tmp/wasm-term-workspace @@ --remote ws://127.0.0.1:4796 -c 'sandbox_mode="danger-full-access"' \
  ::: "until:Ask Codex" type:"hello there" wait:300 key:enter "until:Worked for" screen cat:/home/user/.codex/history.jsonl

# in a browser: the shared dev page (wasm-term/web; README "Run it")
#   http://127.0.0.1:4790/?guest=codex            defaults: remote=/proxy/codex, dir=/tmp/wasm-term-workspace, sandbox=danger-full-access
#   ../../web/verify/run.sh codex                 the browser checks (WASM_TERM_URL=https://... for the tailnet URL)
#   cd ../../web && bun verify/profile.ts 'http://127.0.0.1:4790/?guest=codex&build=names&persist=0' --blocked
```

`@@` starts the guest's arguments and `:::` the harness steps (Bun swallows a bare `--`).
Upstream pins rust 1.95.0; everything here ran on stable 1.99.0 (`RUSTUP_TOOLCHAIN=stable`),
where the wasm targets are installed.

### Burn-down

Workspace crates (of the 133 in the TUI's wasm graph) that type-check. Each run is
`scripts/check.sh <n>`, log `vendor/check-wasm32-wasip1-<n>.log`. All **[ran]**.

| Run | Pass | What changed before it | Frontier it exposed |
| --- | --- | --- | --- |
| 0 | 36 | nothing | tokio, crossterm, socket2, C build scripts, ... (section 2) |
| 1-5 | 41 | first session: wasi-sdk, tokio and crossterm forks, four leaf forks, path-uri / path-utils / uds arms | socket2, hickory-proto, opentelemetry-http, openssl-sys, lzma-sys, filedescriptor + serial2, wxc_common, arboard |
| 6 | 41 | re-run to confirm the starting point | same eight |
| 7 | - | socket2 fork (wasip1 arm), tokio `TcpSocket` / `UdpSocket` / `TcpListener::bind` stand-ins, reqwest 0.12 fork (wasm-bindgen backend only on wasm32-unknown), portable-pty fork, gates for wxc_common, native-tls, zip's xz, arboard | rama-net (socket options socket2 lacks on WASI), tonic (`tokio::net::UnixStream`), openssl-sys again (reqwest's default-tls) |
| 8 | - | rama-net and tonic forks; reqwest fork drops native-tls on WASI | rama-tcp, rama-udp (`tokio_util::udp`), opentelemetry-otlp (blocking client impl missing on wasm32) |
| 9 | 71 | rama-tcp, rama-udp, tokio-util, opentelemetry-http forks | codex-git-utils (symlink), codex-state (`file_id`) |
| 10 | - | those two arms | codex-config (system config paths) |
| 11 | - | config loader unixified | codex-exec-server (no-follow fs, positional I/O, fd passing), codex-message-history |
| 12 | - | exec-server WASI fs module, history permissions and locking | codex-arg0, codex-rmcp-client |
| 13 | - | three `cfg(unix)` lines | **codex-core**: 5 errors, all `synthetic_exit_status*` in `exec.rs` |
| 14 | - | exit-status stand-ins | codex-app-server (1 error), codex-app-server-daemon (updater), codex-lmstudio |
| 15-16 | 130 | daemon updater stub, app-server shutdown signal, lmstudio | **codex-tui**: clipboard and `agents_overview` gating only |
| 17-18 | **131** | clipboard gated like Android, `agents_overview` enabled | none: `Finished` |
| 19 | 131 | crossterm switched to `guests/crossterm-wasi` | none |
| link | - | `main/`, WebSocket relay in app-server-client, `wasm` profile | none: `Finished wasm profile in 15m 58s`, 202 MB |

The second NOTES prediction that turned out wrong in the good direction: section 7 of the first
session expected steps 4 and 5 (cut the embedded app-server out, reduce `codex-core` to its
`config` module) to be necessary and the riskiest. Neither was needed. Once the third-party
leaves compiled, all of `codex-core` and `codex-app-server` type-checked with a handful of
stand-ins, because the tokio fork's `process` API makes the ~60 files that spawn things compile
unchanged. The whole graph is linked in; the embedded server is simply never started.

### What exists

| Piece | State | Verified |
| --- | --- | --- |
| crossterm | `guests/crossterm-wasi/crossterm` (the kernel side's fork of the same revision). See "crossterm reconciliation" | **[ran]** in the module, headless and in Chrome |
| tokio fork (1.52.3) | `tokio::process` (every spawn fails `Unsupported`), `tokio::signal::ctrl_c` (never completes), `TcpStream::connect` / `TcpListener::bind` (fail), `TcpSocket` and `UdpSocket` types (every call fails), blocking pool runs closures inline when the thread cannot be spawned | **[ran]**: the TUI's `spawn_blocking` / `tokio::fs` paths execute in the module |
| socket2 fork | wasip1 takes the unix backend over a private copy of libc's wasip2 socket definitions whose functions all fail `ENOTSUP` | **[ran]** compile; a connect attempt fails cleanly at run time **[inferred]** from the TUI staying up while its HTTP requests fail |
| reqwest 0.12, opentelemetry-http, tokio-util forks | `target_arch = "wasm32"` narrowed to `all(wasm32, target_os = "unknown")`, so WASI takes the native hyper path; reqwest also drops hyper-tls/native-tls on WASI | **[ran]** compile and link; no `__wbindgen_*` imports in the module |
| portable-pty fork | no serial, no filedescriptor; `native_pty_system().openpty()` fails | **[ran]** compile |
| rama-net / rama-tcp / rama-udp, tonic forks | a few cfg lines each | **[ran]** compile |
| gethostname, gix-fs, rustls-native-certs, tokio-graceful forks | first session | **[ran]** compile |
| chrono fork (0.4.43) | `chrono::Local` on WASI is the fixed offset in `WASM_TERM_UTC_OFFSET_MINUTES` (the host passes the browser's; `docs/abi.md`) instead of UTC | **[ran]**: turn footers show local time, compared with the browser's clock by `web/verify/codex.js` |
| dirs fork (6.0.0) | `dirs::home_dir()` on WASI is `$HOME` | **[ran]** compile and link; the `~` abbreviation it enables was not exercised (see "Differences from native") |
| codex workspace patch | 9 commits; list below | **[ran]** |
| `main/` | current-thread runtime, `--remote` / `CODEX_REMOTE_ADDR` (any ws/wss URL, so a proxy path works), `CODEX_WASM_CWD`, prepares the emulated home | **[ran]** |
| C toolchain | wasi-sdk 34; aws-lc-sys, ring, libsqlite3-sys, onig_sys, zstd-sys, bzip2-sys, tree-sitter* compile **and link** | **[ran]** |

### What is stubbed (fails at run time on WASI), and what was changed to work

Stubs, none reachable in remote mode without a user action:

- processes of any kind (`tokio::process`, `std::process`): shell tools, git, MCP stdio servers,
  external editor, `tmux`/`tput` probes, the app-server daemon updater, sandbox helpers;
- ptys (`portable-pty`), Unix sockets (`codex-uds`, tonic's UDS connector), TCP/UDP sockets
  (socket2, tokio net), so also every HTTP request the TUI makes itself: the announcement tip,
  update check, cloud config, OTEL export, analytics. They fail fast and are tolerated;
- the embedded (in-process) app-server: **not in the module any more**.
  `InProcessAppServerClient::start` is a stub on WASI that returns `Unsupported`; it was the
  only call from the client into `codex_app_server`, so the linker now drops the server and
  everything in `codex-core` that only the server ran (see "Module"). The crates still
  type-check and are still dependencies; nothing was removed from the graph;
- system clipboard (`arboard`): compiled out as on Android. Copy still goes out as OSC 52;
- native-tls, keyring-style platform integrations, `wxc_common` (Windows MXC), zip's xz;
- symlink creation in `codex-git-utils`; sandboxed file open in `codex-exec-server`;
- `--remote-auth-token-env`: refused with an explanation (a browser cannot send the header);
- the unix-only parts of the TUI that already have a non-unix fallback upstream: job control
  (Ctrl-Z), the terminal-size monitor.

Made to work:

- `codex-exec-server`'s local filesystem (`no_follow/wasi.rs` on plain `std::fs`; positional
  reads and writes by seek). All TUI config I/O goes through this;
- config loader system paths (`/etc/codex/*`), and its packaged-defaults label without
  `current_exe()`;
- `history.jsonl`: append mode; the advisory lock is treated as held;
- `codex-state` quick-check identity by path hash (no `file-id` on WASI);
- the batched startup probe (`tui/src/terminal_probe.rs`), compiled for WASI: wasi-libc has
  `poll`, `read` and `fcntl(O_NONBLOCK)`; there is no `dup`, so the probe opens `/dev/tty` a
  second time, which upstream already has as its fallback. One write of `ESC[6n`, OSC 10, OSC 11,
  `ESC[?u`, `ESC[c`, as natively; ghostty-web answers all five, so the terminal's default colours
  are known and the shaded rows (composer, user messages) are derived from them **[ran]**;
- history across sessions: `message-history` identifies the history file by inode, which std
  does not expose on WASI, and without an identity it refuses every lookup. A fixed identity on
  WASI (one file per machine) makes arrow-up reach prompts from before a reload **[ran]**;
- the transport, below.

Three std holes on WASI that are handled in `main/` rather than patched at each use, **[ran]**
(`vendor`-less probe program under the harness): `std::env::temp_dir()` **panics**
(`not supported by WASI yet`), so `tempfile::env::override_temp_dir("/tmp")` is called first;
`std::env::current_exe()` is `Unsupported`, so a nominal `codex_self_exe` is passed in;
`dirs::home_dir()` was `None`, so `CODEX_HOME` is set explicitly (since the dirs fork it is
`$HOME`, and `CODEX_HOME` is still set so that the page can pin it). `std::fs::canonicalize`
works.

Direct `std::env::temp_dir()` calls would abort the module. The non-test ones that are in the
TUI's graph and can still be reached now that the server is gone are guarded
(`if cfg!(target_os = "wasi") { "/tmp" } else { std::env::temp_dir() }`): `chatgpt` apply
command, `cloud-tasks-client`, `exec-server-protocol` (temp-path normalisation), `hooks` output
spill, the TUI's IDE-context socket lookup. Left alone: `arg0` (its dispatch is not called),
`cli`, `linux-sandbox`, `app-server-test-client` (not in the graph), and call sites inside
`#[cfg(test)]`. **[read]** which are reachable; none was hit in any run before or after.

### Transport

`app-server-client/src/remote.rs` is written against `tokio_tungstenite::WebSocketStream<S>` and
only ever does `next()`, `send(Message::Text)`, `close()`. Instead of re-typing it (what the
first session planned), `remote_wasi.rs` gives it an `S`: the client end of an in-memory
`tokio::io::duplex`. A task on the other end runs tungstenite in the server role with no
handshake and relays whole messages to and from `wasm_term_tokio::WebSocket`. The upstream file
changes by one `cfg`'d function and a few gated imports. Costs: each message is framed and
masked once more in memory, and both directions share 4 MiB pipes, so a message larger than that
in one direction while the other direction is also blocked would stall; not observed, and
client-to-server messages are small.

### crossterm reconciliation

Two WASI backends existed for the same fork revision: the first session's (in this patch
series) and `guests/crossterm-wasi` (kernel side). Both reuse the unix parser path. The codex
port now uses **the guests one**, unmodified, by path
(`crossterm = { path = "../../../guests/crossterm-wasi/crossterm" }` in the workspace
`[patch.crates-io]`; `setup.sh` runs `guests/crossterm-wasi/setup.sh` if the tree is missing).
The port-local patch and `vendor/crossterm` are gone. Reasons: it had been run in the browser;
its `EventStream` registers with tokio's reactor itself, so the port needs no glue task
(the first session's `input_fds()` / `notify_input_ready()` hooks are unnecessary); and one
backend is one thing to keep working. Nothing in the guests needs to change. One thing the
guests side should know: it works with this port's tokio fork as well as with stock tokio.

### tokio: can the fork shrink?

The `async-tui` guest shows stock tokio is enough for the runtime, timers and the reactor. The
fork is still needed here for what codex's dependency graph names or calls:

- `tokio::process` as a module (about 60 workspace files, plus process-wrap under rmcp);
- `tokio::signal::ctrl_c`, `TcpStream::connect`, `TcpListener::bind`, `TcpSocket`, `UdpSocket`
  (hyper-util, hickory, rama, sqlx, tokio-tungstenite name them);
- `spawn_blocking` / `tokio::fs` on a target with no threads. Stock tokio returns an error from
  every such call on wasip1; the TUI does its config I/O, `tui::init()` and history lookups
  that way, so the inline blocking pool is what makes startup work at all.

So it cannot shrink to nothing, but it is additive (648 lines, nine files, three of them new) and touches no
scheduler or driver code.

### Module

What the page serves is `wasm-ship` + `wasm-opt -Oz`, brotli-compressed: **11.4 MB over the
wire, 38.7 MB to compile**, down from 118 MB (38 MB with `gzip -1`) at the end of the second
session. All sizes **[ran]**, in MB (10^6 bytes); gzip is `gzip -1` as in the earlier notes,
brotli is quality 9 with a 16 MiB window (what `package.ts` writes, about 1 minute per build).

| Step | Build | Raw | gzip -1 | brotli 9 |
| --- | --- | --- | --- | --- |
| second session | `wasm` (opt-level 1 workspace, `s` dependencies, names kept) | 202.2 | | |
| second session | `wasm-small` (opt-level `s`, stripped) | 117.8 | 38 | |
| embedded server unreachable (one stub) | `wasm`, names kept | 104.6 | | 15.2 |
| same | `wasm-small` | 58.7 | 18.4 | 11.3 |
| + `wasm-opt -Oz` (no LTO) | `wasm-small` | 47.0 | 18.5 | 12.2 |
| + fat LTO, one codegen unit | `wasm-ship` | 44.9 | 17.3 | 11.3 |
| + `wasm-opt -Oz` | `wasm-ship`, **shipped** | 38.7 | 16.5 | 11.4 |

What each step is and what it bought:

- **The cut.** `scripts/sizes.ts` on the names build attributed 20.7 MB of code to `codex_core`
  instantiations, 13.5 to `codex_tui`, 10.2 to `codex_app_server`. The client enters the server
  in exactly one place, `codex_app_server::in_process::start`; with that call stubbed on WASI
  the code section went from 131.6 MB to 66.9 MB (`codex_core` 20.7 to 5.3, `codex_app_server`
  gone) with no other change. This is the "real cut" the earlier notes expected to need a
  remote-only `codex-app-server-client`; the linker's dead-code removal does it once nothing
  refers to the server. It is also the only step that shrank the download much.
- **LTO.** `lto = "fat"`, `codegen-units = 1`: 58.7 to 44.9 MB raw, 27 minutes cold (the final
  link alone about 15, single-threaded) and 13 GB peak. The compressed size did not move: what
  LTO removes (duplicate generic instances, small non-inlined functions) is what brotli already
  squeezed. It is worth having for the raw size, which is what the browser compiles and holds.
- **`wasm-opt -Oz`** (binaryen 123, `vendor/tools/binaryen`): about 20% off the raw size in 2.5
  minutes, and the compressed size goes *up* slightly (denser code compresses worse). Kept, again
  for the raw size.
- **Names.** Stripped from what ships (`strip = true`). The names build is packaged next to it
  as `&build=names` for `web/verify/profile.ts` and readable traps.
- **opt-level `z`** instead of `s`: not tried. The TUI redraws and re-wraps on every frame and the
  runs here have no way to say what `z` costs there.

What is left in the shipped module by crate (names build, so opt-level 1 for workspace crates:
proportions, not sizes): `codex_tui` 13.1 MB, `codex_config` 7.1, `codex_core` 5.3, `core` 4.6,
`codex_network_proxy` 3.0, `toml` 2.4, `codex_rollout` 2.2, `codex_exec_server` 1.9, `starlark`
1.8. The next cuts would be the things `Config` drags in that a remote client never runs:
the network proxy (rama), exec-policy's starlark, rollout. Each needs its own stub at the point
where config loading reaches it, and none is large by itself.

### Observed running

All **[ran]** against mock-llm (Docker, `up.sh`) through `ws://127.0.0.1:4796`.

Headless (`web/harness.ts`, 100x30):

- start screen identical in content to `mock-llm/baseline/codex-plain.txt` (banner, the five
  slash-command hints, composer, `mock-model default · <cwd>` footer); the cwd shown is the
  server's (`/tmp/wasm-term-workspace`);
- `hello there` -> the scripted reply, `Worked for <1s`;
- `please use a tool` -> `Ran echo mock-llm-tool-ok && pwd`, result, `MOCK-TOOL-DONE`;
- `run with approval` with `sandbox_mode="workspace-write"` -> the approval prompt
  ("Would you like to run the following command?"), `y`, "You approved codex to run ...", result;
- F2 opens the warnings view; `/quit` prints the resume hint and exits with code 0.

Chrome (Xvfb, driven with the `browser-control` CLI; ghostty-web fell back to its canvas
renderer because WebGL2 is unavailable there), 192x55:

- page load to composer about 1.4 s; start screen with the large animated logo;
- typed `hello there`, Enter: the reply rendered (screenshot kept by the reporting agent);
- terminal replies seen by the program: `ESC[1;1R`, `ESC[?7u ESC[?62;22c`; Shift+Enter arrives
  as a CSI-u key and inserts a newline;
- viewport change to 90x29: re-laid out; `/quit`: `exit code 0`;
- idle: 2 `poll_oneoff` calls in 4 s.

Third session, on the shared page (Chrome under Xvfb through `browser-control`, at the tailnet
HTTPS URL; ghostty-web's canvas renderer, there is no GPU), `web/verify/run.sh codex`: 35
checks. With the shipped build it was run five times: three runs passed all 35; one failed only
"the long reply grew on screen in many steps" (not reproduced, cause not found); one stopped at
its first screenshot, which the shared Chrome did not take within 30 s. From that browser on the
same machine the shipped module was downloaded and compiled in 0.4 to 0.5 s and the start screen
was up 0.75 s after navigation, when the machine was not busy (5 s and 10 s in one run when it
was). `web/webkit/smoke.sh` (WebKit's Linux build, desktop and iPhone profiles): the module
downloads, compiles and runs there too, first output about 1 s after navigation, prompt and
reply, and in the iPhone profile the keys row against codex: arrow up recalls, Shift+Enter is a
newline, Ctrl then c clears, Esc closes the slash popup.

What the browser checks cover, each against the mock backend:

- the launcher entry and its defaults; the module's URL, type, encoding and cache headers; the
  loading indicator while it downloads and compiles;
- connect through the page's own origin (`wss://.../proxy/codex`); start screen, plain prompt and
  tool call equal to `mock-llm/baseline/codex-plain.txt` and `codex-tool.txt` line for line after
  normalising times and the captures' older workspace path;
- the turn footer's time equals the browser's local time;
- markdown (emphasis, list, fenced and highlighted code, table, quote); a long reply streaming in
  many steps, the wheel scrolling back through it and forward to its end;
- resize to 84x30 and back; the slash-command popup; `/status`; the warnings viewer (F2);
- paste (the browser's paste event as a bracketed paste), Shift+Enter as a newline, Ctrl+C;
- `wasmTerm.readFile` / `listFiles`; `config.toml` and `history.jsonl` in IndexedDB and not the
  scratch or log directories; arrow-up recalling a prompt from before a reload;
- a line written to the terminal in one burst is shown whole and the Enter after it submits;
- the approval dialog (`sandbox=workspace-write`, prompt `run with approval`) equal to
  `codex-tool-approval.txt`, `y`, the command's output; `/quit` with code 0; files still
  readable after exit.

codex 0.162 owns the whole screen (alternate buffer, mouse reporting, its own transcript
scrolling), so there is no terminal scrollback to compare and no separate transcript pager:
Ctrl+T does nothing in this mode. That is upstream's behaviour, not the port's **[inferred]**
from the native client's identical screens; it was not checked natively.

Differences from native seen so far:

- `~` is not abbreviated. The mechanism is there now (`dirs::home_dir()` is `$HOME`), but the
  paths the TUI shows are the server's and the emulated home is `/home/user`, which is nobody's
  home on the server. `&env=HOME=/home/agent` (the mock server's home; `CODEX_HOME` stays pinned
  by the page) should make the two agree; not run.
- A session across a DST change keeps the offset it started with.
- The TUI's own HTTP requests still fail (announcement tip, update check).

### The "startup stall" (second session's open problem 1): not a stall

The second session saw a burst of characters followed 1.5 s later by Enter put a newline in the
composer instead of submitting, and concluded from key-event timestamps that the only thread
computed for about 1.2 s after the first paint. It did not. What was established, in order:

1. **[ran]** `web/verify/profile.ts` (Chrome's sampling profiler on the Worker, wasm names from
   the module): the longest stretch in which the guest's thread does not go idle is under
   200 ms (start-up: config loading, the first frames), and during the alleged stall the thread
   sits in `poll_oneoff` under tokio's park. `WASM_TERM_TRACE=1` now reports compute gaps of
   100 ms or more; it reports none there.
2. **[ran]** A trace of every `poll_oneoff` and terminal `fd_read`: the eleven characters are read
   in one `fd_read` when they are written, and the Enter is read 1.5 s later. Nothing arrives
   late at the syscall level.
3. **[ran]** Logging inside the TUI (to a file, read back with the new `readFile`): the composer
   received `h` when the burst arrived and the other ten characters only when Enter did, 1 ms
   before it. So ten parsed key events sat somewhere for 1.5 s.

**Root cause: `guests/crossterm-wasi`, `EventStream`.** With no helper thread on WASI, the stream
polls the reader itself, and it did so with a 1 µs timeout. The tty source's loop only runs
`while timeout has time left`, and that is also the loop that hands out events an earlier read
already parsed. Whether 1 µs "has time left" by the time the loop tests it depends on the
clock's granularity and the call overhead; usually it did not. So after one `read` that parsed
several events, the first was delivered and the stream then found the reader "empty", cleared
tokio's readiness and parked. The remaining events came out one per later wake-up, whatever
caused it. Fast typing, key repeat, wheel reports and unbracketed pastes all hit this; a turn's
streaming output masked it by waking the task. Fix: on WASI the source makes one pass even with
a zero timeout (parsed events first, then one non-blocking look at the descriptors), and the
stream asks with zero. It is in `guests/crossterm-wasi` (`wasi.patch`, `overlay/`), not in this
port's patches; the Rust guests were rebuilt with it and `web/verify/run.sh terminal-functions`
still passes (57 of 57).

**[ran]** Harness, burst at the moment the composer appears, Enter 1.5 s later: 0 of 4 submitted
before, 5 of 5 after. The same on the page is a check in `web/verify/codex.js`.

A second effect looked like the same problem in a headless browser and is not in the guest at
all: **the page's main thread is the program's only path for input and network events**, and
software-emulated WebGL (no GPU) took 0.7 to 3.5 s per frame of codex's animated start screen.
Every one of the roughly ten sequential RPCs of start-up then waited for a frame (the proxy log
shows the server answering in 2 to 8 ms and the next request following 250 to 500 ms later),
stretching start-up to seconds, during which input goes to codex's provisional start-up
composer. The page now uses the 2D canvas renderer when WebGL is software (`web/client.ts`;
`&renderer=` overrides): 6 ms between main-thread tasks instead of 1.4 s in the same
measurement. Not established: how a phone's real GPU behaves under the same animation.

### Open problems

1. Memory on a phone is unmeasured. The only number is crude: Playwright's WebKit on Linux, all
   of that browser's processes together, held about 640 to 700 MB more resident memory with the
   shipped module running than before the page was opened (about 800 MB more with the 105 MB
   names build). That includes the terminal, a 32 MiB stack and JavaScriptCore's compiled code.
   It says the engine can do it, and nothing about what iOS allows a tab.
2. Only short sessions were run. Large history replays (multi-megabyte frames), reconnect after a
   dropped socket, and sessions long enough to grow the transcript are untested.
3. `web/harness.ts` starts from an empty `~/.codex` every run (no persistence store outside a
   browser).
4. Ctrl+T (transcript pager) does nothing in 0.162's owned-screen mode; not compared with native.

### Ordered remaining work

1. Measure on a real phone: load time on a mobile network, memory, whether iOS keeps the tab.
   If memory is the limit, the next size steps are in "Module" (stub what `Config` drags in).
2. Authentication for a real server: the proxy must authenticate the browser and add the bearer
   token (HOST-REQUESTS 3). Nothing in the port changes.
3. HTTP for the TUI's own requests through `wasm_term.http_open` as a hyper connector, if the
   announcement tip and update check are wanted.
4. If a busy page main thread turns out to matter on real devices: the network bridge in its
   own Worker (HOST-REQUESTS 5).

### Upgrading to a new codex release

1. Look first: `grep -c legacy_core tui/src -r` in the new tag. When upstream has finished
   moving the TUI off `codex_core::config`, most of this graph and most of the patch series
   disappear, and the right move is to start the series over rather than rebase it.
2. Bump `CODEX_UPSTREAM_TAG` / `CODEX_UPSTREAM_COMMIT` in `scripts/env.sh`, move `vendor/codex`
   aside, run `scripts/setup.sh`. `git am` stops at the first patch that no longer applies;
   fix it there (`git am --continue`), keeping each change a `cfg` arm. The patches most likely
   to conflict are the ones in `tui/` (0004, the probe gates in 0008) and `Cargo.toml`.
3. Check the versions in `scripts/forks.txt` and `setup.sh` (tokio) against the new
   `Cargo.lock`: a fork must be of the version the lock file names, or cargo ignores the
   `[patch]` entry with a warning. For a changed version, move the old fork aside, re-run
   `setup.sh` (it copies the new version and applies `patches/forks/<crate>`), fix what fails.
4. If the crossterm revision in `[patch.crates-io]` changed, set `CROSSTERM_REV` in
   `guests/crossterm-wasi/setup.sh` and regenerate there (`setup.sh --force`); its three layers
   are described in that script.
5. `scripts/check.sh <label>` until `scripts/count.sh` says all but the proc macros check, then
   `scripts/ship.sh`, the harness line above, `web/verify/run.sh codex` and
   `web/webkit/smoke.sh`.
6. `scripts/commit-vendor.sh "<what changed>"` (commits each dirty tree to its `wasm-term-port`
   branch and re-exports `patches/`), then prove the series: apply each to a fresh worktree of
   its base with `git am` and compare with the port branch (the loop is at the end of this
   file).
7. Things that silently go wrong rather than fail: a new call from the client into
   `codex_app_server` (the module doubles in size; `scripts/sizes.ts` shows it), a new direct
   `std::env::temp_dir()` on a reachable path (aborts when hit), a new `cfg(unix)` /
   `cfg(not(unix))` pair around terminal start-up in `tui/src/tui.rs` (the WASI build silently
   takes the fallback).

## 8. Rules followed

`~/.codex` was not touched; nothing was executed that reads or writes a codex home, and no
model provider was called. Second session: the mock backend was only ever started with
`mock-llm/up.sh` (it had been taken down by someone else mid-session); the native `codex` was run
once as a client through `mock-llm/run-codex-client.sh` to compare paste behaviour; one npm
package (`@xterm/headless`) was installed under `ports/codex/web/node_modules`. Nothing new was
installed system-wide or into `~/.rustup`.

Third session: nothing in `~/.codex` or the user's opencode/codex state was touched; the native
`codex` was run once as a client (`mock-llm/run-codex-client.sh`, isolated home) to compare paste
behaviour, with `termctrl`; no model provider was called. Profiling and the main-thread
measurements used a private headless Chrome started by Playwright from `web/node_modules`, not
the shared one. binaryen 123 was added under `wasm-term/vendor/tools/binaryen`; nothing was
installed system-wide. The dev server unit was restarted several times and is running; the
Docker backend and the tailscale serve entry were left as they were.

Re-applying the series (what "confirmed" means above):

```sh
cd wasm-term/ports/codex && source scripts/env.sh
check() { # <repo> <base ref> <patch dir>
  git -C "$1" worktree add -q --detach /tmp/reapply "$2" &&
  git -C /tmp/reapply -c user.name=port -c user.email=port@local am -q "$3"/*.patch &&
  git -C /tmp/reapply diff --quiet HEAD "$(git -C "$1" rev-parse wasm-term-port)" && echo "ok $1"
  git -C "$1" worktree remove --force /tmp/reapply
}
P="$PWD/patches"   # absolute: git -C changes directory
check "$CODEX_SRC" "$CODEX_UPSTREAM_TAG" "$P/codex"
check ../../vendor/tokio upstream "$P/tokio"
for d in ../../vendor/forks/*/; do check "${d%/}" upstream "$P/forks/$(basename "$d")"; done
```

Toolchains added (first session): wasi-sdk 34 and emsdk under
`wasm-term/vendor/tools/`, and the `wasm32-unknown-emscripten` rust-std component for the
stable toolchain via rustup (for the approach (c) measurement). Running rustup inside the
checkout also made it sync the 1.95.0 toolchain that upstream's `rust-toolchain.toml` pins
(it downloaded at least the `rust-src` component); the builds here do not use it.
