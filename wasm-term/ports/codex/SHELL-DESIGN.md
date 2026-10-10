# A shell tool for in-tab codex, from bat-rust: design and prototype (2026-10-10)

Question: codex runs in a browser tab as a `wasm32-wasip1` guest of wasm-term. How does its
shell tool (run a command, read its output, get the exit status) get a real shell and a
filesystem shared with codex's own file tools, using the `bat-rust` project?

Paths used below: **WT** = this worktree's `wasm-term/`; **BR** = the bat-rust worktree
`/home/kkrausse/devfs/repos/kkrausse/bat-rust/.claude/worktrees/codex-shell` (branch
`codex-shell`, off `rewrite/rust`). "Ran" means I ran it; "read" means I read the code and
did not run it; "inferred" means neither.

## 1. Short answer

Run bat-rust's shell **as it is already built** (`bat_sh.wasm`, 521 KiB, one file) as a
component of wasm-term's host, in its own Worker, with its 24 host calls answered from the
vfs codex already uses. Do not move codex onto the bat-rust kernel, and do not recompile the
shell for WASI.

The fact that decides it: bat-rust's shell is not tied to bat-rust's kernel. It is a
`wasm32-unknown-unknown` module with its own memory whose whole view of the world is 24
imports in a module named `sh` (open, read, write, stat, readdir, rename, ...; `BR/crates/bat-sh/src/sys.rs`),
and the coreutils are functions inside it, not programs. bat-rust's own runtime binds those
imports to its kernel in 318 lines (`BR/runtime/src/process/sh.ts`). Binding them to
wasm-term's vfs instead is the same job, and the prototype does it in about 370 lines of
TypeScript with **no change to bat-rust and no change to wasm-term's host**.

What that gives, all of it run in Chrome 154 and in Playwright's WebKit (section 6):
`bash -lc '…'` commands from a `wasm32-wasip1` Rust program on wasm-term's host; stdout,
stderr and exit status as events on one descriptor that `poll_oneoff` waits on; output while
the command is still running; several commands at once; kill, including of a busy loop; one
filesystem, no copying. A command starts in **0.1 ms** (median, spawn to exit event for
`echo hi`), the first one of a page in about 10 ms.

What it does not give: programs that are not in the shell. No `rg`, `awk`, `diff`, `git`,
`python`, `node` (section 2). Those are the real remaining work, and they are bat-sh work
whichever integration is chosen.

## 2. What bat-rust offers, and what codex needs (question 1)

### What codex asks of a child (read, `WT/vendor/codex/codex-rs`, 0.162.0)

- One tool pair: `exec_command` and `write_stdin` (unified exec); every model's
  `shell_type` maps to it (`protocol/src/openai_models.rs:316-320`).
- argv is `[shell, "-lc", command]`; `-lc` because `allow_login_shell` defaults to true
  (`core/src/shell.rs:24-33`, `core/src/tools/handlers/unified_exec.rs:100-141`).
- The shell is found without `$SHELL`: on non-unix `get_user_shell_path()` is `None`, then
  `which("bash")`, `/bin/bash`, `/usr/bin/bash`, zsh, and last `/bin/sh` unchecked
  (`shell-command/src/shell_detect.rs:122-125, 315-370`). Existence is `std::fs::metadata`,
  so **a file `/bin/bash` in the vfs makes codex choose bash**. bat-rust already plants such
  stubs (`SHELL_STUBS` in `BR/runtime/src/process/sh.ts`).
- cwd, an environment (filtered `std::env::vars()` plus `NO_COLOR=1 TERM=dumb PAGER=cat
  GIT_PAGER=cat CODEX_CI=1 …`, `core/src/unified_exec/process_manager.rs:93-104`), **stdin
  null** unless `tty: true`, stdout and stderr as two pipes read in 8 KiB chunks and merged
  at once (`utils/pty/src/pipe.rs:108-122`, `core/src/unified_exec/process.rs:369`).
- No kill timeout in interactive mode: `yield_time_ms` (250 ms to 30 s) is how long to
  collect before answering "still running, session N"; the process lives on and is polled
  with `write_stdin("")`. A turn interrupt does not kill it; session shutdown and dropping
  the handle do. With `tty=false` the only input accepted is `"\u{3}"` (interrupt).
- Exit status is an `i32`; a signal is 128 + signo.
- The narrowest place to substitute a backend: `codex_sandboxing::spawn_process(SpawnRequest
  { command, cwd, env, arg0, sandbox, tty, stdin_open, … }) -> SpawnedProcess`
  (`sandboxing/src/spawn.rs:31-45`), which can return
  `codex_utils_pty::spawn_from_driver(ProcessDriver { writer_tx, stdout_rx, stderr_rx,
  exit_rx, terminator, … })` (`utils/pty/src/process.rs:364-378`): a channel-shaped child
  with no `std::process` type in it.
- `apply_patch` typed as a shell command is intercepted in-process before any spawn
  (`core/src/tools/handlers/apply_patch.rs:436`), so the shell does not need it.
