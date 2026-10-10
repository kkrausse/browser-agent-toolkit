# wasm-term guest ABI

The contract between a program (a `wasm32-wasip1` module) and the emulated
machine it runs on. The implementation is `host/wasi.ts` (imports),
`host/machine.ts` (signals, network handles, the event ring) and `kernel/`
(the pty and line discipline). Rust bindings: `guests/wasm-term-sys`.

Sections 1 to 3 are that contract. A program written in JavaScript runs on the
same machine through a node-style shim instead of these imports; that, and the
page-side API, is section 4.

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
| `NOSYS` | 52 | | `PIPE` | 64 |

## 1. Process environment

| Thing | Value |
| --- | --- |
| fd 0, 1, 2 | the pty slave (three separate descriptors on the same terminal) |
| fd 3 | preopened directory `/` |
| argv | `[<guest name>, ...]` from the page (`?arg=`) |
| env | `TERM=xterm-256color COLORTERM=truecolor HOME=/home/user USER=user PWD=/home/user LANG=C.UTF-8`, the time zone (below), plus whatever the page passes. The dev page adds `WASM_TERM_ORIGIN=<page origin>`, a guest's own settings and each `?env=K=V` |
| cwd | wasi-libc starts at `/`; call `chdir($HOME)` if you want the home directory |
| exit | `proc_exit(code)`, returning from `_start` (code 0), a fatal signal (128 + signo), or a trap (134) |

A Rust panic with `panic = "abort"` prints its message to the terminal and
traps; the page shows the trap as the exit reason.

**Time zone.** WASI preview1 has no time-zone interface and the filesystem has
no zone database, so local time is whatever the host says in the environment
(`timeZoneEnv()` in `host/index.ts`, part of the defaults):

| Variable | Value |
| --- | --- |
| `TZ` | the browser's IANA zone name (`Intl.DateTimeFormat().resolvedOptions().timeZone`), e.g. `America/Los_Angeles`. Only useful to a guest that carries its own zone data |
| `WASM_TERM_UTC_OFFSET_MINUTES` | minutes east of UTC at the moment the program starts (`-new Date().getTimezoneOffset()`), e.g. `-420`. A guest adds it to UTC to get local time. It is not updated while the program runs, so a DST change during a session is not followed |

The codex port reads the offset in its chrono fork (`chrono::Local` on WASI);
that is the whole guest side.

Set `WASM_TERM_TRACE=1` in the environment to have the host log, once a
second, how many times each import was called. It shows what a program is
blocked in, or that an event loop is spinning. It also logs every stretch of
100 ms or more between two host calls: the guest was computing, and on its one
thread that is time in which it read no input.

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
  | child process | an event (output or exit) is queued |
  | file, directory, `/dev/null` | always |

  The event's `nbytes` is the number of bytes a read would return now (at
  least 1). wasi-libc implements `ioctl(FIONREAD)` from this field.
- `FD_WRITE`: ready at once for terminals open for writing, files and
  `/dev/null`. **Never ready** for signal, WebSocket, HTTP and child-process
  descriptors and for a terminal opened read-only, because those cannot be written with
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
no permissions. The page can pre-populate files (`ProgramOptions.files`).
`fd_filestat_set_times` and `path_filestat_set_times` succeed and do nothing.

**Persistent directories.** The page may name directories whose regular files
survive a reload (`ProgramOptions.persist`; the dev page names `$HOME` for
wasm guests). Nothing changes for the guest: it reads and writes files as
usual. Rules a guest can rely on:

- A file below a persistent directory is saved when the guest closes it, on
  `fd_sync`/`fd_datasync`, on rename and unlink, and at exit. A file that is
  only written and kept open is not saved until one of those.
- Whole files are saved, so keep them small (configuration, history), not
  databases that are rewritten in place.
- Only regular files: empty directories, symlinks and timestamps do not
  survive. On the next start the saved files are simply there, with their
  parent directories.
- Saving is asynchronous on the page; a write made in the instant before the
  tab is closed can be lost.

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
- A browser will not send some request headers a program sets (`User-Agent`, `Cookie`,
  `Origin`, `Referer`, `Accept-Encoding`, `Sec-*`, `Proxy-*`, ...): `fetch` drops them or
  substitutes its own, and it hides `Set-Cookie` in the response. A program that needs them
  goes through a relay on the page's origin (below).
- The host stops pulling from the network when about 1 MiB of body is unread.

#### The HTTP relay convention

