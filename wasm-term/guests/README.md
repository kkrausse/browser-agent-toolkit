# Guests

Programs built for the wasm-term guest ABI (`../docs/abi.md`), all
`wasm32-wasip1`, all running unmodified on the kernel in the browser.

| Guest | What it proves |
| --- | --- |
| `repl` | Cooked mode. Lines read from ordinary `std::io::stdin()`; echo, backspace, `^W`, `^U`, `^V`, `^D`, `^C` are all the kernel's line discipline. Also `stty`, a password prompt (ECHO off), vfs commands, and `keys`: a raw-mode dump of the exact bytes each key, paste, click and focus change sends. |
| `tui` | Raw mode. ratatui on the stock `CrosstermBackend`: alternate screen, colours, kitty keyboard, mouse, bracketed paste, focus, resize, and a 50 ms timer multiplexed with input through `crossterm::event::poll`. |
| `async-tui` | The codex shape: tokio `current_thread` + crossterm `EventStream` + ratatui + a WebSocket + a streamed HTTP body, in one `select!`. |
| `net` | The WebSocket and streaming-HTTP primitives against the dev server's `/test/` endpoints, then one `poll` loop over keyboard + WebSocket + event stream + timer. |
| `events` | Prints each crossterm event. A small probe for the crossterm backend. |

Libraries:

| Crate | What |
| --- | --- |
| `wasm-term-sys` | Bindings for the ABI: `termios`, `signal`, `poll`, `net`. No dependencies. |
| `wasm-term-tokio` | tokio adapters: `Readiness` (an `AsyncFd` for wasi), async `WebSocket`, async streaming `http`. |
| `crossterm-wasi/` | The crossterm fork codex pins, made to build for wasi. Generated; see below. |

## Build

```sh
./build.sh          # cargo build --release for wasm32-wasip1, copies *.wasm to dist/
```

The first run executes `crossterm-wasi/setup.sh`, which clones the crossterm
fork (network needed once). `.cargo/config.toml` sets the target and
`--cfg tokio_unstable`.

## crossterm on wasm32-wasip1

crossterm does not build for wasi: every backend is behind `cfg(unix)` or
`cfg(windows)`. codex needs the real thing, because it uses ratatui's
`CrosstermBackend`, crossterm's `EventStream`, and (through
`[patch.crates-io]`) the `openai-oss-forks/crossterm` fork with extra queries.

### What was chosen

**Make that fork's own unix backend compile for wasi**, rather than write a
new backend or a crossterm-shaped shim. `crossterm-wasi/setup.sh` produces
`crossterm-wasi/crossterm/` from the pinned revision
(`ed1cdab335221515706178d68495bba2aed1924f`, the one in
`codex-rs/Cargo.toml`) in three layers:

1. `mechanical.sh`: `cfg(unix)` becomes `cfg(any(unix, target_os = "wasi"))`
   by sed. No judgement involved, so it re-applies to any revision.
