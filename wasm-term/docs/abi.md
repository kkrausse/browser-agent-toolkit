# wasm-term guest ABI

The contract between a program (a `wasm32-wasip1` module) and the emulated
machine it runs on. The implementation is `host/wasi.ts` (imports),
`host/machine.ts` (signals, network handles, the event ring) and `kernel/`
(the pty and line discipline). Rust bindings: `guests/wasm-term-sys`.

A guest:

- exports `memory` and `_start` (a WASI *command*);
- imports from `wasi_snapshot_preview1` (standard) and, optionally, from
  `wasm_term` (this document, section 3);
- runs on one thread, in a Web Worker. Blocking calls block that Worker.

All integers are little-endian. "errno" always means a WASI preview1 errno
number (0 = success); these are also the target's native `errno` values, so
`std::io::Error::from_raw_os_error` gives the right `ErrorKind`.

| errno | value | | errno | value |
| --- | --- | --- | --- | --- |
| `AGAIN` | 6 | | `NOENT` | 44 |
| `BADF` | 8 | | `NOTCONN` | 53 |
| `EXIST` | 20 | | `NOTDIR` | 54 |
| `INTR` | 27 | | `NOTEMPTY` | 55 |
| `INVAL` | 28 | | `NOTSUP` | 58 |
| `IO` | 29 | | `NOTTY` | 59 |
| `ISDIR` | 31 | | `RANGE` | 68 |
| `LOOP` | 32 | | `SPIPE` | 70 |

## 1. Process environment

| Thing | Value |
| --- | --- |
| fd 0, 1, 2 | the pty slave (three separate descriptors on the same terminal) |
| fd 3 | preopened directory `/` |
| argv | `[<guest name>, ...]` from the page (`?arg=`) |
| env | `TERM=xterm-256color COLORTERM=truecolor HOME=/home/user USER=user PWD=/home/user LANG=C.UTF-8`, plus whatever the page passes. The dev page adds `WASM_TERM_ORIGIN=<page origin>` and each `?env=K=V` |
| cwd | wasi-libc starts at `/`; call `chdir($HOME)` if you want the home directory |
| exit | `proc_exit(code)`, returning from `_start` (code 0), a fatal signal (128 + signo), or a trap (134) |

A Rust panic with `panic = "abort"` prints its message to the terminal and
traps; the page shows the trap as the exit reason.

Set `WASM_TERM_TRACE=1` in the environment to have the host log, once a
second, how many times each import was called. It shows what a program is
blocked in, or that an event loop is spinning.

## 2. WASI preview1

Everything in preview1 is present. What matters is how it maps to the machine.

### Terminal descriptors

`fd_fdstat_get` reports a terminal as `CHARACTER_DEVICE` with all rights
except `FD_SEEK`/`FD_TELL`, which is what wasi-libc's `isatty()` (and so
`std::io::IsTerminal`) tests for.

- `fd_write` on a terminal goes through the line discipline's output
  processing (OPOST/ONLCR: `\n` becomes `\r\n` unless the program turned it
  off) and never blocks.
- `fd_read` on a terminal follows the current termios settings:
  canonical mode returns one line per call (or 0 at EOF, i.e. `^D` on an empty
  line); non-canonical mode follows `VMIN`/`VTIME` exactly as on Linux.
- `O_NONBLOCK` (`fd_fdstat_set_flags` with `FDFLAG_NONBLOCK` = 4): a read that
  would block fails with `AGAIN`. The flag is per descriptor, so setting it on
  fd 0 does not affect fd 1.
- `fd_read` fails with `INTR` when a signal whose disposition is *catch* (3.2)
  is delivered while the call is in progress and no data is available. (Rust's
  `read_line`/`read_to_end` retry `Interrupted`; plain `read` returns it.)
- Opening `/dev/tty` gives another descriptor on the same terminal. Opened
  read-only, it never polls writable (see `poll_oneoff`).
- `/dev/null` reads as EOF and discards writes.

