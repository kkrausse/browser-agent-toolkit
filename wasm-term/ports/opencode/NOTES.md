# opencode TUI in the browser

Target: opencode v2.0.26 (`anomalyco/opencode`, tag `v2.0.26`, commit `9b4ec571`), which pins
OpenTUI 0.5.17 (`anomalyco/opentui`, tag `v0.5.17`, commit `6f0efd33`).

**Result: it runs, as a guest on the main dev page.** The real opencode TUI source, unmodified,
executes in a browser Web Worker on the wasm-term machine's node-style shim (`../../host/node`),
renders through OpenTUI's Zig core compiled to wasm32-wasi into ghostty-web via the kernel pty, and
talks to a remote `opencode serve` with `fetch` + SSE. No server-side PTY. Markdown and syntax
highlighting match the native client cell for cell; settings, history and tabs survive a reload;
copy and paste go through the page.

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
bun run build:native      # dist/opentui.wasm: ReleaseFast, debug info stripped (about 2.5 minutes)
bun run build:tui         # dist/site/: guest.js, tui.js (minified), parser.worker.js, wasm files, grammars (3 s)

../../mock-llm/up.sh      # backend in Docker: scripted model + opencode serve on :4792
cd ../../web && bun run dev
```

Open <http://127.0.0.1:4790/?guest=opencode> (or <http://127.0.0.1:4790/> for the launcher form).
`&server=`, `&password=`, `&dir=` choose the server, its password and the project directory; the
defaults are the mock backend's (`http://127.0.0.1:4792`, `wasm-term-mock`,
`/tmp/wasm-term-workspace`). `&persist=0` runs without saved state, `&reset=1` forgets it first.
`&env=WASM_TERM_DEBUG=1` sends the TUI's log to the browser console, `&env=WASM_TERM_FFI_STATS=1`
logs FFI call and copy volume once a second.

```sh
../../web/verify/run.sh opencode        # the browser check, 26 assertions
../../web/verify/run.sh opencode-perf   # load and latency numbers
../../mock-llm/down.sh
```

Other entry points:

