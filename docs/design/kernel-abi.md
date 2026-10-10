# Kernel ABI (`bat-kernel`), version 1

The kernel is one Wasm module (`crates/bat-kernel`, target `wasm32-wasip1-threads`)
instantiated in every worker and on the page over one shared `WebAssembly.Memory`. All
kernel state lives in that memory behind kernel locks. A syscall is a call to an export.

This file is the contract. `crates/bat-kernel/src/abi.rs` implements it and
`runtime/src/kernel/kernel.ts` is the typed TypeScript binding over it; when one changes the
other two change in the same commit. Node's `fs`/`net`/`child_process` layers and the
service-worker bridge should be written against `kernel.ts` (section 12) and fall back to raw
exports (`kernel.x.bat_*`) only for what it does not wrap.

Build: `cd crates/bat-kernel && CARGO_TARGET_DIR=../../target-kernel cargo build --release --target wasm32-wasip1-threads`
→ `target-kernel/wasm32-wasip1-threads/release/bat_kernel.wasm`. Stable Rust, no
wasm-bindgen. `bat_abi_version()` returns `1`.

## 1. Conventions

- **Pointers** are `u32` byte offsets into the shared memory. **Strings** are `(ptr, len)`
  UTF-8, no terminator. Paths longer than 4096 bytes fail with `ENAMETOOLONG`.
- **Results**: `i32`, `>= 0` on success, `-errno` on failure (Linux numbers, table in
  `runtime/src/kernel/errno.ts`). Functions documented as returning `f64` return a
  non-negative value or `-errno` as a float.
- **64-bit quantities** (file sizes, offsets, times, sequence numbers) cross as `f64`.
  Times are milliseconds since the epoch.
- **Paths** may be absolute or relative to the calling process's working directory. They are
  normalized lexically (`.`, `..`, repeated `/`) before resolution, so `a/link/..` is `a`
  even when `link` is a symlink. Symlink targets are resolved against the real directory
  that contains the link. At most 40 symlinks per resolution (`ELOOP`).
- **Calling process**: every attached thread is bound to one process (section 3); fd
  numbers, the working directory, the event word and signals are per process.

### Memory ownership

- The caller owns every buffer it passes. Get kernel memory with `bat_alloc(size) -> ptr`
  (16-byte aligned, 0 on OOM) and return it with `bat_free(ptr, size)` (same size).
  `kernel.ts` allocates one 256 KiB scratch block per instance and uses it for paths, stat
  results and small payloads.
- The kernel never keeps a caller pointer after the call returns.
- Two calls hand kernel-owned buffers to the caller (`bat_journal_take`,
  `bat_persist_snapshot`); they are released with `bat_blob_free(ptr, len)`.
- `bat_image_section` returns a pointer into the immutable image head; it stays valid for
  the session and must not be freed.
- **Views go stale when memory grows.** Any instance may grow the memory. Old
  `TypedArray` views remain valid for addresses below the old size, so the binding reads
  the exported word `BAT_MEM_GEN` (bumped on every growth) through its existing view and
  re-creates its views when it changed. Do this before reading results that may live in
  newly grown memory (anything returned by `bat_alloc`).
- `TextDecoder` refuses shared memory: copy (`u8.slice`) before decoding.

### Blocking rules

A thread declares at attach whether it may block (`Atomics.wait`): workers yes; the page and
service workers no.

| Call | Thread that may block | Thread that may not (page) |
| --- | --- | --- |
| lock acquisition (every call) | futex wait under contention | spins (critical sections are short) |
| `bat_read`/`bat_accept` on pipe, socket, listener without `O_NONBLOCK` | blocks until data / EOF / connection | `-EAGAIN` |
| `bat_write` on pipe/socket without `O_NONBLOCK` | blocks until everything is written | writes what fits; `-EAGAIN` if nothing fits |
| `bat_poll` with timeout ≠ 0 | blocks | behaves as timeout 0 |
| `bat_waitpid` without `WNOHANG` | blocks until the child exits | `-EAGAIN` |
| `bat_flush_wait` | blocks until durable | `-EAGAIN` unless already durable |
| reading an image body that is not cached, on a thread with no handle for that image | asks kerneld, blocks until loaded | `-EAGAIN`; retry after `BAT_FAULT_WORD` changes |

Forbidden on the page: nothing traps, but the page must be written for `-EAGAIN`:
use `bat_fd_subscribe` + the event word, `kernel.retrying(fn)` for image reads,
`kernel.flush()` (async). Filesystem calls on the overlay and all `stat`/`readdir`/
`realpath` calls never block on any thread. A mutation that has to copy an image file into
the overlay (open for write, append, rename, chmod, link of an image file) can return
`-EAGAIN` on the page for the same reason as a read; nothing is changed in that case.

Never call the kernel from inside a host import callback.

## 2. Attaching (how a new worker joins)

Implemented by `attachKernel` in `runtime/src/kernel/attach.ts`; a new kind of worker only
needs `{ module, memory }` posted to it and that function.