Not an import: an agreement between a guest's HTTP client and a relay on the page's own origin,
for requests to servers that do not answer CORS or that need headers a page cannot set. The dev
server implements the relay (`web/server.ts`, `/proxy/http/`); the codex port's reqwest fork
implements the client side (`ports/codex/patches/forks/reqwest`, `src/async_impl/wasi.rs`).

- The guest reads the relay's base URL from `WASM_TERM_HTTP_RELAY` (the page passes it as a
  guest setting; unset or empty = fetch directly). A request for
  `<scheme>://<host>[:<port>]<path>?<query>` is sent to `<base>/<host>[:<port>]<path>?<query>`
  instead. The scheme is not sent: the relay knows the origin of every host it allows.
- Every request header travels as `x-wasm-term-fwd-<name>: <value>`. The relay forwards
  exactly those, under their real names, and nothing else from the incoming request.
- The response comes back as it is, streamed, except: `set-cookie` arrives as
  `x-wasm-term-fwd-set-cookie-<n>` (one per cookie) and `www-authenticate` as
  `x-wasm-term-fwd-www-authenticate`; the guest unwraps both. `content-encoding` and
  `content-length` are gone (the body is already decoded).
- Hosts that are not allowlisted get `403`; an unreachable one `502`.

### 3.4 Child processes

A guest runs commands in **the machine's shell**: bat-rust's `bat-sh`, a POSIX-style shell with
the coreutils built in (`cat`, `ls`, `sed`, `grep`, `rg`, `find`, ...; `host/sh/`, built from a
pinned bat-rust commit by `host/sh/build.sh`). There are no other programs: what is not a
command of that shell is "command not found" (127). The shell works on **the guest's own
filesystem**, the same objects `path_open` reaches, so a file either side writes is there for the
other at once. A machine started without a shell (`ProgramOptions.shell`) fails `proc_spawn`
with `NOSYS`.

```
proc_spawn(req: *const u8, req_len: i32, flags: i32, fd: *mut u32) -> errno
proc_recv(fd: i32, buf: *mut u8, buf_len: i32, out: *mut [u32; 2], flags: i32) -> errno
proc_send(fd: i32, data: *const u8, len: i32, flags: i32) -> errno
proc_signal(fd: i32, signo: i32) -> errno
```

- `proc_spawn` starts a child and returns at once with a descriptor. `req` is
  `u32 argc, u32 envc`, then `cwd`, `argv[0..argc]`, `env[0..envc]` (`NAME=value`), each as
  `u32 length` + bytes (UTF-8, no terminator). `argv` is a shell invocation
  (`["/bin/bash", "-lc", "<command line>"]`; `sh`, `bash`, `zsh`, `dash`, `ash`, with or without
  a directory) or one of the shell's commands by itself (`["ls", "-la"]`). The child gets exactly
  `env`; nothing is inherited. `flags` bit 0: keep the child's stdin open for `proc_send`
  (otherwise it reads end of file). `INVAL` for a malformed request or one over 768 KiB,
  `NOSYS` without a shell. A program that does not exist is not an error here: the child
  starts, prints the shell's message to stderr and exits 127.
- `proc_recv` takes the next event. `out[0]` = kind, `out[1]` = payload length, also when the
  call fails with `RANGE` because `buf` is too small (the event stays queued: call again with a
  larger buffer). `AGAIN` when no event is queued and `flags & 1` or the descriptor is
  non-blocking; otherwise it blocks. `NOTCONN` once the exit event has been taken.

  | kind | Event | Payload |
  | --- | --- | --- |
  | 1 | stdout | bytes as the child wrote them; consecutive writes may arrive merged, at most 256 KiB per event |
  | 2 | stderr | the same |
  | 3 | exited (the last event) | `i32 status`, `i32 signal`, `u32 queue_us`, `u32 run_us`, `u32 host_calls` |

  `status` is the exit status, `128 + signal` when a signal ended the child (`signal` 0
  otherwise). The last three say what the run cost: microseconds from `proc_spawn` until a shell
  picked the command up, microseconds from then to the end, and how many host calls (file
  operations and writes) the shell made.
- `proc_send` queues bytes for the child's stdin; `flags` bit 0 closes stdin after them (with
  `len = 0`: just end of file). `PIPE` when stdin was not opened, is closed, or the child has
  ended. Never blocks: what the child has not read yet is held by the host.
- `proc_signal`: `signo` 2 (INT), 15 (TERM) or 9 (KILL), anything else `INVAL`. There are no
  handlers on the other side: each ends the child, with status `128 + signo`. A child inside a
  host call (file operation, `sleep`, a read of stdin, a blocked write) ends at once; one that
  is only computing (`while :; do :; done`) is ended after 250 ms by terminating its Worker.
  Signalling a child that has ended succeeds and does nothing.