| Command | What it shows |
| --- | --- |
| `bun run build:tui:debug` | the same site with an unminified `tui.js` |
| `sh native/build.sh ReleaseSmall` | a smaller core: 2.6 MB, 0.49 MB gzipped (ran; no measurable latency difference) |
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
  (`host/tui-input.ts`) and never bundle the CLI. **[ran]**
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
| Is it the real UI code | Yes: `packages/tui` and OpenTUI TS from source, unmodified on disk; 17 anchor-checked edits in 5 files applied at bundle time, 5 module substitutions | Yes, if the runtime can load it | Yes, bit for bit | n/a |
| Effort | Done in this port: about 2k lines here plus the generic JS-guest shim in `host/node` (about 1k) | Very high. Bun is JavaScriptCore + Zig with no wasm target; QuickJS-class engines in WASI lack `bun:ffi`, Node APIs, a JIT, and still need the wasm core and an FFI bridge between two wasm modules. You redo (a)'s shims inside a slower engine | High. The binary is a 210 MB x86_64 ELF needing a Linux kernel ABI (epoll, threads, mmap, JIT pages). Needs v86/container2wasm-style full system emulation plus an in-emulator network stack bridged to fetch | Does not exist |
| Performance | Browser's own JS JIT; renderer is wasm. FFI adds one copy in and out per buffer argument | Interpreter-only JS (no JIT in wasm): 10-100x slower for a Solid + Effect app | x86 emulation of a JIT-ed JS engine; tens of MB to boot, seconds to minutes to start | n/a |
| Download | 0.58 MB gz wasm + 0.87 MB gz JS, plus the tree-sitter runtime and grammars on first use | engine (1-10 MB) + the same wasm core + bundle | hundreds of MB | n/a |
| Upgrades | Re-run the build. Breaks loudly if an anchor moved (17 anchors) or a new Node/Bun API appears on the TUI path | Same shims plus engine maintenance | Zero porting work per release; that is its one advantage | n/a |
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
| `process.stdin/stdout`, `setRawMode`, `SIGWINCH`, `env`, `cwd`, `platform`, `on/off/exit/kill` | renderer I/O, layout, signals | essential → `host/node/process.ts` on the kernel pty |
| `node:fs` (+promises) | kv state, prompt history/stash/frecency, theme lookup, logs, plugin directory scan | essential → `host/node/fs.ts` on the machine's vfs; config and state directories persisted |
| `node:crypto` | `createHash("sha1")` names the lock taken for every state file write (`util/src/flock.ts`); `randomUUID` | essential → `host/node/modules/crypto.ts` (Bun's polyfill left `createHash` undefined) |
| `node:path`, `node:os`, `node:url`, `events`, `stream`, `buffer`, `util` | everywhere | essential → bundler polyfills + `host/node/modules` |
| `node:child_process` | `$EDITOR`, `open` URL, service management | unreachable or stubbed (throws by name) |
| `node:module`, `node:vm`, `node:sqlite`, `node:worker_threads`, `node:perf_hooks` | plugin loading, Zed integration | stubbed |
| `Worker` (global) | OpenTUI's tree-sitter parser worker | essential for markdown and highlighting → a nested module Worker, `dist/site/parser.worker.js` |
| `fetch`, streaming response body, `WebSocket`, `AbortSignal.any`, `Promise.withResolvers` | all server traffic | essential, native in browsers |
| host clipboard (native threads), audio (miniaudio) | copy/paste, attention sounds | replaced: clipboard through the page (`src/shims/host-clipboard.ts` → the machine's clipboard messages); audio absent |

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
  `build.zig` accepts). ReleaseFast: 10.2 MB as linked, of which 7.3 MB is DWARF; 3.0 MB after
  `native/postprocess.ts` strips it (0.58 MB gzipped). ReleaseSmall: 2.6 MB, 0.49 MB gzipped.
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
    `wasmTermAlloc/Free`. `native/postprocess.ts` removes the function-table maximum and the
    `.debug_*` sections.
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
| native reads/writes a JS buffer argument in place | copy into linear memory before the call, copy back after, free; an argument declared output-only (`FfiHint`) is not copied in and only the bytes written come back |
| `ptr(view)` yields an address native may retain | pinned mirror of the view's whole ArrayBuffer, re-synced on each `ptr()`, freed by `FinalizationRegistry` |
| `toArrayBuffer(addr, off, len)` aliases native memory | returns a copy; the call site that needs aliasing uses `view()` (below) |
| declared types (`u64`, `usize`, `bool`, `ptr`) | coerced per the module's real signature, parsed from the wasm type section |
| `JSCallback` | generated one-import-one-export trampoline module per signature, placed in the function table |
| symbol missing from the library | throwing stub, recorded in `stats.missingSymbols` |

Things that were wrong on wasm32 and are fixed by anchor-checked edits in
`build/opentui-wasm-plugin.ts` **[ran]** (each was an observed failure; 17 anchors in 5 files now):

- `StyledChunk.text_len`/`link_len` and `ExternalCapabilities.term_name_len`/`term_version_len`
  are `usize` in Zig (`text-buffer.zig:45,52`, `lib.zig:1520,1522`) but `"u64"` in
  `core/src/zig-structs.ts:23,44,118,120`. Symptom: every text renderable was empty.
- `bun-ffi-structs` decides pointer size from `process.arch` (8 on x64); forced to 4.
- `core/src/zig.ts:5401` reads a pointer field with `getBigUint64`.
- Top-level `await` (`zig.ts:222`, `bun-ffi-structs` backend load) makes Bun's bundler initialise
  modules out of order across import cycles: `TypeError: The superclass is not a constructor`
  at `solid/src/elements/slot.ts:18`. Both TLAs are replaced by synchronous code.

The two FFI gaps the first version left open, and what was done **[ran]**:

- `toArrayBuffer` aliasing. `core/src/buffer.ts:94-97` exposes a buffer's cell arrays as typed
  arrays over native memory and caches them. With a copy that cache was a snapshot taken once:
  the renderer's link hit-testing (`renderer.ts:3882`, `buffer.buffers.attributes[...]`) read
  stale cells and writes through `buffer.buffers.*` went nowhere. The plugin now points those
  four arrays at `ffi.view()`, real typed arrays over linear memory, and re-derives them when
  the memory has grown (growth detaches the old ArrayBuffer). A caller that keeps one of the
  arrays across a growth holds a zero-length array; upstream code re-reads `buffer.buffers`
  each time. `NativeSpanFeed` state views are still copies (unused when output goes to fd 1).
- Buffer arguments copied both ways. Measured with `WASM_TERM_FFI_STATS=1`: 15 MB/s copied in
  (and again out) while typing on the home screen, all of it `editBufferGetText`, which fills a
  1 MiB scratch buffer several times per keystroke; under 0.6 MB/s for everything else while a
  long reply streams. The ten OpenTUI functions of that shape (`fn(handle, out, max) written`)
  are declared output-only in `src/opentui-ffi-hints.ts`. Read-only *input* buffers are still
  copied back after the call; at the measured volumes that is noise, and telling them apart
  needs per-symbol knowledge the FFI declarations do not carry.

## 3. Network (`--server` mode)

- Transport **[read]** + **[ran]**: plain `fetch` JSON requests and one SSE stream read from a
  `fetch` body (`GET /api/event`), reconnect logic in `client/src/solid/connection.ts`. No
  `EventSource`. WebSocket only for persistent-PTY terminal panes (ticket in the query string).
- Auth **[ran]**: HTTP Basic, user `opencode`, password = the server's
  `OPENCODE_SERVER_PASSWORD` (`client/src/service-probe.ts:93`). There is no flag to disable it;
  a foreground `opencode serve` prints a random password if none is set.
- CORS **[ran]** from Chrome at origins `http://localhost:4798` and `http://127.0.0.1:4790`: preflights and requests with
  `Authorization` pass with no server flags. The allow-list is `http://localhost:*`,
  `http://127.0.0.1:*`, `https://*.opencode.ai`, Tauri origins (`server/src/cors.ts:3-20`); any
  other origin needs `opencode serve --cors <origin>` (see `../../mock-llm/README.md` for the
  measured headers).
- COEP **[ran]**: the page is `Cross-Origin-Embedder-Policy: require-corp` and the cross-origin
  `fetch` to the opencode server still works, because it is a CORS-mode request.
- Not exercised: persistent-PTY WebSocket panes, an `https` page talking to a non-loopback
  `http` server (mixed content will block it), remote origins needing `--cors`.

## Status

All **[ran]** in Chrome on this machine (Xvfb, so ghostty-web's canvas renderer: WebGL2 is not
available here) against the containerised backend (`../../mock-llm/up.sh`), by
`../../web/verify/opencode.js` (26 assertions, re-runnable: `../../web/verify/run.sh opencode`).

| Function | How it was checked |
| --- | --- |
| Launcher, settings | the form on `/` lists the guest with the mock defaults; submitting starts it with `server`/`password`/`dir` in the URL |
| Connect | home screen shows the server's model and `/tmp/wasm-term-workspace:master` |
| Plain prompt | screen equals `mock-llm/baseline/opencode-plain.txt` (blank lines, tab bar, timings and token counts aside) |
| Streaming | the long reply's on-screen text was sampled every 50 ms and grew in 10+ steps |
| Tool call + permission | dialog equals `opencode-tool-permission.txt`; after Allow once the screen equals `opencode-tool.txt` |
| Markdown, highlighting | every cell of the reply (text, colour, bold, italic) equals a native capture (`../../web/verify/baseline/opencode-markdown.json`, taken with `termctrl show --format json`) |
| Long reply, scrolling | mouse wheel scrolls the transcript back and forward to `END-OF-LONG-RESPONSE` |
| Command palette | `ctrl+p` (a kitty keyboard sequence) opens it; filtering; running an entry |
| Mouse | clicking a palette entry runs it; wheel; drag selection |
| Sessions | new session, session list (`ctrl+x l`), switching back shows the earlier transcript |
| Resize | the window is sized to 110x36 and 120x47; the TUI relays out |
| Paste | the browser's paste event arrives as a bracketed paste and lands in the prompt |
| Clipboard read | `ctrl+v` reaches the TUI as a key (`CSI 118;5u`); it asks the machine, the page answers, the text is inserted |
| Clipboard write | selecting transcript text with the mouse calls the page's `navigator.clipboard.writeText` with it (resolved OK) |
| Persistence | after a reload: open tabs restored, prompt history on arrow-up, chosen theme still applied; IndexedDB holds `cli.json`, `prompt-history.jsonl`, `tui/tabs.json` and no lock files |
| Exit | `ctrl+c` twice: exit code 0 reported to the page, alternate screen left, mouse tracking off |

One thing in that list is not the real thing: Chrome asks the user before the first clipboard
*read*, and that prompt cannot be answered under automation, so the check replaces the page's
clipboard object (`window.wasmTerm.clipboard`) and exercises everything between it and the TUI.
`navigator.clipboard.readText()` itself was not exercised.

### What was wrong with markdown

In the PoC a reply showed `## heading` and `**bold**` literally and code was not coloured. The
native client conceals the markup and highlights (compared on the same mock reply). OpenTUI does
both from tree-sitter, which runs in a worker; three separate things stopped it **[ran]**:

1. The worker script and grammar locations were placeholder paths (`/wasm-term/assets/...`), so
   the Worker 404ed. `build/build-site.ts` now bundles `parser.worker.ts` (unmodified) with the
   node shim and copies `tree-sitter.wasm` and OpenTUI's bundled grammars and queries into
   `dist/site/`; `src/shims/opentui-runtime-assets.ts` returns their URLs.
2. OpenTUI calls `new Worker(path)`, a classic script; the bundle is an ES module. `host/guest.ts`
   wraps `Worker` to add `type: "module"`.
3. `parser.worker.ts` stores each grammar in its cache directory and passes web-tree-sitter the
   cache *path*. Under Node that is a file read; anywhere else web-tree-sitter calls `fetch(path)`,
   which asked the dev server for `/home/user/.local/share/opentui/tree-sitter/languages/*.wasm`.
   `src/tree-sitter-worker-globals.ts` gives the worker a private in-memory filesystem and a
   `fetch` that answers paths existing in it.

Languages other than markdown, JavaScript, TypeScript and Zig come from opencode's
`parsers-config.ts`, which downloads grammars from `github.com` release assets and queries from
`raw.githubusercontent.com` on first use. In the browser those are cross-origin fetches from the
worker; whether GitHub's release-asset redirect passes CORS was not tested (the native client in
the mock setup cannot reach them either, its egress is blocked).