1. Instantiate the module with imports (section 11) over the shared memory:
   `WebAssembly.instantiate(module, { env: { memory }, bat, wasi_snapshot_preview1, wasi })`.
   The memory is created once by the page: `new WebAssembly.Memory({ initial: 64, maximum: 65536, shared: true })`.
2. A fresh instance runs on the module's built-in **boot stack**, shared by all fresh
   instances. Take the boot lock: CAS the `i32` at address `BAT_BOOT_LOCK` (exported global)
   from 0 to 1 (workers may `Atomics.wait` between attempts; the page spins).
3. `t = bat_thread_alloc(stack_size, __tls_size, __tls_align)` → pointer to the Thread
   record (0 on OOM). `stack_size` is at least 64 KiB; the binding uses 1 MiB.
4. Set the exported global `__stack_pointer` to `u32[t + 28]` and call
   `__wasm_init_tls(u32[t + 32])`.
5. Release the boot lock (store 0, `Atomics.notify`).
6. `bat_thread_start(t, flags)`; `flags` bit 0 = this thread may block. Returns the tid.
7. The first instance only (the page): `bat_kernel_init()` → creates the root directory and
   the host process, binds the caller to it and returns its pid (1).
8. Bind to a process: the page is bound by step 7; kerneld calls `bat_host_proc_new()`;
   a process worker calls `bat_proc_attach(pid)` with the pid it was given.

Thread record fields the host may read (`u32` each): `+0` locks held, `+4` dying, `+8` may
block, `+12` tid, `+16` pid, `+24` stack low, `+28` stack top, `+32` TLS block.

Detaching: a thread never frees itself. kerneld stops a worker through the **kill gate**:
`bat_thread_mark_dying(t)` (the thread parks at its next lock acquisition), poll
`bat_thread_lock_depth(t)` until 0, `worker.terminate()`, and later `bat_thread_free(t)`.
Terminating a worker any other way can leave a kernel lock held forever.

Exported globals (each is the *address* of an `i32` word; read with `Atomics.load`):

| Global | Meaning |
| --- | --- |
| `BAT_BOOT_LOCK` | boot lock (step 2) |
| `BAT_MEM_GEN` | bumped when memory grows |
| `BAT_OVERLAY_GEN` | bumped on every change to the overlay namespace (create, remove, rename, mount); resolution caches key on it |
| `BAT_KERNELD_WORD` | bumped when the supervisor has work |
| `BAT_FAULT_WORD` | bumped when a proxied image fault completed |
| `BAT_PERSIST_WORD` | bumped when the durable sequence advanced |

## 3. Processes

A process is a pid, a parent pid, an fd table, a working directory, a pending-signal word,
an **event word** and an exit status. The page is pid 1. Pids are never reused.

| Export | Result | Notes |
| --- | --- | --- |
| `bat_host_proc_new()` | pid | new parentless process (fds 0: null, 1/2: host log); binds the caller |
| `bat_proc_attach(pid)` | 0 | bind the calling thread to `pid`; a starting process becomes running |
| `bat_getpid()`, `bat_getppid()` | pid | |
| `bat_chdir(path, len)` | 0 | must be a directory; stored canonical |
| `bat_getcwd(buf, cap)` | len | `ERANGE` if too small |
| `bat_spawn(req, len, out_fds)` | child pid | `out_fds`: 3 × `i32`, the caller's pipe ends or −1 |
| `bat_proc_info(pid, buf, cap)` | len | the info block of the request; on `ERANGE` the needed size is in `buf[0..4]` |
| `bat_proc_exit(code)` | 0 | closes every fd of the calling process, publishes `code & 255`, wakes the parent |
| `bat_waitpid(pid, flags)` | status | `flags` bit 0 = do not block. Only for a direct child (`ECHILD`). Removes the child from the table. |
| `bat_kill(pid, sig)` | 0 | `sig` 0 probes; 9 goes to the supervisor; others set bit `sig` in the target's pending word and queue `TOKEN_SIGNAL` |
| `bat_sig_take()` | mask | pending signals of the caller, cleared |
| `bat_proc_list(buf, cap_records)` | count | records of 4 × `u32`: pid, ppid, state (0 starting, 1 running, 2 exited), status |

Exit status: `0..255` from `bat_proc_exit`; `128 + signal` when killed; `127` if the worker
could not be created; `1` if the worker crashed.

**Spawn request** (little-endian, packed):

```
u32 flags                       reserved, 0
3 × { u32 mode, u32 arg }       stdin, stdout, stderr
                                mode 0 inherit the caller's fd of the same number
                                     1 pipe (the caller gets the other end in out_fds)
                                     2 null
                                     3 the caller's fd `arg`
-- info block (returned verbatim by bat_proc_info) --
u32 argc
u32 envc
str exec                        each str = u32 len + bytes
str cwd                         empty = inherit the caller's
str argv[argc]
str env[envc]                   "KEY=value"
```

The kernel only creates the process record and queues a spawn for the supervisor. kerneld
gives the pid to a warm process worker, which attaches and runs the configured *runner*
module (`export async function run({ kernel, pid, info }): Promise<number | void>`); the
returned number is the exit code. Executable formats (JS entry, WASI) are the runner's
concern, not the kernel's. `spawnSync` = `bat_spawn`, then `bat_poll` on the pipe ends while
reading them, then `bat_waitpid`.

