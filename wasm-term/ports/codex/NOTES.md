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

It is a large port, not a small one. At this tag the TUI crate still type-depends on
`codex-core` (through `codex_app_server_client::legacy_core::config`), so the whole
workspace graph is in play: 133 workspace crates, 928 packages. **41 of the 133 check for
wasm today** after this work (36 before). The rest are blocked behind seven third-party
leaves and two C libraries listed in section 7; the TUI crate itself has not been reached
by the compiler yet.

What exists and works now, all reproducible with `scripts/setup.sh` and `scripts/check.sh`:

- the crossterm fork codex pins, with a backend on the wasm-term ABI, checking clean for
  `wasm32-wasip1`, `wasm32-wasip1-threads` and native;
- tokio 1.52.3 with all the features codex enables checking for `wasm32-wasip1`;
- a wasi-sdk C toolchain setup under which the C dependencies that matter (aws-lc, ring,
  sqlite, oniguruma, zstd, bzip2, tree-sitter) get through their build scripts.

Nothing has been linked or executed in the kernel yet.

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

## 7. Build attempt and burn-down

### Layout

```
wasm-term/ports/codex/
  NOTES.md
  scripts/env.sh             build environment (target, wasi-sdk, tokio_unstable, jobs=6)
  scripts/setup.sh           recreate vendor/ trees from upstream pins + patches/
  scripts/check.sh           cargo check the TUI lib for the wasm target, summarise failures
  scripts/export-patches.sh  regenerate patches/ from the port branches in vendor/
  scripts/fork-crate.sh      start a new crates.io fork under vendor/forks/
  scripts/unixify.sh         rewrite cfg(unix) -> cfg(any(unix, target_os = "wasi")) in a file
  patches/codex/             against openai/codex rust-v0.162.0
  patches/crossterm/         against openai-oss-forks/crossterm ed1cdab
  patches/tokio/             against tokio 1.52.3 (crates.io)
  patches/forks/<crate>/     against the crates.io version in Cargo.lock
wasm-term/vendor/            (gitignored) codex/, crossterm/, tokio/, forks/*, tools/wasi-sdk,
                             tools/emsdk, codex-target/, check-*.log
```

Each tree under `vendor/` is a git repo with a pristine base (`upstream` branch or the
upstream tag) and a `wasm-term-port` branch; `patches/` is `git format-patch` of the
difference. **[ran]** every series re-applies cleanly to its pristine base and reproduces
the port branch exactly.

Reproduce:

```sh
cd wasm-term/ports/codex
scripts/setup.sh                      # only needed on a machine without vendor/
scripts/check.sh mylabel              # wasm32-wasip1; ~1 min warm, ~10 min cold, 6 jobs
WASM_TARGET=wasm32-wasip1-threads scripts/check.sh mylabel
```

Upstream pins rust 1.95.0; the checks ran on stable 1.99.0 (`RUSTUP_TOOLCHAIN=stable`)
because that is where the wasm targets are installed. No toolchain-version errors appeared.

### Done

| Piece | State | How verified |
| --- | --- | --- |
| crossterm fork + `src/wasi_compat.rs` | raw mode, window size, SIGWINCH via `sig_fd`, input via `poll_oneoff`, threadless `EventStream` with `wasi_compat::input_fds()` / `notify_input_ready()` hooks for the embedder's reactor. The unix code is reused: the module offers look-alikes of the rustix/mio/signal-hook pieces it calls, pulled in with one `use` per file | **[ran]** `cargo check` for wasip1, wasip1-threads, native. Not executed |
| tokio fork | `tokio::process` (API-compatible, every spawn fails `Unsupported`), `tokio::signal::ctrl_c` (never completes), `TcpStream::connect` (fails), blocking pool runs inline when the target has no threads | **[ran]** checks for wasip1 with fs, io-std, io-util, macros, net, process, rt, rt-multi-thread, signal, sync, time. Not executed |
| gethostname, gix-fs, rustls-native-certs, tokio-graceful | third `cfg` arm each | **[ran]** check as part of the graph |
| workspace: `utils/path-uri`, `utils/path-utils`, `uds` | WASI arms (uds: same shape, every call `Unsupported`) | **[ran]** |
| `[patch.crates-io]` in `codex-rs/Cargo.toml` | points crossterm, tokio and the four leaves at `vendor/` | **[ran]** |
| C toolchain | wasi-sdk 34 via `CC_/CFLAGS_wasm32_wasip1*`; aws-lc-sys, ring, libsqlite3-sys, onig_sys, zstd-sys, bzip2-sys, tree-sitter* build scripts pass for wasip1 | **[ran]**; linking not attempted |

Workspace crates that check for `wasm32-wasip1`: **41 of 133** (`vendor/ok-crates-5.txt`).
Gained by the port: ansi-escape, file-search, uds, utils/path-uri, utils/path-utils, plus
third-party crossterm, ratatui-crossterm, process-wrap, sqlx-core, tokio-tungstenite.

Another agent is building a crossterm WASI backend for the same fork revision under
`wasm-term/guests/crossterm-wasi/` in parallel, against the live kernel. There should be one.
Theirs will have been run; mine additionally keeps the unix parser path and has the
`EventStream` hooks tokio needs. Reconcile before either is depended on.

### Current frontier (run 5, `vendor/check-wasm32-wasip1-5.log`) **[ran]**