### Persistence

The client's files live in the machine's vfs through `host/node/fs.ts`; the guest descriptor
(`web/guest.ts`) names `~/.config/opencode` and `~/.local/state/opencode` as persistent and
excludes `/locks/`. The machine does the rest (IndexedDB on the page; see `../../docs/abi.md`
4.1). Two port-side fixes were needed **[ran]**:

- Every state write goes through a file lock named `createHash("sha1")` of the path, and Bun's
  browser polyfill of `node:crypto` exported `createHash` as undefined: "Failed to persist session
  tabs" in the TUI's console overlay, and only the append-only prompt history ever reached disk.
  `node:crypto` is now `host/node/modules/crypto.ts`.
- The settings service passed to `run()` was an in-memory stub. `host/tui-input.ts` now keeps it
  in `<config>/cli.json`, the file the native CLI uses (as plain JSON, without the CLI's
  comment-preserving edits or its v1 migration).

### Size and speed

What the browser downloads for this guest, as served (gzip) **[ran]**:

| File | Raw | Gzipped | Was |
| --- | --- | --- | --- |
| `opentui.wasm` | 3.0 MB | 0.58 MB | 10.2 MB / 3.0 MB (7.3 MB of DWARF) |
| `tui.js` | 3.0 MB | 0.87 MB | 6.7 MB / 1.3 MB (unminified, with crypto-browserify) |
| `parser.worker.js`, `tree-sitter.wasm`, grammars on first use | 0.14 + 0.2 + 0.4-1.4 MB each | | not served |