A process whose parent has exited is removed from the table when it exits.

## 4. Filesystem by path

One overlay (read-write) over read-only image mounts. Lookup is overlay first, then image,
with whiteouts. Writing to an image file copies it into the overlay; removing an image
entry leaves a whiteout; a directory created over a removed image directory starts empty.
Renaming a directory that is (partly) in an image fails with `EXDEV` (as overlayfs does):
copy and delete instead.

| Export | Result | Notes |
| --- | --- | --- |
| `bat_stat(path, len, flags, out)` | 0 | `flags` bit 0 = do not follow a final symlink (`lstat`). `out`: Stat |
| `bat_readlink(path, len, buf, cap)` | len | `EINVAL` if not a symlink |
| `bat_realpath(path, len, buf, cap)` | len | canonical absolute path |
| `bat_readdir(path, len, buf, cap)` | bytes | records `u8 kind, u16 name_len, name`; merged view, overlay names first then image names in name order; on `ERANGE` the needed size is in `buf[0..4]` |
| `bat_read_file(path, len, flags, buf, cap, out_stat)` | bytes | whole file in one call. `out_stat` is filled whenever the file exists; on `ERANGE` take the size from it and retry. `flags` bit 0: return the **compiled** body if the image entry has one (then `size` is its length and `compiled_len != 0`; `facts` describes it) |
| `bat_write_file(path, len, data, dlen, mode, flags)` | 0 | create or replace. `flags` bit 0 append, bit 1 fail if it exists |
| `bat_mkdir(path, len, mode, recursive)` | 0 | recursive: existing directories are fine |
| `bat_rmdir(path, len)` | 0 | `ENOTEMPTY`, `ENOTDIR`; a mount point gives `EINVAL` |
| `bat_unlink(path, len)` | 0 | `EISDIR` for directories |
| `bat_rename(old, oldlen, new, newlen)` | 0 | replaces an existing file or empty directory |
| `bat_symlink(target, tlen, path, len)` | 0 | target stored verbatim |
| `bat_link(old, oldlen, new, newlen)` | 0 | hard link (files and symlinks) |
| `bat_chmod(path, len, mode, flags)` | 0 | `flags` bit 0 = do not follow |
| `bat_utimes(path, len, mtime_ms, flags)` | 0 | only mtime is kept; atime reads as mtime |
| `bat_truncate(path, len, size)` | 0 | |

**Stat** (64 bytes, 8-aligned):

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u32 | kind: 0 file, 1 directory, 2 symlink, 3 fifo, 4 socket, 5 character device |
| 4 | u32 | mode (permission bits only) |
| 8 | f64 | size |
| 16 | f64 | mtime, ms |
| 24 | f64 | ctime, ms |
| 32 | f64 | inode number (unique per dev) |
| 40 | u32 | nlink |
| 44 | u32 | dev: 0 overlay, 1 + image id |
| 48 | u32 | module facts word of an image entry (`docs/design/image-format.md`), else 0 |
| 52 | u32 | compiled body length of an image entry, else 0 |
| 56 | f64 | birth time, ms |

There are no uids, no permission checks, no atime. Image entries report the image build
time for every time field.

## 5. File descriptors

Per process, lowest free number first. Flags (Linux values): `O_RDONLY 0`, `O_WRONLY 1`,
`O_RDWR 2`, `O_CREAT 0o100`, `O_EXCL 0o200`, `O_TRUNC 0o1000`, `O_APPEND 0o2000`,
`O_NONBLOCK 0o4000`, `O_DIRECTORY 0o200000`, `O_NOFOLLOW 0o400000`.

| Export | Result | Notes |
| --- | --- | --- |
| `bat_open(path, len, flags, mode)` | fd | directories can be opened read-only (for `fstat`); read-only opens of image files read through the chunk cache without copying up |
| `bat_close(fd)` | 0 | the last close of a pipe end gives the other side EOF / `EPIPE` |
| `bat_read(fd, buf, len)` | bytes | 0 = end of file / peer closed |
| `bat_pread(fd, buf, len, pos)` | bytes | regular files only; does not move the position |
| `bat_write(fd, buf, len)` | bytes | `EPIPE` when the read side is gone; `EBADF` on a read-only or image fd |
| `bat_pwrite(fd, buf, len, pos)` | bytes | |
| `bat_seek(fd, offset, whence)` | `f64` position | whence 0 set, 1 current, 2 end; `ESPIPE` on pipes and sockets |
| `bat_fstat(fd, out)` | 0 | pipes report kind 3, sockets 4, null/console 5 |
| `bat_ftruncate(fd, size)` | 0 | |
| `bat_fsetmeta(fd, mode, mtime_ms)` | 0 | negative leaves the field alone (`fchmod`/`futimes`) |
| `bat_set_nonblock(fd, on)` | 0 | applies to the open file description (shared by dups and inherited copies) |
| `bat_dup(fd)` | new fd | |
| `bat_fd_path(fd, buf, cap)` | len | canonical path at open time (empty for pipes and sockets) |
| `bat_pipe(out)` | 0 | `out`: 2 × `i32` = read end, write end. Capacity 64 KiB |