- `fd_close` on a running child kills it (KILL) and discards its unread events.
- `poll_oneoff`: readable when an event is queued; never writable. `fd_read`/`fd_write` on the
  descriptor fail with `INVAL`.
- Back-pressure: while more than 1 MiB of output events are unread, the child's writes to
  stdout and stderr are not answered, so it waits. A reader must therefore keep reading until
  the exit event.

Not there: a terminal for the child (no pty, `isatty` is false in it), process groups, job
control, a pid, `waitpid`, children of children that are real programs. Inside one child,
pipeline stages run one after another, each into a buffer (bat-sh's design), so `yes | head`
does not end.

Rust: `wasm_term_sys::process::Child` (`spawn`, `recv` / `try_recv`, `send`, `close_stdin`,
`signal`; `Drop` closes) and, under tokio, `wasm_term_tokio::Child` with `async fn recv`.
`guests/proc` is a program that checks and times all of the above.

**How it runs** (`host/proc.ts`, `host/sh/`, `host/shell-worker.ts`). By default each child
runs in a **shell Worker**: a Worker holding one `bat_sh.wasm` instance that sleeps on a
`SharedArrayBuffer` channel between runs, so starting a command is one `Atomics.notify`
(about 0.1 ms), not a Worker start. The shell's 24 host calls (`sh_open`, `sh_read`, ...) travel
over the channel to the guest's Worker, which owns the filesystem, and are answered there:
at the top of every blocking host call, inside every wait (`poll_oneoff`, a blocking read,
`ws_recv`, ...), and in the wait of the guest's own terminal-output flow control. A guest that
computes without making a blocking host call keeps its children waiting; that is the price of
one thread owning the files. One answering pass is limited to 4 ms so that a child making
thousands of calls does not keep the guest from its own events. Up to four children run at
once (`ShellOptions.slots`); more wait for a free Worker. The page creates the Workers (the
guest's Worker is blocked and could not): the guest's Worker posts `{ t: "proc_need", slot,
channel }` for a channel that has no Worker yet (one is asked for before the first command)
and `{ t: "proc_replace", slot, channel }` when a killed child would not stop, with a fresh
channel, so whatever the dying Worker still writes goes nowhere. If a Worker cannot be
started the page says so with a `FRAME_PROC` frame and the machine switches to **inline**
mode: the shell runs to completion inside `proc_spawn`, in the guest's own Worker. Inline is
also the default on a machine that reports at most two cores, and can be asked for
(`ShellOptions.mode`, `?shell=inline` on the dev page). Inline has no streaming (all events are
queued when `proc_spawn` returns), no stdin (end of file), and no kill: a run is abandoned
with status 124 after two minutes, and a loop that makes no host call cannot be stopped at all.

After a child that changed files has ended, the persistence hook runs (the same one a guest's
own `fd_close` triggers), so shell-written files below a persistent root are stored like any
other. `/bin/sh`, `/bin/bash`, `/usr/bin/bash` and `/usr/bin/env` exist as empty files, for
programs that look for a shell before asking for one.

## 4. Host side

For whoever embeds the machine in a page (`host/index.ts`):

```ts
const program = startProgram({
  guestUrl, kernelUrl, workerUrl, args, env, files,
  cols, rows, xpixel, ypixel,
  persist: { namespace, roots: ["/home/user"], exclude: ["/locks/"] },   // optional
  shell: { moduleUrl: "/bat_sh.wasm", workerUrl: "/shell-worker.js" },   // optional: child processes (3.4); mode, slots, spinUs
  clipboard: { readText, writeText },             // optional; default navigator.clipboard
  onOutput(bytes) { terminal.write(bytes) },   // pty master output
  onExit(status) { ... },                      // { code, signal?, error? }
  onLoad(progress) { ... },                    // optional; wasm guests: { phase: "download" | "compile" | "start", loaded, total }
});
program.write(data);              // pty master input: keys, paste, mouse/focus reports, query replies
program.resize(cols, rows, xpixel, ypixel);    // winsize, SIGWINCH if changed
program.signal(signo);            // like kill(1)
program.kill();                   // terminate the Worker now (after exit: release its files)
await program.exited;
await program.readFile(path);     // Uint8Array | null: a file out of the program's filesystem
await program.listFiles(dir);     // [{ path, size }]: every regular file below a directory
program.procs;                    // [{ command, status, signal, calls, queueMs, runMs }]: the children that have ended (last 500)
program.shellWorkers;             // [{ slot, why: "need" | "replace", at }]: every shell Worker the page started
```

`workerUrl` selects the kind of guest: the bundled `host/worker.ts` runs a
wasm module (sections 1 to 3), the bundled `host/js-worker.ts` runs a
JavaScript module (4.2). Everything else is the same for both.

The page must be cross-origin isolated (`Cross-Origin-Opener-Policy:
same-origin`, `Cross-Origin-Embedder-Policy: require-corp`), because the
Worker blocks in `Atomics.wait` on a `SharedArrayBuffer`.

**Loading.** The Worker compiles a wasm guest with
`WebAssembly.compileStreaming` on the `Response` that `fetch` returned (so the
browser compiles while it downloads and may keep the compiled code in its
cache) and counts the bytes on a clone of it. `onLoad` gets `download` events
about every 100 ms, `compile` when the last byte has arrived, `start` when the
module is compiled. `total` is the module's size: `Content-Length`, or, for a
compressed response, the `X-Wasm-Term-Size` header if the server sends one,
else 0 (unknown). A large module should be served as `application/wasm`,
precompressed, under a URL that names its content, with `Cache-Control:
immutable`; `web/server.ts` does that for packaged guests (`WasmGuest` in
`web/guests.ts`, `ports/codex/scripts/package.ts`).

**Reading files back** (debugging: a program's log, the configuration it
wrote). `program.readFile(path)` and `program.listFiles(directory)` ask the
Worker with a `FRAME_FILE` frame (`u32 id`, `u32 op` (0 read, 1 list), path);
it answers with `{ t: "file", id, data }` the next time the program makes a
host call, so a program stuck in computation answers late and one blocked in
`poll_oneoff` answers at once (the frame wakes it). The data is a copy. A wasm
guest's Worker is kept after the program exits, idle, holding only the
filesystem, so the files of a program that crashed can still be read; then the
request is an ordinary message (`FileRequest`). `program.kill()` lets go of
it. A JavaScript guest's Worker ends with the program. On the dev page:
`await wasmTerm.readFile(path)` (text), `await wasmTerm.listFiles(dir)`,
`await wasmTerm.download(path)` in the console.

### 4.1 Data paths

- page → Worker: a single-producer/single-consumer frame ring in a
  `SharedArrayBuffer` (`host/ring.ts`, `host/protocol.ts`), because a Worker
  blocked in a syscall never services `postMessage`. Frames: terminal input,
  resize, signal, network event, clipboard reply, file request, shell-Worker
  status. Frames that do not fit wait on the page.
- Worker → page: `postMessage` (terminal output, exit, network requests,
  changed persistent files, clipboard requests, load progress, file answers).
  Output is flow-controlled: the Worker pauses when 1 MiB is unacknowledged.
  That holds for both kinds of guest (`machine.flushOutput()`). While it is
  paused it sleeps on the ring's wake counter (not on the ack word), sets
  `H_OUT_WAITING`, and the page then bumps the wake counter with each ack; that
  way the same sleep also answers the shell Workers.
- shell Worker ↔ guest's Worker (3.4): one `SharedArrayBuffer` channel per
  shell Worker (`host/sh/channel.ts`): the run request one way, the shell's
  host calls and their replies the other. The shell bumps the ring's wake
  counter after posting a call, which is what `Machine.addWakeSource` is for:
  every sleep of the guest's Worker checks its wake sources first.

Persistence (`host/persist.ts`, `host/persist-store.ts`). The vfs stays in
memory. The Worker posts `{ t: "persist", path, data | null }` for every file
below a persistent root that changed or disappeared; the page stores them in
IndexedDB (database `wasm-term`, key `<namespace>\n<path>`) and passes them
back as `files` on the next start. The page does the storing because a wasm
guest's Worker is blocked and would never run IndexedDB's callbacks, and
IndexedDB rather than OPFS because it behaves the same in every browser.
`namespace` keeps programs apart; `exclude` leaves out paths containing a
substring (lock directories). `openPersistStore(namespace).save(path, null)`
then `flush()` deletes one stored file from the page (the dev page's
`&signout=1` removes a guest's credential files, `GuestInfo.credentials`, that way).

Clipboard. A Worker has no clipboard API. A program asks with
`{ t: "clipboard_read", id }` and gets a `FRAME_CLIPBOARD` frame (`u32 id`,
`u32 ok`, then the text or the error message in UTF-8); it writes with
`{ t: "clipboard_write", text }`. The page serves both from
`ProgramOptions.clipboard`. Browsers gate the real thing: Chrome asks the user
before the first read; Safari only allows a read from inside a user gesture,
which a request arriving from a Worker is not, so there a read fails and the
program sees the error (the browser's own paste, Cmd+V or the paste event,
still works: it reaches the program as a bracketed paste). There is no wasm
import for this yet; only JavaScript guests can ask (4.2). OSC 52 is not
handled by the terminal emulator.

### 4.2 JavaScript guests: the node-style shim

`host/machine.ts` is the machine without WASI: the pty (`machine.pty`),
`pump()` (process everything the page sent), `waitUntil(deadline)` (block for
more), signal dispositions and queues, network handles. `host/wasi.ts` is one
consumer. `host/node/` is the other: it runs a program written against Node's
APIs, such as a bundled TUI framework application.

A guest is an ES module that exports `main`:

```ts
import type { JsGuestContext } from "wasm-term/host/node/runtime";

export async function main(context: JsGuestContext): Promise<number | void> {
  process.stdout.write(`${process.stdout.columns}x${process.stdout.rows}\n`);
  ...
}
```

The module is imported only after the shim is installed, because bundles read
`process` and friends while their modules are evaluated. The program ends
when `main` returns (the number is the exit code), when it calls
`process.exit`, or when a signal's default action ends it.
`host/node/demo-guest.ts` (`?guest=js-demo`) is a complete small example.

What is installed, and what it maps to:

| node API | machine |
| --- | --- |
| `process.stdin.setRawMode(on)` | `pty.getTermios()` / `pty.setTermios()` with the bits libuv's raw mode changes (like `cfmakeraw`, but `OPOST` stays on) |
| `process.stdin.on("data")`, `.read()`, `"end"` | `pty.slaveRead()` after each `pump()`; data stays in the tty until there is a consumer; `end` on EOF (`^D`) |
| `process.stdout.write`, `process.stderr.write` | `pty.slaveWrite()` + `flushOutput()`; blocks the program while the page is more than 1 MiB behind |
| `process.stdout.columns` / `.rows`, `getWindowSize()` | `pty.getWinsize()` |
| `process.stdout.on("resize")`, `process.on("SIGWINCH")` | a signal queue from `openSignalQueue(mask)`; `SIGWINCH` is always caught |
| `process.on("SIGINT" / "SIGTERM" / ...)` | the signal's disposition is *catch* while a listener exists; otherwise the default action applies (`^C` in cooked mode ends the program with 130) |
| `process.env`, `argv`, `cwd()`, `chdir()`, `exit()`, `kill()`, `hrtime`, `nextTick`, `platform` = `"linux"` | the init message; `kill` raises on the machine |
| `Buffer`, `setTimeout`/`setInterval` returning handles with `ref`/`unref`/`refresh`, `setImmediate` | globals |
| `node:fs`, `node:fs/promises` | the same vfs wasm guests get, including persistent directories (`host/node/fs.ts`): the sync calls, their promise twins, `createWriteStream`; `watch` never fires |
| `node:os`, `node:url`, `node:path`, `node:console`, `node:process` | fixed Linux-like values, the installed objects |
| `node:crypto` | `createHash` for `sha1` and `sha256` (synchronous), `randomBytes`, `randomUUID`; the rest throws by name |
| `node:child_process`, `module`, `vm`, `sqlite`, `worker_threads`, `perf_hooks`, `tty`, `net` | importable; calling into them throws by name |
| network | the browser's own `fetch` and `WebSocket`: a JavaScript guest returns to its event loop, so it does not need the machine's network descriptors |
| clipboard | `context.clipboard.readText()` / `.writeText()` (4.1) |

A bundle gets those `node:` modules through `nodeShimsPlugin()` from
`host/node/bun-plugin.ts` (`Bun.build({ target: "browser", plugins: [...] })`);
`events`, `buffer`, `stream`, `util`, `assert` come from Bun's own browser
polyfills.

A JavaScript program has to return to its event loop, so the shim does not
block in `waitUntil`. It waits with `Atomics.waitAsync` on the ring's wake
counter (`H_WAKE`) and calls `pump()` when it resolves; where `waitAsync` is
missing (Safari before 16.4) it polls every 8 ms. The one place it does block
is output flow control. Differences from Node worth knowing: there is one
thread and no child processes; `stdin` has no `"readable"` event; signals are
delivered between event-loop turns, not preemptively.

`context` also carries `machine`, `vfs`, `fs`, `guestUrl` (resolve the
program's other files against it), `log()` (a line for the page's console)
and `machine.outputStats()` (bytes written, times paused by flow control).