2. `wasi.patch`: about 20 changed lines. Selects the poll-based tty event
   source on wasi (upstream's `use-dev-tty` variant; the default one needs
   mio's unix `SourceFd`), redirects a few `use` lines, adds the wasi
   dependencies, swaps the `EventStream` module.
3. `overlay/`: two new files.
   - `src/wasi_compat.rs` supplies what the unix code asks the OS for, under
     the names it already uses: `termios` (tcgetattr/tcsetattr/winsize over
     the `wasm_term` imports), `filedescriptor::poll` (over `poll_oneoff`),
     `signal_hook::low_level::pipe::register` (over a signal descriptor), and
     a `UnixStream` stand-in for the two self-pipes.
   - `src/event/stream_wasi.rs`: `EventStream` without a thread.

The result: the input parser, the escape-timeout handling, raw mode,
`supports_keyboard_enhancement`, `cursor::position`, the fork's colour
queries and input-discard logic are upstream's code, compiled unchanged. Only
the syscalls underneath differ. rustix (which supports wasi) still does the
plain descriptor work.

`guests/Cargo.toml` applies it with

```toml
[patch.crates-io]
crossterm = { path = "crossterm-wasi/crossterm" }
```

and ratatui 0.30.2 with the `crossterm` feature builds against it with no
changes. `tui` and `async-tui` use the same crossterm and ratatui versions and
features as codex-rs.

### Why not the alternatives

- *A separate ratatui `Backend` plus a crossterm-shaped event reader.* Small
  for a demo, but codex names crossterm types throughout (`KeyEvent`,
  `EventStream`, commands via `execute!`, the fork's query functions). Every
  one of those would need a twin, and the input parser would be a
  reimplementation that drifts from upstream.
- *A new `cfg(target_os = "wasi")` backend inside crossterm.* That is a copy
  of `tty.rs` (which already exists twice upstream, as `tty.rs` and `mio.rs`)
  and of the terminal mode code. More to maintain for the same behaviour.

### `EventStream` and tokio

Upstream's `EventStream` parks a helper thread in a blocking poll and has it
wake the stream's task. wasm32-wasip1 has no threads. The wasi version asks
the async runtime's reactor to do the waiting:

- tokio's I/O driver works on wasi (mio over `poll_oneoff`) when built with
  `--cfg tokio_unstable` and the `net` feature. A `current_thread` runtime
  then parks in one `poll_oneoff` covering registered descriptors and the next
  timer.
- tokio on wasi can only register TCP streams, so a descriptor is registered
  by dressing it as one: `TcpStream::from_std(std::net::TcpStream::from_raw_fd(fd))`.
  It is used only for readiness (`poll_read_ready` / `readable()`), never read
  as a socket. `try_io(Interest::READABLE, || Err(WouldBlock))` clears the
  cached readiness after a drain.
- mio's wasi backend is level-triggered and tokio registers read *and* write
  interest. A descriptor that polls writable would wake the runtime on every
  park. So `EventStream` watches a second, read-only descriptor on the
  terminal (`/dev/tty` opened for reading) and its own SIGWINCH descriptor;
  the ABI guarantees neither ever polls writable. **Do not register fd 0, 1 or
  2 with tokio.**
- When either is readable the stream runs the ordinary event reader with a
  1 µs timeout (a zero timeout only inspects already-parsed events), which
  reads the terminal without blocking.

Consequences for the codex port:

- `EventStream::new()` must be called inside a tokio runtime with I/O enabled
  (`enable_all()` / `enable_io()`), and the crate must be built with
  `--cfg tokio_unstable` and tokio's `net` feature.
- The runtime must be `current_thread`. `rt-multi-thread`,
  `spawn_blocking`, `tokio::fs`, `tokio::process`, `tokio::signal` and real
  `tokio::net` sockets do not exist on this target; code using them has to be
  cut or replaced.
- `event-stream` on wasi pulls in tokio (optional dependency of the fork).
- Measured idle cost in `async-tui` (10 Hz ticker): about 20 `poll_oneoff`
  calls per second, no spinning (`?env=WASM_TERM_TRACE=1` shows it).

### Network for tokio programs

`wasm-term-tokio` wraps the ABI's pollable descriptors the same way:

```rust
let mut ws = wasm_term_tokio::WebSocket::connect("ws://host/path", &[])?;
ws.send_text("hi")?;                       // synchronous, never blocks
let event = ws.recv().await?;              // Open / Text / Binary / Close / Error

let mut response = wasm_term_tokio::http("GET", url, &[("accept", "text/event-stream")], b"").await?;
let n = response.read(&mut buf).await?;    // returns as bytes arrive; 0 = end
```

`Readiness::new(fd)` is the general tool for any other descriptor.

codex talks to its app-server through `tokio-tungstenite`. That crate does its
own TCP + TLS + framing, none of which exists here: the browser owns the
socket and hands over whole messages. The port should replace the transport
with `wasm_term_tokio::WebSocket` at the point where codex has a
stream/sink of messages, not try to run tungstenite over a byte stream. Note
the browser cannot set custom headers on a WebSocket handshake, only
subprotocols; anything codex sends as a header (auth) needs another route
(query string, subprotocol, or a first message).

## Changing the crossterm port

```sh
crossterm-wasi/setup.sh --force           # fresh tree at the pinned revision
# edit files under crossterm-wasi/crossterm/
git -C crossterm-wasi/crossterm diff > crossterm-wasi/wasi.patch
# new/overlay files are untracked in that clone: copy edits back to crossterm-wasi/overlay/
```

To move to a newer fork revision, set `CROSSTERM_REV` (and update the
default in `setup.sh`); the mechanical step re-applies by itself and the patch
touches only `use` lines and module selection.