An unlinked file stays readable and writable through fds that are still open on it.
There is no `fsync` export: durability is `bat_flush_begin` (section 9).

## 6. Sockets

A connection is a pair of 256 KiB byte rings in shared memory. There is one loopback
namespace of ports; the host argument of `listen`/`connect` in the Node layer is ignored.

| Export | Result | Notes |
| --- | --- | --- |
| `bat_listen(port)` | listener fd | `port` 0 picks a free one (≥ 49152); `EADDRINUSE` |
| `bat_connect(port)` | socket fd | connected immediately; `ECONNREFUSED` if nothing listens |
| `bat_accept(fd)` | socket fd | blocking or `-EAGAIN` (blocking rules) |
| `bat_shutdown(fd)` | 0 | half-close: the peer reads EOF after the buffered bytes |
| `bat_sock_ports(fd, out)` | 0 | `out`: 2 × `u32` = local port, peer port |
| `bat_socketpair(out)` | 0 | `out`: 2 × `i32` |

`bat_read`/`bat_write`/`bat_close`/`bat_set_nonblock`/`bat_fd_subscribe`/`bat_poll` work on
sockets. Closing a listener refuses queued and future connections. The page reaches a guest
server by `bat_connect(port)` and non-blocking reads/writes driven by its event word; no
message channel is involved.

## 7. Readiness and the event word

Each process has an event word. The kernel bumps it (and `Atomics.notify`s it) whenever
something the process subscribed to became ready. The process event loop is:

```
word = bat_event_word() >> 2
loop:
  seen = Atomics.load(i32, word)
  n = bat_events_take(buf, cap_pairs)        // (token u32, mask u32) pairs
  dispatch each; if n == 0: await Atomics.waitAsync(i32, word, seen).value
```

(`kernel.runEvents(on)` is exactly this.) Events are edge-style: after an event, read or
write until `-EAGAIN`.

| Export | Result | Notes |
| --- | --- | --- |
| `bat_event_word()` | address | of the caller's process event word |
| `bat_events_take(buf, cap_pairs)` | count | drains queued events |
| `bat_fd_subscribe(fd, mask)` | 0 | replaces the caller's subscription on `fd`; mask 0 removes it. If the fd is already ready an event is queued at once. Token = fd number |
| `bat_fd_poll(fd)` | mask | current readiness, never blocks |
| `bat_poll(fds, n, timeout_ms)` | ready count | `fds`: n × `{ i32 fd, u32 events, u32 revents }`; timeout < 0 forever, 0 never blocks. `revents` 32 = bad fd |
| `bat_watch_add(path, len, recursive)` | watch id | the path must exist; watches the canonical path |
| `bat_watch_remove(id)` | 0 | |
| `bat_watch_read(buf, cap)` | bytes | whole records: `u32 id, u32 kind, u16 len, relative path` (byte-packed) |

Masks: `1` readable (or EOF, or a connection to accept), `4` writable, `8` error (peer gone
for writing), `16` hang-up.

Tokens: an fd number; `0x80000000 | pid` a child exited (mask = its status; sent to the
parent automatically, no subscription); `0x40000000` watch records are waiting;
`0x40000001` signals are pending (mask = signal bits; call `bat_sig_take`).

Watch kinds: `1` rename (an entry appeared or disappeared), `2` change (content or
metadata). Paths are relative to the watched directory; empty means the watched path
itself. Only overlay mutations produce events (images never change). An event identical to
the last one still queued is dropped. Subscriptions and watches die with the process.

## 8. Images

An image (`docs/design/image-format.md`) is a file in OPFS, opened read-only by each worker
that wants to read bodies itself (`createSyncAccessHandle({ mode: 'read-only' })`). The
index is read once into kernel memory at mount. Bodies are read in 128 KiB chunks through
the host import `host_image_read` into a cache shared by all instances; a chunk is read
from OPFS once per session. A thread with no handle (the page; a worker that started before
the mount) has its chunks read by kerneld.

| Export | Result | Notes |
| --- | --- | --- |
| `bat_image_reserve()` | image id | ids are small integers from 0; the host must have its handle registered under this id before mounting |
| `bat_image_mount(id, name, nlen, path, plen)` | entry count | reads the head through the **calling thread's** handle and attaches the image at `path` (created if missing). Mounts are not persisted; mount after the overlay is restored |
| `bat_image_count()` | count | ids reserved so far |
| `bat_image_name(id, buf, cap)` | len | the name given at mount (the OPFS file name); `ENOENT` if not mounted |
| `bat_image_stats(id, out)` | 0 | `out`: 4 × `f64` = entries, file length, cached bytes, host reads |
| `bat_image_section(id, section, out)` | 0 | `out`: 2 × `u32` = ptr, len of an in-head section (2 program scripts, 3 meta) |
| `bat_image_fault(image, chunk)` | 0 | supervisor: load a chunk on this thread and bump `BAT_FAULT_WORD` |

The cache has no eviction yet (see `docs/design/decisions.md`). Each mount also builds a
hash table from full path to entry, so a lookup below a directory that has no overlay
entries costs one probe (plus one per missing trailing component on a miss).