Echo, erase (`^?`), word erase (`^W`), kill (`^U`), literal-next (`^V`),
reprint (`^R`), `^S`/`^Q`, and signal characters are handled by the kernel
before the program sees anything, as on a Unix tty. A program that wants raw
bytes must say so with `tcsetattr`.

Input is processed, and echoed, when the program enters a host call. A program
that computes without making any call sees no echo and no `^C` until its next
call; the page can still kill it.

### `poll_oneoff`

Any mix of subscriptions; blocks until at least one is ready.

- `CLOCK`: relative or absolute (`SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME`),
  clock 0 (realtime) or anything else (monotonic).
- `FD_READ` readiness, by descriptor kind:

  | Descriptor | Readable when |
  | --- | --- |
  | terminal | a `read` would not block: a full line or EOF in canonical mode; `>= VMIN` bytes (or 1 byte if `VTIME > 0` or `VMIN = 0`) otherwise |
  | signal descriptor | a caught signal is queued |
  | WebSocket | an event is queued (or the socket has finished) |
  | HTTP | the response head has arrived and not been taken; or body bytes are available; or the body has ended or failed |
  | file, directory, `/dev/null` | always |

  The event's `nbytes` is the number of bytes a read would return now (at
  least 1). wasi-libc implements `ioctl(FIONREAD)` from this field.
- `FD_WRITE`: ready at once for terminals open for writing, files and
  `/dev/null`. **Never ready** for signal, WebSocket and HTTP descriptors and
  for a terminal opened read-only, because those cannot be written with
  `fd_write`. This is deliberate: mio's wasi backend is level-triggered and
  tokio registers both directions, so a descriptor that always polled writable
  would make the runtime spin.
- Unknown descriptor: an event with `error = BADF`.
- `poll_oneoff` itself never fails with `INTR`. To notice a signal while
  polling, include a signal descriptor in the subscriptions.
- `nsubscriptions = 0`: `INVAL`.

`std::thread::sleep`, tokio's timers and mio's `Poll` all end up here.

### Clocks, random, args

`clock_time_get(REALTIME)` is wall time; any other clock id is monotonic
(`performance.now()`, 5 µs resolution on a cross-origin isolated page).
`random_get` is `crypto.getRandomValues`.

### Filesystem

An in-memory tree, created fresh for every program start, with `/dev/tty`,
`/dev/null`, `/tmp`, `/etc` and `$HOME` present. Files, directories, symlinks,
hard links, rename, readdir, seek/pread/pwrite, truncate all work. There are
no permissions and nothing persists. The page can pre-populate files
(`ProgramOptions.files`). `fd_filestat_set_times` and
`path_filestat_set_times` succeed and do nothing.

### Sockets

`sock_recv` / `sock_send` behave as `fd_read` / `fd_write` (so a descriptor
from this ABI can be wrapped in `std::net::TcpStream` for runtimes that only
know sockets), `sock_shutdown` succeeds, `sock_accept` is `NOTSUP`. There is
no `connect`: outbound connections are made with section 3.3.

### Signals through WASI

`proc_raise(signo)` delivers a signal to the program itself.

## 3. The `wasm_term` import module

Everything WASI lacks. Every function returns an errno as `i32`. Pointers are
`i32` offsets into the guest's memory.

### 3.1 Terminal

```
tcgetattr(fd: i32, termios: *mut Termios) -> errno
tcsetattr(fd: i32, action: i32, termios: *const Termios) -> errno
winsize_get(fd: i32, winsize: *mut Winsize) -> errno
```

`BADF` if `fd` is not open, `NOTTY` if it is not a terminal, `INVAL` for an
unknown `action`.

`action`: `TCSANOW` = 0, `TCSADRAIN` = 1 (same as NOW: output never queues),
`TCSAFLUSH` = 2 (also discards unread input).

`Termios`, 44 bytes, alignment 4:

| Offset | Field | Type |
| --- | --- | --- |
| 0 | `c_iflag` | u32 |
| 4 | `c_oflag` | u32 |
| 8 | `c_cflag` | u32 |
| 12 | `c_lflag` | u32 |
| 16 | `c_cc` | u8[20] |
| 36 | `c_ispeed` | u32 |
| 40 | `c_ospeed` | u32 |

