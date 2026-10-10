# opencode TUI in the browser

Target: opencode v2.0.26 (`anomalyco/opencode`, tag `v2.0.26`, commit `9b4ec571`), which pins
OpenTUI 0.5.17 (`anomalyco/opentui`, tag `v0.5.17`, commit `6f0efd33`).

**Result: it runs.** The real opencode TUI source, unmodified, executes in a browser Web Worker,
renders through OpenTUI's Zig core compiled to wasm32-wasi into ghostty-web via the wasm-term
kernel pty, and talks to a remote `opencode serve` with `fetch` + SSE. No server-side PTY.

Each claim below is marked **[ran]** (verified by running it here) or **[read]** (from source).
Paths are relative to `wasm-term/vendor/opencode` (`opencode/…`) and `wasm-term/vendor/opentui`
(`opentui/…`). The full API inventory with every use site is in
[`notes/api-survey.md`](notes/api-survey.md) (a source survey, all **[read]**).

## Run it

```sh
# once: checkouts, toolchain, dependencies (all under wasm-term/vendor, gitignored)
cd wasm-term/vendor
git clone --depth 1 --branch v2.0.26 https://github.com/anomalyco/opencode.git opencode
git clone --depth 1 --branch v0.5.17 https://github.com/anomalyco/opentui.git opentui
mkdir -p tools && curl -fsSL https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz | tar -xJ -C tools
(cd opentui && bun install --ignore-scripts)     # 545 packages
(cd opencode && bun install --ignore-scripts)    # 2405 packages, 3.2 GB

cd ../ports/opencode
bun run build:native      # dist/opentui.wasm (about 90 s)
bun run build:tui         # dist/opencode-tui.browser.js

# backend (separate terminals): scripted model + isolated opencode serve on :4792
../../mock-llm/run-mock.sh
../../mock-llm/run-opencode-server.sh

bun run serve             # http://localhost:4798
```

Open
`http://localhost:4798/?guest=opencode&env=OPENCODE_SERVER_URL=http://127.0.0.1:4792&env=OPENCODE_SERVER_PASSWORD=wasm-term-mock`

Other entry points:

| Command | What it shows |
| --- | --- |
| `bun run demo:core` | a 40-line OpenTUI program on the wasm core, under Bun, in your terminal |
| `bun run demo:opencode-bun` | the opencode TUI on the wasm core, hosted by Bun (real Node APIs, same wasm renderer) |
| `bun run test:opentui` | OpenTUI's own JS test suite against the wasm core |

## Recommendation

**Approach (a): bundle the real TUI TypeScript, shim the Node surface, put OpenTUI's Zig core in
wasm behind a `bun:ffi`-shaped backend.** It is the only candidate that is both the real UI code
and small enough to load and run at native-like speed, and it is no longer hypothetical.

Why it works out well here, specifically:

- opencode exposes the TUI as a function. `run(input: TuiInput)` (`opencode/packages/tui/src/app.tsx:205`,
  type at `:180`) takes the server endpoint, config service, updater and package installer as
  injected values. `packages/cli` is only one host for it
  (`opencode/packages/cli/src/commands/handlers/default.ts:97`). We write another host
  (`host/tui-input.ts`, 44 lines) and never bundle the CLI. **[ran]**