## 9. Overlay persistence

The overlay is journaled as physical records (node number based; format in
`crates/bat-kernel/src/persist.rs`). kerneld owns the OPFS files
(`bat/<namespace>/overlay/{journal,snap-a,snap-b}`), restores at boot, then enables
journaling. Directories marked non-persistent are never written and come back empty.

| Export | Result | Notes |
| --- | --- | --- |
| `bat_flush_begin()` | `f64` | asks the supervisor to drain; returns the sequence number to wait for, or −1 if persistence is off |
| `bat_flush_wait(seq, timeout_ms)` | 0 | workers: block until durable (`ETIMEDOUT`). Page: wait on `BAT_PERSIST_WORD` and compare `bat_persist_durable()` |
| `bat_persist_durable()` | `f64` | durable sequence number |
| `bat_persist_exclude(path, len)` | 0 | mark a directory (created if missing) non-persistent; call at every boot, after restore |
| supervisor only: | | |
| `bat_persist_replay(ptr, len)` | bytes applied | apply a snapshot or journal payload |
| `bat_persist_enable(seq)` | | start journaling at `seq` |
| `bat_journal_take(out)` | 0 | `out`: `{ u32 ptr, u32 len, f64 end_seq }`; free with `bat_blob_free` |
| `bat_persist_snapshot(out)` | 0 | same shape; all persistent nodes as records; discards pending journal bytes (they are in the snapshot) |
| `bat_persist_set_durable(seq)` | | publish and wake waiters |
| `bat_persist_pending()` | bytes | journal bytes not yet taken |

`kernel.flush()` (async, any thread) and `kernel.flushSync()` (workers) wrap this.

## 10. Supervisor (kerneld only)

| Export | Result | Notes |
| --- | --- | --- |
| `bat_kerneld_next(out)` | kind | 0 idle; 1 spawn (`out[0]` pid); 2 kill (pid, signal); 3 exited (pid); 4 fault (image, chunk); 5 flush. Wait on `BAT_KERNELD_WORD` between drains |
| `bat_proc_mark_exited(pid, status)` | 0 | for killed or crashed workers |
| `bat_proc_thread(pid)` | Thread ptr | thread bound to `pid`, 0 if none yet |
| `bat_thread_mark_dying`, `bat_thread_lock_depth`, `bat_thread_free` | | kill gate, section 2 |

## 11. Imports the host must provide

Module `env`: `memory`.

Module `bat`:

| Import | Signature | Contract |
| --- | --- | --- |
| `host_wait` | `(addr i32, expect i32, timeout_ms f64) -> i32` | `Atomics.wait` on the `i32` at `addr`; timeout < 0 = forever. Return 0 woken, 1 value differed, 2 timed out. Never called on a thread attached as non-blocking |
| `host_notify` | `(addr i32, count i32) -> i32` | `Atomics.notify`; count `0xffffffff` = all |
| `host_log` | `(level i32, ptr i32, len i32)` | UTF-8 text; level 1 stdout-like, 3 error |
| `host_now_ms` | `() -> f64` | wall clock, ms since the epoch |
| `host_image_read` | `(image i32, offset f64, ptr i32, len i32) -> i32` | read exactly `len` bytes of image `image` at `offset` into memory; return bytes read, `-11` if this thread has no handle for the image, another negative on failure. Must not call the kernel |

(The wait/notify instructions go through imports because the stable Rust toolchain does not
expose them; they are reached only on contended or blocking paths.)