| Blocker | Exact error | Reaches the TUI through | Intended fix |
| --- | --- | --- | --- |
| socket2 0.6.3 | `src/lib.rs:187: error: Socket2 doesn't support the compile target` | hyper-util, rama-net, codex-shell-escalation (-> codex-arg0) | fork with a `sys/wasi.rs` whose every call is `Unsupported`; gate shell-escalation out of arg0 on WASI |
| hickory-proto 0.25.2 | `src/runtime.rs:122: error[E0432]: unresolved imports tokio::net::TcpSocket, tokio::net::UdpSocket` | hickory-resolver <- rama-dns <- rama-tcp <- codex-network-proxy <- codex-config, codex-protocol | make `codex-network-proxy` types-only on WASI (config and protocol use about a dozen plain types and two helper functions from it), dropping rama |
| opentelemetry-http 0.31.0 | `src/lib.rs:96: error: future cannot be sent between threads safely` (reqwest's wasm backend) | codex-otel | reqwest decision below |
| openssl-sys 0.9.111 | `Could not find directory of OpenSSL installation` | native-tls <- codex-http-client | make `native-tls` a non-WASI dependency of http-client |
| lzma-sys 0.1.20 | `signal.h: error: "wasm lacks signal support"`, `call to undeclared function 'pthread_sigmask'` | xz2 <- zip <- codex-core-plugins | disable zip's `xz`/`lzma` feature on WASI, or gate plugin archive handling |
| filedescriptor 0.8.3, serial2 0.2.33 | `cannot find type RawFileDescriptor`, `cannot find type SerialPort in module sys` | portable-pty <- codex-utils-pty <- core, exec-server, arg0 | gate portable-pty in `utils/pty` on WASI; spawn functions return `Unsupported` |
| wxc_common | `src/exec_stream.rs:62: cannot find interruptible_reader in the crate root` | codex-mxc-sandbox <- codex-sandboxing | gate mxc-sandbox on WASI |
| arboard 3.6.1 | `src/lib.rs:82: cannot find Clipboard in platform` | codex-tui directly | widen the existing `cfg(not(target_os = "android"))` gates in the TUI to exclude WASI; OSC 52 path remains |

### Ordered remaining work

1. **Clear the frontier above** (eight items; each is a gate or a stub, none needs design
   except reqwest). Expect each to expose another layer.
2. **Decide reqwest.** Recommended: fork reqwest 0.12 and 0.13 so that the wasm-bindgen
   backend is selected only for `target_os = "unknown"`, letting WASI take the native hyper
   path, which then fails at connect time through the tokio/socket2 stand-ins. That keeps
   every caller compiling unmodified. Wiring real HTTP to the kernel's `http_open` can come
   later as a hyper connector; the remote TUI does not need it.
3. **Get the data crates through**: codex-http-client, codex-network-proxy, codex-protocol,
   codex-config, codex-app-server-protocol. At that point a protocol-level test guest is
   possible, independent of the TUI.
4. **Cut the embedded server**: in `codex-app-server-client`, make `codex-app-server` a
   non-WASI dependency; on WASI provide same-named stand-ins for the handful of in-process
   types the TUI names (`InProcessServerEvent`, `EmbeddedNetworkPolicy`, `StateDbHandle`,
   `LogDbLayer`, `InProcessClientStartArgs`). This removes the largest crate and its
   exclusive dependencies from the graph.
5. **`codex-core` for its `config` module only**: gate the other top-level modules in
   `core/src/lib.rs` on `not(target_os = "wasi")`, keeping `config`, `otel_init` and whatever
   they reference in-crate (`windows_sandbox`, `unified_exec`, `path_utils`, `context`,
   `responses_metadata` are named by `config/mod.rs`). This is the step with the most
   uncertainty; if `config` drags too much of core with it, fall back to making all of core
   type-check, which the tokio process stand-in was built to make possible.
6. **The crates `core::config` and the TUI name**: mcp, rmcp-client, exec-server, sandboxing,
   login (keyring), models-manager, model-provider, core-plugins, git-utils, state/rollout
   (sqlx), otel, backend-client, feedback, cloud-config, connectors, realtime-webrtc,
   worktree, arg0. Mostly pattern 1 and pattern 5 fixes; `scripts/unixify.sh` handles files
   whose unix arms are std-only.
7. **The TUI crate itself**: `terminal_probe.rs` (libc dup/fcntl/poll/read -> a WASI arm on
   `poll_oneoff`), `tui/job_control.rs` (no suspend), `tui/terminal_stderr.rs`, clipboard,
   `external_editor.rs`, `webbrowser`, `libc::tcflush` in `tui.rs:426-433`, history file
   locking.
8. **Transport**: re-type the three functions in `app-server-client/src/remote.rs` over a
   message-level stream and add a WASI implementation on `wasm_term.ws_*` registered with
   tokio's I/O driver; skip `ensure_rustls_crypto_provider` there.
9. **A port `main`** (`ports/codex/` crate, not a patch): parse the endpoint, build a
   current-thread runtime, call `codex_tui::run_main(.., Some(endpoint))`, and run the small
   task that awaits readability of `crossterm::wasi_compat::input_fds()` and calls
   `notify_input_ready()`. Link with a 16 MiB+ stack.
10. **Link**, then measure module size; then run in the kernel against `mock-llm` through the
    bridge and compare with `mock-llm/baseline/codex-*.txt`.
11. Only then: threads or not, real HTTP or not, persistence.

Steps 1-7 are type-checking work and can be measured with `scripts/check.sh` the whole way;
8-10 are where unknown run-time problems will appear.

## 8. Rules followed

`~/.codex` was not touched; nothing was executed that reads or writes a codex home, and no
model provider was called. Toolchains added: wasi-sdk 34 and emsdk under
`wasm-term/vendor/tools/`, and the `wasm32-unknown-emscripten` rust-std component for the
stable toolchain via rustup (for the approach (c) measurement). Running rustup inside the
checkout also made it sync the 1.95.0 toolchain that upstream's `rust-toolchain.toml` pins
(it downloaded at least the `rust-src` component); the builds here do not use it.