`Winsize`, 8 bytes: `ws_row: u16`, `ws_col: u16`, `ws_xpixel: u16`,
`ws_ypixel: u16` (the Linux `struct winsize`).

Flag bits and `c_cc` indexes are the **Linux values**, so constants from
`libc` for Linux port unchanged:

| `c_iflag` | | `c_oflag` | | `c_lflag` | |
| --- | --- | --- | --- | --- | --- |
| `ISTRIP` | 0x20 | `OPOST` | 0x1 | `ISIG` | 0x1 |
| `INLCR` | 0x40 | `OLCUC` | 0x2 | `ICANON` | 0x2 |
| `IGNCR` | 0x80 | `ONLCR` | 0x4 | `ECHO` | 0x8 |
| `ICRNL` | 0x100 | `OCRNL` | 0x8 | `ECHOE` | 0x10 |
| `IUCLC` | 0x200 | `ONOCR` | 0x10 | `ECHOK` | 0x20 |
| `IXON` | 0x400 | `ONLRET` | 0x20 | `ECHONL` | 0x40 |
| `IXANY` | 0x800 | `XTABS` | 0x1800 | `NOFLSH` | 0x80 |
| `IMAXBEL` | 0x2000 | | | `ECHOCTL` | 0x200 |
| `IUTF8` | 0x4000 | | | `ECHOKE` | 0x800 |
| | | | | `IEXTEN` | 0x8000 |

`c_cc`: `VINTR` 0, `VQUIT` 1, `VERASE` 2, `VKILL` 3, `VEOF` 4, `VTIME` 5,
`VMIN` 6, `VSTART` 8, `VSTOP` 9, `VSUSP` 10, `VEOL` 11, `VREPRINT` 12,
`VWERASE` 14, `VLNEXT` 15, `VEOL2` 16. A slot holding 0 is disabled.

Initial state (a fresh Linux pty): `ICRNL|IXON|IUTF8`, `OPOST|ONLCR`,
`ISIG|ICANON|ECHO|ECHOE|ECHOK|ECHOCTL|ECHOKE|IEXTEN`, `^C ^\ ^? ^U ^D`,
`VMIN=1 VTIME=0`. Other flags (`c_cflag`, speeds, parity) are stored and
returned but have no effect.

`cfmakeraw` is not an import; it is this, done by the guest:

```
c_iflag &= ~(IGNBRK|BRKINT|PARMRK|ISTRIP|INLCR|IGNCR|ICRNL|IXON)
c_oflag &= ~OPOST
c_lflag &= ~(ECHO|ECHONL|ICANON|ISIG|IEXTEN)
c_cflag = (c_cflag & ~(CSIZE|PARENB)) | CS8;  c_cc[VMIN] = 1;  c_cc[VTIME] = 0
```

The window size is set by the page (terminal resize). When it changes the
kernel raises `SIGWINCH`.

Canonical lines are capped at 4095 bytes plus the terminator. Non-canonical
input is not capped.

Terminal ↔ program byte protocols (bracketed paste, SGR mouse reports, focus
reports, kitty keyboard, cursor-position and device-attribute replies,
alternate screen, colours) are not part of this ABI: in raw mode the bytes
the terminal emulator produces arrive unmodified from `fd_read`, and the
bytes the program writes reach the emulator unmodified.

### 3.2 Signals

There are no asynchronous handlers. A signal either takes its default action,
is ignored, or is *caught*, which queues it on signal descriptors.

```
sig_action(signo: i32, action: i32, old_action: *mut u32 /* may be 0 */) -> errno
sig_fd(mask: u32, fd: *mut u32) -> errno
```

`action`: 0 default, 1 ignore, 2 catch. `INVAL` for `signo` outside 1..31,
for `SIGKILL` (9), or an unknown action.

Signal numbers are Linux's. Sources:

| Signal | Raised by | Default action |
| --- | --- | --- |
| `SIGINT` 2 | `VINTR` (`^C`) with `ISIG` | terminate, exit status 130 |
| `SIGQUIT` 3 | `VQUIT` (`^\`) with `ISIG` | terminate, 131 |
| `SIGTSTP` 20 | `VSUSP` (`^Z`) with `ISIG` | ignored (no job control) |
| `SIGWINCH` 28 | window size change | ignored |
| `SIGHUP` 1, `SIGTERM` 15, any other | the page (`Program.signal`), `proc_raise` | terminate, 128 + signo (`CHLD`, `CONT`, `URG` and the stop signals are ignored) |

Signals are noticed when the program is inside a host call (any terminal
read/write, `poll_oneoff`, `sched_yield`, `tcsetattr`, `winsize_get`, the
network calls). A default-action termination happens at that point.

`sig_fd(mask, &fd)` opens a signal descriptor that receives every *caught*
signal whose bit (`1 << signo`) is set in `mask`. Opening a descriptor does
not change dispositions: call `sig_action(signo, 2)` too.

- `fd_read` returns whole records, each one `u32` signal number; the buffer
  must hold at least 4 bytes. With nothing queued it blocks, or fails with
  `AGAIN` if the descriptor is non-blocking.
- A signal is queued at most once per descriptor until read (standard signals
  do not count).
- Several descriptors may name the same signal; each gets a copy. This is what
  lets a library (crossterm's SIGWINCH pipe) and the application each have
  their own.
- Pollable with `FD_READ`.
- A caught signal also interrupts an in-progress blocking terminal `fd_read`
  with `INTR` (2, terminal descriptors).

### 3.3 Network

The browser does the I/O (`WebSocket`, `fetch`) on the page's thread; the
program sees descriptors. Both kinds are pollable with `FD_READ`, never poll
writable, and are closed with `fd_close` (which closes the socket or aborts
the request).

Browser rules apply and cannot be worked around from the guest: cross-origin
`fetch` needs CORS; WebSocket handshakes cannot carry custom headers (only
subprotocols); a page served over https cannot open `ws://` or `http://`
URLs; some ports are blocked outright.

```
last_error(buf: *mut u8, buf_len: i32, len: *mut u32) -> errno
```

Copies a human-readable description of the most recent network failure
(what the browser reported). Always succeeds.

#### WebSocket

```
ws_open(url: *const u8, url_len: i32, protocols: *const u8, protocols_len: i32, fd: *mut u32) -> errno
ws_send(fd: i32, kind: i32, data: *const u8, len: i32) -> errno
ws_recv(fd: i32, buf: *mut u8, buf_len: i32, out: *mut [u32; 2], flags: i32) -> errno
ws_close(fd: i32, code: i32, reason: *const u8, reason_len: i32) -> errno
```

- `ws_open` returns immediately with a descriptor; the connection proceeds in
  the background. `protocols` is a comma-separated list (may be empty).
  `INVAL` if the URL is not `ws://` or `wss://`.
- `ws_send`: `kind` 2 = text (UTF-8), 3 = binary. Messages sent before the
  handshake completes are held and sent when it does. `NOTCONN` once the
  socket has finished, `INVAL` for another `kind`.
- `ws_recv` takes the next event. `out[0]` = kind, `out[1]` = payload length,
  payload in `buf`:

  | kind | Event | Payload |
  | --- | --- | --- |
  | 1 | open | negotiated subprotocol (UTF-8, may be empty) |
  | 2 | text message | UTF-8 |
  | 3 | binary message | bytes |
  | 4 | closed | `u16` close code, then the reason (UTF-8) |
  | 5 | failed | error text (UTF-8) |

  Exactly one of kind 4 or 5 is delivered, and it is the last event.
  - No event queued: blocks; with `flags & 1`, or `O_NONBLOCK` on the
    descriptor, fails with `AGAIN`.
  - `buf_len` too small: `RANGE`, with `out` filled in so the caller can
    retry with `out[1]` bytes. The event stays queued.
  - After the final event has been taken: `NOTCONN`.
- `ws_close` starts the closing handshake (`code` 0 = none given); a kind 4
  event follows.
- `fd_read` on a WebSocket is `INVAL` (message boundaries matter).

#### HTTP

```
http_open(method: *const u8, method_len: i32, url: *const u8, url_len: i32,
          headers: *const u8, headers_len: i32, body: *const u8, body_len: i32,
          fd: *mut u32) -> errno
http_head(fd: i32, buf: *mut u8, buf_len: i32, out: *mut [u32; 2], flags: i32) -> errno
```

- `http_open` starts a `fetch` and returns a descriptor at once. `headers` is
  `Name: value` lines separated by `\n`. An empty method means `GET`. The
  request body is sent whole (`body_len` 0 = no body); it cannot be streamed.
- `http_head` waits for the response head. `out[0]` = status, `out[1]` =
  length of the header text, which is written to `buf` as `name: value\r\n`
  lines (names lower-cased, as the browser reports them).
  - Not arrived yet: blocks; with `flags & 1` or `O_NONBLOCK`, `AGAIN`.
  - `buf_len` too small: `RANGE` with `out` filled in; retry.
  - The request failed (DNS, refused, CORS, aborted): `IO`; see `last_error`.
- The body is read with plain `fd_read` on the same descriptor, **as it
  arrives**: a read returns whatever bytes are available, blocks if there are
  none yet (or `AGAIN` when non-blocking), returns 0 at the end of the body,
  and fails with `IO` if the transfer broke. This is what makes server-sent
  events and other streamed responses usable. Calling `http_head` first is
  optional.
- Redirects are followed by the browser; the status is the final one.
- The host stops pulling from the network when about 1 MiB of body is unread.

## 4. Host side

For whoever embeds the machine in a page (`host/index.ts`):

```ts
const program = startProgram({
  guestUrl, kernelUrl, workerUrl, args, env, files,
  cols, rows, xpixel, ypixel,
  onOutput(bytes) { terminal.write(bytes) },   // pty master output
  onExit(status) { ... },                      // { code, signal?, error? }
});
program.write(data);              // pty master input: keys, paste, mouse/focus reports, query replies
program.resize(cols, rows, xpixel, ypixel);    // winsize, SIGWINCH if changed
program.signal(signo);            // like kill(1)
program.kill();                   // terminate the Worker now
await program.exited;
```

The page must be cross-origin isolated (`Cross-Origin-Opener-Policy:
same-origin`, `Cross-Origin-Embedder-Policy: require-corp`), because the
Worker blocks in `Atomics.wait` on a `SharedArrayBuffer`.

Data paths:

- page → Worker: a single-producer/single-consumer frame ring in a
  `SharedArrayBuffer` (`host/ring.ts`, `host/protocol.ts`), because a Worker
  blocked in a syscall never services `postMessage`. Frames: terminal input,
  resize, signal, network event. Frames that do not fit wait on the page.
- Worker → page: `postMessage` (terminal output, exit, network requests).
  Output is flow-controlled: the Worker pauses when 1 MiB is unacknowledged.

### Other kinds of guest

`host/machine.ts` is the machine without WASI: the pty (`machine.pty`),
`pump()` (process everything the page sent), `waitUntil(deadline)` (block for
more), signal dispositions and queues, network handles. `host/wasi.ts` is one
consumer. A node-style shim for a JavaScript program would be another, built
on the same object:

| node API | machine |
| --- | --- |
| `process.stdin.setRawMode(on)` | `pty.getTermios()` / `pty.setTermios()` with the `cfmakeraw` bits |
| `process.stdin.on("data")` | `pty.slaveRead()` after each `pump()` |
| `process.stdout.write` | `pty.slaveWrite()` + `flushOutput()` |
| `process.stdout.columns` / `.rows` | `pty.getWinsize()` |
| `process.stdout.on("resize")`, `process.on("SIGINT")` | a signal queue from `openSignalQueue(mask)` with the dispositions set to catch |

A JavaScript program has to return to its event loop, so it cannot block in
`waitUntil`. It should wait with `Atomics.waitAsync` on the ring's wake
counter (`H_WAKE`) and call `pump()` when it resolves. That shim is not
built; nothing in the machine needs to change for it.