Module `wasi_snapshot_preview1` (pulled in by Rust's std, not used for real work):
`environ_get`, `environ_sizes_get`, `fd_write` (panic messages; forward to the log),
`proc_exit` (throw), `sched_yield`, and optionally `clock_time_get`, `random_get`.
Module `wasi`: `thread-spawn` (return −1). Provide whatever `WebAssembly.Module.imports`
lists; `attach.ts` has all of them.

## 12. TypeScript binding

`runtime/src/kernel/`:

| File | What |
| --- | --- |
| `attach.ts` | `createKernelMemory()`, `attachKernel({ module, memory, canBlock, first?, host? }) → KernelInstance` (section 2) |
| `kernel.ts` | `createKernel(instance) → Kernel`: synchronous typed functions over the exports, constants (`O_*`, `K_*`, `POLL*`, `TOKEN_*`, `FACT_*`) |
| `errno.ts` | `kernelError(rc, syscall, path) → KernelError { code, errno, syscall, path }` |
| `boot.ts` | page: `bootKernel(options) → { kernel, kerneld(op, args), storeImage, mountImage, restored, timings, close }` |
| `kerneld.ts` | the supervisor worker script |
| `process-worker.ts` | process worker bootstrap; `ProcessContext` for runner modules |
| `opfs.ts` | OPFS layout, image download, handles |

`Kernel` functions throw `KernelError`; `try*` variants return `undefined` for
`ENOENT`/`ENOTDIR`; `*Raw` variants return the raw `-errno`. Summary:

- paths: `stat`, `tryStat`, `kindOf` (allocation-free existence probe), `statRaw` + `st`
  (raw `-errno`, fields read lazily from the scratch area until the next call: build your
  own Stats from it), `readFile`, `readFileInto(path, dst)` (no allocation; returns
  `-(size) - 1` if `dst` is too small), `tryReadFile`, `readText`, `readModule` (compiled body + facts for the loader),
  `writeFile`, `mkdir`, `rmdir`, `unlink`, `rename`, `symlink`, `link`, `readlink`,
  `realpath`, `chmod`, `utimes`, `truncate`, `readdir`
- fds: `open`, `close`, `read`, `readRaw`, `write`, `writeRaw`, `seek`, `fstat`,
  `ftruncate`, `fsetmeta`, `setNonblock`, `dup`, `fdPath`, `pipe`
- sockets: `listen`, `connect`, `accept`, `shutdown`, `sockPorts`, `socketpair`
- readiness: `subscribe`, `pollFd`, `poll`, `takeEvents`, `runEvents`, `watchAdd`,
  `watchRemove`, `watchRead`
- processes: `getpid`, `getppid`, `chdir`, `getcwd`, `spawn`, `procInfo`, `exit`,
  `waitpid`, `kill`, `sigTake`, `procList`
- images: `imageNames`, `imageStats`, `imageSection`
- persistence and misc: `flush`, `flushSync`, `overlayGeneration`, `retrying`

`readFile` and friends return private (non-shared) `Uint8Array` copies. Allocating that
array is most of the cost of a small read (`docs/experiments/2026-10-09-kernel-m0.md`):
layers that serve many small reads should pool and use `readFileInto`.

kerneld RPC ops (`booted.kerneld(op, args)`): `storeImage { name, url }`,
`hasImage { name }`, `removeImage { name }`, `mount { name, path }`, `snapshot`, `flush`,
`spareReady`, `stats`.

## 13. Reserved for the next exports (not implemented yet)

Shapes are fixed here so callers can be designed for them; names may still gain parameters.

- **Resolver**: implemented; see section 14 (owned by the node-runtime agent, in
  `crates/bat-kernel/src/resolve.rs`, binding in `runtime/src/loader/resolve.ts`).
- **HTTP/1.1 codec and WebSocket framing**: built, with a different shape from the one
  first reserved here (fd-based, so the kernel never copies body bytes). See section 15.

## 14. Resolver

Node's module resolution, done in one call. Owned by the node-runtime agent; the whole
implementation and its exports are in `crates/bat-kernel/src/resolve.rs` (`abi.rs` does not
change). It reads through the path functions of section 4 and never holds one of its own
locks across a VFS call.

```
bat_resolve(spec, slen, importer, ilen, flags, conds, clen, out, cap) -> i32
bat_package_scope(path, plen, out, cap) -> i32
bat_resolve_stats(out) -> 0
```

### `bat_resolve`

- `spec`: the specifier. Relative (`./x`, `../x`, `.`, `..`), absolute (`/x`), a `file://` URL
  (query and fragment dropped, percent-escapes decoded; an escaped `/` or a host other than
  `localhost` is `EINVAL`), `#name` (package `imports`), or bare (`pkg`, `pkg/sub`,
  `@scope/pkg`, `@scope/pkg/sub`). Builtins (`node:fs`, `fs`) are the caller's business and
  must be filtered before the call.
- `importer`: absolute path of the importing **file**, or of a **directory** when flags bit 1
  is set. It is taken as already real: the `node_modules` walk starts from it as written.
  Unused when `spec` is absolute or a `file://` URL.
- `flags`: bit 0 = ESM `import` (conditions `node`, `import`, the extras, `default`); clear =
  `require` (`node`, `require`, the extras, `default`). Bit 1 = `importer` is a directory.
  Bit 2 = do not realpath the result.
- `conds`: extra condition names, comma separated, may be empty (`"development,browser"`).
  `module-sync` is **not** built in: Node 22.12+ enables it for both `require` and `import`,
  so a caller that wants that Node's answers passes it here (in the TODO app's tree it changes
  `react-router`, `@react-router/node` and two more).
- `out`: byte 0 = package scope type of the resolved file: `0` no `type` field (or no
  package.json), `1` `"commonjs"`, `2` `"module"`, from the nearest package.json at or above
  the resolved file's directory, not looking above a directory named `node_modules`.
  Bytes 1.. = the resolved absolute path, realpath'd unless bit 2.
  One exception: an `imports` entry whose target is a `node:` builtin returns that target
  verbatim (`node:fs`; it does not start with `/`) with type byte 0.
- Returns `1 + path length`, or
  - `-ENOENT` module not found (also: a package was found but the file its `exports` names
    does not exist);
  - `-EACCES` the package has `exports` and the subpath or condition is not exported
    (`ERR_PACKAGE_PATH_NOT_EXPORTED`), or a `#name` is not defined by `imports`
    (`ERR_PACKAGE_IMPORT_NOT_DEFINED`);
  - `-EINVAL` invalid specifier, or an invalid `exports`/`imports` target or map;
  - `-ERANGE` `out` too small (nothing is written; the result is cached, retry is cheap);
  - `-ENAMETOOLONG` an argument over 65535 bytes;
  - `-EAGAIN` a package.json lies in an image this thread has no handle for yet (section 8:
    wait on the fault word and retry). `-EAGAIN`, `-EIO` and `-ENOMEM` are never cached.

