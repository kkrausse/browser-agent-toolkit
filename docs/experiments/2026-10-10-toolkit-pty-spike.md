# Terminal on the toolkit runtime: spike (2026-10-10)

Branch `toolkit-pty`. Two unknowns were checked before building a pty into the toolkit kernel
and moving the OpenCode client onto it. Neither is a blocker. **[ran]** = run here, **[read]** =
from source.

## 1. Can the toolkit's Node stand-ins run the OpenCode client?

Not the files wasm-term serves today: `ports/opencode/dist/site/tui.js` is a browser-target
bundle with wasm-term's own shim compiled in (`host/node/bun-plugin.ts` maps `node:fs`, `process`,
`os`, `crypto`… onto `host/node/modules/*`, which read `globalThis.__wasmTermNode`). But the same
sources bundle for Node with the shim plugin left out, and that bundle runs.

- **[ran]** `bun build/build-site.ts --target=node` (new): `dist/node/tui.js` (5.9 MB unminified,
  `node:*` left as imports), `main.js` (`host/node-main.ts`, the entry), `opentui.wasm`.
- **[ran]** In the runtime harness (Chrome, `runtime/harness/cli.ts run`), with no terminal and no
  server: the three files were written into the guest's filesystem, `main.js` booted the OpenTUI
  wasm core (3.0 MB, `WebAssembly` in the process worker), the loader evaluated the whole TUI
  bundle, the client created its XDG directories and made its first request, which went to a
  kernel socket: `connect ECONNREFUSED 127.0.0.1:4096`. 706 ms from import to that error.
  So module loading, the `bun:ffi`-shaped wasm backend, `fs`, `os`, `crypto`, `path` and the
  routed `fetch` are enough as they are.

What `wasm-term/host/node` supplies and `runtime/src/node` does not yet (**[read]**):

| wasm-term shim | toolkit today | needed |
| --- | --- | --- |
| `process.stdin.isTTY`, `setRawMode` (libuv's raw bits on the pty), `data` from pty reads | `isTTY` false, `setRawMode` a no-op, stdin a pipe | termios calls on fd 0 |
| `process.stdout.isTTY`, `columns`, `rows`, `getWindowSize`, `resize` | `isTTY` false | window size from the pty, `resize` on SIGWINCH |
| SIGWINCH / SIGINT from the line discipline | signals only from `kill` | the pty raises them on its foreground process |
| `tty.isatty` true | `tty.isatty` false, constructors throw | real `isatty` |
| global `Worker` (OpenTUI's tree-sitter worker: markdown concealment, highlighting) | hidden from guests; `worker_threads.Worker` throws | a worker for the parser, or no highlighting |
| clipboard through the page | none | OSC 52 through the terminal, or a page hook |
| files in a private vfs, persisted to IndexedDB by listed roots | the kernel filesystem, overlay persisted to OPFS | nothing: the client's files are ordinary files |
| `fetch` relayed to the page (`page-fetch.ts`) | loopback `fetch` goes to kernel sockets | nothing: `http://127.0.0.1:4096` is the server |

The tree-sitter worker is the only item that is more than plumbing: the runtime has no worker
threads for guests. It degrades (markup shown literally), so it is taken last.

## 2. How does the pty crate fit shared kernel memory, and how do blocking reads work?

- **[read]** `wasm-term/kernel/src/pty.rs` and `termios.rs` are plain Rust over two `VecDeque`s:
  no globals, no host calls, time passed in. Only `wasm.rs` assumes one thread (an `UnsafeCell`
  global and a scratch buffer for a host with a separate memory). The toolkit kernel does not
  need `wasm.rs`: it becomes a default feature (`host-abi`) that `bat-kernel` turns off, so its
  `#[no_mangle]` exports do not end up in `kernel.wasm`.
- A `Pty` goes behind a kernel `Mutex` (a word in shared memory) like a pipe's ring, with the
  kernel's `WaitQ`s beside it. A slave `read` is the pipe's loop: lock, `Pty::read`; on
  `Block(deadline)` read the queue's sequence word under the lock, unlock, and
  `memory.atomic.wait` on it (with the VTIME deadline as the timeout). `master_write` bumps the
  word. A thread that may not block (the page; a JS process that reads from its event loop) gets
  `EAGAIN` and uses the existing readiness subscriptions: the pty posts `POLLIN` to the slave's
  subscribers when `Pty::poll_in()` turns true, and to the master's when there is output.
- Output had flow control in wasm-term's host (a window against the page). Here: a writer that
  may block waits while more than 1 MiB of output is untaken.
- Signals: `Pty::take_signals()` after every master write, resize and hang-up, delivered with the
  kernel's `kill` to the newest live process started on that terminal (there are no process
  groups).
- **[ran]** nothing yet for this part; it is the first build step.

## bat-sh

**[read]** `crates/bat-sh` and `runtime/src/process/sh.ts` have no interactive mode: no prompt,
no line editing, no `isatty` check. Whether `sh` with a script on stdin is enough for a plain
shell on a pty is looked at once the pty exists.
