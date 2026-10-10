
## 2026-10-09 — image format and prepare (bat-image / bat-prepare agent)

- **Index order is (parent path, name), not full path.** A plain full-path sort does not
  keep a directory's children together (`a/b` sorts before `a-x`, with `a/b/…` in
  between), so `readdir` would need a scan or a second table. Ordering by parent then
  name makes children one contiguous slice that a directory entry points at, while a
  literal full path is still one binary search. Measured on the TODO tree: 12,110
  entries, 1.73 MB head.
- **Body alignment is 16 bytes, not a page.** 4 KiB alignment would add about 2 KiB per
  body (~30 MB over 10k files plus 1.8k compiled bodies) for no benefit to a positioned
  read. It is a header field (`body_align_log2`), so a page-cache design that wants 4096
  is a writer flag, not a format change.
- **Facts word is `bat-modules`' word verbatim** (bits 0..23), plus two bits owned by
  prepare: bit 30 `FAILED`, bit 31 `IN_PROGRAM`. `bat-modules` must keep bits 24..31
  clear. The **facts blob** (import/export lists) is stored directly after the compiled
  body so one read returns both; its length is entry word 44.
- **`CODE_IS_SOURCE` modules store no second body.** 3,420 of 5,249 modules in the TODO
  tree compile to their own source; storing them twice would add ~50 MB.
- **Modules shipped in a program script keep no compiled body in the image** (only facts
  and blob, `IN_PROGRAM`). Otherwise the OpenCode bundle would be in the download three
  times (original 27.7 MB, compiled 27.7 MB, script 27.7 MB). Cost: without the script
  the loader must transform `/app/server.js` at run time.
- **Program registration is `__bat_define(path, fn)`** with the function header derived
  from the facts word; facts are not repeated in the script.
- **One image mounted at `/`** (`/workspace/node_modules`, `/app`, `/app/node_modules`)
  rather than one per root: one OPFS file, one handle per worker, one mount.
- **Editable source lives in `manifest.json`, not the image**, so a source-only change
  rewrites the manifest (3 ms) and never touches the dependency image.
- **Entry mtime is one fixed image-wide value** (2026-01-01T00:00:00Z), so equal inputs
  give byte-identical images (checked: same sha256 across four rebuilds).
- **Prune by rule, not by list:** a package is "platform native" when its package.json
  restricts `os`/`cpu` (and `cpu` lacks `wasm32`). That removed all 8 native packages in
  the TODO tree without naming them. `.map` (22 MB) and `.md`/`.mdx` (4.6 MB) are **kept**:
  whether the guest's Vite/esbuild read dependency source maps was not checked, and the
  brief was to be conservative. The policy's `prune.extensions` can drop them once a
  guest file-access trace shows they are never opened.
- **Two Bun installs, not three.** Frozen install of the project's own lock (proves lock
  and manifest agree), then install with overrides. The old third "delete and reinstall
  to verify" pass is dropped; both installs take ~0.3 s with a warm Bun cache.
- **`bun install --cpu/--os` cannot target the guest** (`wasm32` is rejected), so native
  optional packages are installed for the host and then pruned.
- **Need from `bat-modules`, not blocking:** `transform` takes the nearest package.json
  `type`; prepare computes it per package scope. Source maps for lowered TS/JSX are not
  stored in the image yet (no field asked for them).
