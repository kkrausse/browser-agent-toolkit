# Rust rewrite: design (2026-10-09)

Branch `rewrite/rust`, worktree `/home/kkrausse/devfs/repos/kkrausse/bat-rust`. The previous
toolkit and its Vivari runtime are reference only; they stay readable in the main checkout
`/home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit` (runtime source in its
`vendor/vivari`). Nothing here depends on them at build or run time.

## Goal

The TODO example's "Open editor" (Vite 7 + React Router dev preview, real OpenCode 2.0.3
server, chat) starts about as fast as the same programs start natively. Same demo as the
README GIF: add todos, open editor, ask for a dark theme and a todos-left counter, preview
hot-reloads.

Budgets on diesel2, reopen (image already in the browser), to be measured, not assumed:

| Stage | Old runtime | Budget |
| --- | --- | --- |
| Runtime boot + mount dependency tree | ~2.0 s | < 100 ms |
| Vite spawn → listening | 1.6 s | < 500 ms |
| Vite spawn → app visible in preview | 3.9 s | < 1.2 s |
| OpenCode spawn → attached | 3.2 s | < 1.0 s |
| Whole "Open editor" | 7.2 s | < 1.5 s |

## Why the old design was slow, and the decision that removes each cost

| Old cost | Cause | New design |
| --- | --- | --- |
| 1.5–1.9 s laying 10,534 files into a RAM VFS on every open; 0.5 s OPFS restore | tree lives only in kernel memory | Dependency tree is one immutable **image file in OPFS**, mounted by reading its index; file bodies are read on demand. Open cost is independent of tree size. |
| 20,000–70,000 kernel round trips at 24–60 µs; one kernel thread serialises every process | fs lives in another worker behind SAB + postMessage | **Library kernel in shared Wasm memory**: one Rust Wasm module instantiated in every worker over one shared `WebAssembly.Memory`. A syscall is a function call. No kernel thread. |
| 3.6 s (later 0.2 s) module resolution in JS | resolver in JS over sync fs | Resolver in Rust inside the kernel, plus resolution results precomputed into the image where cheap. |
| ESM→CJS text rewrite at load, failed first compile for TLA, live-binding retry | loader discovers module shape at run time | **Modules are compiled at prepare time** by a native Rust tool (oxc): every dependency file is stored in the image already in the loader's function format with its facts (ESM/CJS, TLA, export names). Workspace files use the same transform compiled to Wasm. |
| OpenCode bundle: 0.5 s read, 0.36 s compile, 0.7 s evaluate per start | 27.7 MB string copied through the VFS and `eval`ed | Prepare emits the bundle as a real script at an immutable URL; the process loads it with `importScripts`, so the browser streams, compiles off-thread and keeps a **V8 code cache**. Evaluation itself is the floor. |
| 0.14–0.24 s worker boot evaluating a 4.1 MB runtime per process | monolithic runtime bundle | Small runtime core, builtins loaded lazily, **pre-warmed spare process worker**. |
| esbuild-wasm (Go) 0.35 s first call, slow transforms; 15 MB lightningcss-wasm; threaded N-API oxide | native tools swapped for generic wasm builds | Rust tools compiled to Wasm and called in-process: `esbuild` shim over oxc for transforms; dependency optimizer output shipped in the image; oxide scanner and ripgrep built against the kernel fs. Generic wasm packages only as a first-pass fallback. |
| SQLite: whole-image export per commit, JSON-file RPC | engine lived in the kernel worker | sqlite-wasm in the guest process with a page-level VFS over kernel file descriptors. |

Structural floor that stays: JS runs on the visitor's CPU in a worker; V8 evaluates the
OpenCode bundle (~0.7 s on diesel2 before code caching; measure after).

## What is Rust and what is not

Rust: kernel (VFS, image, overlay, pipes, sockets, HTTP/WebSocket codec, process table,
resolver, watch), image format, prepare CLI, module transform, tool backends.

TypeScript, necessarily: the objects a guest program touches (`fs`, `http`, `process`, … are
JS APIs; they are thin over kernel calls), worker bootstrap, service worker, the React chat
UI, and the server handler a Bun/TS app mounts. No TS classes unless the Node API being
implemented is a class.

## Layout

```
crates/
  bat-image/     image format: reader (no_std-friendly) and writer
  bat-kernel/    the library kernel, target wasm32 with shared memory
  bat-modules/   module transform + CJS/ESM facts (oxc); native lib and Wasm build
  bat-prepare/   native CLI: dependency tree → image, precompiled modules, program scripts
  bat-tools/     Wasm tool backends (esbuild-shim transform, oxide scanner, rg, …)
runtime/         TS: kernel bindings, process worker, loader, Node builtins, host SDK, service worker
packages/toolkit/  the one npm package: prepare, server, browser, react, vite
examples/todo-app/
bench/           harness pages + scripts that produce the numbers in docs/experiments/
```

## Kernel

- One Wasm module, one shared memory (max 4 GiB, grown on demand). Every worker (and the
  page) instantiates the module over that memory with its own stack and TLS. All kernel
  state is in shared memory behind locks; there is no message protocol and no data window.