Algorithm (checked against Node 24 on the TODO app's real dependency tree, see below):

- **Path requests** (relative, absolute, `file://`): the exact file; else, for a name ending in
  `.js` try `.ts` then `.tsx`, `.mjs` → `.mts`, `.cjs` → `.cts`, `.jsx` → `.tsx`; else append
  `.js .json .node .mjs .cjs .ts .tsx .mts .cts .jsx` in that order; else as a directory:
  package.json `main` (same file probing, then its index), then
  `index.js index.json index.node index.mjs index.cjs index.ts index.tsx`. A request ending
  in `/` (or `.`/`..`) is directory-only. The probing is the same in `import` mode (real Node
  refuses extensionless and directory imports; real `require` appends only
  `.js .json .node`). A `main` that resolves to nothing falls back to the index, and if that
  is missing too the lookup ends with `-ENOENT`.
- **Bare**: first self-reference (the importer's own package scope, if its `name` is the
  requested package and it has `exports`), then `<dir>/node_modules/<name>` for the
  importer's directory and each parent, skipping directories themselves named
  `node_modules`. In a package directory with `exports` the subpath goes through the map and
  the result must exist as written (no probing); a missing entry is `-EACCES`. Without
  `exports`: `main`/index for the package itself, path probing for a subpath; `module` and
  `browser` fields are ignored. If that finds nothing, `require` goes on to the next
  `node_modules` up, `import` stops with `-ENOENT`, as Node does.
- **`exports` / `imports` maps**: string, array (first valid entry), nested condition objects
  (key order decides), `null` excludes, exact subpath keys before patterns, one `*` per key
  with Node's precedence (longest prefix before the `*`, then longest key), every `*` in the
  target replaced by the match. Targets must start with `./`; `.`, `..` and `node_modules`
  segments in a target or a match are `-EINVAL`. An `exports` key ending in `/` matches
  nothing (Node dropped folder mappings). An `imports` target that is not `./` is resolved as
  a bare specifier from that package's directory.
- **`#name`**: the nearest package.json's `imports`. In `require` mode a scope without an
  `imports` field gives `-ENOENT`, in `import` mode `-EACCES`; a lone `#` is `-EINVAL`.
- A malformed package name (`@scope` without a name) is `-EINVAL` for `import` and `-ENOENT`
  for `require`. A package.json that does not parse counts as an empty one.

### `bat_package_scope`

`path` is a file or directory (absolute, or relative to the working directory; it need not
exist, in which case it is taken as a file). Finds the nearest package.json at or above the
directory (for a directory: starting with the directory itself), not looking above a
directory named `node_modules`. `out` byte 0 = type as above, bytes 1.. = the absolute path
of that package.json (not realpath'd). Returns `1 + path length`, `-ENOENT` if there is none,
`-ERANGE` if `out` is too small.

### `bat_resolve_stats`

`out`: 8 × `f64`: resolve calls; result-cache hits; VFS stat calls made by the resolver;
package.json files read and parsed; package.json cache hits; nanoseconds spent in resolutions
that missed the result cache (`host_now_ms` deltas, so the resolution is whatever the host
clock gives; two host calls per miss, none per hit); result-cache entries; package-cache
entries. Counters are process-wide and never reset.

### Caches

Both are kernel statics shared by every process, behind kernel `RwLock`s.

- **Packages**: per directory, the parsed summary of its package.json (`name`, `main`,
  `type`, the `exports` and `imports` trees) or "none here". An entry is valid for the
  `BAT_OVERLAY_GEN` it was filled at. After a generation change an entry that came from an
  image (`Stat.dev != 0`) is revalidated with one stat (same `dev` and `ino`) instead of being
  read again; overlay entries and negatives are re-read.
- **Results**: keyed by (flags, `conds`, importer directory, `spec`), holding the answer or
  the errno (`ENOENT`, `EACCES`, `EINVAL`). Dropped whole when `BAT_OVERLAY_GEN` changes or at
  65536 entries. A hit takes one read lock, one hash and one copy.

Limit: `BAT_OVERLAY_GEN` counts namespace changes only. Rewriting an existing overlay
package.json **in place** (same name, new contents) does not bump it, so its cached summary
and the results derived from it stay until the next create, remove, rename or mount anywhere
in the overlay.

### Verification

`resolve.rs` has table tests for the JSON parser and the map matching, and an opt-in test
(`resolve::tests::real_tree`, `--ignored`) that mounts an image natively and replays a case
file produced by asking real Node (`require.resolve` through `createRequire`, and
`import.meta.resolve`). Last run: 9143 cases over the TODO app's real `node_modules` (every
package's self-reference, own `exports` and `imports` keys, each dependency and its exported
subpaths, from the package root and from a nested directory) plus a small fixture tree; all
agree with Node 24.18, including the type byte and the nearest package.json, with
`module-sync` passed in `conds`.

## 15. HTTP/1.1 and WebSocket codecs, port identity

`crates/bat-kernel/src/http.rs`, `ws.rs`; binding `runtime/src/net/codec.ts`. Both codecs
work on a socket fd and read or write its rings in place. A socket direction must have one
reader and one writer. Pointers reported in events point into the receive ring and stay
valid until the next `*_recv` (or `bat_http_release`) on the same parser.

Events are `u32` words written to a caller buffer:

| Event | Words |
| --- | --- |
| `1` head | `1, total_words, flags, status, head_ptr, head_len, a_off, a_len, b_off, b_len, length_lo, length_hi, n`, then `n` × `name_off, name_len, value_off, value_len`. Offsets are into the head bytes at `head_ptr`. Request: `a` = method, `b` = target. Response: `a` = reason. |
| `2` body | `2, ptr, len` |
| `3` message end | `3, 0` |
| `4` end of stream | `4, clean` (`1`: between messages, or after an until-close body) |
| `5` error | `5, errno` (`71` EPROTO: malformed message) |
| `6` WebSocket frame | `6, flags, len_lo, len_hi` (flags: opcode in bits 0..3, `0x100` FIN, `0x200` masked) |
| `7` WebSocket payload | `7, ptr, len` (already unmasked) |
| `8` WebSocket frame end | `8` |

Head flags: `1` keep-alive, `2` chunked, `4` upgrade (the parser pauses), `8` has
Content-Length, `16` Expect: 100-continue, `32` body runs until close, `64` HTTP/1.0,
`128` no body by status or method.

| Export | Result | Notes |
| --- | --- | --- |
| `bat_http_parser_new(kind)` | handle | `0` requests, `1` responses |
| `bat_http_parser_free(handle)` | | |
| `bat_http_recv(handle, fd, out, cap_words)` | words written | `0`: nothing new, wait for readability. At most one head per call. `cap_words` must fit a head (`13 + 4 × headers`); the binding uses 2048 |
| `bat_http_release(handle, fd)` | 0 | release lent ranges without parsing further |
| `bat_http_resume(handle, fd, raw)` | 0 | after a head with the upgrade flag: `raw != 0` ends the parser and leaves the bytes after the head in the ring for `bat_read`; `0` continues as HTTP |
| `bat_http_expect_no_body(handle)` | 0 | the next response answers a HEAD request |
| `bat_http_reserve(fd, flags, out)` | capacity | free part of the send ring: `out` = `cap, ptr1, len1, ptr2, len2`. `flags` bit 0: room is kept for chunk framing. `-EAGAIN` when full, `-EPIPE` when the peer is gone |
| `bat_http_commit(fd, flags, n)` | n | publish `n` bytes written after reserve; with bit 0, as one chunk (`%08x\r\n` … `\r\n`) |
| `bat_ws_new()`, `bat_ws_free(handle)` | handle | frame parser |
| `bat_ws_recv(handle, fd, out, cap_words)` | words written | |
| `bat_ws_reserve(fd, flags, len, out)` | n | writes a frame header for up to `len` (f64) payload bytes into the send ring, unpublished; `out` = `header_len, n, ptr1, len1, ptr2, len2`. `n < len`: the frame was cut and sent without FIN, continue with opcode 0. Flag `0x200` sets the MASK bit with a zero key |
| `bat_ws_commit(fd, total)` | 0 | publish `header_len + n` bytes |
| `bat_ws_accept_key(key, len, out)` | 28 | `Sec-WebSocket-Accept` text |
| `bat_port_listener(port)` | id | identity of the listener on `port` (never reused), 0 if none; wait on the exported word `BAT_PORTS_WORD` for changes |

`bat_close` now also drops readiness events still queued for that fd.

## 16. Additions by the node runtime

- **`bat_module_facts(path, len, buf, cap) -> len`** (`crates/bat-kernel/src/module_facts.rs`):
  the facts blob (import/export lists, `docs/design/module-format.md` §6) of the image
  entry at `path`; 0 if it has none or the file is not in an image. On `ERANGE` the needed
  size is in `buf[0..4]`. `bat_read_file` with the compiled flag returns only the body and,
  in the stat, the facts word; the loader asks for the blob when an ES module imports a
  CommonJS module by name.
- **`bootKernel({ processWorkerType: 'classic' })`** is passed to kerneld's
  `new Worker(...)`. The node runtime's worker is a classic script
  (`runtime/dist/bat-process.js`, built by `runtime/build.ts`); its configuration is in the
  URL fragment (`processWorkerUrl` in `runtime/src/process/config.ts`). It speaks the same
  `attach` / `images` / `run` → `ready` / `error` protocol as `process-worker.ts` and
  ignores `runnerUrl`.
- **A process worker must not both call `bat_proc_exit` and post `exited`.** kerneld
  retires the worker for each, and `retire` schedules `bat_thread_free` each time; the
  second free corrupts the heap (observed as the page spinning on a lock about five
  seconds later). The node worker relies on the supervisor event alone. `retire` should
  ignore a worker it has already retired.
- **`proc::finish` publishes the status before closing the files** (it used to store it
  afterwards, so `waitpid` right after pipe EOF could return 0).