- **Apps that are Bun workspace members are relocated, not re-resolved** (added when
  `examples/todo-app` became a member of this repo's workspace with
  `"@kkrausse/browser-agent-toolkit": "workspace:*"` and no lock of its own). Prepare
  stages the workspace root (root manifest + lock, every member's package.json, the
  `files` of linked members), installs there frozen, then builds a standalone
  `node_modules`: the store moves to `node_modules/.bun`, the member's links are
  re-pointed, each linked workspace package is copied to
  `.bun/<name>@workspace/node_modules/<name>` with links to its dependencies and peers
  (not devDependencies), and store packages nothing reaches are removed (288 of 417 in
  this repo: the toolkit's build-time dependencies). Rewriting the manifest to `file:`
  and letting Bun resolve again would have dropped the lock's pins.
- **The image's meta section carries nothing build-specific.** It briefly held the input
  fingerprint, which includes the tool binary's mtime, so every rebuild of `bat-prepare`
  changed the image hash and would have forced a 236 MB re-download for identical content.

## Toolkit package and TODO example (2026-10-09)

- **`RuntimeHost` is the only seam** between `packages/toolkit` and the runtime:
  `packages/toolkit/src/runtime-host.ts`. The runtime ships a module exporting
  `bootRuntime(options): Promise<RuntimeHost>`; `openEditor` imports it from
  `manifest.runtime.entry` (default `runtime/host.js` beside the manifest) unless the caller
  passes `boot`. Two members go beyond the list in the brief: `hostOrigin` (the runtime, not
  the toolkit, knows how a guest reaches the page's server, so "`host.internal` carries the
  page's scheme and port" is its fact) and `setHostPaths(port, prefixes)` (preview routing
  lives in the service worker).
- **`openEditor` returns `Promise<Editor>`**, resolved once the workspace is booted and both
  programs are starting; `editor.ready` is the rest. A synchronous return could not hand out
  `fs` or a preview URL, and waiting for the chat would hold the preview back. The chat
  controller exists from that moment: its requests wait behind the agent's verification.
- **The manifest is `bat-prepare`'s (`bat-prepared-v1`)**, not a second toolkit format.
  `prepare()` only maps options to `bat-prepare app` and reads the manifest back. The server
  handler adds `modelCatalog`/`defaultModel` when delivering it.
- **Chat client: Effect and `@opencode/client` dropped, reducer and generated types kept.**
  The published client's promise flavour is itself plain `fetch` plus a 40-line SSE reader,
  so `chat/api.ts` (about 120 lines, 15 calls) follows it call for call. The controller's
  scopes/fibers became three nested `AbortController`s plus the existing generation and
  selection counters. The vendored reducer (500 lines) is OpenCode's own event-to-message
  projection and was kept unchanged; the 6,500-line types file is type-only, exact generated
  2.0.3 output, and costs nothing at run time, so trimming it by hand would only lose the
  pin. Dropped with Effect: span diagnostics, the reader fence (dispose now aborts and joins
  its own requests), `exportChats` (superseded by native `editor.sessions.export`).
- **The `runJavascript` guest plugin still bundles Effect** (build-time, into one string).
  The promise plugin API shows no cancellation signal for a tool in its types (not tried at run time); the Effect one has it, and
  cancelling a runaway script matters. It now spawns `process.execPath` instead of
  `/bin/node.js`.
- **OpenCode is a Node program**: `node /app/server.js`, with `OPENCODE_DATABASE_PATH` inside
  `/workspace/.server/data`, so sessions persist with the workspace (the old runtime kept the
  database at `/runtime-probe`, outside it).
- **Startup order is one function** (`startupOrder` in `browser.ts`): the agent starts when
  the preview's server listens; both are joined; the preview's failure wins.
- **UI styling kept as it was.** The old chat UI already was shadcn-on-Base-UI with a
  prefixed, precompiled Tailwind sheet and Lucide icons; it is copied unchanged. Its
  dependencies are now ordinary `dependencies` of the package instead of being bundled.
- **A development fake host** (`./fake`, `./fake/server`) backs `RuntimeHost` with native
  processes so everything but the runtime is exercised for real. Measured there on diesel2
  (native Vite 7.3.6 and OpenCode 2.0.3, machine otherwise busy): preview listening 1.0 s
  after spawn, app visible 3.6 s after Open, agent verified 3.7 s after its spawn, chat
  attached 6.1 s after Open. These are native floors under load, not runtime numbers.

## 2026-10-09 kernel: Wasm target and threading model (bat-kernel)

- **Target `wasm32-wasip1-threads`, stable Rust, no wasm-bindgen, no nightly.** On stable,
  `wasm32-unknown-unknown` cannot link a shared memory (std is built without atomics and
  `-Zbuild-std` is nightly). `wasm32-wasip1-threads` ships std with atomics, imports a
  shared memory and has real TLS. The price is five WASI imports std pulls in, stubbed in
  `runtime/src/kernel/attach.ts`. Link arguments live in the crate's `build.rs`.
- **Per-instance stack and TLS are installed by the host binding**, not by wasi-threads'
  `wasi_thread_start`: the binding takes a boot lock word, calls `bat_thread_alloc` on the
  module's boot stack, then sets the exported `__stack_pointer` and calls
  `__wasm_init_tls`. This lets the page and any worker attach by themselves.
- **Futex wait/notify are host imports** (`Atomics.wait`/`notify`): the wasm intrinsics are
  unstable in Rust (`stdarch_wasm_atomic_wait`). They are reached only under contention or
  when blocking, so the import cost is off the fast path (uncontended lock+unlock measured
  at ~60 ns with five instances fighting over one lock).
- **Own locks and own allocator.** std's `Mutex` and wasi-libc's malloc lock futex-wait,
  which traps on the page. Kernel locks spin on threads that may not block; the heap is
  the `dlmalloc` crate over `memory.grow` behind such a lock.
- **Kill gate.** `worker.terminate()` can stop a worker inside a critical section and
  leave a kernel lock held forever. Each thread counts held locks in shared memory; kerneld
  marks the thread dying, waits for the count to reach zero (a dying thread parks at its
  next acquisition), then terminates. Costs one store and one load per lock acquisition.
- **Growth and views.** Any instance may grow the memory; `BAT_MEM_GEN` tells bindings to
  re-create their views. The heap grows in ≥ 1 MiB steps to keep that rare.

## 2026-10-09 kernel: filesystem and persistence choices (bat-kernel)

- **Renaming a directory that is in an image returns `EXDEV`** (overlayfs behaviour
  without redirect_dir). Moving it for real means copying the subtree; callers that hit
  `EXDEV` already fall back to copy + delete. Image *files* are copied up on rename.
- **Path normalization is lexical** before resolution (`a/link/..` is `a`). Symlink targets
  are resolved against the real containing directory. Node normalizes paths itself before
  calling the OS, so guests do not see the difference; the walk stays allocation-free.
- **Image body cache: 128 KiB chunks, lock-free once loaded, no eviction yet.** Chunks
  (not whole bodies) so neighbouring small files share one OPFS read and large files are
  read incrementally. Worst case is the image size in memory (197 MB for the TODO tree).
  Eviction needs a pin protocol with readers; deferred until memory pressure is measured.
- **The page has no image handle** (`FileSystemSyncAccessHandle` is worker-only): a miss on
  the page returns `EAGAIN`, kerneld loads the chunk, the page retries after
  `BAT_FAULT_WORD` changes (`kernel.retrying`). The same proxy serves workers that started
  before a mount.
- **Journal is physical, not logical**: records name overlay nodes by number (node, link,
  unlink, write, truncate, meta), so replay needs neither path resolution nor the images
  and a snapshot is just a compacted journal in the same format. Mount points are ordinary
  journaled directories; mounts themselves are re-applied by the host at each boot.
- **Snapshots alternate between two OPFS files**, header written after the payload is
  flushed; the journal is truncated only after the snapshot is durable. Journal frames carry
  an FNV-1a checksum and the end sequence; a torn tail is truncated at restore.
- **Spawn is a request to the supervisor, the executable format is the runner's business.**
  The kernel records argv/env/cwd/stdio and queues the pid; kerneld hands it to the warm
  spare worker, which runs a configured runner module. The kernel has no notion of node vs
  WASI.
- **bat-image needed nothing extra**: the kernel reads the head with one host call and uses
  `Image<'static>` over it.

## 2026-10-09 modules: transform and loader format (bat-modules)

Spec: `docs/design/module-format.md`; reference loader `crates/bat-modules/harness/loader.mjs`.

- **An ES module is a generator function `function* (__bat)`, not the seven-parameter
  function the design sketched.** The prelude defines export getters, fetches dependency
  namespaces, and `yield`s once; the loader links the whole static graph (first `.next()` of
  each module), then evaluates (second `.next()`). A plain function cannot stop between the
  two, and the alternatives all failed a concrete case: evaluating a dependency before the
  importer has bound its namespace breaks a cycle where B calls a hoisted function of A that
  reads A's import (the case the old runtime retried with `with(...)`); and a synchronous
  module that imports a module with top-level await has to wait without itself being async.
  Top-level await is `async function*`; the only change is the header, chosen from a facts
  bit. Verified against native Node on a cycle and an edge-case graph, and on Vite's chunk
  cycle.
- **ES modules get no `require`/`module`/`exports`/`__filename`/`__dirname` parameters**, as
  in Node. That removes the whole class of "ESM declares its own `require`" collisions, and
  `typeof require` checks in bundles take the branch they take in Node. One reserved
  identifier remains, `__bat` (the prefix covers the prelude's locals); a source using it
  is rejected rather than silently miscompiled. CommonJS keeps Node's five parameters plus
  `__bat` for `import()`.
- **JavaScript is edited in place, not re-printed.** Decisions come from oxc's AST and
  scope analysis; the output is the source with spans replaced. Lines are exact without a
  source map and unchanged CommonJS (3,352 of 3,374 CommonJS files in the TODO tree) is
  returned borrowed and flagged `CODE_IS_SOURCE`. TypeScript/JSX go through oxc's
  transformer and codegen first, then the same pass; only they get a source map.
- **Full scope analysis (oxc_semantic) is kept for ES modules** although it is 40% of the
  time on the OpenCode bundle (parse 0.31 s, semantic 0.30 s, rewrite 0.09 s; 0.75–0.88 s
  total against 0.73 s for the old lexer rewrite). A hand-rolled "is this name shadowed"
  walk would be faster and is exactly the kind of approximation this rewrite removes; the
  cost is paid once at prepare time. The whole TODO tree (5,355 files, 103.6 MB including
  that bundle) takes 1.1 s on 12 threads.
- **CommonJS export names are a superset of Node 24's lexer, quirks included.** Checked
  with Node's internal `cjs_lexer` binding over the tree's 4,227 CommonJS files: 0 files
  miss a name Node reports. Three lexer quirks had to be reproduced for that (listed in
  module-format.md §6).
- **Mixed files load as ES modules**: CommonJS by extension or package type but written
  with `import`/`export` (Node refuses these). Warning diagnostic, not an error.
- **The Wasm build is its own Cargo workspace (`crates/bat-modules/wasm`) with a stub
  `js-sys`.** oxc_transformer → oxc_compat → oxc-browserslist depends on js-sys on every
  wasm32 target; in a cdylib that exports ~1,500 wasm-bindgen descriptor functions and
  imports only wasm-bindgen's post-processor can satisfy (first build: 2.36 MB, would not
  instantiate). With the stub: no imports, four exports, 1.86 MB (0.58 MB gzip). The
  separate workspace keeps the `[patch]`, the size profile and the lock file away from the
  native build.
- **oxc helper calls are imports of `@oxc-project/runtime/helpers/*`** (legacy decorators;
  private fields under `useDefineForClassFields: false`). oxc has no inline-helper mode.
  The runtime has to provide that package for workspace code using those options.
  Standard decorators are not lowered by oxc at all: warning, output kept as written.
- **Wasm build is `opt-level = "z"`** (supersedes the 1.86 MB figure above, which was "s"):
  1.24 MB, 0.46 MB gzip. On a 234-line TSX file, warm: z 1.6–1.8 ms, s 1.4 ms, 3 1.1–1.3 ms
  (2.29 MB). Workspace files are few, the download is paid by every visitor.

## 2026-10-09 kernel: lookup fast path and JS boundary, from the M0 measurements

- **Per-image path hash table, built at mount.** The component walk cost 1.4–1.9 µs per
  stat of a nine-component path (a binary search per component, ~160 ns each in Wasm).
  One pass over the index at mount (inside the 2 ms index time for 12,197 entries) builds
  path → entry; a lookup below a directory with no overlay entries is then one probe.
  Stat hit went from 2.3–5.7 µs to ~1.2 µs with two workers, and what is left is mostly
  JavaScript (string copy in, object out).
- **The RwLock is reader-preferring.** Readers used to queue behind a "waiters" bit, which
  cost every reader 200 spins while it was set.
- **Copies out of shared memory go through a private buffer; small reads should be
  pooled.** `Uint8Array.slice` on the shared memory costs several µs per call (the
  allocation, not the copy) and `TextDecoder`/`TextEncoder.encodeInto` refuse shared
  buffers in Chrome 154. `readFileInto` and `statRaw`/`st` exist for layers that pool.
- **The resolver is not written by the kernel agent.** The node-runtime agent put one in
  `crates/bat-kernel/src/resolve.rs` while the kernel agent's own was being started; to
  keep one resolver the kernel agent dropped its attempt and left that file alone.

## 2026-10-09 tools: esbuild shim, optimizer cache, prepare additions (bat-tools)

Numbers and evidence: `docs/experiments/2026-10-09-tools.md`.

- **A shim is laid over the generic package it falls back to (`overlay`), not installed in
  its place (`dir:`).** Bun installs a `file:` override without its dependencies (the lock
  entry is `["esbuild@file:.bat-shims/esbuild", {}]`), so a `dir:` shim cannot keep
  `esbuild-wasm` in the tree. The policy keeps `esbuild → npm:esbuild-wasm@{version}` and
  adds `overlay: dir:…/packages/guest-shims/esbuild`: prepare copies the shim's files into
  the installed package and merges `package.overlay.json` (`main`). The fallback is the
  neighbouring `lib/main.js`, always at the locked version. `dir:` remains right for shims
  with no fallback (the oxide scanner).
- **The esbuild shim depends on oxc directly, in its own Wasm (`bat_esbuild.wasm`), not on
  `bat-modules`' Wasm.** `bat-modules` emits loader function bodies with facts; esbuild's
  `transform` must return a plain ES module with `define` applied and esbuild's result
  shape. Both link the same oxc 0.153 crates, so one combined module would save about
  1 MB of download; that needs one crate exporting both ABIs and is left as a follow-up.
- **`transform` never downlevels and never minifies beyond whitespace.** `target` and
  `supported` are accepted and ignored (the guest runs in current Chrome; Vite's dev
  transforms pass `esnext`). `minifyWhitespace` is done by oxc's printer. `minify`,
  `minifyIdentifiers`, `minifySyntax`, `format: cjs|iife`, non-JS loaders, decorators,
  `import x = require()`, and any option the shim does not know go to the real esbuild
  (`esbuild-wasm`, loaded on first such call). Nothing in dev mode takes that path for the
  TODO app (0 of 22 calls at startup, 0 of 25 with a hot update).
- **`build()` is implemented for exactly one shape: one entry whose imports are all
  external after the plugins' `onResolve`.** That is `bundleConfigFile`, which React
  Router's child compiler runs at every start through `vite.loadConfigFromFile` (the
  `--configLoader native` flag only covers Vite's own load). A config that imports a
  local file, and every `context()` (the dependency optimizer), fall back.
- **The optimizer cache is produced by running the project's own Vite at the guest's path
  in a mount namespace (bubblewrap), not by rewriting hashes.** Vite's `configHash` covers
  `root` and `resolve`, and each `fileHash` covers the absolute output path, so only a
  run that sees `/workspace` writes exactly what the guest would. Without bubblewrap the
  script runs at the host path and recomputes `configHash`/`lockfileHash`/`hash` with a
  copy of Vite's functions that is first checked against the hashes Vite itself wrote;
  both modes gave the same three hashes for the TODO app. `fileHash` then keeps the host
  path (Vite compares it only between two of its own runs).
- **The cache is delivered as project files, not in the image.** Vite commits a
  re-optimization by renaming the `deps` directory, and the kernel answers `EXDEV` for
  renaming an image directory; and the cache depends on `vite.config.ts`, so putting it
  in the image would turn a config edit into a new 236 MB image. Cost: `manifest.json`
  grows from 24 KB to 6.0 MB (3.7 MB of that is the optimizer's source maps). A second
  small image, or a manifest-side blob, would be better; that is a format change for the
  prepare and kernel owners.
- **Prepare gained three things**, each small: substitution `overlay`; `projectScripts`
  (host programs whose output files become project files; a failing script is reported in
  the manifest and skipped); and a base directory for `dir:` paths in the embedded policy
  (`$BAT_POLICY_BASE`, else the crate's `data/` at build time; it used to be the current
  directory).

## 2026-10-09 sqlite: engine, VFS, journal mode, durability (runtime/src/sqlite)

Measurements: `docs/experiments/2026-10-09-sqlite.md`.

- **Own build of SQLite, not `@sqlite.org/sqlite-wasm` or wa-sqlite.** The amalgamation
  (3.53.1, the version Node 24.18 bundles) compiled with wasi-sdk 34 and
  `SQLITE_OS_OTHER`, with the VFS written in C beside it (`native/bat_sqlite.c`). The
  result imports 18 functions from one module and no WASI or Emscripten runtime, so it
  instantiates synchronously with about 200 lines of glue; the published builds need
  either their Emscripten glue (asynchronous init) or a hand-written replacement for 36
  imports, and their VFS hook is a JS struct binding. 653 KiB, 303 KiB gzip; the official
  package's Wasm alone is about 850 KiB. clang is not installed on diesel2, so the binary
  is committed; `native/build.sh` records the inputs and their hashes.
- **`-Os`.** As fast as `-O2` once warm, a third smaller, and about half the cold cost
  (V8 compiles each Wasm function on its first call; `-O2` inlining makes the functions a
  first boot touches larger). `-Oz` was 2x slower on inserts.
- **Left out of the build**: FTS3/5, R-Tree, Geopoly, session, load-extension (+250 KiB
  for FTS5 and R-Tree at `-O2`). OpenCode uses none. `EXTRA=-DSQLITE_ENABLE_FTS5` adds one.
- **Real WAL, with the WAL index and all locks in process memory.** `PRAGMA
  journal_mode=WAL` returns `wal` and the file is an ordinary WAL database (native SQLite
  opens it and vice versa). `xShmMap`/`xShmLock` are heap memory and a lock table in C
  keyed by database path, shared by the connections of one process, so several
  `DatabaseSync` objects on one file behave as on native (checked against native,
  including SQLITE_BUSY). Chosen over exclusive locking mode because that would make a
  second connection in the same process fail, and over answering `delete`/`memory`
  because WAL writes each changed page once per commit and `MEMORY` journaling is not
  crash-safe (the crash harness's control case shows it).
- **Nothing coordinates two processes on one database file.** The kernel has no advisory
  locks, and the WAL index is private to a process. Two guest processes writing the same
  database at the same time can corrupt it. One process (OpenCode) owns its database
  today. Doing this properly needs kernel support: byte-range or whole-file advisory locks
  released when a process dies, and for WAL a shared mapping (the index could live in
  kernel shared memory). Not built.
- **xSync does not wait, and SQLite is told it need not sync to order writes.** The overlay
  journal is one ordered stream of whole records, so a crash leaves all files as of one
  instant between two operations. The kernel backend therefore reports
  `SAFE_APPEND | SEQUENTIAL | POWERSAFE_OVERWRITE` and on xSync only asks kerneld to drain
  (`kernel.flush()` not awaited, at most one request outstanding). Consequences: the file
  is never corrupt after a crash or closed tab (3,978 crash points checked with native
  SQLite, plus one reload mid-transaction in Chrome); a transaction that returned from
  COMMIT can be lost if the tab dies before the drain. With OpenCode's
  `synchronous=NORMAL` SQLite calls xSync only at checkpoints, so in practice the window
  is kerneld's own 250 ms drain tick plus the OPFS write. `createKernelBackend(kernel,
  { sync: 'wait' })` blocks in xSync until OPFS has the data (measured: 1,000 autocommits
  76 ms instead of 18–24, 6 MB insert 129 ms instead of 35–45), for a caller that wants
  commit to mean durable; then `synchronous=FULL` is what makes every commit sync.
  **This depends on the journal staying a single ordered stream taken at record
  boundaries**; if persistence ever becomes per-file or unordered, the device
  characteristics in `backend-kernel.ts` must drop to `POWERSAFE_OVERWRITE` and `sync`
  must default to `wait`.
- **WAL doubles what goes to OPFS**: a page is written to the WAL and again at checkpoint,
  and both are journaled (the browser bench pushed 60–130 MB through the journal). Not
  reduced; a larger `wal_autocheckpoint` or a non-persistent `-wal` would be the levers,
  and the second is unsafe.
- **Cold start is the remaining cost, and prewarming is the runtime's choice.** Warm, a
  call is within about 2x of native. The first statements of a process cost 40–80 ms under
  Node and 59 ms on a first page load in Chrome (10–14 ms on later loads) because of lazy
  Wasm compilation. `sqlite.__bat.prewarm(scratchFile?)` runs a canned workload; in the
  same worker it brought the first boot to 4.9 ms in Chrome. Compiled code is shared by
  workers that received the same `WebAssembly.Module`, so the module should be compiled
  once (page or kerneld, `compileStreaming`) and posted, not compiled per process.
- **Numbers cross the JS boundary as doubles.** Row values are fetched with one call per
  row (`bat_row` fills a flat record); `changes` and `lastInsertRowid` come back as
  doubles; BigInt is used only when an integer is outside ±(2^53−1) or `readBigInts` is
  set. JS numbers bind as REAL, as in Node.
- **Buffers given to SQLite come from `sqlite3_malloc`**, not libc `malloc`: SQLite frees
  bound text and blobs with `sqlite3_free`, and the two are only the same allocator by
  build accident (found as a heap trap in the differential run).

## 2026-10-09 networking and the page-side host (net agent)

Numbers: `docs/experiments/2026-10-09-net.md`. Code: `crates/bat-kernel/src/{http,ws}.rs`,
`runtime/src/{net,host,sw}/`.

- **The HTTP and WebSocket codecs take an fd, not caller buffers** (kernel-abi.md §13
  reserved buffer-fed shapes; §15 is what was built). A buffer-fed parser means ring →
  kernel scratch → JS, two copies of every body byte. `bat_http_recv(parser, fd, …)` parses
  the socket's receive ring in place and reports body bytes as ranges *inside the ring*;
  JS copies them once into its own memory and the next call releases them. Sending is the
  mirror: `bat_http_reserve` shows the free part of the send ring, JS writes there,
  `bat_http_commit` publishes. It relies on a socket direction having one reader and one
  writer; two writers on one socket would interleave, as they would with `write(2)`, but
  here could also break chunk framing.
- **Chunk size lines are fixed width** (`0000a3f2\r\n`, leading zeros are legal) so the
  payload position is known before its length and the chunk can be written in place.
- **Client WebSocket frames carry the MASK bit with an all-zero key.** RFC 6455 requires
  the bit from clients; the key's purpose (defeating cache poisoning through proxies) does
  not exist on a ring inside one tab, and a zero key makes masking a no-op, so payload is
  never rewritten. The `ws` package accepts it (verified).
- **Message heads are serialised in JavaScript** (string concatenation written straight
  into the ring as Latin-1). §13 reserved `bat_http_write_head`; passing structured
  strings into Wasm would cost more than building the string, and it is not parsing.
- **`httparse` for heads** (no_std, no dependencies, +~10 KiB): the hand-written part is
  only framing (lengths, chunks, keep-alive, upgrade).
- **A separate bridge worker (`netd`) instead of routing preview traffic through kerneld
  or the page.** The design said "through kerneld". kerneld does synchronous OPFS journal
  writes on its loop, and the page's main thread renders the chat; a preview load is ~700
  requests. netd is one more kernel host process with its own event word: frame → service
  worker → netd → socket ring, and the page is on the path only once, to hand each side
  its end of a MessageChannel. Cost: one more worker (it also runs the image download, so
  it earns its start-up).
- **Preview WebSockets bypass the service worker after the first message.** The frame's
  shim sends one end of a MessageChannel through the service worker to netd; from then on
  frames go frame ↔ netd directly, so an idle-killed service worker does not drop HMR.
- **Request and response bodies cross service worker ↔ netd as transferred streams**,
  except a response of announced length ≤ 256 KiB, which netd reads and posts as one
  buffer. Measured: a transferred stream per response made a trivial request 5.1 ms
  (load 17); with the small-body path 1.36 ms, against 0.90 ms for a response the service
  worker synthesizes itself.
- **The service worker's scope is `/preview/`**, not `/`: it never controls the page that
  hosts the editor, so the host app's own requests, caching and any service worker of its
  own are untouched. It needs `Service-Worker-Allowed: /` (the handler already sends it).
- **First navigation**: `bootRuntime` resolves only after the worker is `activated` and
  has its port, and the frame's URL does not exist before `bootRuntime` resolves. After an
  idle restart the worker asks every window client for a new port (`bat-need-port`) and
  holds the request up to 4 s.
- **No 410 for stale listeners.** The old runtime bound a preview URL to a listener
  identity. Here the URL names a port; a restarted guest server on the same port simply
  serves, and nothing listening is a 503 page. The kernel still exposes the identity
  (`bat_port_listener`) for `endpoint.ready`.
- **Guest cookies live in the service worker.** `Set-Cookie` cannot be put on a
  synthesized response and `Cookie` is not readable from a request, so the worker keeps a
  jar per guest port (name → value; Max-Age/Expires only to delete) and adds `Cookie` to
  guest requests. The page origin's real cookies therefore never reach a guest server
  through the preview; they do travel on `hostPaths` and `host.internal` requests, which
  are real same-origin requests. Not done: `document.cookie` in the frame does not see
  guest cookies, and the jar is lost when the worker restarts.
- **The WebSocket shim is injected inline after `<head>`** (or `<html>`, or the doctype;
  never before the doctype, which would switch the document to quirks mode). The
  transform holds back at most the bytes before `<head>`; the rest streams.
- **`EventSource` is not shimmed**: its request is an ordinary fetch the service worker
  streams (checked with the native class, 100 ms cadence preserved).
- **`endpoint.fetch` keeps connections alive** (pool per port, at most 48 concurrent,
  further requests queue). A connection the guest closed while idle is detected by its
  hang-up; a request that still lands on one is retried on the next. A response body must
  be read or cancelled to give its connection back, as with `fetch`.
- **Guest HTTP server: `ServerResponse` is a `Writable`**, not Node's hand-rolled
  `OutgoingMessage`. Finish/drain/destroy ordering then comes from Node's own stream code
  (vendored), which is what `ws`, connect and Effect's `NodeHttpServer` observe. `end(body)`
  before any write sends `Content-Length`; anything else is chunked.
- **A client that half-closes is treated as gone** while the server is still producing the
  response (Node does the same unless `httpAllowHalfOpen`). This is how an aborted
  `fetch` or a closed SSE reader reaches `req.on('close')`.
- **Readiness events are not trusted for their mask.** fd numbers are reused at once and an
  event queued for a closed connection was delivered to the next one with the same
  number; the server took it for a hang-up ("socket hang up" on roughly one run in three
  of the benchmark). Fixed twice: the kernel drops queued events when an fd is closed,
  and the server checks the current state (`bat_fd_poll`) before acting.
- **Guest HTTP client goes through one router** (`net/fetch.ts`): loopback → kernel
  socket, `host.internal` → the worker's own origin, anything else → the browser's
  `fetch`. `http.request` buffers the request body until `end()`; responses stream. No
  `Accept-Encoding` is ever added on the kernel path because nothing there decompresses.
- **`host.internal` is only a name for the worker's own origin**: `hostOrigin` is
  `<page scheme>://host.internal[:<page port>]`, and the router swaps the host name back,
  so the request is same-origin (cookies, no mixed content) with the path the guest wrote.
- **A pending guest `fetch` keeps the process alive; an unread response body does not.**
  The response body is wrapped so the loop is ref'd only while a read is outstanding.
- **Unix-domain paths are ports**: `listen(path)` and `connect(path)` hash the path into
  20000–39999. No kernel object, visible to every process, collisions possible in theory.
- **The image is hashed while it streams, by `bat_node_native.wasm`** (WebCrypto has no
  incremental digest), in netd. Transport compression needs no client code: the handler
  answers with `Content-Encoding: zstd|br` and the browser decodes. A stored image is
  trusted by name and size afterwards (the name is its hash; a file only gets its name
  once verified).
- **Runtime assets are one flat directory**, `runtime/dist/`, copied by `prepare()` to
  `<prepared>/runtime/`; every URL is taken relative to `host.js`'s own URL. The global
  `fetch` router is installed by a hidden builtin (`bat:net-globals`) that the host puts
  in the process worker's `prewarm` list, so the process runtime needed no change.
- **Open, not understood:** once, a page spawn trapped in `fd::pipe` with "operation does
  not support unaligned accesses", and a following debug loop of `pipe()` calls hung the
  page (spinning on a lock). It was after an HTTP exchange and 16 file writes with the
  journal on. Not reproduced in five repeats of the same sequence nor in a 2,400-write
  stress with pipe allocation. It smells like heap corruption or a lock left held; the
  ring code added here writes into kernel memory from JS and is the first suspect.
- **The oxide scanner is vendored at tag v4.3.3, not built from the fork rev.**
  `kkrausse/tailwindcss@11050dda` is upstream `main` plus one line and no longer matches
  the 4.3.3 binding (283 differences on a symlinked source); the vendored tree with the
  fork's line applied is identical to native in the differential. Target `wasm32-wasip1`
  with a WASI written in the package: the scanner's dependencies use `std::fs`.
- **lightningcss gets a lazy front, not a slimmer Wasm**: dev never calls it (0 calls in
  12 traced runs); the 110–135 ms were the eager load of 15.9 MB.
- **rollup stays `@rollup/wasm-node`**: 6 ms load, 59 ms for 19 parses, 1.2% of the first
  page, and native rollup is no faster inside the server.
- **The shipped Vite cache carries a `.gitignore` (`*`).** Tailwind's automatic source is
  the whole workspace, which has no `.gitignore`, so the scanner read the optimizer's
  bundles (5.81 of 5.83 MB scanned) and the CSS depended on optimizer timing. This changes
  the served `style.css` (11,310 → 6,146 bytes: only what the sources use).

## 2026-10-09 finding for the tools and node-runtime agents: Vite's `configHash` differs in the guest (net agent)

- **The shipped optimizer cache is thrown away at every start**, with "Re-optimizing
  dependencies because vite config has changed". Vite's `getConfigHash` stringifies the
  config with `value.toString()` for functions, and `config.assetsInclude` is a closure
  over an imported binding. Natively its text is
  `return DEFAULT_ASSETS_RE.test(file) || assetsFilter(file)`; in the guest the module
  transform has rewritten the import reference, so it is
  `return __bat_i1.l.test(file) || assetsFilter(file)`. Everything else in the hashed JSON
  is equal (compared by dumping the same JSON from `resolveConfig` natively and in the
  guest, image `image-6d0320607a66c410`). The cache script therefore has to hash the
  guest's text (or the overlay has to take functions out of the hash); a transform that
  preserves `Function.prototype.toString` is not on offer.
- **The re-optimization that follows did not finish**: `deps_temp_*` stayed, every
  `/.browser-editor-cache/vite/deps/*.js` request waited (endpoint fetch timed out after
  8 s; nothing on stderr), so the frame stops at the server-rendered HTML. Until either
  point is fixed the preview renders but does not hydrate.
- **Fixed in the toolkit's Vite plugin** (same day): in guest mode `configResolved` wraps
  `config.assetsInclude` in a function whose text has no imported binding, so the hash is
  the same in the prepare run and in the guest (`3988b30b` on both sides for the TODO
  app). The example then starts without re-optimizing. The second point stands.