First numbers, from `../../web/verify/opencode-perf.js` on this machine (12 cores shared with a
Rust build, load average 15-25; loopback; canvas renderer). Treat them as an order of magnitude:

| | Now | Before the size and FFI changes |
| --- | --- | --- |
| Navigation to the prompt being on screen | 0.55-0.9 s | 1.1-1.3 s |
| Key press to the program's next output reaching the terminal | median 13 ms, p90 19 ms | median 16 ms, p90 33 ms |
| Wheel event to next output | median 3 ms, max 18 ms | median 10 ms, max 390 ms |
| Long reply (80 lines over 12 s) | about 700 frames, 0.54 MB of terminal output | |

The latency is measured to `terminal.write`; the emulator's paint on the next animation frame is
on top. Not measured: frame time inside the wasm renderer, memory growth over a long session
(linear memory went from 18 MB at start to 39 MB after one long reply), anything on a phone.

### Known gaps, in priority order

1. **Only Chrome was run.** Safari/iOS matters and has known differences, none of them tested:
   - The page must be cross-origin isolated, which browsers only grant in a secure context:
     `http://127.0.0.1` works, `http://<tailscale-name>:4790` from a phone does not. It needs
     HTTPS in front of the dev server, and then the opencode server must be HTTPS too (mixed
     content) and started with `--cors <page origin>`.
   - Clipboard: Safari allows `navigator.clipboard` calls only inside a user gesture. A request
     that arrives from the Worker is not one, so `ctrl+v` paste and copy-on-select will be
     refused there (the TUI shows its own error). Cmd+V and the paste event still work, since
     they are a bracketed paste. A gesture-synchronous path (the page reading the clipboard in
     the key handler and handing it over) would fix read; write needs the selection text before
     the gesture ends, which the TUI only knows asynchronously.
   - `Atomics.waitAsync` exists from Safari 16.4; before that the pump polls every 8 ms.
     Nested module Workers (tree-sitter) need Safari 15.5.
   - No touch input mapping (scroll gestures to wheel reports, an on-screen way to send
     `ctrl+p`), and the canvas renderer is the only one tried.
