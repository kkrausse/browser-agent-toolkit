# Survey: running the opencode TUI (v2.0.26) in a browser Web Worker on OpenTUI v0.5.17

Paths are relative to the two repo roots (`opencode/…` = `vendor/opencode`, `opentui/…` = `vendor/opentui`). Everything below was read from source unless marked **inferred** or **not determined**.

Three things limit certainty:
- Neither checkout has `node_modules`, so third-party code (Effect's `HttpMiddleware.cors`, the `open` package, `solid-js` export maps) could not be read.
- The import graph was computed with a regex-based resolver over `import`/`export from`/`import()`; inline `import type {…}` members are not distinguished, so a few edges may be type-only.
- Your vendored OpenTUI is locally modified: `packages/native/build.zig`, `packages/native/src/renderer-output.zig`, and new `packages/native/src/lib-wasm.zig` (comment says it is `lib.zig` minus audio and host clipboard).

---

## Part 1 — Runtime API inventory

### 1.0 Import graph shape

- **Size**: 428 modules reachable from `packages/tui/src/index.tsx`; 326 of them statically.
- **Real dynamic imports** (only three):
  - `tui/src/app.tsx:255` — `import("@opencode/simulation/frontend")`, gated on `process.env.OPENCODE_DRIVE`.
  - `tui/src/plugin/context.tsx:313` — `import("./builtins")`. This always runs during plugin reconcile, so treat it as static. It pulls in all `feature-plugins/**`, `@opencode/latex/plugin`, `@opencode/merman/plugin`, and the storybook module. Storybook is only *registered* under `OPENCODE_STORY` (`plugin/builtins.ts:29`).
  - `plugin/src/source.ts:29` — `import("#plugin-source")`, only when a local plugin is read.
  - `client/src/pty-handoff.ts:20` also has `import("./promise/index.js")`, only in `prepare()`, which the TUI never calls.
- **Workspace modules statically reached**:
  - `@opencode/client`: `effect/service.ts`, `service.ts` (types), `service-contender.ts`, `service-probe.ts`, `service-timing.ts`, `service-version.ts`, `pty-handoff.ts`, `shared-events.ts`, `promise/{index,client,rpc,api}.ts`, `promise/generated/*`, `solid/{index,connection,data,pty}.ts`.
  - `@opencode/util`: `global.ts`, `global-roots*.ts`, `flock.ts`, `hash.ts`, `open.ts`, `runtime-import.ts` + `runtime/import.*.ts`, `effect/{layer-node,app-node}.ts`, `session-title-fallback.ts`; `activity-calendar.ts` via builtins.
  - `@opencode/plugin`: `host.ts`, `source.ts`, `runtime.ts` + `runtime-modules.ts` (bun variant only), `tui/{index,plugin,solid}.ts`.
  - `@opencode/schema`: about 30 files, `effect` only.
  - `@opencode/theme/tui`: `effect` + `@opentui/core` only.
  - `@opencode/core`: only `util/slug.ts` (no imports).
  - `@opencode/ui`: only the five `audio/*.mp3` assets.
  - `@opencode/latex`, `@opencode/merman`: pure JS plus `string-width`, `@opentui/core`, `@opencode/plugin/tui`.
  - `@opencode/simulation`: only via `OPENCODE_DRIVE`.
- **`packages/sdk` is not used by the TUI.**
- **Third-party specifiers in the static closure**: `@opentui/core`, `@opentui/solid` (+ `/components`), `@opentui/keymap` (+ `/extras`, `/opentui`, `/addons/opentui`, `/solid`), `solid-js`, `solid-js/store`, `effect`, `effect/Array`, `@solid-primitives/event-bus`, `fuzzysort`, `remeda`, `strip-ansi`, `string-width`, `get-east-asian-width`, `uqr`, `opentui-spinner/solid`, `open`.
- **Node/Bun built-ins imported**: `fs`, `fs/promises`, `path`, `os`, `url`, `crypto`, `node:child_process`, `node:module`, `node:vm`, `node:perf_hooks`, `node:sqlite`/`bun:sqlite`.
- **Not imported anywhere in the TUI closure**: `node:net`/`tls`/`http`/`https`/`tty`/`readline`/`zlib`/`dns`/`async_hooks`/`events`/`util`/`worker_threads`, `Bun.spawn`/`which`/`serve`/`$`/`hash`/`write`. OpenTUI core does use `events`, `stream`, `node:util`, `node:console` and worker threads.

### 1.1 Conditional import maps reachable

None of these maps define a `browser` condition, so a bundler with only `browser` falls through to `default`.

| Map entry (importer) | `bun` | `node` | `workerd` | `default` | What it means for a browser |
|---|---|---|---|---|---|
| `#attention-sounds` (`tui/src/attention.ts:20`) | 5× `import x from "@opencode/ui/audio/*.mp3" with { type: "file" }` | `createRequire(import.meta.url)` then `require.resolve`; if `OPENCODE_NODE_ASSETS_DIR` is set it is just `path.join` | — | **bun** | Alias to a stub exporting five strings |
| `#string-width` (`tui/src/util/string-width.ts:1`) | `export const stringWidth = Bun.stringWidth` — throws at module eval without a `Bun` global | Pure JS (`string-width`, `strip-ansi`, `get-east-asian-width`, `Intl.Segmenter`) | — | **bun** | Force the node variant |
| `#zed-sqlite` (`tui/src/editor-zed.ts:1`) | `bun:sqlite` | `node:sqlite` | — | **bun** | Alias to a stub class |
| `#runtime-plugin-support` (`tui/src/plugin/context.tsx:24`) | `ensurePluginRuntime()` (`Bun.plugin`, `Bun.resolveSync`, `Bun.Glob`, `import.meta.dir`) and `@opentui/solid/runtime-plugin-support/configure` | Comment only, empty module | — | **node** | Default is already safe |
| `#plugin-source` (`plugin/src/source.ts:29`, dynamic) | `Bun.Transpiler`, `Bun.resolveSync`, `node:module` | `node:module`, `node:url` | — | **node** | Only loaded for local plugins |
| `#runtime-import` (`util/src/runtime-import.ts:1`, via `plugin/src/host.ts:4`) | `import(specifier)` and `Bun.resolveSync` at call time; imports `node:url` | `node:vm`, `node:module` `registerHooks`, `node:fs`, `import.meta.resolve` | Pure: both functions reject/throw "unavailable on workerd" | **bun** | The workerd variant is ideal |
| `#global-roots` (`util/src/global.ts:8`) | — | — | Everything under `os.tmpdir()/opencode/{data,cache,config,state,tmp}` | XDG: `os.homedir()` + `process.env.XDG_*` at module eval | See 1.5 |
| OpenTUI `#opentui/runtime-assets` (`core/src/zig.ts`, `lib/tree-sitter/client.ts`, `default-parsers.ts`) | `platform/runtime-assets.bun.ts`: `with {type:"file"}` / `{type:"wasm"}` imports, per-platform `@opentui/core-*` | `platform/runtime-assets.node.ts`: `OTUI_ASSET_ROOT` + `statSync`, `import.meta.resolve`, dynamic import of native package | — | **node** | Needs its own browser variant |

Unreachable from the TUI: `@opencode/core`'s `#sqlite`, `#pty`, `#persistent-pty-binary`, `#fff`, `#photon-wasm`, `#shell-parser-wasm`, `#v1-migration`.

### 1.2 Module-evaluation side effects (run on import)

- **`util/src/global-roots.ts:4-8`** — `os.homedir()` and `process.env.XDG_*`. Then `util/src/global.ts:13` calls `roots("opencode")`, which does `path.join(data!, app)`. If `os.homedir()` is empty and the XDG vars are unset, `data` is `undefined` and this throws at import (assuming Node-compatible `path.join`). Fix: non-empty `homedir()`, set `XDG_*`, or use the workerd variant (only needs `os.tmpdir()`).
- **`util/src/global.ts:31`** — `Flock.setGlobal({ state })` (pure).
- **`util/src/global.ts:82`** — `makeGlobalNode(...)` (pure LayerNode object).
- **`tui/src/util/string-width.bun.ts:1`** — `Bun.stringWidth` (default condition).
- **`tui/src/attention-sounds.bun.ts:2-6`** — mp3 file imports. Node variant: `createRequire(import.meta.url)` and `require.resolve` at `attention-sounds.node.ts:4,12-16`.
- **`tui/src/editor-zed-sqlite.{bun,node}.ts:1`** — `bun:sqlite` / `node:sqlite` import.
- **`tui/src/plugin/runtime-plugin-support.bun.ts:5-6`** — bun condition only.
- **`tui/src/routes/session/index.tsx:134`** — `addDefaultParsers(parsers.parsers)`. Registers tree-sitter parser configs from `tui/src/parsers-config.ts`, whose `wasm` and query entries are `https://github.com/...` and `https://raw.githubusercontent.com/...` URLs. Registration is pure; fetching happens later in the parser worker.
- **`tui/src/app.tsx:108`** — `registerOpencodeSpinner()`; also `component/spinner.tsx:12`, `session-tabs.tsx:57`, `one-cell-spinner.tsx:7`.
- **`extend({...})` renderable registrations** — `terminal-pane.tsx:16`, `fade-in-text.tsx:77`, `shimmer-text.tsx:46`, `retry-provider.tsx:191`, `title-shimmer.tsx:263`, `tab-pulse.tsx:756`. All pure.
- **`tui/src/context/theme.tsx:120`** — `subscribeThemes(setThemeSources)` (pure).
- **`Intl.Segmenter` / `Intl.NumberFormat` constructed at module level** — `util/locale.ts:55`, `prompt/display.ts:3`, `ui/file-path.tsx:5`, `latex/src/layout.ts:17`, `feature-plugins/prompt/footer.tsx:7`, `sidebar/context.tsx:5`. Fine in browsers.
- **`import open from "open"`** at `util/src/open.ts:1`, statically reached from `app.tsx:87`. The package is not installed here, so its import-time behaviour is **not determined**; it is a Node package and must be aliased.
- **`client/src/effect/service.ts:3,6,7`** — statically pulls `service-contender.ts` (`node:child_process`), `pty-handoff.ts` (`node:fs/promises`), `service-probe.ts` (`node:os`, `node:path`). No top-level calls; the modules just need to resolve.
- **OpenTUI**:
  - `core/src/platform/assets.ts:9` — `registerEnvVar("OTUI_ASSET_ROOT")`.
  - `core/src/platform/worker.ts:89-90,117` — `getBuiltinModule("node:worker_threads")` probe, then picks `globalThis.Worker` if present.
  - `core/src/platform/runtime.ts:38-41` — reads `globalThis.Bun` and falls back to portable implementations.
  - `@opentui/solid/index.ts:2` — statically imports `@opentui/core/testing`, which imports `stream` (`Readable`/`Writable`).

### 1.3 `Bun.*` / `bun:` uses

| Site | Purpose | Class |
|---|---|---|
| `tui/src/component/migration-overlay.tsx:19,26` | `await Bun.sleep(1_000)` in `onMount`; `<MigrationOverlay />` is always mounted (`app.tsx:1398`) and polls `api.migration.v1.status` | **E** — must shim `Bun.sleep` (or patch); otherwise a ReferenceError inside a mount effect on every launch |
| `tui/src/util/string-width.bun.ts:1` | `Bun.stringWidth` | **S** — use node variant |
| `tui/src/component/prompt/local-attachment.ts:73-76` | `Bun.file(file).exists()/size/slice().arrayBuffer()` to read a pasted local file path as an attachment; called from `component/prompt/index.tsx:1440` on paste | **S/A** — only when pasted text resolves to a path; stub to throw "does not exist" |
| `tui/src/editor-zed-sqlite.bun.ts:1` | `bun:sqlite` for Zed selection DB | **S** stub (use is **A**: needs `ZED_TERM`/`TERM_PROGRAM=zed`) |
| `tui/src/plugin/runtime-plugin-support.bun.ts`, `plugin/src/runtime.ts:13-37`, `plugin/src/runtime-modules.ts:9-59` | `Bun.plugin`, `Bun.resolveSync`, `Bun.Glob`, `import.meta.dir` for external plugin loading | **A** — bun condition only; `ensurePluginRuntime` returns `{}` when `typeof Bun === "undefined"` |
| `util/src/runtime/import.bun.ts:8` | `Bun.resolveSync` in `resolveModule` | **A** — only via `Host.resolve` for external plugins |
| `plugin/src/source.bun.ts:29,45,59` | `Bun.Transpiler`, `Bun.resolveSync` | **A** — dynamic, local plugins only |
| `attention-sounds.bun.ts` | `with { type: "file" }` imports | **S** |

A fake `Bun` global makes `plugin/src/runtime.ts:13` and OpenTUI `platform/runtime.ts:38` take their Bun branches. Either provide `sleep`, `stringWidth`, `stripANSI`, `write` (OpenTUI's `BunLike`) or patch the two opencode sites instead.

### 1.4 Node built-ins, by use site

**`fs` / `fs/promises`**

| Site | Purpose | Class |
|---|---|---|
| `tui/src/context/storage.tsx:53` `mkdirSync`; `:63` `readFileSync`; `:116` `fs.watch` | Persisted TUI state directory, created synchronously when `<StorageProvider>` mounts (`app.tsx:321`). `watch` is in try/catch and degrades. | **E** — needs a sync-capable fs shim; `watch` may throw |
| `tui/src/util/persistence.ts:5-30` | `readFile`, `writeFile`, `appendFile`, `mkdir`, `rename`, `rm` for all persisted files; temp name uses `process.pid` + `crypto.randomUUID()` | **E** (memory, IndexedDB or OPFS backing) |
| `util/src/flock.ts:149-218,320` | Lock directories under `<state>/locks` or `<state>/<channel>/locks`: `mkdir(mode)`, `writeFile({flag:"wx"})`, `stat`, `utimes`, `rm`, `os.hostname()`, `process.pid`, `crypto.randomUUID/randomBytes`. Used by every `storage.store` update and by model preferences. | **E** as API; semantics can be a trivial in-process mutex |
| `tui/src/model-preference.ts:155` | `fs.watch(dirname(model.json))` on subscribe, **not** in try/catch; `.on("error")` is attached | **S** — stub must return `{ on(), close() }`, not throw |
| `tui/src/config/index.tsx:358` | `fs.watch(dirname(host.path))` only if `input.config.path` is set | **A** — omit `config.path` |
| `tui/src/plugin/discovery.ts:15,28,41` | `stat`/`readdir` for `<config>/plugins` and `.opencode/plugins`; called at `app.tsx:218` | **E** as API — see error-code note below |
| `tui/src/util/config-directories.ts:21` | `stat(<ancestor>/.git|.hg)` to find project root | **E** as API (same note) |
| `tui/src/theme/discovery.ts:8,17` | `readdir`/`readFile` of `<dir>/themes/*.json`; ENOENT is handled | **S** |
| `tui/src/plugin/context.tsx:336,343`, `plugin/watch.ts:33-84` | `stat`, `fs.watch`, `lstat`, `realpath`, `existsSync` for external plugin targets | **A** — only with configured or discovered plugins |
| `plugin/src/source.ts:1` | `readFileSync`/`readdirSync` for plugin fingerprints | **A** |
| `tui/src/editor.ts:18,35,37` | Temp file for `$EDITOR` | **A** |
| `tui/src/editor.ts:52,59,72` | `readdirSync`/`readFileSync`/`statSync` on `~/.claude/ide/*.lock`; whole thing is in try/catch and returns undefined | **S** |
| `tui/src/editor-zed.ts:199` | `statSync` on Zed db | **A** |
| `tui/src/audio.ts:28` | `readFile(soundPath)` then `Audio.loadSound` | **S/A** |
| `tui/src/routes/session/index.tsx:159-160,1252-1256` | Session export writes to `os.tmpdir()/session-<uuid>.md|json`; the "copy" action uses the clipboard instead | **A** (or map to a download) |
| `tui/src/component/devtools-bar.tsx:180,222` | Debug dump to tmpdir | **A** |
| `tui/src/util/path.ts:8` | `realpathSync.native` only when platform is `win32` (`routes/session/index.tsx:3510`) | **A** |
| `util/src/global.ts:69,73` | `fs.promises.mkdir` ×7 and `realpath(tmp)` inside the `Global.node` layer | **A** — provide `Global.Service` directly (1.5) |
| `client/src/effect/service.ts:154-157,195` (Effect `FileSystem`), `client/src/pty-handoff.ts` | Local service registration file | **A** — never invoked with a remote endpoint |

Error-code note: `localPluginDirectories` and `localProjectDirectory` only swallow errors whose `.code` is `ENOENT` or `ENOTDIR` (`config-directories.ts:32-36`). They run under `Effect.promise` at `app.tsx:218`, so any other rejection becomes a defect and kills startup. The fs shim must throw Node-style errors with `code: "ENOENT"`.

**`path`** — about 38 import sites (pure). `node:path` `win32` is used in `util/path.ts:2`. **E**; any `path-browserify`-style polyfill needs `win32` (or a stub) and `relative`/`resolve`, which rely on `process.cwd()`.

**`os`**

| Site | Purpose | Class |
|---|---|---|
| `util/src/global.ts:17`, `global-roots.ts:4`, `global-roots.workerd.ts` | `homedir`, `tmpdir` | **E** (module eval) |
| `util/src/flock.ts:209` | `hostname` | **E** as API |
| `tui/src/util/system.ts:12` | `release()`, `process.arch` — debug dialog and error report (`dialog-debug.tsx:30`, `error-component.tsx:228`) | **S** |
| `tui/src/routes/session/index.tsx:16` | `EOL`, `tmpdir` | **S** |
| `tui/src/editor.ts:17,45`, `editor-zed.ts:190-191` | `tmpdir`, `homedir` | **S** |
| `tui/src/component/devtools-bar.tsx:4` | `tmpdir` | **A** |
| `client/src/service-probe.ts:1,40` | `homedir` in `fallback()` | **A** |

**`child_process`**
- `tui/src/editor.ts:24` — `spawn($VISUAL|$EDITOR …)` with inherited stdio; called from `component/prompt/index.tsx:558`. Returns early if neither env var is set (`editor.ts:15-16`). **A**.
- `client/src/service-contender.ts:19` — spawns `opencode serve --service`. **A**.

**`crypto`**
- `util/src/hash.ts:1` — `createHash("sha1"|"sha256")`. Used by flock (lock key) and plugin source fingerprints. **E** — needs a *synchronous* hash (WebCrypto is async). Exact call sites inside flock were not traced.
- `util/src/flock.ts:3` — `randomBytes`, `randomUUID`. **E**.
- Global `crypto.randomUUID()` at `terminal-pane.tsx:39`, `persistence.ts:24`, `devtools-bar.tsx:180`, `session/index.tsx:1254`. Browser-native.

**`url`**
- `tui/src/component/prompt/autocomplete.tsx:2,249,456` — `pathToFileURL` builds `file://` URIs for @-mentioned files. **E** (trivial polyfill).
- `tui/src/plugin/context.tsx:18`, `plugin/src/source.ts:2`, `util/src/runtime/import.*.ts`. **A**.

**`node:module`, `node:vm`** — `attention-sounds.node.ts`, `util/src/runtime/import.node.ts`. Avoid by variant choice.

**`node:perf_hooks`** — `devtools-bar.tsx:6,111` `monitorEventLoopDelay`; also `process.cpuUsage()`/`process.memoryUsage()` at `:112-125`. Module import is static (stub needed). Runtime use is gated by `<Show when={devtools() …}>` (`app.tsx:1389`), where `devtools = config.data.debug?.devtools ?? app.channel === "local"` (`app.tsx:458`). **A** — pass a channel other than `"local"`.

**`Buffer` global**
- `client/src/service-probe.ts:96` — `Buffer.from(user+":"+pass).toString("base64")` in `Service.headers`, called at `app.tsx:211`. **E** whenever the endpoint has `auth` (or build the header yourself with `btoa`).
- `tui/src/component/terminal-pane.tsx:106,114,181,223,360` — PTY frames. **E** for terminal panes.
- `tui/src/clipboard.ts:40` — image paste. **S**.
- `component/prompt/local-attachment.ts:43,55,76,170`, `feature-plugins/system/diff-viewer-image.tsx:53`. **S**.
- OpenTUI imports `Buffer` from `node:buffer` in `lib/parse.keypress.ts` and `lib/stdin-parser.ts`.

**`performance.now()`** — `ui/animation.ts`, `terminal-pane.tsx:197`, `context/theme.tsx:289`. Browser-native.

### 1.5 `process.*`

| Site | Use | Class |
|---|---|---|
| `tui/src/app.tsx:209,360,548,1125`; `ui/dialog.tsx:222`; `component/dialog-config.tsx:305`; `devtools-bar.tsx:92` | `process.platform !== "win32"` (terminal suspend, copy-on-select default) | **S** — set `"linux"` |
| `app.tsx:332` | `platform` passed to `TuiTerminalEnvironmentProvider` | **S** |
| `app.tsx:213` | `process.cwd()` is **sent to the server**: `api.file.list({ location: { directory: process.cwd() } })`, falling back to `api.location.get()` on any failure | **E** — make `cwd()` a real server-side directory, or let it fail into the fallback |
| `app.tsx:218,315`; `context/theme.tsx:69`; `plugin/context.tsx:104`; `editor.ts:25`; `editor-zed.ts:41` | `process.cwd()` for local plugin/theme discovery and `paths.cwd` | **E** as API |
| `app.tsx:254` | `process.env.OPENCODE_DRIVE` | **A** (leave unset) |
| `app.tsx:338-352` | `OPENCODE_STORY`, `OPENCODE_ROUTE` (JSON initial route), `OPENCODE_FAST_BOOT` | **S** (optional knobs) |
| `app.tsx:286-287` | `process.on/off("SIGHUP")` | **S** no-op |
| `context/theme.tsx:72-73` | `process.on/off("SIGUSR2")` theme refresh | **S** no-op |
| `app.tsx:1128-1129` | `process.once("SIGCONT")`, `process.kill(0,"SIGTSTP")` in the `terminal.suspend` command | **A** unless the user invokes it; stub `kill` |
| `app.tsx:449-450` | `process.stderr.write` / `process.stdout.write` for exit reason and epilogue after teardown | **S** |
| `util/error.ts:12` | `process.exitCode = …` | **S** |
| `config/index.tsx:327` | `(options.environment ?? process.env).HERDR_ENV` | **S** |
| `context/editor.ts:117,121` | `CLAUDE_CODE_SSE_PORT`, `OPENCODE_EDITOR_SSE_PORT`, `ZED_TERM`, `TERM_PROGRAM` | **S** |
| `editor.ts:15,27`; `editor-zed.ts:189` | `VISUAL`/`EDITOR`, `OPENCODE_ZED_DB` | **A** |
| `util/system.ts:5-18` | `platform`, `arch`, `TERM_PROGRAM`, `TERM`, `TMUX`, `STY` | **S** |
| `util/persistence.ts:24`, `util/src/flock.ts:208` | `process.pid` | **S** |
| `devtools-bar.tsx:112-125` | `cpuUsage`, `memoryUsage` | **A** |
| `plugin/builtins.ts:29` | `OPENCODE_STORY` | **S** |
| `util/src/global.ts:17,79`, `global-roots.ts:5-8` | `OPENCODE_TEST_HOME`, `OPENCODE_CONFIG_DIR`, `XDG_*` | **E** (module eval) |
| `client/src/effect/service.ts:172,175`, `service-contender.ts:23`, `service-probe.ts:40` | `process.kill`, `process.env` | **A** |

Not used in the TUI closure: `process.argv`, `chdir`, `exit`, `hrtime`, `nextTick`, `versions`, `stdin`. OpenTUI's own `process` usage was not inventoried (you said you have the renderer covered); note `core/src/testing/test-renderer.ts:84,363-364` uses `process.nextTick` and `process.stdout.columns/rows`.

### 1.6 Effect platform services and `Global`

- **The TUI itself uses no Effect platform services.** There is no `FileSystem`, `Path`, `ChildProcess`, `HttpClient` or `@effect/platform-node` in `packages/tui/src`. `run` uses only `Effect`, `Latch`, scopes and `Effect.tryPromise`.
- **`client/src/effect/service.ts`** imports `FileSystem` from `effect` and uses it only in `read()` (`:154`) and `terminate()` (`:195`), i.e. `discover`/`incumbent`/`ensure`/`stop`. The TUI only calls `Service.headers`, which is re-exported from `service-probe.ts` and is pure apart from `Buffer`.
- **`run` requires only `Global.Service`** (`app.tsx:207`) and reads four fields:
  - `global.config` → `localPluginDirectories` (`:218`) and `createThemeSource` (`:382`)
  - `global.home` → `TuiPaths.home` (`:316`)
  - `global.state` → storage root and all persistence files (`:317`)
  - `global.data + "/worktree"` (`:318`)
- **`Global.Interface`** (`util/src/global.ts:35-45`): `home, data, cache, config, state, tmp, bin, log, repos`, all strings.
- **`Global.node`** = `makeGlobalNode({ service, layer, deps: [] })`. The layer runs `acquire`, which does `fs.promises.mkdir` on data/config/state/log/bin/repos/tmp, then `fs.promises.realpath(tmp)`, and honours `OPENCODE_CONFIG_DIR`.
- **`LayerNode`** (`util/src/effect/layer-node.ts`) is a pure Effect `Layer` graph compiler with no platform dependency. The CLI wires it as `Effect.provide(LayerNode.compile(Global.node))` (`cli/src/commands/handlers/default.ts:155`).
- **Simplest browser wiring**: skip the layer and provide the value directly. `cli/test/cors.test.ts:40` does exactly this: `Effect.provideService(Global.Service, Global.make({ config, state }))`. You would write `run(input).pipe(Effect.provideService(Global.Service, Global.make({ home, data, config, state, … })))`. `Global.make` still reads `Path.*` defaults, so the module-eval constraints in 1.2 remain.
- **The CLI host** additionally uses `FileSystem`, `Npm.Service`, `Config.Service`, `Updater.Service` to build `TuiInput` (`default.ts:88-143`). All of that is host-side and replaceable; see 1.8.

### 1.7 Feature families

**Clipboard**
- `tui/src/clipboard.ts:13-20` composes `createHostClipboard()` (OpenTUI native backend: `core/src/lib/host-clipboard.native.ts:77` calls `resolveRenderLib()`) with `createRendererClipboardAdapter(renderer)` (OSC 52 via `renderer.copyToClipboardOSC52`, `core/src/lib/clipboard.ts:308-331`).
- It is created unconditionally at `app.tsx:267-273` inside the renderer scope. **E** as a call.
- Writes use `destination: "all-available"` and succeed if host is written **or** terminal is "attempted" (`clipboard.ts:55-61`), so OSC 52 alone is enough for copy.
- Read prefers `image/png` then `text/plain` from the host backend. With your `lib-wasm.zig` (no host clipboard), whether `createHostClipboard()` fails at construction or only on use is **not determined**; I did not read `host-clipboard.internal.ts`.
- Bracketed paste is separate and goes through stdin.

**Open URL**
- `util/src/open.ts` wraps the `open` npm package; `openUrl` accepts only http(s).
- Call sites: `app.tsx:1089` (docs), `app.tsx:1337` (clicked link), `ui/link.tsx:28`, `component/dialog-integration.tsx:212,665,1208` (OAuth/integration flows), `routes/session/form.tsx:481`.
- `openPath` at `ui/working-directory-actions.tsx:42`.
- **S** — alias `open` to `postMessage` → `window.open` on the main thread. This is functionally important for provider login flows.

**External editor** — `tui/src/editor.ts:14-41`: temp file, `renderer.suspend()`, `spawn`, read back. No-op when `$VISUAL`/`$EDITOR` are unset. **A**.

**Editor integration** — `context/editor.ts`, mounted at `app.tsx:391`.
- With no `CLAUDE_CODE_SSE_PORT`/`OPENCODE_EDITOR_SSE_PORT` and no lock file it stays "disabled" and schedules reconnect polling; the reconnect cadence was not read. **S**.
- If it did connect it would use `new WebSocket(url, { headers: {...} })` (`context/editor.ts:393-397`), a non-browser constructor form. **A**.

**Audio / attention**
- `tui/src/audio.ts` uses OpenTUI `Audio.create` (native miniaudio through `resolveRenderLib`, `core/src/audio.ts`) plus `readFile(path)`.
- `getAudio()` catches creation failure and returns null; `loadSoundFile` then returns null; `attention.ts:113-119` tolerates that.
- Notifications use `renderer.triggerNotification(message, title)` (native call, `core/src/renderer.ts:1959`), which emits terminal escape sequences.
- **S** — sounds silently disabled if native audio symbols are absent. Whether `Audio.create` throws or traps with your wasm lib is **not determined**.

**Terminal title** — `renderer.setTerminalTitle(...)` at `app.tsx:605-616` and `util/renderer.ts:4` (native call that emits OSC to stdout). Toggle via `config.terminal.title`. **S**; nothing OS-level.

**Plugin loading** — `PluginProvider` is always mounted (`app.tsx:397`).
- Builtins need nothing platform-specific.
- External plugins come from three sources: (a) `discoverPluginTargets(directories)` over local dirs (ENOENT → `[]`); (b) server-reported TUI plugins (`plugin.features.tui === true`, source `package` or `local`), which resolve via `input.packages.prepare(spec, false)` then `Host.resolve` → `resolveModule`; (c) `config.data.plugins`.
- With the workerd `#runtime-import` variant or a rejecting `packages.prepare`, external plugins become per-plugin failures recorded in state. Server-reported ones are `optional: true`, but a thrown error is still recorded as "failed" (`plugin/context.tsx:345-378`); it is not fatal.
- `PackageSource.prepare` is where npm installs happen on the CLI (`default.ts:139-141`). **A** — supply a rejecting stub.

**Tree-sitter / syntax highlighting**
- Used by `<code>`, `<markdown>`, `<diff>` renderables (`routes/session/message-parts.tsx:98,182`, `routes/session/index.tsx:2083,3003`, `permission.tsx:97`, `component/patch-diff.tsx:107,199`) and directly by `getTreeSitterClient().highlightOnce(...)` at `component/patch-diff.tsx:156`.
- OpenTUI `core/src/lib/tree-sitter/client.ts:126-128` creates `new PlatformWorker(workerPath)`. The path comes from `options.workerPath` → `env.OTUI_TREE_SITTER_WORKER_PATH` → global define `OTUI_TREE_SITTER_WORKER_PATH` → `resolveDefaultTreeSitterWorkerPath(...)` with an `existsSync` fallback to `parser.worker.ts` (`:202-220`).
- `platform/worker.ts:153-162` prefers `globalThis.Worker`, then `node:worker_threads`, then `UnsupportedWorker`. Nested workers inside a Web Worker would be picked up.
- The worker (`parser.worker.ts`) imports `web-tree-sitter` (peer dep 0.25.10), `path`, `fs/promises` `mkdir`, and caches downloads under `<dataPath>/tree-sitter` using `readFile`/`writeFile`/`mkdir` (`download-utils.ts:44-71`).
- `dataPath` is `getDataPaths().globalDataPath` = `XDG_DATA_HOME` or `os.homedir()/.local/share/<appName>` (`lib/data-paths.ts:90-97`).
- Grammar sources:
  - OpenTUI bundled defaults (`default-parsers.ts`: javascript, typescript, markdown, … under `assets/<lang>/…`), resolved through `#opentui/runtime-assets` to filesystem paths.
  - opencode's extra parsers (`tui/src/parsers-config.ts`), fetched with global `fetch` from GitHub release / raw.githubusercontent URLs at first use.
- Whether those GitHub URLs are CORS-fetchable from a browser worker was **not determined**. Release downloads redirect to another host; mirror them same-origin to be safe.
- The runtime wasm comes from `resolveTreeSitterWasm()` (`web-tree-sitter/tree-sitter.wasm`).
- **S** if you accept no highlighting (failures are caught at `patch-diff.tsx:159`; whether `<code>`/`<markdown>` degrade as cleanly was not verified). Otherwise it needs a browser runtime-assets variant, a worker URL and an fs shim inside the worker.

**Shiki** — not used by the TUI. No reference in `packages/tui/src` or `@opencode/theme/tui`; it is used by web packages only.

**Images**
- `<image>` renderable at `routes/session/index.tsx:2525`, `component/prompt/index.tsx:1709`, `component/dialog-image-preview.tsx:49`, `feature-plugins/system/diff-viewer-image.tsx:67`, fed by `data:` URIs.
- OpenTUI `core/src/image.ts` imports `open`/`stat` from fs, presumably for path sources; not verified.
- No photon/sharp on the TUI side; `#photon-wasm` is `@opencode/core` server-side only.
- **S/A** depending on terminal graphics support in your emulator.

**SQLite (Zed)** — `tui/src/editor-zed.ts` reads Zed's `db.sqlite` to find the active editor selection. Only polled when `ZED_TERM=true` or `TERM_PROGRAM=zed` (`context/editor.ts:121,178-204`). **A**; the import needs a stub.

**Storage / persistence** — all under `global.state` (CLI: `$XDG_STATE_HOME/opencode`, i.e. `~/.local/state/opencode`).

| File | API | Site |
|---|---|---|
| `<state>/<channel>/tui/<key>.json` | `createStorage`: sync `readFileSync` load, `Flock.withLock` + `writeJsonAtomic` (tmp + rename), locks in `<state>/<channel>/locks`, `fs.watch` live reload | `context/storage.tsx:47-141` |
| `<state>/prompt-history.jsonl` | `readText`/`appendText`/`writeText` | `prompt/history.tsx:93-139` |
| `<state>/frecency.jsonl` | same | `prompt/frecency.tsx:42-75` |
| `<state>/prompt-stash.jsonl` | same | `prompt/stash.tsx:40-86` |
| `<state>/model.json` (+ `<state>/locks`) | `createModelPreferenceRepository`: `readJson`, Flock, `writeJsonAtomic`, `fs.watch` | `context/local.tsx:154`, `model-preference.ts:103-175` |
| `<state>/session.json` (pinned sessions) | `readJson`/`writeJsonAtomic` | `context/local.tsx:514-530` |

- Storage keys: `tabs` (`context/session-tabs.tsx:72`), `layout` (`app.tsx:501`, `component/session-frame.tsx:42`), `session-terminal-selection` (`context/session-terminals.tsx:22`), `update-notifications` (`context/update-notification.tsx:37`), `system-theme` (`context/theme.tsx:129`), `directory-recents` (`prompt/directory-recents.ts:13`), `plugin.<id>.<key>` (`plugin/api.tsx:201`), `view` and `getting-started` (sidebar plugins).
- `<channel>` is `input.app.channel` and must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (`storage.tsx:41-45`).
- I found no separate "kv" state file in v2.0.26; the storage context above replaces it.
- `<data>/worktree` is only a path string passed to `TuiPaths.worktree`.

### 1.8 `TuiInput` surface a browser host must supply

From `app.tsx:180-203`:
- `app: { name, version, channel }`
- `server.endpoint: { url, auth?: { type: "basic", username, password } }`; `server.service` optional — omit it and reconnect just retries the same endpoint.
- `args: { model?, agent?, prompt?, continue?, sessionID?, newSessionID?, fork?, auto? }`
- `config: { path?, get(): Promise<Info>, update(fn): Promise<Info> }`. On the CLI this is the *local* TUI config file service, so you need your own (return `{}`-ish `Info`; omit `path`). The `Info` schema is at `tui/src/config/index.tsx:69-250`.
- `updater?` — omit.
- `packages: { prepare(spec, install?) }` — a rejecting stub is acceptable.
- `environment?` — on the CLI this is `undefined` for `--server` (`default.ts:142`).
- `terminalHandoff?` — a hook that returns a pre-created `CliRenderer`, its `ThemeMode`, and a `complete` callback (`app.tsx:194-201,219,248-253,438-441`). This is the cleanest injection point for your own renderer with custom stdin/stdout. Without it, `run` calls `createCliRenderer(options)` with no stdin/stdout, so it would use process defaults.
- `log?`

After render, `run` calls `renderer.waitForThemeMode(1000)` unless the handoff provides `mode` (`app.tsx:291`).

---

## Part 2 — Network

### 2.1 HTTP client

- **Implementation**: `packages/client/src/promise/generated/client.ts:301-336` is a generated plain-`fetch` client. `const fetch = options.fetch ?? globalThis.fetch`; `ClientOptions = { baseUrl, fetch?, headers? }` (`:273-277`), so a custom `fetch` is injectable.
- **Wrapping**: `OpenCode.make` (`client/src/promise/client.ts:10-18`) wraps the raw client with `SharedEvents` and RPC helpers.
- **Not used on the TUI path**: Effect `HttpClient`, unix sockets, TLS options, `duplex`, streamed request bodies, `keepalive`, `credentials`, `mode`. `client/src/effect/api.ts` exists but the TUI does not import it.
- **URL building** is relative to `baseUrl` and preserves any path prefix (`:304-308`), so a reverse-proxy sub-path works.
- **Headers set** (`:310-316`): `options.headers` (the Authorization header), descriptor headers (only `x-opencode-ticket: 1` on two endpoints), per-call headers, and `content-type: application/json` (or `application/octet-stream` for binary bodies) when a body exists. No `Host`, `User-Agent` or other forbidden headers. No `x-opencode-*` besides the ticket header.
- **Bodies**: `JSON.stringify(...)` or a raw `BodyInit` for `binaryBody` (`:323-328`).
- **Errors**: `ClientError` with reasons `Transport | UnexpectedStatus | UnsupportedContentType | MalformedResponse | SseEventTooLarge`.

### 2.2 Event stream

- **Endpoint**: `GET /api/event`, SSE read with a `fetch` body reader. No `EventSource`, no WebSocket.
  - `client.ts:1705-1709`: `sse({ method: "GET", path: "/api/event", … })`
  - The parser (`:364-417`) requires `content-type: text/event-stream`, uses `response.body.getReader()` + `TextDecoder`, splits on blank lines, joins `data:` lines and `JSON.parse`s them. Max event size 16 MiB.
- **Sharing**: `shared-events.ts` multiplexes one underlying stream to many subscribers (4096-event queue per subscriber) and replays the cached `server.connected` event to late subscribers.
- **Server heartbeat**: `server/src/handlers/event.ts:21` emits `: heartbeat\n\n` every 15 seconds.
- **Reconnect** (`client/src/solid/connection.ts`, created at `tui/src/context/client.tsx:25`):
  - Connect timeout 2 s (`:32,81`).
  - The first event must be `server.connected` (`:106`).
  - Idle watchdog 45 s with no bytes aborts and reconnects (`:35,87-92`).
  - Fixed 1 s delay between attempts (`:33,181`); the attempt counter resets after a connection that lasted at least 1 s (`:158`).
  - If `options.reconnect` exists (managed service only) it is called to re-resolve the endpoint (`:165-175`).
  - Events are batched to Solid every 10 ms (`:68-73`).
  - `pageLifecycle` (the `window`/`document` listeners at `:219-240`) is opt-in and the TUI does not set it, so there is no DOM access in a worker.
- **RPC**: `client/src/promise/rpc.ts` uses `raw.rpc.call` (plain request; path not checked) plus the shared event stream filtered on `rpc.<id>.<name>`. It uses `AbortSignal.any` and `Promise.withResolvers`, which need a recent browser.

### 2.3 Endpoint and auth

- **`Endpoint`** (`client/src/service.ts:2-14`): `{ url: string; auth?: { type: "basic"; username: string; password: string } }`.
- **`Service.headers(endpoint)`** (`client/src/service-probe.ts:93-98`):
  ```ts
  if (endpoint.auth === undefined) return undefined
  return { authorization: "Basic " + Buffer.from(endpoint.auth.username + ":" + endpoint.auth.password).toString("base64") }
  ```
- **Scheme**: HTTP Basic, username `opencode`, single header `authorization`.
- **CLI env vars**: `OPENCODE_PASSWORD`, falling back to `OPENCODE_SERVER_PASSWORD` (`cli/src/env.ts:10-11`). With `--server`, the CLI builds the endpoint from that env var and probes `GET /api/info` with a 5 s timeout (`cli/src/services/server-connection.ts:24-40`). There is no username env var.
- **Server-side accepted credentials** (`server/src/middleware/authorization.ts`):
  1. Query param `auth_token=<base64(user:pass)>`, checked first (`:11,33-34`).
  2. `Authorization: Basic …` (`:35-36`).
  3. A session cookie named `ServerAuth.sessionCookieName(host)`, honoured only for same-origin requests: `origin` absent or `URL.parse(origin).host === host` (`:63-70`).
- **401 behaviour**: JSON `{ _tag: "UnauthorizedError", message: "Authentication required" }`. `www-authenticate` is added only when `sec-fetch-mode` is absent or `navigate` (`:44-55`), so browser `fetch` gets no native credentials prompt.
- **Password is mandatory in the standalone server**: `server/src/process.ts:52-53` fails with "Missing server password". `opencode serve` generates a random one when none is configured and prints `server password <pw>` in the foreground when it did not come from env (`cli/src/server-process.ts:83-88,191-192`).
- **Unauthenticated exceptions** (`process.ts:186-196`, `authorization.ts:80-84`): pairing connect URLs (`/auth/connect/<code>`) and ticketed PTY connect URLs. `GET /api/info` before readiness still requires auth.

### 2.4 WebSocket / PTY endpoints

Yes, the TUI uses WebSockets for terminals.

- `tui/src/context/client.tsx:23,31` creates `createPersistentPtyClient(api, { url })`.
- `client/src/solid/pty.ts:44-65` then:
  1. `POST /api/experimental/persistent-pty/{ptyID}/connect-token` with header `x-opencode-ticket: 1` (plus the Basic header) → `{ ticket }`.
  2. Opens `ws(s)://…/api/experimental/persistent-pty/{ptyID}/connect?ticket=…&cursor=…&attachment_id=…&takeover=…&input_protocol=1` with **global `WebSocket`** (an `openSocket` hook exists but the TUI does not pass one), `binaryType = "arraybuffer"`.
- The ticket-in-query design exists because "browsers cannot set headers on WebSocket upgrades" (`authorization.ts:80`).
- **Consumers**: `tui/src/component/terminal-pane.tsx` (embedded terminal renderable, `Buffer` for frames) and `tui/src/context/session-terminals.tsx` (lists via `api.experimental.persistentPty.list`, listens for `persistent-pty.added/removed`, gated on `server.info().capabilities?.persistentPty !== false`).
- **Server origin checks** — both the token mint and the WS upgrade enforce `isAllowedRequestOrigin(origin, host, cors)`:
  - `server/src/handlers/persistent-pty.ts:99-103`: 403 Forbidden unless `x-opencode-ticket === "1"` and the origin is allowed.
  - `:111-112`: 403 on upgrade for a disallowed origin.
  - The `Origin` header on a WS upgrade is therefore checked against the same allow-list (same-host is also OK).
- **Non-persistent PTY API** (`createPtyClient`, `/api/pty/{id}/connect-token`, `/api/pty/{id}/connect`) exists in the client but is not referenced by the TUI.
- **Other WebSockets**: `context/editor.ts` (IDE MCP socket to `ws://127.0.0.1:<port>`, off by default) and the simulation control server (`ws` package, `OPENCODE_DRIVE` only).

### 2.5 Server CORS policy

`packages/server/src/cors.ts:3-20`:

```ts
const opencodeOrigin = /^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/
export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  if (input.startsWith("oc://renderer")) return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  if (opencodeOrigin.test(input)) return true
  return opts?.cors?.includes(input) ?? false
}
```

- **Applied** at `server/src/process.ts:71-74` (and identically in `server/src/fetch.ts:51`):
  ```ts
  (transform ? transform(app) : app).pipe(
    HttpMiddleware.compression(),
    HttpMiddleware.cors({ allowedOrigins: (origin) => isAllowedCorsOrigin(origin, options), maxAge: 86_400 }),
  )
  ```
- **Allowed by default**: no `Origin`; `http://localhost:<port>`; `http://127.0.0.1:<port>`; `oc://renderer…`; the Tauri origins; `https://*.opencode.ai`.
  - The localhost checks require a trailing `:`, so portless `http://localhost` (port 80) is not allowed.
  - `https://localhost:…` is not allowed.
  - Custom entries are exact-string matches.
- **How to allow more**:
  - Flag: `opencode serve --cors <origin>` (repeatable; `cli/src/commands/commands.ts:544-548`, "Additional allowed CORS origin (repeat for multiple origins)").
  - Persisted for the background service: `opencode service set cors "<o1>,<o2>"` (`cli/src/services/service-config.ts:270-280`). Validation rejects `*`, `null`, non-http(s), trailing slash, path, query, fragment and userinfo (cases in `cli/test/cors.test.ts:57-73`).
  - Precedence: flag overrides config (`cli/src/server-process.ts:102`: `cors: options.cors ?? config.cors`).
  - Embedders: `ServerOptions.cors: string[]` (`server/src/options.ts:17`).
  - There is no CORS env var.
- **`packages/cli/test/cors.test.ts`** covers only config persistence/validation and flag parsing. It does not exercise HTTP preflight behaviour.

### 2.6 Credentials and preflight

- **`Access-Control-Allow-Credentials` is not needed** for the TUI client. It sends an explicit `Authorization` header and never sets `credentials: "include"`. Only the cookie path would need it, and that is same-origin-only by design.
- **Every TUI request is non-simple** (`authorization`; `content-type: application/json` on bodies; `x-opencode-ticket` on token mints), so every cross-origin call triggers an `OPTIONS` preflight, cached for 24 h via `maxAge: 86_400`.
- **Not determined (Effect source unavailable)**:
  - Whether `HttpMiddleware.cors` with only `allowedOrigins` + `maxAge` reflects requested headers or uses a fixed allow-list.
  - Whether it sets `Access-Control-Allow-Credentials`.
  - Whether it answers `OPTIONS` itself before the inner app.
- **Why that ordering matters**: `dispatch()` (`process.ts:173-200`) returns 401 for any unauthenticated request other than pairing/ticket URLs, and preflights carry no `Authorization`. The middleware order (cors outermost) and the comment at `server/src/handlers/pty.ts:123-124` ("The custom header forces a CORS preflight, so cross-origin browser pages cannot mint tickets without passing the server's origin policy") strongly suggest preflights are answered by the middleware and that the first-party web app already works cross-origin this way. That is **inferred**; a single `curl -X OPTIONS` with `Origin` and `Access-Control-Request-Headers: authorization,content-type,x-opencode-ticket` against a running server would settle it.
- **Fallback if preflight is a problem**: `?auth_token=<base64(user:pass)>` is accepted on any request and avoids the `Authorization` header (JSON `content-type` would still preflight). It can be added through the injectable `fetch`.
- **SSE over `fetch`** only needs the normal CORS response headers. `HttpMiddleware.compression()` is in the chain; the browser handles `content-encoding` transparently. Whether compression buffers SSE was not checked.
- **Mixed content**: a page on `https://` cannot `fetch` `http://<lan-ip>` or open `ws://`. `http://localhost` / `127.0.0.1` are exempt in mainstream browsers. This is a deployment constraint, not something in the code.

### 2.7 `opencode serve` flags

`cli/src/commands/commands.ts:539-552` — "Start the v2 API and web server":
- `--hostname <string>` (optional; default `127.0.0.1`, or service config)
- `--port <int>` (optional; default is ephemeral for foreground, `ServiceConfig.defaultPort()` for `--service`)
- `--cors <origin>` (repeatable, non-empty)
- `--service` (boolean; background-service mode, reads persisted config, `chdir`s to home)
- `--stdio` (boolean; prints `{"url": …}` as JSON; removes the password env vars from the server process's own environment, `cli/src/server-process.ts:79-82`); mutually exclusive with `--service` (`handlers/serve.ts:9`)

There is **no `--password` flag**. The password comes from `OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD`, else random (foreground), else persisted service config (`opencode service set password …`; service keys are `disabled, remote, hostname, port, password, cors, env` at `service-config.ts:28`).

Related: `opencode pair [--url <http(s) url>] [--remote]` prints one-time browser/app pairing links (`commands.ts:517-537`). Top-level `--server <url>` / `--standalone` are on the default command (`commands.ts:15-24`).

---

## Part 3 — Existing browser-ish seams

**Bottom line**: nothing in either repo runs `@opencode/tui` or OpenTUI in a browser or on wasm today. The closest seams are (a) the Node/Vite build, (b) the headless Drive renderer, (c) `@opentui/ssh`'s stream-injection pattern, and (d) `TuiInput.terminalHandoff`.

### 3.1 `packages/simulation` (Drive)

- `Drive.create(options, version)` is in `simulation/src/frontend/simulation.ts:9-29`, reached only via `process.env.OPENCODE_DRIVE` (`tui/src/app.tsx:254-257`).
- `OPENCODE_DRIVE_RENDERER` (Effect `Config`, default `"visible"`) selects:
  - `"headless"` → `SimulationRenderer.create` → `createTestRenderer({...options, width, height, kittyKeyboard, [stdout: recording, bufferedOutput: "stdout"]})` from `@opentui/core/testing` (`frontend/renderer.ts:20-61`). This is a real `CliRenderer` on an in-memory screen, default 100×40, with an optional recording `Timeline` written to a file (`simulation/src/recording.ts` uses `node:fs`, `node:stream`).
  - otherwise → normal `createCliRenderer(options)`.
- It then starts `SimulationServer` — a JSON-RPC control **WebSocket server** using the `ws` package (`control-server.ts:53,60`) on `manifest.endpoints.ui` — and prints `opencode drive ui websocket: <url>` to stderr.
- `DriveManifest.resolve()` (`simulation/src/manifest.ts`) imports `node:os`/`node:path`; where the manifest comes from was not read.
- It runs outside a real terminal but still on Bun/Node with the native lib, and needs a listening socket, so it cannot be used directly in a browser.
- `cli/vite.node.config.ts:61-67` has a `simulationGraphPlugin` (`verifySimulationGraph(this.getModuleIds())`) that guards which simulation modules end up in the Node bundle; details not read.

### 3.2 Node build: `packages/cli/vite.node.config.ts` + `script/build-node.ts`

This is the existing proof that the TUI source graph compiles without Bun, via Vite and `vite-plugin-solid`.

- **Entry**: `build.ssr: "src/node/index.ts"`, `target: "node26"`, `outDir: "dist-node"`, `minify: true`, `ssr: { noExternal: true }`, output `format: "esm"`, `entryFileNames: "opencode.mjs"`, `inlineDynamicImports: true`. Everything is bundled; there are no externals.
- **`resolve.conditions: ["node"]`**, which picks the `node` variant of every map in 1.1.
- **Aliases** (`:108-116`):
  - `/^solid-js\/store$/` → `solid-js/store/dist/store.js`
  - `/^solid-js$/` → `solid-js/dist/solid.js` (the client build; otherwise the `node` condition would resolve Solid's server build)
  - `/^ws$/` → `<ws>/wrapper.mjs`
- **JSX**: `solid({ solid: { generate: "universal", moduleName: "@opentui/solid" } })` plus `esbuild: { jsx: "automatic" }`.
- **Defines** (`:276-284`): `OPENCODE_VERSION`, `OPENCODE_CLI_NAME: "opencode2-node"`, `OPENCODE_CHANNEL`, `OPENCODE_ARTIFACT: "cli-node"`, `OPENCODE_LIBC` (`"glibc"` on linux else `undefined`), `FFF_LIBC` (`"gnu"` on linux else `undefined`), `process.env.WS_NO_BUFFER_UTIL: "1"`.
- **Custom plugins**:
  - `appAssetsPlugin` — virtual `virtual:opencode-app-assets` reading the web UI archive from SEA or `OPENCODE_NODE_ASSETS_DIR`.
  - `rawTextPlugin` — `.md`/`.txt` inlined as strings, `enforce: "pre"`.
  - `runtimeRequirePlugin` — rewrites Turndown's `require('@mixmark-io/domino')`.
  - `fffNodePlugin` — stubs the `ffi-rs` native binding and the FFF binary lookup.
  - `simulationGraphPlugin`.
- **Banner prelude** (`nodePrelude`, `:127-249`):
  - `createRequire` shims and `__filename`/`__dirname`.
  - `node:module.registerHooks` mapping `@opencode/plugin*` specifiers to in-memory modules that read `globalThis[Symbol.for("opencode.plugin.v2.promise"|"…effect")]`.
  - SEA asset extraction to `tmpdir()/opencode-node-<uid>/<hash>-<platform>-<arch>`.
  - Env wiring: `OPENCODE_NODE_ASSETS_DIR`, **`OTUI_ASSET_ROOT`** (how OpenTUI finds its native lib, parser worker and tree-sitter wasm on Node), `OPENCODE_NODE_PTY_PATH`, `OPENCODE_PARCEL_WATCHER_PATH`, `OPENCODE_PHOTON_WASM_PATH`, `OPENCODE_TREE_SITTER_WASM_PATH`, `OPENCODE_TREE_SITTER_BASH_WASM_PATH`, `OPENCODE_TREE_SITTER_POWERSHELL_WASM_PATH`, `FFF_BINARY_PATH`, `OPENCODE_FFF_FFI_PATH`, `OPENCODE_PTY_BIN`, `OPENTUI_LIBC=glibc` on linux.
- **`script/build-node.ts`**: per-target loop (`:89-101`) of `collectNodeAssets(target)` (`script/node-assets.ts` uses `getNodeAssets` from `@opentui/core/node-assets` plus the audio mp3s listed in `cli/src/node/target.ts:42-46`) → hash → copy to `dist-node/assets` → write app archive → `build(mainConfig(input))` → `assertTextImportsInlined` → SEA packaging. Targets: linux x64, darwin arm64, win32 arm64/x64, and probably linux arm64 (list starts above line 36; not read).
- **`cli/src/node/index.ts`**: imports `./plugin-runtime.promise` and `./plugin-runtime.effect`, adds an EPIPE guard on stdout, then `await import("../index")`.
- **The Bun build** (`cli/script/build.ts:7,195`) uses `createSolidTransformPlugin` from `@opentui/solid/bun-plugin` and defines `process.env.OPENTUI_LIBC` on linux.

### 3.3 `packages/cli/dev/*` and root `dev:vite`

- **Root script**: `"dev:vite": "bun run --cwd packages/cli --conditions=browser dev/vite.ts"`. It still runs on Bun in a real terminal with the native OpenTUI lib; it is not a browser path.
- **Why `--conditions=browser`**: the README does not say. **Inferred**: it makes Bun resolve `solid-js` to its client build for the externally loaded parts.
- **`dev/vite.ts`**: `ensureSolidTransformPlugin()`; unless `argv[2] === "serve"`, it imports `./tui` and registers a Bun plugin overriding module `@opencode/tui` with `{ run }` from the Vite runner; then imports the normal CLI (`../src/index`).
- **`dev/tui.ts`**: Vite `createServer` rooted at `packages/tui`, `middlewareMode`, no HMR websocket.
  - Aliases `solid-js` → `solid-js/dist/dev.js` and `solid-js/store` → `solid-js/store/dist/dev.js`.
  - `vite-plugin-solid` with `{ hot: false, dev: true, solid: { generate: "universal", moduleName: "@opentui/solid" }, babel: { plugins: [[solid-refresh/babel, { bundler: "vite" }]] } }`.
  - A custom environment `native` with `consumer: "server"`, `resolve.conditions: ["bun","development","module"]`, `externalConditions: ["bun","node"]`.
  - `noExternal`: `solid-js`, `solid-refresh`, `@opentui/solid`, `@opentui/keymap`, `opentui-spinner`, `@solid-primitives/*`, `@opencode/plugin`, `@opencode/client`, `@opencode/latex`, `@opencode/merman`.
  - `external`: `@opentui/core`, `@opentui/core/testing`, `effect`, … (list continues past line 120; not read).
  - It redirects `tui/src/context/route.tsx` to `dev/route.tsx` to preserve the route across reloads.
- **`dev/entry.ts`**: loads `../../tui/src/index` through Vite and calls `host.mount(run)`. `dev/host.js` is a plain shared object outside Vite's module cache.
- **Takeaway**: `run` is already driven as a relocatable function with an injected `TuiInput` (`host.mount(app)` → `app({...input, …})`, `dev/tui.ts:25-35`), and the Vite + `vite-plugin-solid` universal config is the JSX recipe to reuse.

### 3.4 Web packages / ghostty-web

- **No web package renders the TUI.** There are no imports of `@opencode/tui` or `@opentui/*` in `packages/app`, `packages/web`, `packages/desktop`, `packages/session-ui`, `packages/ui` or `packages/plugin-browser`.
- **`ghostty-web`** is a dependency of `packages/app` and `packages/gui-extensions`, used in `packages/gui-extensions/src/terminal/{model.ts,renderer.tsx,terminal.tsx,serialize.ts}` and app e2e tests. It is the web app's own shell-PTY terminal widget, fed by the PTY WebSocket.
- **`patches/ghostty-web@0.3.0.patch`** (193 lines) patches `dist/ghostty-web.js` mouse handling: the modifier bit uses `altKey` instead of `metaKey`, and Shift bypasses mouse tracking in `handleMouseDown/Up/Move` so native selection works. The rest was not read.
- **Reusable**: ghostty-web is already vetted in this repo as a browser terminal emulator, including the shift-select behaviour the TUI expects. `packages/gui-extensions/src/terminal/*` is a working example of the ticketed PTY WebSocket from a browser.
- **`patches/solid-js@1.9.15.patch`** patches `cleanNode` in `dist/dev.*` (and presumably `solid.*`) to detach `owned`/`tOwned`/`cleanups` before iterating. A browser bundle must use the patched Solid.
- **Version note**: the opencode catalog pins `solid-js` 1.9.15 while `@opentui/solid` 0.5.17 declares peer `solid-js` 1.9.12 and depends on `babel-preset-solid` 1.9.12.

### 3.5 OpenTUI test renderer

- `core/src/testing/test-renderer.ts:361-375` (`setupTestRenderer`) constructs `new CliRenderer(stdin, stdout, width, height, { ...config, bufferedOutput: config.bufferedOutput ?? "memory" })`.
- stdin/stdout default to `createTestStdin()` / `createTestStdout()` from `testing/test-streams.ts`: Node `stream.Readable`/`Writable` subclasses with `isTTY`, `columns`, `rows`, `getColorDepth()`.
- **It needs the native lib.** The source comment says "Direct construction skips setupTerminal(); native bytes are routed to an explicit memory destination … CliRenderer still owns native renderer creation and applies the same useThread defaults as production construction." It is the same `CliRenderer` and the same `resolveRenderLib()` path; only terminal setup and the output sink differ.
- Other dependencies: `stream`, `process.nextTick` (`:84`), `process.stdout.columns/rows` as fallbacks (`:363-364`).
- `bufferedOutput: "memory"` vs `"stdout"` and an injected `stdout` (as Drive does) are the same seam you plan to use.
- `packages/core/package.json` exports `./testing` with only `types`/`bun`/`import` conditions (no `node`), and `@opentui/solid/index.ts:2` imports it statically, so it is always in the bundle.

### 3.6 `@opentui/ssh`

- Renderer-agnostic package (depends only on `@opentui/core` + `ssh2`) that turns each SSH session into a `CliRenderer` bound to custom streams. It is the best in-repo model for a non-process terminal.
- `ssh/src/bridge.ts:47-97` builds a flowing `Readable` stdin fed from channel data and a `Writable` stdout with mutable `columns`/`rows`.
- `:313-322` creates the renderer with:
  ```ts
  createRenderer({ stdin, stdout, width: cols, height: rows, exitOnCtrlC: false,
                   exitSignals: [], consoleMode: "disabled", targetFps: 30 })
  ```
- Resize is handled by updating `stdout.columns/rows` and calling `renderer.resize(cols, rows)` (`:233-234,330`).
- `exitSignals: []` (no process signal handlers) and `consoleMode: "disabled"` (do not patch the global console) are exactly the options a worker host wants.
- The opencode TUI's own options at `app.tsx:234-246` do not set them, so use `terminalHandoff` to pass a renderer you created.
- It still runs on Bun/Node with the native lib.

### 3.7 Compiling Solid JSX for OpenTUI

- **opencode tsconfig** (`packages/tui/tsconfig.json`): extends `@tsconfig/bun`; `"jsx": "preserve"`, `"jsxImportSource": "@opentui/solid"`, `lib: ["ESNext","DOM","DOM.Iterable"]`, `noUncheckedIndexedAccess: false`, `noUnusedLocals: true`, project reference to `../core`. Type-level only; TS does not transform JSX.
- **Bun preload**: `packages/tui/bunfig.toml` and `packages/cli/bunfig.toml` both have `preload = ["@opentui/solid/preload"]` (also under `[test]`). The root `bunfig.toml` has only install settings.
- **`@opentui/solid/preload`** → `scripts/preload.ts` → `ensureSolidTransformPlugin()` (`scripts/solid-plugin.ts:43-60`), which registers a Bun runtime plugin (`import { plugin } from "bun"`). The plugin:
  - Redirects `solid-js/dist/server.js` → `solid.js` and `solid-js/store/dist/server.js` → `store.js` via `onLoad` (`:76-89`).
  - Transforms every non-`node_modules` `.jsx`/`.tsx` file (`:91-107`) through `transformSolidSource`.
- **`scripts/solid-transform.ts`** (`:43-83` of the file) is the actual recipe: `@babel/core` `transformAsync` with `configFile: false`, `babelrc: false`, and presets
  - `["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }]` for `.jsx/.tsx`
  - `["@babel/preset-typescript"]` for `.ts/.tsx`
  - optional `babel-plugin-module-resolver` when a `resolvePath` is supplied.
  - It also exports `resolveNodeSolidRuntimeImport` mapping `solid-js` → `solid-js/dist/solid.js` and `solid-js/store` → `solid-js/store/dist/store.js`.
- **`@opentui/solid` exports**: `.` (`index.ts`), `./preload`, `./bun-plugin` (`scripts/solid-plugin.ts`), `./runtime-plugin-support[/configure]`, `./components`, `./jsx-runtime`, `./jsx-dev-runtime`. There are no conditional exports. `scripts/test-node-hook.mjs` and `scripts/test-node.ts` also exist (a Node loader path for tests; not read).
- **For a browser bundle** you need three things:
  1. Solid's universal JSX transform with `moduleName: "@opentui/solid"` — either `vite-plugin-solid` exactly as in `cli/vite.node.config.ts:267-272`, or `babel-preset-solid` as in `solid-transform.ts`.
  2. Solid's client runtime, not the server build. If you add a real `browser` condition, `solid-js` should resolve to its client build on its own; otherwise alias as the Node build does.
  3. `@opentui/solid`, `@opentui/keymap`, `opentui-spinner` and all workspace packages bundled from TS source; their `exports` point at `.ts`/`.tsx`.

### 3.8 Other OpenTUI facts relevant to a wasm host

- `core/src/platform/runtime.ts` already abstracts `Bun.sleep`/`stringWidth`/`stripANSI`/`write` with portable fallbacks, but imports `node:fs`, `node:fs/promises`, `node:path`, `node:url` at top level.
- `core/src/platform/worker.ts` abstracts Workers (global `Worker` first), and exports `WORKER_UNAVAILABLE` plus an `UnsupportedWorker` fallback class.
- **Top-level Node imports in core you will need shims for**: `events`, `stream`, `node:console`, `node:util`, `node:fs`, `node:path` (`console.ts`); `node:fs` (`renderer.ts`: `appendFileSync`, `writeFileSync`); `fs` (`zig.ts`: `existsSync`, `writeFileSync`); `os`, `path` (`lib/data-paths.ts`); `node:buffer` (`lib/parse.keypress.ts`, `lib/stdin-parser.ts`); `node:fs/promises`, `node:path`, `node:crypto` (`audio.ts`); `node:fs/promises` (`image.ts`); `node:util` (`renderables/composition/vnode.ts`); `bun-ffi-structs` (`zig.ts`, `zig-structs.ts`).
- `core/src/runtime-plugin.ts` and `runtime-plugin-support-configure.ts` import `"bun"` but are separate export subpaths, only reached through opencode's bun-variant `#runtime-plugin-support`.
- `packages/web` in OpenTUI is the Astro docs site. It imports `@opentui/core` in docs content and uses `@xterm/headless` for doc visuals; it does not run the renderer in a browser, as far as a file listing and grep show.

---

## Short list of hard blockers vs. stubs

**Must work (E)**
- `fetch` + streaming body reader, `WebSocket`, `AbortSignal.any/timeout`, `Promise.withResolvers`.
- `Buffer`, `path` (including `win32`), `os.homedir/tmpdir/hostname`.
- A sync-capable fs: `mkdirSync`, `readFileSync`, promises API, `rename`, `wx` flag, and errors carrying `code: "ENOENT"`.
- Synchronous `crypto.createHash` and `randomBytes`.
- `process.{env,cwd,platform,pid,on,off,stdout.write,stderr.write}`.
- `Bun.sleep` (or patch `migration-overlay.tsx`).
- `url.pathToFileURL`.
- A `Global.Service` value, a `config` service, a `packages.prepare` stub, and a renderer (best via `terminalHandoff`).

**Stub / no-op (S)**
- `open`, `fs.watch`, signal handlers, `#attention-sounds`, `#zed-sqlite`, `node:perf_hooks`, `node:child_process`, `node:module`, `node:vm`, `os.release`, audio, host clipboard.

**Avoid by configuration (A)**
- `OPENCODE_DRIVE` unset.
- Channel other than `"local"` (devtools bar).
- No `config.path`.
- No `$EDITOR`/`$VISUAL`.
- No `server.service`, no `updater`.
- No external plugins.
- Workerd variants for `#runtime-import` and optionally `#global-roots`.
- Node variant for `#string-width`.