
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
  the same in the prepare run and in the guest (the TODO app ships `3988b30b` and the
  guest's Vite accepts it: no "Re-optimizing", the frame hydrates). The second point
  stands.

## 2026-10-09 node runtime (process worker, loader, builtins)

- **The process worker is a classic script; configuration rides in its URL fragment.**
  Module workers have no `importScripts`, which the Node lib bundle and program scripts met
  during synchronous loading need. kerneld only knows the worker URL, so
  `processWorkerUrl(script, config)` (`runtime/src/process/config.ts`) appends the config
  as JSON; `bootKernel` gained `processWorkerType: 'classic'`.
- **Everything launch-independent happens in the warm spare**: loop, `process`, globals,
  `importScripts` of the Node lib, nine common builtins, streaming compiles of the Wasm
  helpers. Measured: spawn → first guest statement 2.3 ms median warm, 54 ms cold.
- **Two bundles.** `bat-process.js` (kernel binding, loop, loader, TypeScript builtins) and
  `bat-nodelib.js` (Node's own `lib/`, one factory per module, nothing evaluated until
  required). Builtins from other parts of the tree register through
  `runtime/src/<dir>/builtins.ts`, picked up by `runtime/build.ts`.
- **The loop owns its timers.** One host timer tracks the earliest `Timeout` in a heap; a
  turn is due timers → kernel events → immediates, so a timer that came due always runs
  before the next watch event (the chokidar hazard), and sub-4 ms timers poll through a
  MessageChannel instead of hitting the browser's nested-timer clamp. Node's own
  `lib/timers.js` was not vendored: it sits on native timer lists.
- **`process.exit` blocks the worker** (`Atomics.wait` on a private buffer) after
  `bat_proc_exit`, so nothing of the guest runs afterwards; kerneld terminates it. The
  worker does not post `exited` (kerneld's `retire` is not idempotent; see the experiment
  notes).
- **fs callbacks are delivered with `nextTick`, fs promises resolve at once.** Every
  operation is a synchronous kernel call; a macrotask hop per callback bought nothing.
  A program that recurses through fs callbacks forever would starve timers.
- **Worker-scope names are shadowed, not deleted**: `self`, `postMessage`,
  `importScripts`, `location`, `XMLHttpRequest`, `Worker` … live on
  `WorkerGlobalScope.prototype`, so the runtime defines `undefined` own properties over
  them. `navigator` is replaced by a Node-shaped object that keeps `storage`/`locks`
  non-enumerable, because the kernel's OPFS code reaches them through the global.
- **`MessageChannel` in `worker_threads` is implemented in the process's loop**, not on
  the browser's: `on('message')`, keeping the process alive while listening and
  `receiveMessageOnPort` need it. The global `MessageChannel` is still the browser's.
  `Worker` is not provided.
- **Children: no shell.** A command line is split into words (quotes, `VAR=x` prefixes,
  `$VAR`); `sh -c`, `env`, `node`, a JS file, a node shebang or a `.bin` link are run;
  anything with `|`, `&&`, redirections, or an unknown program is ENOENT. `fork` IPC is
  newline-delimited JSON over a loopback socket whose port is passed in
  `NODE_CHANNEL_FD` (the kernel's spawn has three stdio slots and no fd passing).
- **AsyncLocalStorage needs the module transform.** Chrome 154 has no `AsyncContext`.
  First attempt: frames captured by everything the loop schedules plus a wrapped
  `Promise.prototype.then`. Measured with `runtime/harness/guests/als.mjs`: correct across
  timers and I/O, wrong after `await null` inside `als.run(store, asyncFn)` and after
  `await als.run(...)`, because the continuation of a native `await` cannot be hooked.
  Now `bat-modules` (`Options::async_context`, on in `bat-prepare` and in the runtime's
  Wasm calls) compiles `await x` to `__bat_u(await __bat_w(x))`; the two globals are
  pass-throughs until the first `AsyncLocalStorage` exists, then carry the frame with the
  awaited outcome. 49 of 49 checks pass, including a continuation resumed from another
  context. Cost while a storage is in use: one extra promise per `await`. Not covered:
  `for await`, `await using`, code compiled outside the transform.
- **A rewritten callee at statement start is written `void 0,(0,ns.f)()`** in
  `bat-modules` (a bare `(0,…)` continued a previous line without a semicolon). Images
  compiled before commit d883a3a are affected.
- **The entry's program script is loaded with `import()`, as a module.** Measured (table
  in `docs/experiments/2026-10-09-node-runtime.md`): `importScripts` in a dedicated worker
  never gets a V8 code cache; `import()` from the HTTP cache does from the third load
  (27.7 MB OpenCode program: 650–800 ms + 150 ms per process → 230 ms + 5 ms). Consequence
  for prepare: **a program script must be valid module code**, so it is evaluated in
  strict mode. That is free for ES modules (already strict) and wrong for sloppy CommonJS;
  a program that carries CommonJS needs either a check that the module is strict-safe or
  a second, classic script for those modules. A service worker serving the script from
  Cache Storage did not produce a code cache with either loader.
- **Module bodies from the image are evaluated with indirect `eval` and are not code
  cached** (118 ms of the 147 ms for `require('typescript')`; 118 ms for Vite's 546
  wrappers). The remedy is the one above: ship start-up module sets as program scripts.
- **`util.inspect` is still Vivari's bridge**, not Node's `internal/util/inspect.js`
  (which needs V8 introspection bindings). Object output is close, not identical.
- **zlib and the synchronous digests are a separate Wasm** (`crates/bat-node-native`,
  1.1 MB, instantiated on first use), not part of the kernel module, so a process that
  never compresses or hashes does not pay for it and the kernel stays small.

## 2026-10-10 end to end: the TODO scenario on the real runtime (e2e agent)

Evidence: `docs/experiments/2026-10-09-e2e.md`.

- **ripgrep stays the npm package run as a guest `node` process.** After the loop fix a
  search of `src` takes 31–145 ms and a file listing 51–71 ms per spawn in Chrome, under
  the 200 ms bar set for building a `wasm32-wasip1` `rg` against the kernel. Revisit if
  OpenCode starts searching trees larger than a project's own source.
- **Pending asynchronous Wasm compilation keeps a process alive**, like work on Node's
  thread pool. `fs.read` on a pipe or socket waits for readiness instead of blocking in
  the call: Go's Wasm runtime (esbuild-wasm) relies on the call returning.
- **Script output is a derived bundle, not project files** (supersedes "the cache is
  delivered as project files" above): `derived-<sha16>.json` beside the manifest, listed
  as `manifest.derived = { file, bytes, sha256, owns }`. The browser records
  `<bundle> <image>` in `/workspace/.server/derived-installed` and reinstalls, after
  removing the `owns` directories, whenever that differs. Chosen over a second image
  because Vite commits a re-optimization by renaming the cache directory, which an image
  directory cannot do (`EXDEV`). Source files keep the opposite rule: the browser's copy
  wins.
- **Optimized dependencies have no source maps in the guest** (toolkit Vite plugin,
  `optimizeDeps.esbuildOptions.sourcemap: false`, in the prepare run and in the tab so the
  config hash agrees): 5.8 → 2.1 MB. Cost: dependency frames in the preview's devtools show
  bundled code.
- **`@types/*` and `bun-types` are no longer pruned** (+7 MB): an agent verifying its edit
  with `tsc --noEmit` is the normal case, and the app's own tsconfig names them.
- **`/workspace/.server` carries a `.gitignore` of `*`.** The agent's state is inside the
  workspace so that it persists with it; anything that walks the project by ignore rules
  (Tailwind's scanner, ripgrep) must not treat it as project content. Without it every
  agent write reloaded the preview.
- **`resetWorkspace` deletes the overlay and keeps the image**, under the workspace lock
  (busy while any tab has the editor open). It is a runtime export beside `bootRuntime`
  and a toolkit function; the example reaches it through its private editor chunk.
- **A write to an HTTP response whose client is gone is dropped silently**, as Node does;
  the handler learns of the departure from `close`.
- **One command**: `bun run setup` builds everything into `CARGO_TARGET_DIR` (default
  `target/`) and puts the pinned OpenCode 2.0.3 server in `.runtime/opencode-2.0.3`
  (copied from a sibling old checkout, else the checksummed release asset);
  `bun run editor` adds prepare, build and serve of the example.

## 2026-10-10 shell: `/bin/sh` and the coreutils (`crates/bat-sh`, `runtime/src/process/sh.ts`)

Numbers: `docs/experiments/2026-10-10-first-open-and-shell.md`.

- **The shell is its own Wasm module (`bat_sh.wasm`, 521 KiB, 214 KiB gzip) with its own
  memory, not part of the kernel and not a WASI executable.** It is written against 24 host
  calls (`crates/bat-sh/src/sys.rs`: open/read/write/stat/readdir/…, pipe, spawn, wait),
  which `process/sh.ts` maps onto the kernel binding of whichever process runs it. The
  kernel stays the size it was; nothing in the kernel knows about the shell (the design's
  "WASI `.wasm` executables" as a second executable format were not needed for this).
- **The shell is not a kernel process unless it has to be.** Variables, working directory
  and the descriptor table (redirections, captures, here-documents) are the shell's own
  state, and every path it hands the kernel is absolute. So the synchronous calls
  (`execSync`, `spawnSync` of `sh`/`bash`, of a shell script, or of one of the shell's own
  commands) run it **inside the calling worker**, output captured in the shell's memory:
  no spawn, no worker (`execSync('echo hi')` 0.04 ms). The asynchronous calls need a
  second thread, so they start a kernel process whose executable is `/bin/sh`; the
  process worker runs the same module on descriptors 0..2.
- **Builtins, coreutils included, are function calls; only `node` and JavaScript programs
  are children.** A subshell, a command substitution and a pipeline stage are a clone of
  the shell state that is thrown away. Cost of the choice: **stages of a pipeline that are
  builtins run one after the other**, each to its end, through a buffer; an endless
  producer (`yes | head`) cannot work, and `yes` says so. A child process that is a direct
  stage gets a kernel pipe and does run alongside the next stage. A compound command put
  in the background with `&` also runs to its end first; a single program in the
  background is a real background child.
- **An in-memory capture is turned into a temporary file when a child must write to it**
  (`/tmp/.sh-…`, read back and removed at `wait`), rather than a pipe with a pump: the
  shell has no second thread to drain a pipe while it waits, and a file cannot fill up.
  Order between a child's output and the shell's own later output is kept because the
  shell waits before going on; two children writing one capture at once (a pipeline with
  both stages' stderr captured) are concatenated per child.
- **Own parser, no shell crate.** `brush-parser` and `deno_task_shell` bring an async
  executor or a parser generator and their own idea of a process; `yash-syntax` is GPL;
  `conch-parser` is unmaintained. The parser written here is about 1,000 lines. The only
  dependency is `regex-lite` (MIT/Apache-2.0) for `grep`, `sed` and `=~`, chosen over
  `regex` for size; POSIX basic and extended expressions are translated to its syntax.
- **`grep` is the shell's own, not the shipped `rg`**: a search of `src` is 1.5 ms inside
  the shell against 31–145 ms for an `rg` child.
- **A syntax error anywhere stops the whole script before it starts** (the script is
  parsed in one piece; bash runs the lines before the error).
- **Signals reach a shell process only at its host calls** (waiting for a child, `sleep`,
  starting a child, reading or writing a descriptor): there it takes the process's pending
  signals, passes them to its children and ends with 128 + signal. A loop of builtins that
  does no I/O is not interruptible short of SIGKILL (kerneld terminates the worker). A
  `timeout` on `execSync` is checked only at a wait, a sleep or a spawn.
- **`process.kill(-pid)` signals the process and its descendants.** The kernel has no
  process groups; a child started `detached` leads a group that is exactly its
  descendants, which is how OpenCode's shell tool kills a command.
- **`/bin/sh`, `/bin/bash`, `/usr/bin/env` are stub files** written at boot (overlay), so
  `existsSync`, `which` and shebang lines find them; what runs is decided by name, in
  `shellArgv` and in the shell itself. A real program of the same name on `PATH` does
  not shadow one of the shell's own commands.
- **`npm run`, `yarn`, `pnpm`, `bun run`, `npx`, `bunx` exist as far as they can without a
  package manager**: scripts from `package.json` run with `node_modules/.bin` on `PATH`,
  `npx` runs what is installed, `bun file` is `node file`; `install`/`add` say that they
  are not available.
- **Not there**: arrays, `select`, process substitution, job control, traps other than
  `EXIT`, `awk`, `diff`, `git`, `curl`, `tar`, `jq`.

## 2026-10-10 startup (measurements: `docs/experiments/2026-10-09-startup.md`)

- **Both programs start at once.** `startupOrder` no longer waits for the preview to listen
  before starting the agent (that order existed because the old runtime's one kernel thread
  served both). Each launch has its own process worker; the agent is no longer skipped when
  the preview never listens (it is started regardless, and the preview's failure is still
  the one reported).
- **Boot-time spares are per launch.** kerneld makes one warm process worker per prepared
  launch (`manifest.launch.*`) before it takes the lock and restores the overlay, and each
  begins `import()`ing that launch's program scripts as soon as it is warm. A spawn takes the
  spare whose programs equal its `BAT_PROGRAMS`; other spawns take an uncommitted spare.
  After boot one uncommitted spare is kept, as before. Workers also open the image handles
  named in the manifest before the mount (an image file carries its name only when
  complete).
- **`launch.programs` is honoured**: the host passes it as `BAT_PROGRAMS` (removed from the
  environment the guest sees, so children do not load their parent's programs); the worker
  loads those scripts before the entry.
- **Start-up module sets** are an add-on to the images, not part of them:
  `prepare({ startupModules })` takes a recorded list (`{ preview: [guest paths] }`,
  written by `bench/startup/run.ts --record-modules`), `bat-prepare startup-program` emits
  the ES modules and the already-strict CommonJS among them as one module script, and the
  loader prefers a function defined by a loaded program over the image body. The images are
  unchanged and keep every body, so a stale or missing list only loses the speed-up.
  **Sloppy CommonJS stays with `eval`** (217 of the example's 669 modules, 12% of the
  bytes): a module script is strict and there is no cached path for classic scripts in a
  worker. The list is recorded, not derived at prepare time; a native run with
  `module.registerHooks` could derive it and was not built.
  Cost: frames of these modules in stack traces name the program script and its line, not
  the module file (as OpenCode's program always did).
- **`preloadEditor()` exists and takes nothing**: manifest fetch, runtime module import,
  kernel compile. It does not register the service worker, take the lock or create workers,
  so it is safe on a page whose visitor never opens the editor. Numbers that include it say
  so.
- **The TODO example renders the editor panel without `React.lazy`/`Suspense`**: React holds
  a boundary that showed its fallback for 300 ms, which was 300 ms on every open.
- **`EditorPreview` navigates when the server listens**, not after the editor's own
  readiness request.
- **OpenCode's models.dev document is reduced to provider `opencode` by a `--require`
  preload** in the agent process (`modelSourcePreloadSource`), at `JSON.parse`: a text over
  1 MB whose value is an object of at least 20 providers (each with its `id` and `models`)
  is returned with only the kept providers. First attempt, withdrawn: answering the
  server's request for `models.opencode.ai/api.json` through a wrapped global `fetch`.
  Measured: the wrapper was never called (the request does not go through `globalThis.fetch`
  in the guest; not traced further), and the catalog bundled in the server, which is what a
  start builds from, never passes through a request at all. The server's `/api/model` is
  byte-identical with and without the preload for the example (it lists usable providers
  only). The stored document is still the full one (a 5.4 MB row, parsed at each start,
  then reduced). Not verified: a chat turn after the change (no messages were sent while
  measuring); a workspace that had other providers configured through OpenCode itself
  would lose their catalog entries. It depends on the pinned server's internals: if a later
  server does not parse the document with `JSON.parse`, nothing is reduced.
- **Optimized dependencies are transformed to `map: { mappings: '' }`** by the toolkit's
  Vite plugin in the guest, so Vite does not inject its fallback source map (6.1 MB for
  react-dom's 1.1 MB chunk, generated per response).
- **kerneld snapshots when idle**: journal over 1 MB and no journal write for 5 s. The
  16 MB limit stays for busy periods. A snapshot holds the kernel's overlay lock while the
  overlay is serialized.
- **Agent configuration files are written only when their content differs.**

## 2026-10-10 first open, image identity (gaps agent)

Numbers: `docs/experiments/2026-10-10-first-open-and-shell.md`.

- **Transport is `Content-Encoding: zstd` of a copy prepare writes (`<image>.zst`), decoded
  by the browser.** Chrome 154's `DecompressionStream` takes only gzip/deflate (checked:
  `zstd`, `brotli`, `br` all throw), so the alternatives were a Wasm decoder in the worker
  or the network stack's own. The network stack's needs no code and runs off the worker.
  zstd over brotli by build cost at equal size (TODO image 238.9 MB: zstd 9 → 33.8 MB in
  2 s, zstd 19 → 29.0 MB in 47 s; brotli 5 → 32.7 MB in 8 s, brotli 9 → 30.1 MB in 114 s on
  one thread). Default level 9; 19 is an option. A Wasm decoder was not built or measured.
- **Integrity is a SHA-256 per MiB of the image, checked before the block is written.**
  The sums are a sidecar (`<image>.sums`, 7 KB for the TODO image) whose own hash is in the
  manifest, so the manifest stays small for the reopen. WebCrypto hashes a block natively
  (the Wasm SHA-256 pass cost about 8 s for 240 MB); it has no incremental digest, which
  is why blocks rather than one hash. Verifying before the write is what makes it sound to
  use the image while it arrives. The whole-file `sha256` in the manifest is no longer
  computed in the browser when sums exist; it remains the image's name.
- **An image is mounted when its head is in the file**, with the kernel told it is
  arriving (kernel-abi.md §17). Chosen over waiting because at 50 Mbit/s even the
  compressed image is 5 s. The downloader's file is `<name>.partial` in `readwrite-unsafe`
  mode; workers join that mode when `read-only` is refused. The final name still means
  complete and verified: a partial that was mounted cannot be renamed while held, so it is
  marked `.ok` and renamed by the next open.
- **Prepare lays out what a start-up reads first** (`--order`, from a recorded read trace:
  758 files, 11 MB of 239 MB for the TODO app) and the browser **stops reading the image
  after that part until the toolkit says its programs are up** (`RuntimeHost.started()`,
  optional in the contract; 20 s timer as a fallback). Without the stop, the program
  scripts shared the link with the image's remainder. The order file is an input of the
  image (a new order is a new hash); stale lines only cost speed.
- **Everything else a first open fetches is compressed too** (program scripts, derived
  bundle, runtime scripts and Wasm): 281 MB → 41 MB on the wire in total.
- **Packages that are not from the lockfile live in `node_modules/.linked` and travel in
  a second image** (`manifest.layers`), mounted there. The guest does need the toolkit
  (its Vite plugin runs in the guest's config, and `tsc` reads its types), so excluding it
  was not an option; its copy of the runtime (4.4 of 5.1 MB) is pruned by policy. Chosen
  over delivering those files through the overlay (the derived-bundle route) because an
  image is read-only, content-addressed and precompiled like the rest of `node_modules`.
  The policy's shim packages stay in the first image: they change with the tool, not
  with the app.
- **Bun's isolated linker is not deterministic about `.bin` links** (one of four installs
  lacked one): prepare adds the links packages declare and Bun did not write. This was a
  second cause of image churn, independent of the toolkit.
- **Kernel walk**: the image fast path applies whenever the overlay has nothing under the
  next name, so the layer's mount point does not slow lookups elsewhere in `node_modules`.
- **Image collection** runs after the downloads, only in the tab that holds the
  workspace, keeps every mounted image, and retries once after 5 s for files a
  just-closed editor still held. A Web Lock per image name keeps a second tab from
  truncating a download in progress.
- **Not done**: resuming an interrupted download (it restarts), and the UI does not show
  that the image is still arriving in the background.

## 2026-10-10 closing pass (summary: `docs/experiments/2026-10-10-rust-rewrite-summary.md`)

- **The preview frame has no `SharedWorker`.** Vite's client waits for a restarted dev
  server by opening `new WebSocket(url, 'vite-ping')` inside a blob `SharedWorker`; the
  frame's `WebSocket` replacement does not exist in that global, so the ping went to the
  real server and the frame was never reloaded after a `vite.config.ts` edit (measured:
  server answering again after 0.35 s, frame stale indefinitely; with the class hidden the
  app is back 1.46 s after the edit). Cost: an app that uses a `SharedWorker` does not work
  in the preview. The alternative, a `SharedWorker` wrapper that injects the replacement
  into the worker's script, was not built.
- **A new service worker serves the frame from the open after the one that finds it.**
  Seen when the change above was deployed; left as it is.
- **The harness defaults to the setup's outputs** (`examples/todo-app/.editor/prepared`,
  `target/`), then the earlier build directories.

## 2026-10-10 first consumer outside the repository (IRS tools)

What the IRS tools migration needed that the TODO example never asked for. Each is a general
hook; nothing names that app.

- **Release shape: two npm tarballs** (`scripts/release.ts`). The toolkit package carries
  `dist/` with the browser runtime, plus `prepare/`: the guest policy with `dir:` paths
  rewritten to the shim packages beside it, and the pinned OpenCode server. The
  `bat-prepare` executable is its own package per platform,
  `@kkrausse/browser-agent-prepare-<platform>-<arch>`, which `prepare()` resolves from the
  app; no `os`/`cpu` fields, so installing the wrong one is harmless and the error names
  what to build. Measured: 8.1 MB and 2.2 MB (the stripped executable is 6 MB). Both are
  pruned from the guest image by the policy (`prune.paths`); pruning the whole binary
  package broke prepare's "required dependency is missing" check, so only the executable
  goes. The executable links glibc dynamically (built on Ubuntu 26.04): an older host needs
  its own build. Only linux-x64 has been built.
- **A tarball dependency is a lockfile package**, so re-pinning the toolkit gives the large
  dependency image a new identity (435 MB, 52.7 MB compressed for IRS tools) although the
  guest uses one file of it (`dist/vite.js`). Not addressed; treating `file:` tarballs like
  the non-lockfile layer would fix it.
- **`--configLoader native` means Node's rules for the app's Vite config**: an extensionless
  relative import (`./src/config`) fails in prepare's native optimizer run. The app writes
  the extension. The launch was not changed.
- **`prepare({ refresh })`**: project paths that stay the app's and are rewritten at every
  open when they differ. Source is the visitor's once installed, which is wrong for
  configuration the app injects (IRS: public config read by its Vite config). Written by
  `prepare.ts` into the manifest, like the start-up programs; `bat-prepare` does not know.
- **`prepare({ modelCatalog })`** writes the catalog into the manifest, for an app that
  fetches it at prepare time; the handler's serve-time catalog still replaces it.
  `prepare({ workDir })` passes `--work`: the default `<outDir>.work` put 420 MB into a
  release directory.
- **Saved workspaces are the app's; the toolkit has the two ends.** `captureSource(fs)`
  (ZIP of the workspace source: managed directories out, ignore files honoured, limits) and
  `unpackSource(bytes)` (validated before anything is written), and
  `openEditor({ initialWorkspace })`, asked only when the browser holds no workspace: files
  to install instead of the prepared source, sessions imported before the chat attaches,
  and the session to open on. Restore is close → `resetWorkspace()` → open
  (`useEditor().reopen(between)`), not a replacement under running programs: measured in
  IRS tools at 7.0–7.3 s for a whole switch (save the outgoing workspace, download, reset,
  reopen; the reopen itself is 2.0–2.5 s), against about 11.5 s on the previous runtime.
  The source marker is written after the session import, so an interrupted start asks
  again. Dependencies added: `fflate`, `ignore`.
- **`createEditorHandler({ previewHeaders })`**: response headers for everything the service
  worker serves the preview frame, bound into `sw.js` as the handler delivers it (a global
  the worker reads once). The frame's documents never pass the app's server, so a
  `Connection-Allowlist` or CSP set there did not reach them. Bound at the authorized
  script delivery rather than sent by the page, so neither the page nor the guest can
  change it. A change reaches a browser with the worker's next update.
- **`chat.startNewSession` reuses the latest session when it is empty.** Opening on a fresh
  chat every time left one more empty session per open (eight after eight opens).
- **The Vite plugin prebundles the toolkit's browser entries in a host dev server**
  (`optimizeDeps.include`) instead of excluding the package: excluded, its CommonJS
  dependencies (`ignore`, `use-sync-external-store/shim` under Base UI) reached the browser
  unconverted and the editor chunk failed to import. The example never met this because it
  serves a production build.
- **Seen, not fixed**: IRS tools' preview listens after 1.3 s on a reopen (TODO: 0.43 s)
  without a start-up module recording; `bench/startup/run.ts --record-modules` is written
  for the example's page. Page screenshots through CDP timed out twice while a Base UI
  select popup was open; the page itself stayed responsive.
- **`BAT_HOST_LOOPBACK_PORTS`** (process environment, comma-separated ports): a guest request
  to loopback on one of them goes to the browser's `fetch` instead of a kernel socket. Guest
  outbound HTTP was already "loopback → guest listener, `host.internal` → the page's server,
  anything else → the browser's fetch"; what was missing is a way to name a server on the
  developer's own machine, which `examples/terminal-app` needs for a model endpoint the tab
  calls directly (its mock on `127.0.0.1:4311`). Measured there in Chrome: the OpenCode
  server's `POST <base>/responses` leaves the tab cross-origin under COOP/COEP, streams, and
  is preceded by a preflight asking for `authorization, content-type, x-opencode-client,
  x-opencode-project, x-opencode-session, x-session-affinity, x-session-id`.

## 2026-10-10 an editor page as a directory of static files (`examples/terminal-app`)

What it took to serve the terminal example from a file shelf at `/artifacts/<name>/`, with
no server of its own. Measured in Chrome 154.

- **`bootRuntime({ serviceWorker: { url, scope } })`.** The default stays the runtime's
  `sw.js` with scope `/preview/`, which needs `Service-Worker-Allowed` and the origin's
  root. With the option the page names a worker script at or above `scope` that runs the
  runtime's (`importScripts`), and the preview is at `<scope>preview/<port>/`: the worker
  and the frame's WebSocket shim take the prefix from `registration.scope`, and
  `endpoint(port).url` follows. The guest's Vite base is that URL's path, given to the dev
  server as `BROWSER_AGENT_BASE` (`previewBase()`); nothing prepared depends on it.
- **One worker for the page and the preview**, not two with nested scopes. A wider scope
  means the worker controls the editor page too, which the earlier design avoided; here that
  is the point, since the same worker adds COOP/COEP to the page's responses (a static host
  sends none) and reloads are how the page becomes isolated. The app's worker script does
  that in its own `fetch` listener after importing the runtime's; the runtime's listener
  answers only preview requests, so the two do not meet.
- **`setGuestPaths(port, { '/api': 3001 })`** (optional in the contract). The TODO app calls
  root-absolute `/api`, which under `setHostPaths` and before meant the page's server. With
  no such server the app's backend is a guest program, and the worker sends a request to
  that guest listener when it comes from a frame of `port` (by `Referer`: a frame that
  sends none is not routed) and its path is under a named prefix. The guest sees the path
  as asked. Chosen over a Vite middleware or proxy in the guest because the app's files
  stay as they are: its Vite proxy sees paths only after the toolkit's plugin has put the
  base back in front of them, so `/api` never matches there.
- **Compressed files are inflated by the app's worker, not by the image loader.** A static
  host sets no `Content-Encoding`, and `DecompressionStream` has gzip but no zstd or brotli.
  The build ships `<name>.gz` only and the worker answers `<name>` with the inflated
  stream, for every big file alike (image, program scripts, Wasm, the terminal's bundle).
  The loader is unchanged: block checks, mounting at the head, and the pause after the
  start-up part all act on the inflated stream, and not reading still backs up to the
  network. Sizes: image 240 MB raw, 45 MB gzip, 32 MB zstd; whole directory 57 MB. A zstd
  decoder in Wasm would save the 13 MB; not built.
- **Seen**: after the page's one reload into isolation, Chrome kept the first, unisolated
  document and showed it again on a later reload driven through the debugger (document age
  243 s, navigation type `navigate`). The page reloads again when it is shown from that
  cache (`pageshow`, `persisted`), and takes `?reset=1` out of the address before anything
  can reload it.

## 2026-10-10 two OpenCode versions, and what a tab needs for an OAuth sign-in (`examples/terminal-app`)

- **The application directory describes itself.** `bat-prepare` takes `{ id, files }` from an
  `application.json` in the directory it is given (`--opencode`, `BAT_OPENCODE_DIR`,
  `prepare({ openCodeDir })`) in place of the policy's `application.id` and `application.files`;
  guest directory, support packages, program and launch stay the policy's. That is how one
  checkout prepares the TODO example with the 2.0.3 release asset and the terminal example
  with 2.0.26. Chosen over a second policy file (which would repeat the substitutions and
  their `dir:` paths) and over a version switch in the tool (the tool knows no versions).
- **2.0.26 is built here, and pinned by a lockfile.** `scripts/opencode-server` bundles the
  published `@opencode/server` with Bun (the recipe the 2.0.3 artefact was made with). The
  bundle's bytes change with the directory it is built in (measured: 20,707,881 and
  20,707,241 bytes for the same lockfile in two paths), so an output hash in a committed
  policy would only match one machine; the hashes in `application.json` are of the build
  beside them. 2.0.26 ran on the runtime with no change to it: same Node surface as 2.0.3,
  `/api/info` in place of `/api/health`, and a shell tool, which found `/bin/sh`.
- **`BAT_FETCH_DIAG=1`** (process environment): a request handed to the browser's fetch that
  rejects or is answered 400+ writes one stderr line with method, origin + path and the
  status or error. Opt-in and on stderr because the only reader that exists is whoever pumps
  the process's output; a callback on `RuntimeHost` would need a channel from each process
  worker to the page for one consumer.
- **`BAT_FETCH_MAP`** (process environment): exact URLs fetched from another URL. Needed
  because `auth.openai.com/.well-known/jwks.json` has no `Access-Control-Allow-Origin`
  (its preflight is a 404), so the identity-token check of OpenCode's ChatGPT sign-in gets
  "Failed to fetch" in a tab; the example ships a build-time copy of that public document.
  The alternatives were patching the check out of the server bundle or a relay.
- **A loopback redirect is finished by the page.** Measured against OpenAI on 2026-10-10:
  `redirect_uri` on `127.0.0.1` or `localhost` (any port, any path) reaches the login page;
  an https origin gets HTTP 400 `invalid_authorize_request` (param `redirect_uri`); the
  discovery document names no device or registration endpoint and
  `deviceauth/usercode` refuses the dynamic client (`invalid_client`). So the browser ends on
  a dead loopback address, and the page delivers the pasted address to the guest listener
  through `endpoint(port).fetch`. The page finds the attempt and its port in the client's own
  requests, which pass through it; nothing in OpenCode is patched.
- **Seen, not fixed**: a guest process that made one request through the browser's fetch does
  not exit by itself afterwards (`node probe.mjs` with one awaited `fetch`, output complete,
  `exited` unresolved after 8 s; the same on the build before these changes). The servers
  here never exit on their own, so nothing depended on it.

## 2026-10-10 guest HTTPS through a TCP relay, TLS in the tab (`BAT_FETCH_TUNNEL`)

For hosts that answer without `Access-Control-Allow-Origin`, which the browser's fetch can
call but whose answers it will not show: `api.openai.com/v1/responses` with a ChatGPT-plan
token (200 and a stream outside a browser, "Failed to fetch" in a tab), and
`auth.openai.com/.well-known/jwks.json`.

- **A third route for guest HTTP, chosen per process.** `BAT_FETCH_TUNNEL` (host names, or
  `https://host/path` prefixes) with `BAT_FETCH_TUNNEL_URL` (`wss://relay/tcp`): such a request
  is made by the runtime's own client (`runtime/src/net/tunnel.ts`), from the global `fetch`
  and from `node:http(s)` alike. The relay is `wasm-term/web/tcp-relay.ts` unchanged: one
  WebSocket is one TCP connection, ack flow control with a 256 KiB window, an origin and a
  destination allowlist. It sees the destination host, timing and byte counts, and TLS
  records; never a token, a prompt or a reply. Everything not named keeps its route.
- **TLS is rustls compiled to Wasm, not a TypeScript client on WebCrypto.** `subtls` exists
  for exactly "TLS over a WebSocket from a browser" and would have been less work (no Wasm,
  no toolchain), MIT, last release 2025-01. Its README calls it a proof of concept not meant
  for production: TLS 1.3 with one cipher suite and one key exchange, no chain building, no
  alerts, unaudited certificate code. These connections carry a bearer token, so the
  verifier is the part that has to be right. rustls 0.23 with `ring` builds for
  `wasm32-wasip1` with wasi-sdk's clang; a C ABI of fourteen functions
  (`runtime/src/net/tls/native/src/lib.rs`) moves ciphertext and plaintext in and out and
  does no I/O. The file is committed (`bat_tls.wasm`, 647 KB, 300 KB gzipped) like the other
  Wasm that needs a toolchain a setup does not have, and is fetched only by a process that
  tunnels. It imports six WASI calls (random, clock, stderr for a panic), which `tunnel.ts`
  supplies. `rustls-rustcrypto` (pure Rust, no clang) was the fallback had `ring` not built;
  it calls itself alpha.
- **No way to skip verification, and none to add a trust anchor at run time.** The roots are
  `webpki-roots` (Mozilla's list) compiled in; the ABI has no call for either. A test needs
  a certificate of its own, so the crate has a cargo feature that compiles one more anchor
  in from a file (`BAT_TLS_TEST_ROOT`), refuses to overwrite the committed file, and makes
  the module answer 1 to `tls_test_build`, which the runtime prints on the process's stderr.
  The published site ships the committed file (same sha256). New roots or a rustls fix
  mean `cargo update`, a rebuild and a commit.
- **Its own HTTP/1.1 client, one request per connection.** The kernel's codec parses a
  socket's ring in place and cannot be given a byte stream that is not a kernel socket, so
  `tunnel.ts` has a response parser (content-length, chunked, until-close, 1xx skipped) and
  writes requests with `connection: close`. ALPN offers `http/1.1` only. An until-close
  body is complete only on TLS close_notify; a stream that just stops is an error. Not
  done: connection reuse (each request pays a TCP and TLS handshake, measured 90–160 ms
  to api.openai.com from here), HTTP/2, and upgrades: a WebSocket handshake to a tunnelled
  host is sent as a plain GET and answered accordingly.
- **A tunnelled `fetch` is Node's, not the browser's.** No `Origin`, no cookies, no
  preflight; the program's headers as written (they are read from `init.headers`, since a
  `Request` would drop the forbidden ones); `accept`, `user-agent: node` and
  `accept-encoding: identity` added when absent; redirects followed here, credentials
  dropped across origins. That is the point for an API that rejects browsers, and it means
  the relay's allowlists are the only thing between a page and those hosts.
- **Backpressure reaches the far end.** Received bytes are acknowledged to the relay when
  TLS has taken them, and TLS is fed only while the response body's reader wants more
  (1 MiB high-water mark): 3 MiB sent to a reader that does not read stops at 1.5 MiB.
  Abort and body cancel close the WebSocket, which closes the TCP connection.
- **`BAT_FETCH_DIAG` says more for these.** One line per tunnelled request whatever its
  outcome, naming the relay and the negotiated suite, or the layer that failed: `the relay
  refused example.com:443 (denied: not in the relay's allowlist)`, `TLS with host: invalid
  peer certificate: UnknownIssuer`, `the relay at host did not accept the WebSocket`.
- **Found on the way: the OpenCode server died on any OpenAI-provider prompt.** Its OpenAI
  provider tries a WebSocket transport first (`GET /v1/responses`); `ws` aborts that
  request on an answer other than 101, and the runtime turned the resulting "aborted" on
  the response into an uncaught exception (`runtime/src/net/http.ts` now emits a
  response's error only to listeners, as Node does). With that the server logs "session
  websocket connect failed; using http" and posts.
- **Measured** (Chrome 154, harness guest and the terminal example): unauthenticated
  `GET /v1/models` and `POST /v1/responses` come back as OpenAI's 401 JSON, TLS 1.3
  `TLS13_AES_256_GCM_SHA384`; the JWKS document as 200. Against a local TLS server behind a
  relay alias, with a throwaway CA in a test build: five events 300 ms apart arrive 300 ms
  apart; an abort after two events of an endless stream closes the server's side; a 300 KiB
  streamed upload arrives chunked; a certificate for another name and one from an unknown
  CA are rejected, as is the throwaway CA by the committed build.
- **The terminal example** takes `?tunnel=` / `TUNNEL_URL` and tunnels `api.openai.com` and
  `https://auth.openai.com/.well-known/` (the keys; the shipped copy and `BAT_FETCH_MAP` are
  then unused). The token exchange stays with the browser's fetch, where it was seen to work.

## 2026-10-10: the terminal is a kernel device; the OpenCode client is a toolkit process

Until now the terminal example ran two machines in one tab: the toolkit runtime (servers)
and wasm-term's program host (the OpenCode TUI on its own pty, shim and private files),
talking through the page. The terminal is now a feature of the toolkit runtime. Spike:
`docs/experiments/2026-10-10-toolkit-pty-spike.md`; result and numbers:
`docs/experiments/2026-10-10-toolkit-pty.md`.

- **The pty and line discipline are one crate, `crates/bat-pty`,** moved out of
  `wasm-term/kernel` with their 51 tests; wasm-term's kernel keeps its C ABI and depends on
  it. A path dependency from `bat-kernel` on `wasm-term/kernel` was the first try and
  cargo refuses it (a workspace root inside this workspace).
- **A terminal is two file descriptors** (`bat_tty_open`: master and slave), not a new kind
  of process attribute. The generic read/write/poll/subscribe calls work on both; four calls
  cover termios and the window size (ABI section 18). The pty sits behind one kernel lock
  like a pipe's ring; a blocking slave read waits on a wait-queue word with the `VTIME`
  deadline as timeout; a writer that may block waits above 1 MiB of untaken output (the
  flow control wasm-term's host did against the page).
- **No process groups.** The line discipline's signals (^C, a resize, hang-up) go to the
  newest live process that was spawned with the slave as its stdin. Enough for one program
  per terminal and for a shell that waits for its child; not job control.
- **`RuntimeHost.spawnTerminal(launch, { cols, rows, onOutput })`** is the page's handle:
  `write`, `resize`, `kill`, `exited`. Output is a callback, not a `ReadableStream`: every
  chunk is drawn at once and nothing may be dropped (a process's stdout stream drops old
  bytes when unread).
- **Node's tty surface is filled in where the stdio streams are made** (`node/process.ts`):
  `isTTY`, `setRawMode` with libuv's raw bits (OPOST stays on) restored at exit,
  `columns`/`rows`, `resize` on SIGWINCH. `tty.ReadStream`/`WriteStream` return those same
  streams and are not classes one can extend.
- **`worker_threads.Worker` is a forked process.** OpenTUI's tree-sitter worker has to run
  somewhere, and without it the client crashes at the first reply. A worker thread here is
  another process worker joined by `fork`'s channel: messages are JSON, nothing is
  transferred or shared, and its stdin is not the parent's terminal. Right for a worker
  that is asked things and answers; wrong for anything that shares memory or passes ports.
- **The client is the same source built for Node** (`wasm-term/ports/opencode`,
  `--target=node`): the bundle wasm-term serves has wasm-term's shim compiled in, the Node
  build leaves `node:*` as imports. It is an application file of the image (`/app/tui/`),
  beside the server; the example's `prepare.ts` joins the two directories.
- **The client's files are ordinary workspace files** (`/home/user/.config|.local/...`,
  persisted with the overlay in OPFS), not a private vfs with IndexedDB. A reload kills the
  client without a chance to release its file locks, which it would then wait a minute
  for; the page removes the lock directories before it starts the client.
- **The sign-in bar needed a new source.** The page used to see every request of the
  client. Now it gives the client a preload module (`node --import`, `client-tap.ts`) that
  appends the sign-in exchanges, and only those, to a file the page watches. Considered and
  not done: keeping the page in the path as a proxy (that is what was being removed), and
  an `xdg-open` program in the guest (the bar would only appear when the user presses the
  client's "open" key).
- **The display is a component of its own** (`wasm-term/web/display.ts`): bytes in, input
  and size out. `embed.ts` joins it to wasm-term's machine, the example to a
  `RuntimeTerminal`. The example loads it as a separate bundled module, not by importing
  the source: ghostty-web's sources do not pass the example's stricter TypeScript settings.
- **Not done: an interactive shell.** `bat-sh` has no prompt and no line editing; with no
  script argument it reads all of stdin to end of file and then runs it. On a terminal
  that means typed lines are echoed by the line discipline and run together after ^D
  (checked). A prompt loop is a shell feature, not a terminal one.

## 2026-10-10: the clipboard belongs to the display; one bundle-time edit to the client

- **Copy and paste are the terminal's, not the program host's.** wasm-term's host handed the
  client the page's clipboard through its shim. The toolkit runtime gives a program no
  clipboard, and should not grow one for this: a terminal already has both directions.
  Paste is input (the display's `ctrlVPaste` makes ctrl+v the browser's paste; the client
  gets a bracketed paste), and a copy is OSC 52 in the output, which the display
  (`wasm-term/web/osc52.ts`) turns into a clipboard write. The display still knows nothing
  of the toolkit. OSC 52 queries are ignored, so nothing on the terminal can read the
  clipboard. Lost against the old bridge: nothing for text; images were never carried.
- **The client's source gets one edit when it is bundled** (`wasm-term/ports/opencode/build/opencode-edits-plugin.ts`,
  anchor-checked like the OpenTUI edits; the checkout is not written to). Upstream's prompt
  drops a submit silently while the location's agents are still loading, which against a
  server in a tab is the first 0.3 to 0.7 s of the home screen. The submit now waits for
  the list. Considered and not done: holding typed input on the page until the client is
  ready (the page would have to tell keys from the terminal's own replies and guess
  readiness from the screen), and a fixed delay. To drop the edit, remove the plugin from
  `build-site.ts`; the early Enter is then lost again, as upstream.

## 2026-10-10: wasm-term leaves this tree; what the toolkit used of it has places of its own

Entries above name paths under `wasm-term/` and `scripts/opencode-server`; they are records
and are not rewritten. Where those things are now:

| Was | Is |
| --- | --- |
| `wasm-term/web/display.ts`, `osc52.ts`, `wasm-term/third_party/ghostty-web/` | `packages/terminal/` (the display, with the ghostty-web snapshot, its notices and `sync.sh`) |
| `wasm-term/web/tcp-relay.ts`, `tcp-relay-main.ts` | `packages/relay/` |
| `wasm-term/ports/opencode/` | `ports/opencode/` |
| `scripts/opencode-server/` | `ports/opencode/server/` |
| `wasm-term/vendor/` (untracked checkouts) | `ports/opencode/vendor/` (gitignored; `setup-vendor.sh` fetches the pinned tags) |
| `wasm-term/kernel`'s pty | `crates/bat-pty` (since the entry before last) |

- **wasm-term is a separate project and is not on this branch any more.** Its host (the
  machine, the Node-style shim, the vfs), kernel wrapper, guests, dev and static pages, the
  mock backend (`mock-llm`), the **Codex port** and the bun-web-terminal snapshot live only
  on the branch `wasm-term`. Since the client became a toolkit process, nothing here ran on
  that host; it was kept in the tree only because the three pieces above sat inside it.
- **The split is by what a thing is, not where it came from.** `packages/` holds what a page
  or a deployment takes as it is (the toolkit, the display, the relay); `ports/` holds a
  program built from someone else's source for this runtime (OpenCode: its client, and the
  server bundle of the same version beside it). Neither new package knows the toolkit: the
  display takes bytes, the relay carries them.
- **The port builds the Node program only.** Its browser target (the client as a guest of
  wasm-term's machine: `host/guest.ts`, `web/guest.ts`, the tree-sitter worker wrapper,
  `build:tui`) imported wasm-term's host and went with it. The Node build never used that
  import; the built client is byte for byte the same before and after.
- **The display imports its snapshot by path**, not as a `file:` dependency that the package
  manager copies into `node_modules` (a copy that went stale until the next install).
- **Not renamed:** what is compiled into the client under wasm-term's name (the channel
  `wasm-term`, `__wasmTerm…` globals, `wasmTermAlloc`/`wasmTermFree` of the Wasm core,
  `/wasm-term/…` asset paths, the relay's `wasm-term tcp relay:` error text). Renaming them
  changes the built client or the wire for no gain.

## 2026-10-10: the React UI is a package of its own (`packages/react`)

`@kkrausse/browser-agent-toolkit` listed Base UI, lucide, class-variance-authority, clsx,
tailwind-merge and Marked as dependencies and React as an optional peer, so an app that only
prepares, serves, or opens an editor under a UI of its own (`examples/terminal-app`)
installed all of them.

- **Two packages.** `packages/toolkit` keeps its name and `./prepare`, `./server`,
  `./browser`, `./vite`, `./fake`, `./fake/server`, unchanged. `packages/react` is
  `@kkrausse/browser-agent-toolkit-react`: the package root is what `./react` was
  (`useEditor`, `useEditorSnapshot`, `EditorPreview`, `ChatView`, `Transcript`, `Composer`,
  `useChatSnapshot`), and `./styles.css` is the stylesheet with its Tailwind build.
  `react` and `react-dom` are required peers there. For an app: the `/react` import and
  the `/styles.css` import change, and one dependency is added.
- **The rule is the dependency direction.** `react` imports `toolkit`; nothing in
  `packages/toolkit/src` imports React, a UI library or the React package. Where a file
  lives follows from that and from nothing else.
- **The chat logic stays in the toolkit.** `openEditor` creates the chat controller
  (`editor.chat`, `chat: { startNewSession }`) and `sessions.ts` uses its endpoint type,
  so the controller, `api.ts`, `admission.ts`, `forms.ts`, `types.ts` and the vendored
  reducer and OpenCode types (`src/chat/`) cannot move without the toolkit importing the
  React package. It is also what a page needs to drive a chat without this view. What moved
  is what draws: `view.tsx`, `markdown.tsx`, `ui/*`, the two stylesheets, `react.tsx` (now
  `packages/react/src/index.tsx`), the style build script, `LICENSE.shadcn`,
  `LICENSE.marked` and their notices. No file is in both.
- **One export was added:** `isPreparing` on `./browser`, beside `canSend` (the view parks
  a send in that state). The view takes everything else from what `./browser` already
  exported (`createChatController`, `canSend`, the chat types). A `./chat` subpath was
  considered and not added for one function.
- **One copy of the chat code on a page.** The toolkit's build used to split shared chunks
  between `browser.js` and `react.js`. Now the React package's bundle keeps
  `@kkrausse/browser-agent-toolkit/*` external, so the app's bundler resolves both to the
  same module.
- **The Vite plugin** named `./react` in `optimizeDeps.include`. It now names the React
  package only when a `node_modules` at or above the Vite root has it: a string and a
  file check, not an import, so an app without the package gets no warning.
- **Guest policy unchanged.** Its prune globs name `@kkrausse/browser-agent-toolkit/dist/runtime/**`
  and `…/prepare/**`; the React package has neither directory and its name does not match
  those globs. `examples/todo-app/startup-modules.json` records only the toolkit's
  `dist/vite.js`, whose path did not change, so it was not recorded again.
- **Release:** `scripts/release.ts` stages a third tarball,
  `kkrausse-browser-agent-toolkit-react-<version>-<commit>.tgz`. In it the workspace
  dependency on the toolkit becomes a peer dependency on the version, marked optional.
  Tried in a scratch app with both tarballs by `file:` path (bun 1.4): as a dependency, and
  as a required peer, `bun install` asks the registry for the toolkit and fails (404);
  as an optional peer it installs and both packages import. The peer is required in fact;
  "optional" only keeps the package manager from fetching it. The two packages share one
  version.

## 2026-10-10: the terminal example has a public build (`PUBLIC=1`)

A page that strangers can open cannot default to a mock, a collector or a relay of this
machine. `examples/terminal-app/build.ts` takes `PUBLIC=1`; the development build is unchanged.

- **One flag at build time, not a second page.** `process.env.PUBLIC` is a constant of the
  bundle and `src/main.ts` branches on it in six places. The sign-in code, the diagnostics
  and `?model=` stay in the bundle and are gated: `?model=` and `?diag=<url>` still work,
  which is how the public build was tried against the mock.
- **No provider of ours.** Without `?model=` the server's configuration names no provider.
  OpenCode's own `opencode` provider then runs with the key `public` and the free models.
- **A first model is named after all** (`PUBLIC_MODEL`, default `ling-3.1-flash-free`).
  Leaving it to OpenCode was the first choice, since that follows their free list. It was
  tried and failed: the default is the newest free model of the catalog, `exo-free` that
  day, and Zen answered it with HTTP 410 "deprecated". The page uses the name only while
  `opencode.ai/zen/v1/models` lists it, then falls back to OpenCode's choice. Probing which
  model answers was not done: Zen refuses its free tier to anything but OpenCode
  ("OpenCode's free tier can only be used from within OpenCode"), and a probe of the page's
  own would have to pose as it.
- **The relay default is the Deno Deploy one and only `opencode.ai` is tunnelled.** The relay
  carries nothing else, so naming OpenAI's hosts would only produce failures that say "relay".
- **Diagnostics are opt-in by address** (`?diag=<url>`): `installDiag` takes `null` for "no
  collector was built in" and then sends nothing.
- **The ChatGPT sign-in is not installed**: no preload module in the client's command, no
  watcher, no keys copy. The flow needs `api.openai.com` through a relay.
- **The page says what it is in a footer** under the panel (hidden in the development build
  and with `?model=`), not in a dialog: three plain statements and a link.
- **The demo recorder** (`examples/terminal-app/demo/`) follows the TODO example's: real time
  except the model's working time, which is labelled. The mock has a script for the same
  prompt, so that one take does not depend on a free model's rate limits; that take is
  labelled as scripted wherever it is shown.
- **GitHub Pages gets a branch that is replaced, not appended to** (`publish-pages.ts`): the
  commit is built in a scratch repository from the built directory and pushed with force as
  `gh-pages`, so this checkout's branches and index are never involved and 55 MB builds do
  not accumulate. It does nothing without `--yes`.

## 2026-10-11: where sync access handles are exclusive, only kerneld holds the image

The design gives every worker its own read-only `FileSystemSyncAccessHandle` on the image,
and lets the first download be read while it is written (`readwrite-unsafe` in the writer
and the readers). Both need the `mode` option. WebKit does not have it: the option is
ignored and a second handle on a file throws `InvalidStateError`, whichever worker asks
(`runtime/harness/webkit/probe.ts`, Playwright's Linux WebKit 2370). Firefox is expected to
be the same; not run.

What the harness showed first: the kernel already copes. A thread whose host has no handle
gets `EAGAIN` from `host_image_read` and asks kerneld for the chunk (the path the page
always used). In WebKit kerneld mounts first and gets the handle, every process worker
fails to open one and falls back. The only failures that came from this were two guest
scripts comparing a child's stderr, where the "no handle" warning had been printed.

Options for making that deliberate:

1. **Only kerneld holds the handle; everyone else faults through it.** No new mechanism.
   Cost measured in the harness, 164 files / 25.8 MB / 202 cold chunks read by one process:
   52.9 ms in WebKit through kerneld, against 42.8 ms in Chrome with the process's own
   handle; about 0.05 ms per 128 KiB chunk, once per chunk for all processes. A chunk read
   depends on kerneld's event loop being free.
2. **`getFile()` and `FileReaderSync` in each worker.** Needs no handle at all and works
   while another worker holds one (probed: a fresh `getFile()` also sees bytes appended
   since). 0.6 ms per 64 KiB read, an allocation and a copy per read: ten times option 1,
   and a second read path through the kernel's host import for every thread.
3. **One handle, passed around or re-opened per read.** A handle cannot be transferred, and
   open/close per read is two round trips to the storage process per chunk.
4. **Bodies in shared memory up front.** The image is 239 MB.

Picked: 1, by feature detection and without touching Chrome's path.

- Detection costs nothing: the options bag is given a getter for `mode`. An engine that
  knows the option reads it (Chrome: read, second handle allowed); one that does not never
  calls the getter (WebKit: not read, second handle refused). Checked in both.
- kerneld keeps its handle either way. Any other worker that finds the option unread closes
  what it got at once and does not try again; its reads go to kerneld. Because a process
  worker may open the file ahead of the mount (the `images` hint), kerneld retries for up
  to a second when the file is held; that transient open is the one race left.
- **The first download is not mounted while it arrives where handles are exclusive.** The
  writer holds the only handle, so `usable` is announced once the file is complete, closed
  and renamed. The first-ever open there waits for the whole image (32 MB compressed for
  the example) before anything starts. Option 2 would lift this for the arriving file
  alone (kerneld reading through `getFile()` until the download ends); not built, because
  it has to be driven by measurements on a real Safari, not on this port.
- Not addressed: a second tab. It cannot get a handle while the first tab's kerneld holds
  the image, so its mount fails with the handle error after the one-second retry instead
  of reaching the "already open in another tab" message (the Web Lock is only taken when
  the overlay persists, and it is asked for before the mount, so the persisted case still
  reports correctly; the harness page, which does not persist, does not).

## 2026-10-11: no `Atomics.waitAsync` with a timeout; the guest's User-Agent is not sent

Two smaller changes forced by the first runs in WebKit
(`docs/experiments/2026-10-11-webkit.md`).

- **A non-blocking wait with a time limit is the un-timed `waitAsync` raced against
  `setTimeout`** (`runtime/src/kernel/wait.ts`), on every engine. The design has kerneld and
  the page sleep on a wake word with `Atomics.waitAsync`; three of those waits carried a
  timeout. In WebKit (Playwright's Linux build 2370) a worker waiting with a timeout was
  woken neither by `notify` nor by the timeout until something else ran on its event loop:
  31 of 40 notifies unanswered after 3 s, against 0 of 1,500 for the un-timed form
  (`runtime/harness/webkit/probe-waitasync.ts`). kerneld then sat on spawn requests for
  seconds. Not done by engine detection: the fault is intermittent, so it cannot be tested
  for at start-up, and the replacement costs Chrome one timer per kerneld wake-up (A/B in
  Chrome, n = 12 each, load 9–18: whole open 1,936 ms new against 2,070 ms base, inside
  the spread).
- **A request the browser sends for a guest does not carry the guest's `user-agent`**
  (`runtime/src/net/fetch.ts`). Chromium never sent it. WebKit does, and the header makes
  the request need a CORS preflight, which `models.opencode.ai` answers with 405. The
  host's proxy already sets the provider's User-Agent on model requests itself.

## 2026-10-11: the kernel heap grows 64 MiB at a time

`crates/bat-kernel/src/alloc.rs`. The design grew the shared memory on demand in 1 MiB
steps (to bound how often every thread's views go stale). In WebKit every grow of a shared
memory can crash the tab: JavaScriptCore walks all instances attached to the memory and
reads through one that a terminated worker is still destroying
(`docs/experiments/2026-10-11-webkit.md`, 9.1; `runtime/harness/webkit/grow-crash/` shows
it without the runtime, 4 of 4 runs). Process workers are terminated constantly, and the
harness grew the memory about 80 times a run: 2 web-process crashes in 4 runs. With 64 MiB
steps: 2 grows for the same scripts, 82 runs without a crash.

- On every engine, not by detection: a race cannot be tested for at start-up, and the
  step costs address space only (a 64 MiB grow: under 2 ms in WebKit, under 4 ms in
  Chrome; web-process size unchanged).
- Rejected: reserving the image's size at mount (commits the perf work to a shape, and
  the overlay still grows); holding grows back while a worker is being destroyed (there
  is no signal for the end of a worker's teardown).
- This is a reduction. A grow that meets a teardown still crashes.

## 2026-10-11: the tunnel also speaks Wisp, and the public build uses a public Wisp server

The public page depended on one deployment of ours (the relay on Deno Deploy). The tunnel only
needs somebody to carry TCP for a tab, and there is a public protocol for that with public
servers.

- **A second wire format in the same client, not a second client.** `tunnelRequest` takes
  `protocol: 'wisp'` (`BAT_FETCH_TUNNEL_PROTOCOL=wisp` in a process's environment): Wisp v1
  framing around the same queues, TLS engine and HTTP parser. The default and every path of
  the relay's own format are unchanged.
- **One stream per WebSocket**, as with the relay, although Wisp multiplexes: a request's
  failure, abort and cleanup stay those of one socket. Sharing a socket would save a WebSocket
  handshake per request and is not done.
- **No reply to a v2 server's INFO.** A CONNECT as the first packet keeps such a server on v1,
  which is all that is used.
- **What Wisp lacks**: an answer to CONNECT (TLS starts at once and a refusal arrives as a
  CLOSE with a reason), and flow control towards the page (received bytes are held in the tab
  until the body's reader takes them; the relay's format stops the far end instead).
- **The public build's default is `wss://wisp.mercurywork.shop/`**, which is not ours and
  publishes no terms. The build names no relay of ours any more: Deno Deploy suspended the
  account that ran it (403 `USER_SUSPENDED`) the same day, so `TUNNEL_URL` has no default.
- **Measured on 2026-10-11, Chrome, the public build on `http://127.0.0.1:4391`** (so that
  server takes a WebSocket from an origin it has never seen): a prompt answered by
  `ling-3.1-flash-free`, streamed, `HTTP 200 (tunnel via wisp.mercurywork.shop, TLSv1_3
  TLS13_AES_256_GCM_SHA384)`.
- **Seen: four HTTP 429 from Zen before that 200**, retried by OpenCode without anything on
  the page. A second run on the plain TODO app ("change the page heading", done, the frame
  showed the new heading within 100 s): 4 answers of 200 and 12 of 429. Not explained. The server's address is shared by everybody who uses it, which
  would do it if Zen's free tier counts per address; there was no working relay of ours left
  to compare with.

## 2026-10-11: a guest's answers reach the page with `Vary: *`

- **Why**: WebKit takes a module that an earlier document preloaded
  (`<link rel="modulepreload">`) from its memory cache without a request, whatever
  `Cache-Control` said. A preview opened again in the same tab process ran the previous dev
  server's entry modules, and the new server, never asked for them, sent no hot update: 17 of
  83 runs of the React Router TODO scenario in Playwright's WebKit, 0 of 40 after
  (`docs/experiments/2026-10-11-webkit.md`, section 10).
- **What**: the preview service worker sets `Vary: *` on every guest response without
  `max-age`, `s-maxage` or `immutable`. Responses that state a lifetime are untouched.
- **Rejected**: `Cache-Control: no-store` (measured: no effect on this reuse); removing
  preload links from the guest's HTML (the app can add them again from script, and it changes
  the app's document); a per-start prefix in the preview URL (changes Vite's `base`, which
  the prepared optimizer cache is keyed on).
- **Cost**: no memory-cache answer for those responses in any browser. Not measured.
- `runtime/harness/webkit/preload-reuse/run.ts` shows the browser behaviour alone and fails
  when it is gone, which is when to take the header out.

## 2026-10-11: an ES module of a program script is started when the script is loaded

Measured in WebKit (Playwright's Linux build 2370; `docs/experiments/2026-10-11-webkit-perf.md`):
the first call of OpenCode's module function, one `async function*` of 27 MB, takes 21–26 ms
right after the program script is loaded and 260–500 ms once anything was allocated in
between; in a start-up it was 440–540 ms, against about 10 ms in Chrome. JavaScriptCore
checks a function's syntax when the script is loaded and parses it again when it is first
called, skipping nested functions by offsets remembered from the first pass. A garbage
collection drops those offsets, and the whole function is lexed a second time. A generator
is two functions to that engine: the call makes the generator object, the body is compiled
at the first `next()`. So calling the function early is not enough (tried: the 440 ms moved
from the call to the first `next()`), and the first `next()` runs the module's prelude,
which needs the module's context.

Change to the program-script convention (`docs/design/image-format.md`):

- The header of an ES module in a program script is
  `function*(__bat){"use strict";if(__bat===void 0)__bat=yield;` (or `async function*`), and
  it is registered with `__bat_define(path, fn, 1)`. Called with a context, the function
  behaves as before. Called with none, it stops before its prelude and takes the context
  from the `next(context)` that resumes it.
- The loader, for a function registered with the third argument while a program script is
  being loaded ahead of the launch (`import()` in a spare worker), calls it with no context
  and runs it to that first `yield` at once: the body is compiled while the parser's offsets
  are still there. Linking the module later resumes that generator with the context.
- Only when the generator has come to rest. An `async function*` awaits at a `yield`, so a
  generator started in the same turn as the link (a program loaded with `importScripts` on
  first use) would run its prelude a microtask late, and linking reads the dependencies the
  prelude names synchronously. Such a module is called the old way, with its context.
- CommonJS modules are plain functions and cannot be started ahead of their turn; nothing
  changes for them. Modules compiled by the loader from the image keep the old header.
- Not by engine detection: where the parse is not repeated (V8) the function's entry is run
  at load instead of at link, the same work a moment earlier. A/B in Chrome in the report.

What this does not cover: the same second parse is paid by every function nested in the
program the first time it is called after a collection (OpenCode's bundle has about 2,400
module wrappers one level down). That is the larger part of what is left of the gap in
OpenCode's start between the two engines, and nothing the page can do keeps the offsets.

## 2026-10-11: where handles are exclusive, the arriving image is read through file snapshots

Follows "where sync access handles are exclusive, only kerneld holds the image" above, which
left the first-ever open in WebKit waiting for the whole image and named this as the way out.
Built now; numbers in `docs/experiments/2026-10-11-webkit-perf.md`.

Probed first (`runtime/harness/webkit/probe-getfile.ts`, Playwright's Linux WebKit 2370), while
another worker holds the file's sync access handle and appends to it:

- `getFile()` works and its File has everything written so far, flushed or not.
- A File keeps the size it was taken with, and reading it fails with `NotFoundError` once the
  file has been written to again (not at once: the check seems to be on a modification time
  of coarse grain). So a snapshot serves one read, taken immediately before it, and a failed
  read takes another.
- 0.3 ms per `getFile()`, 1.6 ms per `FileReaderSync` read of 128 KiB.

Design:

- The download (`host/image.ts`) announces the partial file as soon as its head is written
  where handles are shared, as before, **or** where they are not and `FileReaderSync` exists;
  then with `usable.snapshot = { headBytes }`. Chrome reads the option, has shared handles and
  takes the path it had.
- kerneld mounts such an image without a handle. The kernel's read is synchronous and a
  snapshot is not, so kerneld keeps a stash: the head is read into it before the mount; a
  fault for a chunk reads 1 MiB from the chunk on (the image is laid out in start-up order,
  and a read costs about the same up to that size), puts it in the stash and has the kernel
  load the chunks it covers, which finds them there. A range that has not arrived is a short
  read, which the kernel already answers for an arriving image by having the reader wait for
  `bat_image_progress` and ask again. No timer and no polling were added.
- When the download ends, the host calls kerneld's `imageArrived(id)` before
  `bat_image_arriving(id, 0)`: kerneld takes the handle the writer has just closed and drops
  the snapshot path. As in Chrome, the file keeps its `.partial` name for the session and is
  renamed by the next open.
- The pause of the download after the start-up's bytes now applies there too, as it does
  wherever the image is used while it arrives.

Not done: other workers reading through snapshots themselves (option 2 of the earlier entry
for every thread). All reads of the arriving image go through kerneld, 1.6 ms a read
instead of 0.05 ms; for the seconds a download lasts, that is the cheaper change.

## 2026-10-11: the kernel memory has a fixed size (256 MiB by default) and is never grown

Follows `docs/experiments/2026-10-11-memory-footprint.md` (item 1 of its list) and the
grow crash of `docs/experiments/2026-10-11-webkit.md` section 9 (branch `webkit-support`).
Numbers and what was run: `docs/experiments/2026-10-11-memory-reduction.md`.

The problem has two halves. The memory was created with `initial: 64, maximum: 65536`
pages. (1) WebKit reserves a shared memory's declared maximum as address space when it is
made, out of a cage of 16 GB on current iOS and 2 GB before spring 2024: 4 GiB is a
quarter of the first and does not fit the second. (2) The kernel's allocator grew the
memory 1 MiB at a time, and in JavaScriptCore every grow of a shared memory can crash the
web process when it meets a worker that is being torn down (`7f8bf72` on `webkit-support`
made the step 64 MiB, which makes it rare).

Measured before deciding:

- Use: 81.7 MB of kernel memory committed after six turns in the TODO example, 83.1 MB in
  the terminal example, 57–71 MB of it touched (Chrome; the footprint report). Most of the
  growth is the image chunk cache, which gets a cap in the next entry.
- `runtime/harness/webkit/probe-sharedmem.ts`, Playwright's Linux WebKit 2370, the web
  process read from `/proc`: a shared memory made with `initial = maximum = 4096` pages
  (256 MiB) took 0.06 ms to make and added 0.4 MiB of resident memory; writing 32 MiB of
  it added 32 MiB. A grow by 64 MiB of a memory with room under its maximum: 0.02 ms and
  0.2 MiB. So in this port committed pages cost nothing until they are written, as in
  Chrome (81.7 MB committed, 57.5 resident there). The process's address space did not
  move for any of it, 4 GiB maximum included: this port's cage is reserved whole at start
  (72 GB of address space with an empty page), so the reservation limit of iOS cannot be
  seen here.

Options:

1. **Lower the maximum, keep growing** (`initial: 64, maximum: N`). Solves (1). Leaves
   (2): fewer grows with a 64 MiB step, never none, unless the first step covers
   everything, which is option 2 by another name.
2. **Fixed size: `initial = maximum = N`, never grown.** Solves (1) and removes (2)
   instead of reducing it: no `memory.grow` of the shared memory is ever executed. No
   typed-array view of it ever goes stale either. Costs: N is committed from the start
   (not resident, by the measurements above, in both engines available here; on iOS that
   rests on the system charging pages when they are dirtied, which is how it accounts
   memory but was not run), and N is a hard ceiling that has to be chosen.
3. **Pre-grow once at boot before any process worker exists**, with a larger maximum left
   for emergencies. The same as 2 until the emergency, at which point a grow happens
   exactly when many workers are alive: the case that crashes. The larger maximum also
   brings (1) back in proportion.
4. **Keep 4 GiB and make only the step large** (`7f8bf72` alone). Does nothing for (1).

Decision: **2**, with N = **4,096 pages, 256 MiB**, by default.

- Why 256 MiB: about three times the most either example committed with an unbounded
  image cache, and five times what they need once the cache is capped (figures in the
  report). It is an eighth of the old 2 GB cage, where 4 GiB could not be reserved at all
  and WebKit's bug 255103 reports 2 GiB failing; whether 256 MiB can be had there was not
  run. 512 MiB would be a quarter of that cage, the most one buffer may take under the
  rule in today's source.
- The embedder sets it: `kernelMemory: { pages, maximumPages? }` on the runtime's boot
  options. `maximumPages` larger than `pages` gives a growable memory again (options 1
  and 3) for an engine without the grow fault; the allocator then grows in 64 MiB steps,
  falling back to what is needed near the ceiling.
- The allocator (`crates/bat-kernel/src/alloc.rs`) hands dlmalloc address space from a
  break that starts at `__heap_base`, inside the memory as created; it used to start at
  the first grown page, so the rest of the initial 4 MiB was never used. It calls
  `memory.grow` only when the break passes the memory's size, which a fixed memory never
  allows.
- wasi-libc's own `malloc` is linked into the module and gets its memory from `sbrk`,
  that is `memory.grow`. In a memory that cannot grow it would return null, so the crate
  defines the C allocation functions over the kernel heap and libc's are not linked.
- **Exhaustion is an error, not a trap.** What can be large asks first: file contents
  (write, truncate, copy-up of an image file), image chunks, pipe and socket buffers go
  through `mem::reserve`, which refuses while less than a reserve (a sixteenth of the
  memory, at most 16 MiB) would be left, and the call fails with `ENOSPC` (files) or
  `ENOMEM`. Before a chunk is refused the image cache is emptied. The first refusal, and
  then every 64th, is logged as an error naming the size, the use and the option. The
  reserve is what the many small infallible allocations (nodes, paths, records) live on
  after that. If the heap is exhausted all the same, the allocator logs the same line
  before Rust's allocation-failure abort; that is still a trap, and with a kernel lock
  possibly held it is fatal for the runtime, as it was.
- What else assumed 4 GiB: the module declares its imported memory with a 4 GiB maximum
  (`--max-memory` in `build.rs`). That is an upper bound on what it accepts, so a smaller
  memory links; it stays, so that an embedder can still ask for more. Nothing maps an
  image into the memory: only an image's head (2.5 MB for the TODO example's 240 MB
  image) and the chunk cache are held, and offsets into the file are 64-bit. No
  JavaScript grows the memory or reads its maximum.

Merging with `webkit-support`: `7f8bf72` changes the same function in `alloc.rs`. This
entry's version contains its step and its fallback; take this side.

## 2026-10-11: the image chunk cache has a limit (32 MiB) and drops chunks by a clock

Item 4 of the footprint report: chunks of the dependency image read into the kernel memory
were never dropped, so the cache was bounded only by the image (240 MB), and it was most
of what made the kernel memory grow in a session. With a kernel memory of fixed size
(previous entry) an unbounded cache is also what would fill it.

Measured before choosing (`bench/memory/read-image.cjs` through the harness, a guest reading
98 MB of image files three times, 892 chunks; n = 2 per cell, load 3; ms per pass):

| limit | Chrome: first pass | later passes | WebKit: first pass | later passes | chunks read in all |
| --- | --- | --- | --- | --- | --- |
| none | 150, 154 | 80–104 | 167, 176 | 70–85 | 892 |
| 64 MiB | 129, 144 | 100–112 | 109, 120 | 67–125 | 2,670 |
| 32 MiB | 115, 123 | 92–106 | 106, 141 | 116–135 | 2,697 |
| 16 MiB | 108, 119 | 87–106 | 82, 92 | 61–126 (one 361) | 2,718 |
| 8 MiB | 105, 111 | 98–108 | 83, 101 | 86–120 | 2,752 |

Reading a dropped chunk again costs about 0.02 ms in Chrome (the reader's own file handle)
and about 0.05 ms in WebKit (a request to kerneld, which holds the only handle), against
0.1 ms to copy a cached chunk out to the guest and decode it. A first pass is faster with
a limit than without one: the cache reuses the same pages instead of touching new ones.

Options: no limit; a limit with least-recently-used order (a list to maintain under a lock
on every read); a limit with a second-chance clock (one bit per chunk set on a read, a hand
that sweeps only when something must go); no cache at all (every read through the host:
for threads without a handle that is a round trip per read, not per chunk).

Decision: **a clock, limit 32 MiB over all images, configurable** (`imageCacheBytes` on the
boot options, `bat_image_cache_limit`). 32 MiB holds what either example reads to start
(figures in the report) with the cost of being wrong shown above to be small, so the
number is not delicate; an embedder short of memory can set 8 MiB at the price in the last
row. Reads take no lock: a reader pins the chunk for its copy with a counter beside the
slot, inside the kill gate so a terminated worker leaves no pin; the thread about to load
a chunk over the limit runs the sweep. A pin that never goes away (not expected) costs
that one chunk, never a wait.

Correction to the previous entry: pipe and socket buffers do not go through
`mem::reserve`. They are of fixed size (at most 1 MiB), allocated when the pipe is made,
and count as small allocations. What asks first is file contents (write, truncate,
copy-up), image chunks and `bat_alloc` above 64 KiB. Also learned by filling a 64 MiB
memory (`bench/memory/fill-memory.cjs`, both browsers: `ENOSPC` after 20–24 MiB, the
runtime carried on): a file is one contiguous buffer that grows by half, so growing it
needs the old and the new buffer at once and the largest single file is roughly a third of
the free memory. That was so before; a fixed memory makes it a limit one can reach.

## 2026-10-11: the tunnel also speaks Wisp, and the public build uses a public Wisp server

The public page depended on one deployment of ours (the relay on Deno Deploy). The tunnel only
needs somebody to carry TCP for a tab, and there is a public protocol for that with public
servers.

- **A second wire format in the same client, not a second client.** `tunnelRequest` takes
  `protocol: 'wisp'` (`BAT_FETCH_TUNNEL_PROTOCOL=wisp` in a process's environment): Wisp v1
  framing around the same queues, TLS engine and HTTP parser. The default and every path of
  the relay's own format are unchanged.
- **One stream per WebSocket**, as with the relay, although Wisp multiplexes: a request's
  failure, abort and cleanup stay those of one socket. Sharing a socket would save a WebSocket
  handshake per request and is not done.
- **No reply to a v2 server's INFO.** A CONNECT as the first packet keeps such a server on v1,
  which is all that is used.
- **What Wisp lacks**: an answer to CONNECT (TLS starts at once and a refusal arrives as a
  CLOSE with a reason), and flow control towards the page (received bytes are held in the tab
  until the body's reader takes them; the relay's format stops the far end instead).
- **The public build's default is `wss://wisp.mercurywork.shop/`**, which is not ours and
  publishes no terms. The build names no relay of ours any more: Deno Deploy suspended the
  account that ran it (403 `USER_SUSPENDED`) the same day, so `TUNNEL_URL` has no default.
- **Measured on 2026-10-11, Chrome, the public build on `http://127.0.0.1:4391`** (so that
  server takes a WebSocket from an origin it has never seen): a prompt answered by
  `ling-3.1-flash-free`, streamed, `HTTP 200 (tunnel via wisp.mercurywork.shop, TLSv1_3
  TLS13_AES_256_GCM_SHA384)`.
- **Seen: four HTTP 429 from Zen before that 200**, retried by OpenCode without anything on
  the page. A second run on the plain TODO app ("change the page heading", done, the frame
  showed the new heading within 100 s): 4 answers of 200 and 12 of 429. Not explained. The server's address is shared by everybody who uses it, which
  would do it if Zen's free tier counts per address; there was no working relay of ours left
  to compare with.