2. **Clipboard read is unverified against the real browser API** (see above), and images in the
   clipboard are not offered: the bridge carries text only, so pasting a screenshot does nothing.
3. **tree-sitter grammars beyond the four bundled ones** depend on cross-origin downloads that
   were not exercised (Python, Rust, Go, ... in code blocks and diffs).
4. **Not tested**: file attachments and `@` file mentions, the diff viewer, terminal panes
   (WebSocket PTY), the model/agent pickers beyond opening them, `opencode pair`, MCP dialogs,
   very long sessions, a non-loopback server.
5. **Absent by construction**: attention sounds (no audio in the wasm core), `$EDITOR`, opening
   URLs in a browser from the TUI (`child_process`), local plugins and themes loaded from disk,
   embedded terminal (ghostty-vt), the updater.
6. **Persistence** is whole-file and asynchronous: a write in the instant before the tab closes
   can be lost, two tabs on the same guest overwrite each other's state (the file locks are per
   tab), and there is no quota handling. The log (`~/.local/share/opencode/log`) is deliberately
   not persisted.
7. **FFI**: read-only input buffers are still copied back after each call; `NativeSpanFeed`
   views are copies; pinned mirrors are only freed when the JS buffer is collected.
8. OpenTUI's own test suite on the wasm core was last run in full before these changes (5368
   pass, 352 fail, mostly audio and embedded terminal). After them only `buffer`, `edit-buffer`
   and `text-buffer` were re-run: 227 pass, 1 fail (`loadFile`, no filesystem behind WASI in the
   test host). The native baseline of the suite has still not been run.

## Remaining work, in order

1. An HTTPS path for the dev page and a server reachable from it, then Safari/iOS: isolation,
   input (touch, on-screen modifier keys), the clipboard gesture rule, the WebGL renderer.
2. Gesture-synchronous clipboard read in the page; image paste.
3. Serve or proxy the extra tree-sitter grammars so highlighting does not depend on GitHub CORS.
4. Exercise attachments, the diff viewer and terminal panes; run a long session and watch memory.
5. Re-run OpenTUI's full suite and its native baseline; turn unexpected failures into fixes.
6. Offer upstream OpenTUI the wasm target (build branch, single-threaded guard, `usize` struct
   fields declared honestly, an output-buffer annotation) so the patch and most of the anchored
   edits disappear.
7. Size: drop the image stack from the core if unused; lazy-load rarely used parts of the bundle.

## Layout

| Path | What |
| --- | --- |
| `host/guest.ts` | the JavaScript guest entry (`main(context)`): boots the wasm core, wires tree-sitter, clipboard, Bun globals, then imports the TUI |
| `host/worker-app.ts`, `host/tui-input.ts` | the TUI bundle's entry and the remote-only `TuiInput` (settings in `cli.json`) |
| `host/bun-main.ts` | the same TUI hosted by Bun |
| `web/guest.ts` | how the dev page offers this port: directory, launcher fields, persistent directories |
| `native/` | wasm build of the Zig core: `build.sh`, patch, `gen-lib-wasm.ts`, `postprocess.ts` (growable table, strip) |
| `src/wasm-ffi.ts`, `src/opentui-ffi-hints.ts`, `src/boot.ts` | the `bun:ffi`-shaped backend, its output-buffer hints, its installer |
| `src/tree-sitter-worker.ts`, `src/tree-sitter-worker-globals.ts` | entry of `parser.worker.js` |
| `src/shims/` | replacements for 5 modules (runtime assets, host clipboard, sounds, sqlite, plugin source) |
| `build/` | `build-site.ts` (everything under `dist/site/`), the bundler plugin with the anchored edits, demo bundler, test preload |
| `demos/`, `captures/`, `notes/` | Bun-hosted demos, evidence from the PoC, API survey |

The generic part (process on the pty, `node:fs` on the vfs, timers, the pump, persistence, the
clipboard messages) is not here: it is `../../host/node` and `../../host`, documented in
`../../docs/abi.md` section 4, and a second guest (`?guest=js-demo`) runs on it.