- Other subprocesses in a turn (git metadata, shell snapshot) tolerate failure; turn
  `shell_snapshot` off rather than let it run a dump script.

The other agent's spawn seam was not in the tree or in `NOTES.md` when this was written
(`ports/codex/main/src/local.rs` only says the shell tools answer "no shell in this
build"), so section 5 is written against codex's own types above.

### How bat-rust runs a command (read, and its numbers are bat-rust's own)

- `BR/crates/bat-sh`: about 8,300 lines of Rust, one dependency (`regex-lite`), a
  POSIX-style shell with the coreutils built in. Exports `sh_alloc`, `sh_free`,
  `sh_run(request) -> status`; imports the 24 `sh_*` calls. A run is one function call.
- Synchronous callers (`execSync`) run it inside the calling Worker: 0.04 ms for `echo hi`.
  Asynchronous callers get a kernel process in a warm spare Worker: 3.5 ms, or 49 to 124 ms
  when the spare is not ready (`BR/docs/experiments/2026-10-10-first-open-and-shell.md`).
- Only `node` and JavaScript programs are real children (`sh_spawn`, `sh_pipe`, `sh_wait`).
  Pipeline stages that are builtins run one after another, each into a buffer: there is no
  concurrency inside a pipeline, so `yes | head` is refused, and a signal is noticed only at
  a host call.
- bat-rust's guests are JavaScript programs. There is no WASI executable format in its
  kernel (`BR/docs/experiments/2026-10-10-rust-rewrite-summary.md` section 7).

### Coverage (ran)

215 command lines a coding agent types, in `BR/crates/bat-sh/tests/codex-cases.tsv`, each run
under the machine's bash and under bat-sh on the same files. Two runs, same verdicts apart
from how a missing program inside a pipeline is counted:

- native bat-sh with an empty `PATH` (`BR/crates/bat-sh/tests/codex-coverage.sh`, recorded in
  `codex-coverage.txt`): 147 equal to bash, 28 differ, 40 "command not found";
- **the integration itself**: `bat_sh.wasm` on wasm-term's vfs through the prototype's
  adapter, under Bun (`WT/ports/shell-proto/coverage.ts`, recorded in
  `results/coverage-wasm.txt`): 146 equal, 12 differ, 57 name a missing program.

| Area | Equal to bash | Differs or missing |
| --- | --- | --- |
| Invocation | `bash -lc '…'`, `/bin/bash -lc` (as argv[0]), `sh -c`, `zsh -lc`, `bash -c '…' _ a b`, `bash script.sh`, `bash -euo pipefail -c` (fixed in BR, below) | nested `/bin/bash -lc 'echo $0'` prints `bash`, not `/bin/bash` |
| Language | pipelines, `&&` `\|\|` `;`, `>` `>>` `<` `2>&1` `&>` `2>/dev/null` `\|&`, globs, `{a,b}`, `( )`, `{ }`, `$( )`, backticks, `$(( ))`, `${v##*/}` `${v%.x}` `${v/a/b}` `${#v}` `${v:-d}` `${v:1:3}` `${v^^}`, here-docs (quoted and not), `<<<`, `for` `while` `until` `case` `if`, functions and `local`, `[[ == ]]`, `$'…'`, `set -e` `-x` `-o pipefail`, `&` + `wait`, `export`, `cd -`, `~`, `eval`, `exec`, `time`, `trap … EXIT`, `read`, `printf -v`, `source`, `command -v`, multi-line scripts | **arrays** (`a=(x y)`: syntax error), associative arrays, **process substitution** `<( )` (syntax error), `BASH_REMATCH` (empty), `shopt`, `pushd`/`popd`, `ulimit`, `alias` listing |
| Reading | `cat` (`-n`), `head` (`-n`, `-c`), `tail` (`-n`, `+N`, `-c`), `sed -n 'a,bp'`, `wc`, `ls` (`-la` `-1` `-R` `-lh` `-S` `-d` `-p` `-F`), `stat -c`, `du -sh`, `pwd`, `realpath`, `basename`, `dirname` | **`nl`**, `tree`, `file`, `less`, `od`, `xxd`, `strings`, `md5sum`, `sha256sum`, `base64`, `cmp` |
| Searching | `grep` with `-n -r -l -L -E -F -P -i -c -v -o -w -x -q -H -h -m -e -A/-B/-C --include --exclude-dir`; `find` with `-name -iname -type -maxdepth -path -not -o ( ) -size -mtime -empty -prune -delete -print0 -exec … \;` and `+`; `xargs -0`; `which` | **`rg`** in every form (`rg pat`, `rg --files`, `rg -l -g`), `fd`; `find -regex`, `find -printf` |
| Editing | `sed -i` (several `-e`, `-E` groups, `i\` `a\`, `/re/,/re/`, `y`, `=`, `-i.bak`), `cat > f <<EOF`, `printf > f`, `tee` (`-a`), `>>`, `mkdir -p`, `rm -rf`, `mv`, `cp` (`-r`, `-a`), `touch`, `ln -s`, `readlink`, `chmod`, `mktemp` (`-d`), `: > f`, `rmdir` | **`patch`**, `ed`, `dd`, `truncate`; `apply_patch` (not needed: codex handles it before spawning) |
| Text | `sort` (`-u -n -r -k -t`), `uniq` (`-c -d`), `cut`, `tr`, `xargs` (`-I`, `-n`), `tac`, `rev`, `seq`, `printf`, `echo -e/-n`, `seq … \| head` | **`awk`**, **`diff`** (`-u`, `-q`, `-r`), `paste`, `comm`, `column`, `fold`, `expr`, `bc`, `jq`, `split`, `expand`; `yes \| head` is refused |
| System | `date` (`+fmt`, `-u`, `-d @N`), `env`, `printenv`, `uname`, `whoami`, `id`, `hostname`, `nproc`, `sleep`, `true`, `false`, `test`, `type`, `umask` | `df`, `ps`, `timeout`, `tar`, `gzip`, `zip`, `curl`, `wget` |
| Tools | | **`git`**, **`python`/`python3`**, **`node`** (a kernel process in bat-rust; nothing to run it here), `perl`, `ruby`, `make`, `cargo`, `gcc`, `pip`, `pytest`, `sudo`. `npm --version` answers from a stub that only does `npm run` |

Read against codex's own prompt (`models-manager/models.json`: "you reach first for `rg` or
`rg --files`… If `rg` is unavailable, you use the next best tool without fuss"; "file reads
such as `cat`, `rg`, `sed`, `ls`, `git show`, `nl`, and `wc`"): the read/edit/search loop is
covered except **`rg`, `nl`, `git`**. Past that the model's habits that fail are `awk`,
`diff`, `python`.

One defect found and fixed in BR (commit `a2e480d`): `bash -euo pipefail -c '…'` ran
`pipefail` as the script. The 128 existing differential cases still pass (ran).

## 3. Integration shapes (question 2)

| | a. codex as a process on the bat-rust kernel | b. bat-rust runtime beside wasm-term, files synced | c. shell + coreutils recompiled to `wasm32-wasip1` as guests | **d. `bat_sh.wasm` as a wasm-term host component (recommended)** |
| --- | --- | --- | --- | --- |
| What it is | wasm-term keeps the pty and the page; WASI files, pipes and spawn go to bat-rust's kernel in shared memory | two machines in one tab; a command runs in bat-rust's process table on a copy of the workspace | bat-sh gets a WASI backend; children are more wasm-term Workers; wasm-term's host grows a process table and a filesystem shared between Workers | the shell module unchanged; its 24 imports answered from wasm-term's vfs; children are shell Workers on a shared-memory channel |
| bat-rust changes | a WASI executable format (none exists), a pty or a pass-through for one, a way for the page to wake a process's event word; booting without an image | none in the kernel; an exec endpoint | a third `sys.rs` backend (the two there are `sh` imports and unix `std`; `cfg(target_arch = "wasm32")` selects the imports for wasip1 as well) | **none**. Wanted later: more builtins (section 2) |
| wasm-term changes | the file half of `host/wasi.ts` (about half of 808 lines), `vfs.ts`, `persist*.ts`, `node/fs.ts` replaced; `poll_oneoff` waits on two machines' wake words | spawn seam to the other runtime; a file syncer both ways | a process table, pipes, a vfs reachable from several Workers (the same problem d solves, at WASI level) | one new descriptor kind and 4 imports in `host/wasi.ts`; three hooks in `host/machine.ts`; the page creates shell Workers. About 1,100 lines exist in the prototype |
| Effort | weeks, in both projects at once | a week, then permanent sync bugs | more than d for the same result | days |
| Fidelity | best: real pipes, real process table, `node`/`npx tsc` children, concurrent pipelines | good for commands, wrong for files (two copies, stale reads) | same shell as d | bat-sh's: sequential pipelines, no programs outside the shell |
| Filesystem | one, bat-rust's: image + overlay journaled to OPFS; no size limit in practice | two | one, wasm-term's | **one, wasm-term's**, the same objects |
| Cost of a file call from a child | a function call | - | a channel round trip | a channel round trip: 4 to 6 µs measured, 15 without spinning, 60 to 110 on an overloaded machine |
| Spawn | 3.5 ms warm, 49 to 124 ms cold (bat-rust's numbers) | the same | a Worker start per child unless pooled | **0.1 ms** warm, about 10 ms the first time (measured) |
| Browsers | bat-rust has only ever run in Chrome (its README); its kernel memory is declared with a 4 GiB maximum (`BR/runtime/src/kernel/attach.ts:41`), which has not been tried on iOS, where large shared maximums are a known source of allocation failures (inferred); one editor per origin (a Web Lock) | the same | as wasm-term | as wasm-term: ran in Chrome and in Playwright's WebKit, desktop and iPhone profile |
| Persistence | OPFS journal (better for large trees) | both | IndexedDB, whole files | IndexedDB, whole files, as today |

Notes on the points the brief asked to consider:

- **Cross-origin isolation.** Both projects already require COOP `same-origin` + COEP
  `require-corp`; d adds SharedArrayBuffers between Workers of the same page, nothing new.
- **Worker topology.** d: page, the guest's Worker (owns the vfs), N shell Workers. The page
  creates the shell Workers because it is the only thread that is never blocked; a Worker
  that blocks right after `new Worker()` may never see its child start. bat-rust has the
  same rule (its supervisor creates process Workers and keeps a spare).
- **Output while codex is blocked or polling.** In d the child's writes are host calls that
  land in the guest Worker's queue for that descriptor; `poll_oneoff` reports the descriptor
  readable; tokio's reactor wakes. Nothing passes through the page. While codex computes
  (a frame of the TUI) the child waits in its call; that is the price of one thread owning
  the filesystem.
- **Cancellation and timeouts.** codex decides (its yield and its handle drop); the host
  provides `proc_signal` and close-kills. A shell at a host call ends within a few ms; one
  spinning without host calls is terminated with its Worker after 250 ms and the Worker is
  replaced (ran).
- **Persistence.** Unchanged: `host/persist.ts` reports changed files below the persistent
  roots when told to (`onFsChange`). The shell must trigger it after each run; the prototype
  has the hook and does not exercise it (inferred). Its scan walks every file below the
  roots, so a workspace of thousands of files under `$HOME` makes every command pay a walk,
  and whole-file IndexedDB writes do not suit large trees: that limit is wasm-term's, not
  the shell's, and it is the strongest argument for a later.
- **Safari/iOS.** Nothing in d needs more than wasm-term already needs: SharedArrayBuffer,
  `Atomics.wait` in Workers, a `WebAssembly.Module` sent by `postMessage`. Ran on WebKit's
  engine on Linux only; a real iPhone was not tried, and on a phone with few cores the
  spinning that buys 4 µs calls may not pay.
- **The opencode TUI talking to bat-rust's in-tab OpenCode server.** That needs no shared
  filesystem and no shared kernel: it is HTTP. bat-rust gives the page a fetch function onto
  a kernel socket (`RuntimeEndpoint` in `BR/packages/toolkit/src/runtime-host.ts`) and a
  URL the service worker routes; the opencode TUI is a JavaScript guest that uses the
  browser's own `fetch`. So it is a page-level wiring (both runtimes booted in one page, the
  TUI's `server` set to bat-rust's endpoint), independent of a to d. Read, not tried. It
  does mean both runtimes will coexist in one tab one day, at which point b's exec bridge
  becomes cheap to add for `node` programs.

## 4. Recommendation, and what would change it (question 3)

**d.** It is the only shape in which neither project has to change to get a working shell,
it is the fastest at what an agent does most (hundreds of sub-millisecond commands), it
keeps the one filesystem codex's file tools already write, and it runs wherever wasm-term
runs. The interface it puts in front of codex (an asynchronous child with a pollable event
descriptor) is the same one a, b or c would need, so choosing d does not close them.

Inside d, run the shell in a Worker, not inline in the guest's Worker. Inline is simpler and
faster per file call, but the guest is frozen for the length of the command, output arrives
only at the end, and a runaway loop cannot be stopped; the measured cost of the Worker is
0.04 ms per command and about 5 µs per file call. Inline stays as a fallback for a device
where a second Worker is not affordable.

What would change the recommendation:

1. **The agent must run real programs** (`npm test`, `tsc`, a project's scripts, `git`).
   None of that is in the shell; `node` exists only as a bat-rust kernel process. Then a (or
   b once both runtimes share a tab) is the way, and d's seam stays as the interface.
2. **Workspaces outgrow an in-memory vfs with whole-file IndexedDB persistence** (a cloned
   repository, tens of thousands of files). bat-rust's OPFS image + overlay is built for
   that; this alone would justify a.
3. **File calls across the channel are slow on real devices.** Measured here at 4 to 6 µs
   on a 12-core machine, 60 to 110 µs when it was overloaded. If phones sit at the slow end,
   `grep -r` over a few thousand files takes seconds: go inline by default there, or give
   bat-sh a `sh_read_file` call (one round trip per file instead of five).
4. **The spawn seam the other agent lands is synchronous** (a call that returns the whole
   output). Then start with inline mode, which satisfies it with one function call.

## 5. The interface

Three boundaries. The middle one exists today; the outer two are proposals the prototype
implements in a disguised form (section 6).

### 5.1 codex ↔ wasm-term host: four imports and one descriptor kind

Modelled on the WebSocket descriptor of `docs/abi.md` 3.3: a pollable descriptor that
delivers typed events.

```
// module wasm_term; every function returns a WASI errno
proc_spawn(req: *const u8, req_len: i32, flags: i32, fd: *mut u32) -> errno
proc_recv(fd: i32, buf: *mut u8, buf_len: i32, out: *mut [u32; 2], flags: i32) -> errno
proc_send(fd: i32, data: *const u8, len: i32) -> errno      // stdin; PIPE while stdin is closed
proc_signal(fd: i32, signo: i32) -> errno                    // 2 INT, 15 TERM, 9 KILL
```

- `req`: `u32 argc, u32 envc`, then `cwd`, `argv…`, `env…` (`NAME=value`), each `u32
  length` + bytes. (bat-sh's own `sh_run` request minus its three stdio words.)
- `flags`: bit 0 = keep stdin open (codex's `stdin_open`); 0 today.
- `proc_spawn` returns at once. `NOENT` only if `argv[0]` is neither a shell name nor one of
  the shell's commands (`SHELL_NAMES` / `SHELL_PROGRAMS` in `BR/runtime/src/process/sh.ts`);
  an unknown program inside a command line is the shell's 127.
- `proc_recv` takes the next event; `out[0]` = kind, `out[1]` = payload length. `AGAIN` when
  none is queued and `flags & 1` or the descriptor is non-blocking; `RANGE` when `buf` is too
  small, with `out` filled in (the event stays queued), exactly like `ws_recv`.

  | kind | Event | Payload |
  | --- | --- | --- |
  | 1 | stdout | bytes, at most 256 KiB per event |
  | 2 | stderr | bytes |
  | 3 | exited (last event) | `i32 status` (128 + signo when killed), `i32 signo` or 0 |

- `poll_oneoff`: readable when an event is queued; never writable.
- `fd_close` on a running child kills it (`KILL`) and frees its Worker.
- Back-pressure: the child's writes are not answered while more than 1 MiB of events are
  unread.

Rust side, in the codex port, behind the seam (`codex_sandboxing::spawn_process`, a
`cfg(target_os = "wasi")` arm):

```rust
// guests/wasm-term-sys: the raw imports. guests/wasm-term-tokio: the async wrapper.
pub struct Child { fd: RawFd, ready: Readiness }
pub enum ChildEvent { Stdout(Vec<u8>), Stderr(Vec<u8>), Exit { status: i32, signal: i32 } }
impl Child {
    pub fn spawn(argv: &[String], cwd: &Path, env: &HashMap<String, String>) -> io::Result<Child>;
    pub async fn recv(&mut self) -> io::Result<ChildEvent>;   // Readiness::readable + proc_recv
    pub fn signal(&self, signo: i32) -> io::Result<()>;
}

// codex: one task per child pumps events into the channels spawn_from_driver wants.
let child = Child::spawn(request.command, request.cwd, request.env)?;
tokio::task::spawn_local(async move {
    loop { match child.recv().await? {
        ChildEvent::Stdout(b) => { let _ = stdout_tx.send(b); }
        ChildEvent::Stderr(b) => { let _ = stderr_tx.send(b); }
        ChildEvent::Exit { status, .. } => { let _ = exit_tx.send(status); break; }
    } }
});
Ok(spawn_from_driver(ProcessDriver { writer_tx, stdout_rx, stderr_rx: Some(stderr_rx), exit_rx,
    terminator: Some(Box::new(move || signal(fd, 9))), writer_handle: None, resizer: None }))
```

`tty: true` is refused (`NOTSUP`) at first; `write_stdin("\u{3}")` maps to
`proc_signal(fd, 2)`, which needs the non-unix arm of `utils/pty/src/pipe.rs:61-86` to stop
answering Unsupported (read, not built).

### 5.2 wasm-term host ↔ bat-rust: `bat_sh.wasm`, unchanged

The module `BR/crates/bat-sh/build-wasm.sh` writes to `BR/crates/bat-sh/js/bat_sh.wasm`.

```
exports  memory
         sh_alloc(n: usize) -> *mut u8          sh_free(p, n)
         sh_run(req: *const u8, len: usize) -> i32        // exit status
         sh_out_ptr(which) / sh_out_len(which)            // in-memory captures; unused here

sh_run request: i32 stdio[3] (a host descriptor, -1 nothing, -2 memory), u32 argc, u32 envc,
                cwd, argv…, env…, stdin bytes; each u32 length + bytes

imports, module "sh"; paths absolute; results >= 0 or a negated Linux errno
  sh_open(path, len, flags, mode) -> fd        flags: Linux O_* (CREAT 0o100, EXCL 0o200, TRUNC 0o1000, APPEND 0o2000)
  sh_close(fd)   sh_read(fd, buf, n) -> n      sh_write(fd, buf, n) -> n
  sh_stat(path, len, follow, out: *mut [f64; 4])     // kind (0 file, 1 dir, 2 symlink), mode, size, mtime ms
  sh_readdir(path, len) -> n     sh_readlink(...) -> n     sh_realpath(...) -> n     sh_take(buf, cap)
        // the three return a byte count; sh_take copies the bytes. readdir: "<kind digit><name>" joined by NUL
  sh_mkdir(path, len, mode)   sh_rmdir   sh_unlink   sh_rename(a, alen, b, blen)   sh_symlink(target, tlen, path, plen)
  sh_chmod(path, len, mode)   sh_utimes(path, len, ms: f64)
  sh_pipe(out: *mut [i32; 2])   sh_spawn(req, len) -> pid   sh_wait(pid) -> status   sh_kill(pid, sig)
  sh_now() -> f64   sh_sleep(ms: f64)   sh_tz() -> i32 (minutes east)   sh_pid() -> u32
```

On wasm-term: the fifteen file calls go to the vfs (`ports/shell-proto/host/sh-host.ts`);
`sh_pipe`/`sh_spawn`/`sh_wait`/`sh_kill` answer "no such program" until there is something
to spawn; `sh_sleep` waits in the shell's own Worker and watches for a kill; descriptors 1
and 2 of the run are the child's event queue. To stop a run from outside, a host call
throws through the shell's frames and the instance is discarded, as bat-rust's own binding
does.

Asked of bat-rust, none of it blocking: publish the module as a build output with a version
(a `sh_abi()` export); `sh_read_file(path) -> n` to make a whole-file read one call; the
builtins of section 7 step 5.

### 5.3 Shell Worker ↔ guest Worker: the channel (`ports/shell-proto/host/channel.ts`)

One SharedArrayBuffer per shell Worker: 16 `i32` words, then 1 MiB of data.

| Word | Written by | Meaning |
| --- | --- | --- |
| `READY` | shell | 1 once its instance exists and it waits for a job |
| `JOB` | guest | bumped to start a run; the request (5.1 `req`) is in the data area; the shell sleeps on this word between runs |
| `REQ` | both | 0 none, 1 call pending (shell), 2 reply ready (guest) |
| `KILL` | guest | signal number; the shell ends at its next host call |
| `RC`, `LEN` | guest | the reply: result, and bytes of reply data |
| `STARTED`, f64 at byte 32 | shell | picked the job up, and when |

A call is `i32 op, f64 n1, f64 n2, u32 len1, u32 len2, u32 len3, s1, s2, data` with `op` one
of `OPEN CLOSE READ WRITE STAT READDIR READLINK REALPATH MKDIR RMDIR UNLINK RENAME SYMLINK
CHMOD UTIMES` or `EXIT(status, signo)`. The shell writes it, sets `REQ = 1`, **adds 1 to the
wake counter of the guest's page→Worker ring (`H_WAKE`) and notifies it**, then waits on
`REQ`. The guest Worker serves pending calls at the top of every blocking host call
(`machine.pump()`), and its sleep samples the wake counter before it looks at the channels,
so a call posted in between is not missed. Both sides stay awake for 50 µs looking for the
other's next move before sleeping.

Page ↔ guest Worker: `InitMessage` gains `proc: { shModule: WebAssembly.Module, channels:
SharedArrayBuffer[], spinUs }`; `WorkerMessage` gains `{ t: "proc_need", slot }` (no Worker
on this channel yet) and `{ t: "proc_replace", slot }` (terminate it and start another on
the same channel). The page creates `new Worker(shellWorkerUrl)` and posts `{ t:
"shell-init", channel, parent: <the ring's SharedArrayBuffer>, wakeIndex: H_WAKE, module,
spinUs }`.

## 6. Prototype: what it shows, how to run it

Code: `WT/ports/shell-proto/` (commit `ac36686`). Nothing under `host/`, `web/`, `kernel/`,
`guests/` or `ports/codex/` is edited; host code is imported read-only.

```sh
# once: wasm-term's kernel (cd WT/web && bun run build) and bat_sh.wasm:
cd /home/kkrausse/devfs/repos/kkrausse/bat-rust/.claude/worktrees/codex-shell
CARGO_TARGET_DIR=$PWD/target-codex-shell/sh-wasm sh crates/bat-sh/build-wasm.sh

cd <WT>/ports/shell-proto
./run.sh                              # everything, in the shared Chrome through browser-control (about a minute)
./run.sh 'arg=quick'                  # the checks without the timings
./run.sh 'warm=0&arg=cold&arg=quick'  # first command with no shell Worker started
./run.sh 'spin=0&arg=worker-only'     # the channel without spinning
bun web/server.ts & web/webkit.sh '' iphone     # the same page in Playwright's WebKit
bun coverage.ts                       # the 215 coverage cases through the adapter, under Bun
```

What is in it:

| File | |
| --- | --- |
| `guest/src/main.rs` | the stand-in for codex: a `wasm32-wasip1` Rust program (std + `guests/wasm-term-sys`) that writes files with `std::fs`, spawns `["/bin/bash", "-lc", command]`, and waits with `poll_oneoff` |
| `host/sh-host.ts` | bat-sh's file calls on wasm-term's `Vfs` |
| `host/sh-wasm.ts` | instantiates `bat_sh.wasm`, binds the 24 imports, encodes `sh_run` |
| `host/channel.ts`, `host/shell-worker.ts` | 5.3 |
| `host/proc.ts` | the process table in the guest's Worker: spawn, events, back-pressure, kill, Worker replacement; inline and worker modes |
| `host/guest-worker.ts` | `host/worker.ts` plus one call to install the above |
| `web/page.ts` | `startProgram` unchanged, plus the shell-Worker supervisor |

**How it stands in for 5.1 without editing the host.** The guest calls the ABI's existing
`http_open("SPAWN", "proc:spawn?mode=worker", body = req)`. `proc.ts` catches the
`http_open` message before it reaches the page and fills that HTTP descriptor's queue
itself, with frames `u8 kind, u32 length, payload`. So reading, `poll_oneoff`, non-blocking
mode and close all run through `host/wasi.ts` as it is: the proposed descriptor kind needs
nothing from the host that the HTTP one does not already have. Signals go as a second
request, `proc:kill?fd=N&sig=15`. The three places `proc.ts` hooks (`machine.post`,
`machine.pump`, `machine.waitUntil`) are what step 2 of the plan turns into real code.

**Checks (ran; 27 with `arg=quick`, 29 in the full run, all pass in Chrome 154 and in
WebKit 27.2 desktop and iPhone profile).** In both modes: the brief's
`bash -lc 'echo hi > f.txt && cat f.txt | wc -c && ls'` prints `3`, `f.txt`,
`from-rust.txt`; the file the shell wrote is read back with `std::fs`; a file the Rust
program wrote is `cat` by the shell; `mkdir -p`, `mv`, `rm`, `ln -s`, `>>` by the shell are
seen through WASI, including through the symlink; `echo out; echo err >&2; exit 7` arrives
as stdout, stderr and status 7 apart; a failing `cat` and an unknown program (127); loops,
`$( )`, globs, a pipeline, `find`, `grep -rn`, `sed`; a here-doc, `sed -i`, a nested
`/bin/bash -lc`; 2,000 files made through WASI then counted and searched by the shell.
Worker mode only: three lines printed 200 ms apart arrive at 0.2, 200.6 and 401.0 ms (inline:
all three at 600.8 ms); three 300 ms children under one `poll_oneoff` finish in 308 ms;
`sleep 30` killed with TERM exits 143; `while :; do :; done` killed, its Worker replaced,
status 137, and the next command runs; six running children dropped free their Workers;
8 MiB of output with a reader that starts 200 ms late arrives complete.

**Numbers** (Chrome 154 headed on Xvfb, diesel2, 12 cores, 1-minute load 5 to 7 from other
agents' work; ms; median (min to max); `results/chrome-full.json`):

| | n | inline | shell Worker |
| --- | --- | --- | --- |
| `echo hi`: spawn to exit event | 300 | 0.065 (0.04 to 0.6) | **0.105** (0.07 to 0.9) |
| of which until the shell is running | 300 | - | 0.01 (0 to 0.04) |
| `echo hi > f.txt && cat f.txt \| wc -c && ls` (16 host calls) | 200 | 0.115 (0.08 to 0.67) | **0.24** (0.175 to 1.7) |
| `sed -n 2,4p notes.md; wc -l notes.md` (12 calls) | 200 | 0.075 (0.055 to 0.65) | 0.17 (0.11 to 2.4) |
| `cat tree/d1/*.rs \| wc -c`, 50 files (254 calls) | 50 | 0.59 (0.53 to 1.3) | 1.39 (1.27 to 2.3) |
| `find tree -type f \| wc -l`, 2,000 files (2,083 calls) | 10 | 5.7 (5.2 to 6.9) | 13.8 (12.8 to 22.4) |
| `grep -rn NEEDLE tree \| wc -l`, 2,000 files, 6.5 MB (10,043 calls) | 10 | 147 (144 to 156) | 203 (190 to 260) |

| | |
| --- | --- |
| First command of a page, no shell Worker started (`warm=0`), n = 3 | 9.5, 10.2, 11.2 ms, of which 7.6 to 9.0 waiting for the Worker |
| A shell Worker from `new Worker` to ready | 10.6 to 11.3 ms on demand; 25 to 38 ms when started beside the guest's own compile |
| Cost of one host call across the channel | 4 to 6 µs (`find`, `grep` above); 15 µs with `spin=0` (`find` 37 ms, `grep` 327 ms); 60 to 110 µs in one run taken at load 17 (`find` 138 ms, `grep` 1,252 ms; not kept as a file) |
| Kill of `sleep 30`: signal to exit event | 2 to 4 ms |
| Kill of a busy loop | 251.5 ms (the 250 ms grace, then the page terminates and replaces the Worker in 11 ms) |
| 8 MiB of output | 278 ms, 33 events of 256 KiB |
| WebKit 27.2 (Playwright, Linux), same page | `echo hi` 0.08, the brief's command 0.20, `find` 13.8, `grep` 213; every check passes (`results/webkit-*.json`) |

For scale: bat-rust's own asynchronous `exec('echo hi')` is 3.5 ms on a warm spare and 49 to
124 ms without one, because each is a new kernel process in a new or spare Worker; here the
shell Worker is permanent and asleep on its channel, so a spawn is one `Atomics.notify`.

**Not shown by the prototype:** codex itself (not built against this); the real `proc_*`
imports (the HTTP descriptor stands in); stdin to a child; a pty child (`tty: true`);
persistence of shell-written files across a reload (the hook is there, not exercised); a
JavaScript guest (the opencode TUI) spawning; a real iPhone or a real Safari; a machine with
two cores; more children at once than channels (they queue; four channels in the page).

## 7. Plan, in order

1. **Seam first, inline mode** (wasm-term + codex port; a day or two). Vendor `bat_sh.wasm`
   by hash next to the codex module; move `sh-host.ts` and `sh-wasm.ts` into `host/`; add
   the descriptor kind and `proc_spawn`/`proc_recv`/`proc_signal` to `host/wasi.ts` with the
   shell run inline; plant `/bin/bash`, `/bin/sh`, `/usr/bin/env`; `wasm-term-sys` and
   `wasm-term-tokio` wrappers; the `cfg(target_os = "wasi")` arm in
   `codex_sandboxing::spawn_process`; `shell_snapshot` off; call the persistence hook after
   each run. Done when the mock model's "run a command" turn shows real output in
   `?guest=codex-local`.
   *Hard part:* the codex side. `ProcessDriver` has a terminator but no interrupt, the
   non-unix arms of `utils/pty` answer Unsupported, and unified exec's timing (150 ms
   early-exit grace, 50 ms after exit for output to close) has only been read, never run on
   WASI.
2. **Shell Workers** (wasm-term; two or three days). `channel.ts`, `shell-worker.ts` and the
   supervisor into `host/` and `host/index.ts`; `machine.ts` gets a list of wake sources
   instead of the prototype's three overrides; `proc_need`/`proc_replace` in
   `protocol.ts`; worker mode becomes the default, inline the fallback
   (`navigator.hardwareConcurrency <= 2`, or a Worker that fails to start).
   *Hard parts:* every place the guest's Worker can block must serve the channels, including
   `flushOutput`'s wait for the page, which the prototype does not cover; the kill of a
   Worker mid-call must leave the vfs consistent (each call is applied whole in the guest's
   Worker, so it does, but a half-written file from a killed `sed -i` is real); JavaScript
   guests wait with `Atomics.waitAsync` and need the same serving in their loop.
3. **Tell the model what exists** (codex port; hours). A developer-instructions block:
   which commands the shell has, that `rg`, `git`, `python`, `node` do not exist, to use
   `grep -rn`/`find` and `apply_patch`. Cheap, and it removes most failed calls.
4. **Verify like the rest of the port**: `web/verify/codex.js` gets a tool turn with a real
   command, an interrupted `sleep`, and a file written by `apply_patch` then read by `cat`;
   the WebKit smoke gets one command.
5. **The missing programs, in bat-sh** (bat-rust; a week, in order of how often codex
   reaches for them): `rg` (the forms in its prompt: `rg pat [path]`, `-n -l -i -g`,
   `rg --files`, over the existing grep engine and `find` walker), `nl`, `diff -u`,
   arrays and `<( )`, `awk` (the largest: a real interpreter, and bat-sh has a
   one-dependency rule to decide about), then `cmp`, `base64`, `sha256sum`, `timeout`,
   `find -regex/-printf`, `tree`. Each is one more line in `codex-cases.tsv`. This also
   helps bat-rust's own OpenCode, whose ripgrep is a 31 to 145 ms `node` child today.
   *Hard part:* `git`. There is none and no small way to one; read-only `git status`/`diff`
   against a snapshot taken at start is the most a builtin could honestly do.
6. **stdin and `sh_read_file`** when something needs them (`proc_send`; one call per file).
7. **Only if section 4's first or second condition arrives:** children that are real
   programs. Either WASI programs as wasm-term guests (the channel generalised from the 15
   file calls to `Vfs`, `sh_spawn`/`sh_pipe` implemented; this is shape c, reached from d),
   or shape a for `node`. Do not start either before a concrete program demands it.

## 8. What each project changes

| | For the recommendation | Already done here |
| --- | --- | --- |
| bat-rust | nothing to get a shell. Then: builtins (step 5), a versioned artifact, `sh_read_file` | branch `codex-shell`: the coverage cases and their recorded run, the `-euo pipefail` fix (`a2e480d`) |
| wasm-term host | a descriptor kind + 3 to 4 imports (`wasi.ts`), wake sources (`machine.ts`), two message types and an init field (`protocol.ts`, `index.ts`), `docs/abi.md` 3.4 | the prototype, outside `host/` |
| wasm-term guests crates | `proc` module in `wasm-term-sys`, `Child` in `wasm-term-tokio` | the equivalent in `shell-proto/guest/src/main.rs`, synchronous |
| codex port | one `cfg(wasi)` arm at `spawn_process`, the `utils/pty` non-unix arms, config (`shell_snapshot` off), the instruction block | nothing; the tree was the other agent's |