- **Blocking**: a worker blocks with `memory.atomic.wait` inside the kernel (pipe read,
  `waitpid`, `spawnSync`, sync sqlite). The page never blocks: it uses non-blocking calls and
  `Atomics.waitAsync` on a wake word. Each process has an event word the kernel bumps when
  something it waits on is ready (socket data, child exit, watch event); the process event
  loop awaits it with `Atomics.waitAsync`, so JS timers and promises keep running.
- **Supervisor worker** (`kerneld`), the only active agent besides processes: creates
  process Workers on spawn requests, keeps the warm spare, drains the overlay journal to
  OPFS, performs egress that needs the page origin. It never services fs calls.
- **VFS**: mount table of (a) image mounts, read-only; (b) one overlay, read-write, holding
  everything written. Lookup is overlay-then-image with whiteouts. Symlinks, modes, mtimes,
  fds, `readdir` with types in one call, recursive watch.
  - Image bodies are read on demand through a host import backed by a read-only
    `FileSystemSyncAccessHandle` per worker, into a shared page cache, so a body is read
    once for all processes.
  - Overlay persistence: append-only journal + periodic snapshot in OPFS, written by
    `kerneld`; `flush()` awaits the journal. A root can be marked non-persistent (caches).
  - One writer per origin via a Web Lock; a second tab gets a clear error.
- **Sockets**: `listen(port)`, `connect(port)` give a pair of byte rings in shared memory,
  usable blocking or event-driven. HTTP/1.1 parsing/serialisation and WebSocket framing are
  kernel functions used by both the guest `http` module and the host side, so no JS parser.
- **Processes**: pid table, argv/env/cwd, stdio pipes, exit status, signals as a pending
  word checked by the loop, `spawn`/`spawnSync`. Executable formats: a JS entry (node), or
  a WASI `.wasm` (rg and other compiled tools) run in a process worker against the kernel.
- **Resolver**: Node resolution (exports/imports conditions, self-reference, extensions,
  realpath) in Rust; cache invalidated by an overlay generation counter only (image
  entries never change).

## Image format (`bat-image`)

One file: header, index, bodies. Requirements:

- Index is a sorted, binary-searchable table (path → kind, mode, body offset/len, symlink
  target, and an optional **compiled** body offset/len + facts word). Mount = map the index;
  no per-file work.
- Bodies uncompressed and aligned so a body is one positioned read. Transport compression is
  the HTTP layer's job (brotli/zstd of the whole file); first-ever open streams it into OPFS.
- Content-addressed file name; identity checked once at download, never per file.
- Optional sections: precomputed resolution table; program scripts list.

## Modules

- **Loader format**: every module is a function `(exports, require, module, __filename,
  __dirname, import.meta object, dynamic import)`; ESM is transformed with real AST work
  (oxc), exports are live getters, cycles work without retries, modules containing TLA are
  marked async in their facts and evaluated as async functions.
- Dependencies are transformed at prepare time; the image stores the result beside the
  original (original still served to tools that read source). Workspace files are
  transformed on load by the same crate built to Wasm, cached by content hash in a
  non-persistent overlay root.
- **Program scripts**: prepare can emit a set of compiled modules as one classic script at a
  content-addressed URL (`define(path, fn)` calls). Used for the OpenCode bundle and for
  Vite's startup module set, loaded with `importScripts` for off-thread compile and code
  cache. This is an optimisation layered on the loader; the loader must work without it.
- TypeScript/JSX stripping: oxc, same crate.

## Node surface

Only what the two guests use (inventory in the appendix), real where used:

- Vendored from Node's own `lib/` (MIT, notice kept) for pure-JS modules: `events`,
  `stream*`, `buffer`, `util`, `path`, `url`, `querystring`, `string_decoder`, `assert`,
  `readline`, `timers`.
- Written here over kernel calls: `fs`, `fs/promises`, `net`, `http`, `https` (client via
  `fetch`), `child_process`, `worker_threads`, `module`, `process`, `os`, `tty`, `crypto`
  (WebCrypto + Rust where sync is needed), `zlib` (Rust), `sqlite` (`DatabaseSync`), `vm`,
  `async_hooks` (`AsyncLocalStorage`), `perf_hooks`, `diagnostics_channel`, `dns`, `wasi`.
- No Bun API: the OpenCode artifact is a Node-target bundle and uses none.
- Guest global `fetch`: loopback goes to kernel sockets; `host.internal` maps to the page
  origin; everything else is the browser's fetch.

## Host side

- **Preview**: service worker intercepts `/preview/<port>/…` and streams to the guest
  listener through `kerneld` (a `MessagePort` per request, streamed both ways).
  WebSocket and EventSource in the preview frame are shimmed to the same path. `hostPaths`
  prefixes go to the real server.
- **Endpoint fetch** (chat UI → OpenCode): the page writes the request to a kernel socket
  directly and reads the streamed response; SSE works without a side channel.

## Toolkit API (one package, five entry points)