- OpenTUI has one FFI seam. Every native call goes through `opentui/packages/core/src/platform/ffi.ts`,
  which already abstracts two backends (Bun and Node's `node:ffi`) behind `dlopen/ptr/toArrayBuffer/
  createCallback`. A wasm backend is a third implementation of the same shape. **[ran]**
- The Zig core asks the OS for almost nothing in the render path: it writes frames to fd 1 and
  reads a clock. Terminal raw mode, stdin and capability-reply parsing are all on the TypeScript
  side (`renderer.ts:3596` `stdin.setRawMode(true)`, `:3600` `stdin.on("data")`), and environment
  variables are pushed in from TypeScript (`renderer.ts:1179`). **[read]**, consistent with **[ran]**.
- Upstream already builds this same graph without Bun (`opencode/packages/cli/vite.node.config.ts`,
  the Node SEA build), so the conditional-import variants we need mostly exist. **[read]**

What would change my mind:

- OpenTUI moving the FFI boundary to something a wasm module cannot honour cheaply, e.g. many
  more APIs that alias JS memory from native (today: two, see "FFI gaps"), or mandatory native
  threads in the render path. Then (d) below (contribute a wasm target upstream) becomes the
  only sustainable form of (a).
- opencode folding `packages/tui` back into the CLI so that `run(TuiInput)` stops being an
  importable seam. The Node shim surface would then grow from "what the TUI touches" to
  "what the CLI touches" (child processes, npm, sqlite), which is approach (b)'s territory.
- A requirement for features that need real native code in the client: audio attention sounds,
  embedded terminal panes (ghostty-vt, x86_64/aarch64 only in `build.zig:ghosttyVtAvailable`),
  external plugins loaded from disk.

### Comparison

| | (a) bundle + shims + wasm core | (b) JS runtime in wasm | (c) emulate the native binary | (d) upstream web renderer |
| --- | --- | --- | --- | --- |
| Is it the real UI code | Yes: `packages/tui` and OpenTUI TS from source, unmodified on disk; 12 anchor-checked edits in 4 files applied at bundle time, 5 module substitutions | Yes, if the runtime can load it | Yes, bit for bit | n/a |
| Effort | Done to a working state in this port: ~2.1k lines | Very high. Bun is JavaScriptCore + Zig with no wasm target; QuickJS-class engines in WASI lack `bun:ffi`, Node APIs, a JIT, and still need the wasm core and an FFI bridge between two wasm modules. You redo (a)'s shims inside a slower engine | High. The binary is a 210 MB x86_64 ELF needing a Linux kernel ABI (epoll, threads, mmap, JIT pages). Needs v86/container2wasm-style full system emulation plus an in-emulator network stack bridged to fetch | Does not exist |
| Performance | Browser's own JS JIT; renderer is wasm. FFI adds one copy in and out per buffer argument | Interpreter-only JS (no JIT in wasm): 10-100x slower for a Solid + Effect app | x86 emulation of a JIT-ed JS engine; tens of MB to boot, seconds to minutes to start | n/a |
| Download | 3.0 MB gz wasm + 1.3 MB gz JS (unminified, unstripped) | engine (1-10 MB) + the same wasm core + bundle | hundreds of MB | n/a |
| Upgrades | Re-run the build. Breaks loudly if an anchor moved (12 anchors) or a new Node/Bun API appears on the TUI path | Same shims plus engine maintenance | Zero porting work per release; that is its one advantage | n/a |
| Network | Browser `fetch`/`WebSocket` directly | must be bridged out of the wasm engine | TCP in the emulator has to be tunnelled through a WebSocket proxy: effectively a server-side component again | n/a |
| Verified | **[ran]** end to end | not attempted; assessment from knowledge of the engines | not attempted | **[read]** searched the OpenTUI tree |

(d): there is no wasm, browser or DOM target in OpenTUI 0.5.17. `packages/web` is the Astro docs
site (uses `@xterm/headless` to pre-render illustrations); the only wasm mentions are tree-sitter
grammars. `packages/ssh` and the `FeedBackend` (`opentui/packages/native/src/renderer-output.zig:8-11`)
show upstream already renders to something other than the process's stdout, which is the closest
prior art. The patch here is small enough to propose upstream (see remaining work, item 9).

## 1. What the TUI client is

**[read]** unless noted; detail and line references for every item are in `notes/api-survey.md`.

- Installed binary: `~/.bun/bin/opencode` is `@opencode/cli@2.0.26`, a 210 MB `bun build --compile`
  executable, repository `anomalyco/opencode`. **[ran]** (`--version`, `package.json`).
- Entry: `packages/cli/src/index.ts` (Effect CLI) → `commands/handlers/default.ts` resolves a
  server (`--server`, `--standalone`, or the background service) and calls `run()` from
  `@opencode/tui`. `--server <url>` exists and skips service management. **[ran]** (`--help`).
- Packages on the TUI path: `@opencode/tui` (SolidJS components), `@opencode/client` (generated
  fetch client + SSE), `@opencode/util`, `@opencode/plugin`, `@opencode/schema`, `@opencode/theme`,
  `@opencode/ui`, `@opencode/latex`, `@opencode/merman`; `@opentui/core`, `@opentui/solid`,
  `@opentui/keymap`; `solid-js` (patched by opencode), `effect`. 428 modules reachable.
- Runtime APIs, by what a `--server` client needs:

| API | Use on the TUI path | In `--server` mode |
| --- | --- | --- |
| `bun:ffi` | only inside OpenTUI (`platform/ffi.ts:211`) and `bun-ffi-structs` | essential → wasm backend |
| `Bun.sleep` | `tui/src/component/migration-overlay.tsx:19,26`, always mounted | essential → 1-line global |
| `Bun.file` | `component/prompt/local-attachment.ts:73` (paste of a local path) | stub ("does not exist") |
| `Bun.stringWidth`, `Bun.plugin`, `Bun.Transpiler`, `bun:sqlite` | only via `bun` variants of package `imports` | avoided by pinning other variants |
| `process.stdin/stdout`, `setRawMode`, `SIGWINCH`, `env`, `cwd`, `platform`, `on/off/exit/kill` | renderer I/O, layout, signals | essential → `src/node/process.ts` on the kernel pty |
| `node:fs` (+promises) | kv state, prompt history/stash/frecency, theme lookup, logs, plugin directory scan | essential → `src/node/fs.ts` (in-memory) |
| `node:path`, `node:os`, `node:url`, `events`, `stream`, `buffer`, `util`, `crypto` | everywhere | essential → bundler polyfills + 3 shims |
| `node:child_process` | `$EDITOR`, `open` URL, service management | unreachable or stubbed (throws by name) |
| `node:module`, `node:vm`, `node:sqlite`, `node:worker_threads`, `node:perf_hooks` | plugin loading, Zed integration, tree-sitter worker | stubbed |
| `fetch`, streaming response body, `WebSocket`, `AbortSignal.any`, `Promise.withResolvers` | all server traffic | essential, native in browsers |
| host clipboard (native threads), audio (miniaudio) | copy/paste, attention sounds | replaced: clipboard bridge shim; audio absent |

## 2. OpenTUI's native core

- What it does **[read]** (`opentui/packages/native/src`, 34.8k lines of Zig): cell buffers and
  frame diffing to ANSI (`buffer.zig`, `renderer.zig`, `ansi.zig`), output transport
  (`renderer-output.zig`), terminal capability state (`terminal.zig`), text storage/wrapping/
  selection (`rope.zig`, `text-buffer*.zig`, `edit-buffer.zig`, `editor-view.zig`), grapheme and
  width tables (`utf8.zig`, `grapheme.zig`, uucode), Yoga flexbox layout (C++, `yoga.zig`),
  images (stb/libwebp/lcms2), audio (miniaudio), host clipboard (X11/Wayland/AppKit/Win32),
  embedded terminal (ghostty-vt). Input parsing is TypeScript (`core/src/lib/stdin-parser.ts`).
- FFI surface **[ran]**: 369 `export fn` in `lib.zig`; TypeScript declares 399 symbols in one
  `dlopen` (`core/src/zig.ts:441`). 5 callback sites (log, event bus, span feed, 2 Yoga).
  Handles are `u32` (`handles.zig:3`), not pointers.
- OS requirements **[ran]** (the built module's import section): 30 `wasi_snapshot_preview1`
  functions and 2 C++ exception symbols. `src/wasm-ffi.ts` implements 9 of them (`fd_write`,
  `fd_read`, `fd_close`, `fd_fdstat_get`, `fd_prestat_get`, clocks, `random_get`, `proc_exit`); the
  core demo called nothing else (**[ran]**, `WASM_FFI_STATS=1`). The rest belong to file logging,
  image loading and kitty file transport (**[read]**); which of them the opencode session touched
  was not recorded. It writes frames straight to fd 1 (`StdoutOutput`,
  `renderer-output.zig:168`). No termios, no stdin reads, no `getenv` in the render path.
  Threads: an optional render thread (`renderer-output.zig:594`; already forced off on Linux by
  `renderer.ts:1130`), plus audio and clipboard workers.
- Upstream wasm/browser target: none **[read]** (see (d) above).
- Does it compile to wasm **[ran]**: yes, `wasm32-wasi`, Zig 0.16.0 (the only version
  `build.zig` accepts), 10.2 MB unstripped ReleaseFast, 3.0 MB gzipped.
  - First attempt, unpatched (`zig build -Dlibrary-target=wasm32-wasi`), 13 errors in 4 groups:
    ```
    miniaudio.h:16216:31: error: call to undeclared function 'sched_get_priority_min'   (+3 pthread sched)
    std/Thread.zig:346:9: error: Cannot spawn thread when building in single-threaded mode   (renderer-output.zig:594)
    src/audio.zig:189:24: error: expected 32-bit integer type or smaller; found 64-bit integer type   (7 sites)
    src/clipboard/host.zig:140:17: error: Unsupported clipboard worker target
    ```
  - Enabling threads instead (`+atomics`, `single_threaded = false`) fails inside Zig's own std:
    `std/Io/Threaded.zig:959:50: error: expected type 'i64', found 'u64'` and
    `std/heap.zig:16:74: error: unimplemented`. So the build is single-threaded.
  - What makes it build: `native/opentui-native-wasm.patch` (73 lines: a wasm branch in
    `build.zig` producing a WASI reactor with an exported function table and no miniaudio; one
    guard in `renderer-output.zig`) and `native/gen-lib-wasm.ts`, which derives `lib-wasm.zig`
    from `lib.zig` by dropping the 61 audio and host-clipboard exports and adding
    `wasmTermAlloc/Free`. `native/postprocess.ts` removes the function-table maximum.
  - `wasm32-freestanding` was not attempted: Yoga (C++) and the image libraries need libc/libc++.
- Does it work **[ran]**: OpenTUI's JS test suite against the wasm core
  (`bun run test:opentui`): **5368 pass, 352 fail, 24 skip** of 5744 in 195 files. Failures by
  cause: about 186 audio (`createAudioEngine` dropped), 32 embedded terminal (ghostty-vt not in
  the wasm build), the rest images/file loading/split-footer image scrollback (no filesystem
  behind WASI in the test host) and the two FFI gaps below (`NativeSpanFeed` "state buffer view"
  tests, `OptimizedBuffer` raw buffers, "packed color owner retention", "borrowed pointer call
  sites"). The native baseline for the same suite on this machine was **not run**, so some of the
  352 may fail natively too.

### The wasm FFI backend (`src/wasm-ffi.ts`)

| bun:ffi behaviour | wasm backend |
| --- | --- |
| native reads/writes a JS buffer argument in place | copy into linear memory before the call, copy back after, free |
| `ptr(view)` yields an address native may retain | pinned mirror of the view's whole ArrayBuffer, re-synced on each `ptr()`, freed by `FinalizationRegistry` |
| `toArrayBuffer(addr, off, len)` aliases native memory | returns a copy |
| declared types (`u64`, `usize`, `bool`, `ptr`) | coerced per the module's real signature, parsed from the wasm type section |
| `JSCallback` | generated one-import-one-export trampoline module per signature, placed in the function table |
| symbol missing from the library | throwing stub, recorded in `stats.missingSymbols` |

Things that were wrong on wasm32 and are fixed by anchor-checked edits in
`build/opentui-wasm-plugin.ts` **[ran]** (each was an observed failure):

- `StyledChunk.text_len`/`link_len` and `ExternalCapabilities.term_name_len`/`term_version_len`
  are `usize` in Zig (`text-buffer.zig:45,52`, `lib.zig:1520,1522`) but `"u64"` in
  `core/src/zig-structs.ts:23,44,118,120`. Symptom: every text renderable was empty.
- `bun-ffi-structs` decides pointer size from `process.arch` (8 on x64); forced to 4.
- `core/src/zig.ts:5401` reads a pointer field with `getBigUint64`.
- Top-level `await` (`zig.ts:222`, `bun-ffi-structs` backend load) makes Bun's bundler initialise
  modules out of order across import cycles: `TypeError: The superclass is not a constructor`
  at `solid/src/elements/slot.ts:18`. Both TLAs are replaced by synchronous code.

FFI gaps that remain (**[read]** the call sites; not hit by opencode in testing):

- `toArrayBuffer` aliasing. `core/src/buffer.ts:94-97` exposes a buffer's cell arrays as typed
  arrays over native memory; with the copy, JS writes to `buffer.buffers.*` do not reach the
  renderer. `NativeSpanFeed` state views likewise (unused when output goes to fd 1).
- Buffer arguments are copied both ways on every call, including large read-only inputs.

## 3. Network (`--server` mode)

- Transport **[read]** + **[ran]**: plain `fetch` JSON requests and one SSE stream read from a
  `fetch` body (`GET /api/event`), reconnect logic in `client/src/solid/connection.ts`. No
  `EventSource`. WebSocket only for persistent-PTY terminal panes (ticket in the query string).
- Auth **[ran]**: HTTP Basic, user `opencode`, password = the server's
  `OPENCODE_SERVER_PASSWORD` (`client/src/service-probe.ts:93`). There is no flag to disable it;
  a foreground `opencode serve` prints a random password if none is set.
- CORS **[ran]** from Chrome at origin `http://localhost:4798`: preflights and requests with
  `Authorization` pass with no server flags. The allow-list is `http://localhost:*`,
  `http://127.0.0.1:*`, `https://*.opencode.ai`, Tauri origins (`server/src/cors.ts:3-20`); any
  other origin needs `opencode serve --cors <origin>` (see `../../mock-llm/README.md` for the
  measured headers).
- COEP **[ran]**: the page is `Cross-Origin-Embedder-Policy: require-corp` and the cross-origin
  `fetch` to the opencode server still works, because it is a CORS-mode request.
- Not exercised: persistent-PTY WebSocket panes, an `https` page talking to a non-loopback
  `http` server (mixed content will block it), remote origins needing `--cors`.

## PoC status

All **[ran]** against the mock-backed isolated server (`../../mock-llm`), Chrome on this machine
(canvas renderer; WebGL2 was unavailable under Xvfb), terminal 192x55 and 150x47.

Works in the browser:

- Home screen, connection to the server, model and workspace shown.
- Typing through the kernel line discipline in raw mode; kitty keyboard sequences (`ctrl+p`).
- Prompt → streamed reply over SSE; shell tool call; "Permission required" dialog → Allow once →
  tool output → final answer (`captures/browser-opencode-tool.png`, `.txt`).
- Markdown reply with a table; command palette; mouse wheel scrolling; window resize relayout;
  `ctrl+c` exit: exit code 0 reported to the page, alternate screen left.

Works under Bun on the same wasm core: the above flow (`captures/bun-host-wasm-core-tool.txt`),
and the minimal `demos/core-hello.ts`.

Known gaps and things not checked:

- Syntax highlighting and markdown concealment: tree-sitter runs in an OpenTUI parser worker
  loaded from asset paths that are placeholders here (`src/shims/opentui-runtime-assets.ts`).
  Markdown rendered with its markup visible (`## heading`, `**bold**`). Whether the native
  client conceals it in the same reply was not compared.
- Nothing persists: `src/node/fs.ts` is in-memory, so prompt history, kv settings and theme
  choice reset on reload.
- Host clipboard: `src/shims/host-clipboard.ts` needs the embedder to install
  `globalThis.__wasmTermClipboard`; nothing does yet. OSC 52 through the terminal is untested.
- Terminal output flow control (`H_OUT_ACK`/`OUT_WINDOW` in `host/protocol.ts`) is not honoured
  by `host/worker-main.ts`; it posts output as produced.
- Not tested: paste, text selection, images, terminal panes (WebSocket PTY), session switching,
  long sessions (memory growth of pinned mirrors), Safari/Firefox, WebGL renderer.
- No frame-time or FFI overhead measurements were taken; it felt immediate at mock speeds
  (64-138 tok/s streamed) but that is an impression, not a number.
- The opencode TUI's local config service is a stub returning `{}` (`host/tui-input.ts`).

### Glue for :4790

`web/` and `host/` were not edited. `web/server.ts` on :4798 here serves wasm-term's own
`web/index.html` and `web/client.ts` unchanged and substitutes the worker. For the guest to be
selectable on :4790, `web/` needs:

1. `web/client.ts`: choose `workerUrl` per guest (today a constant `"/worker.js"`), e.g.
   `/opencode-worker.js` when `guest=opencode`.
2. `web/server.ts`: bundle `ports/opencode/host/worker-main.ts` and serve it at that URL; serve
   `ports/opencode/dist/opentui.wasm` at `/guests/opencode.wasm` and
   `ports/opencode/dist/opencode-tui.browser.js` (+ `.map`) at the site root.
3. Pass `OPENCODE_SERVER_URL` / `OPENCODE_SERVER_PASSWORD` (already possible with `&env=`).

`host/worker-main.ts` reuses `host/kernel.ts`, `host/ring.ts` and `host/protocol.ts` as they
are. `docs/abi.md` did not exist when this was written; the JS-program side of the machine
(async pump instead of blocking syscalls, `process` on the pty, Node-style timers) lives in
`host/worker-main.ts` and `src/node/` and is what a generic "JS program on node shim" guest in
`host/` would absorb.

## Remaining work, in order

1. Wire the guest into `web/` (three changes above) so it is on :4790 with the other guests.
2. Persist the filesystem (IndexedDB/OPFS behind `src/node/fs.ts`), at least `Global.state`
   and `Global.config`; implement the TUI config service over it.
3. Tree-sitter: serve `parser.worker.js`, `tree-sitter.wasm` and grammars, and make
   `resolveDefaultTreeSitterWorkerPath` return real URLs (a nested Worker; `core/src/platform/
   worker.ts` already prefers `globalThis.Worker`).
4. Honour output flow control in the JS-guest pump; move the pump and `process` shim into `host/`.
5. Clipboard bridge to the page (`navigator.clipboard` lives on the main thread).
6. Close the two FFI gaps: real views over linear memory for `buffer.ts:94-97` (needs
   non-detaching memory: fixed-size or shared), and skip copy-back for read-only buffer
   arguments.
7. Run the native baseline of the OpenTUI suite and diff it against the wasm run; turn the
   remaining unexpected failures into fixes.
8. Size: strip debug info (`strip = false` in `build.zig`), try ReleaseSmall, drop the image
   stack if unused, minify the JS (unminified today so anchors and stack traces stay readable).
9. Offer upstream OpenTUI the wasm target (build branch, single-threaded guard, `usize` struct
   fields declared honestly) so the patch and most of the twelve edits disappear.
10. Test matrix: Safari/iOS, Firefox, WebGL renderer, paste/selection/mouse drag, terminal
    panes, non-loopback servers with `--cors`.

## Layout

| Path | What |
| --- | --- |
| `native/` | wasm build of the Zig core: `build.sh`, patch, `gen-lib-wasm.ts`, `postprocess.ts` |
| `src/wasm-ffi.ts`, `src/boot.ts` | the `bun:ffi`-shaped backend and its installer |
| `build/` | bundler plugin (anchored edits), opencode and demo bundlers, test preload |
| `src/shims/` | replacements for 5 modules (runtime assets, host clipboard, sounds, sqlite, plugin source) |
| `src/node/` | Node built-ins for the browser: `process` on the pty, in-memory `fs`, `os`, `url`, `path`, `console`, timers |
| `host/` | `tui-input.ts` (remote-only `TuiInput`), `worker-main.ts` (Worker entry), `worker-app.ts`, `bun-main.ts` |
| `web/server.ts` | dev server on :4798 |
| `demos/`, `captures/`, `notes/` | Bun-hosted demos, evidence, API survey |