```ts
// host, at build time
prepare({ appRoot, outDir, source: string[], preview?: Launch, files?: Record<string,string> })

// host, at serve time
createEditorHandler({ preparedDir, base?, providers, modelCatalog?, onEvent? })
  → { matches(req), fetch(req), headers }      // app does its own authorization around it

// browser
openEditor({ base?: '/editor/', onEvent?, signal? }) → Editor
Editor: {
  fs, preview: Service, agent: Service, chat: ChatController,
  restartPreview(), restartAgent(), flush(), close(),
  sessions: { export(), import(bundle) },
  subscribe(listener), snapshot()          // steps, status, timings
}
Service: { endpoint: { url, fetch }, ready: Promise<void>, stop() }

// react
<EditorPreview editor hostPaths isReady /> <ChatView controller … /> useEditor()

// vite
browserEditor()   // guest base path, cache dir, null editing module; host private chunks
```

Dropped from the old surface: tool descriptors, two delivery formats, three editor shells,
the stop/close matrix, retained-switch machinery, trace/query switches, "candidate" naming.
Kept constraints: header envelope for model requests, `host.internal` carries the page's
scheme and port, source install preserves existing files, second-tab message, COOP/COEP
`same-origin`/`require-corp` and `Service-Worker-Allowed`.

## Milestones

| | Done when |
| --- | --- |
| M0 | Kernel Wasm shared by ≥3 workers in Chrome; image of the TODO guest tree mounts from OPFS; `bench/` reports mount time and 40k mixed stat/read calls from two workers at once. |
| M1 | `node` process runs CJS+ESM+TS scripts with fs, child_process and timers; loader uses precompiled modules. |
| M2 | Vite dev server for the TODO app listens; preview iframe renders the app; HMR over the shimmed WebSocket works. |
| M3 | OpenCode 2.0.3 server answers `/api/health`, activates plugins, streams events; grep and `runJavascript` tools work. |
| M4 | Toolkit package + TODO example end to end; the README scenario passes in Chrome. |
| M5 | Budget table measured (n ≥ 5, fresh and reopen), written to `docs/experiments/`; README updated with a new recording. |

## Working rules for agents on this branch

- Work only in `/home/kkrausse/devfs/repos/kkrausse/bat-rust`, branch `rewrite/rust`. Never
  commit to or push `main`; do not push at all. Do not touch the main checkout or the
  user's running services (ports 3000, 3001, 5173 and their tmux sessions).
- Several agents share this worktree. Stay inside the paths you were given. Commit often
  with `git add -- <your paths> && git commit -m "…" -- <your paths>` (retry if
  `index.lock` is held). Descriptive commit messages; end them with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Bun + TypeScript for JS; functions and interfaces, not classes, unless a Node API is one.
- No unit-test suites for their own sake. Verify by running the real thing (harness pages,
  real guest programs); add a test only for a concrete failure you hit or an external
  format you must match.
- Browser checks go through the `browser-control` CLI (never its MCP server) with your own
  named session and your own port, so origins and OPFS do not collide. Chrome is already
  running headed on Xvfb `:99`. Pages need COOP/COEP headers.
- Code lifted from Node's `lib/` or adapted from Vivari keeps its MIT notice
  (`third_party/NOTICES.md`).
- If a design decision here turns out wrong, change it, and record the change and the
  measurement that forced it in `docs/design/decisions.md` (append-only, short entries).

## Appendix: what the guests need

OpenCode 2.0.3 artifact: one ESM file `server.js` (27.7 MB, one top-level await, Node
target, no `Bun.*`), three tree-sitter `.wasm`. Imports: path, fs, fs/promises, url, util,
stream(+promises,web), os, crypto, http, https, module, events, buffer, string_decoder,
sqlite (`DatabaseSync`, WAL pragma), child_process (`spawn` of `rg`), zlib, net, tls,
worker_threads (`MessageChannel` only), tty, timers/promises, perf_hooks, vm, readline,
querystring, dns, diagnostics_channel, async_hooks (`AsyncLocalStorage`), assert, sea,
inspector, http2 (required, unused). Serves Effect `HttpApi` on `node:http` port 4096,
Basic auth, one SSE stream. Launch env and config: see the old
`opencode-chat/src/opencode-launch.ts` and `browser.ts`. Tools used in the demo: read,
edit, grep, glob (ripgrep on PATH) and the `runJavascript` plugin (spawns `node` on a temp
`.mjs`).

Vite guest: vite 7.3.6, rollup 4.63.1, esbuild 0.28.2, lightningcss 1.32.0,
@react-router/dev 7.18.3, @tailwindcss/vite + oxide 4.3.3, @babel/core, chokidar 4, jiti.
Launch: `vite --configLoader native --host 0.0.0.0 --port 5173 --strictPort`, cwd
`/workspace`. Loads ~700 modules before the first response; 21 esbuild transforms; Tailwind
and Babel on first render. Guest tree today: 10,533 files, 235 MB, of which ~70 MB is never
used by the dev server and the OpenCode bundle appears twice; prepare should prune.
