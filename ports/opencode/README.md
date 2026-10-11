# OpenCode port

OpenCode 2.0.26 for the toolkit runtime, both halves:

- **the terminal client** (the real TUI of `anomalyco/opencode`, tag `v2.0.26`, on OpenTUI
  0.5.17), built as an ordinary Node program, `dist/node/`. Its source is not edited on disk:
  OpenTUI's native core (Zig) is compiled to WebAssembly and the bundler points OpenTUI's FFI
  seam at it. The runtime runs it as a process on a terminal of its kernel
  (`examples/terminal-app`, in the image at `/app/tui/`);
- **the server** (`server/`), bundled from the published `@opencode/server` packages into
  `.runtime/opencode-2.0.26/` of the repository.

[`NOTES.md`](NOTES.md) is the port's record: what the client needs from its host, how the
Wasm FFI works, what was measured. It was written when this directory was
`wasm-term/ports/opencode` and the client ran in the browser on wasm-term's own machine; that
host, its dev page, its mock backend and the browser-target build are on the branch
`wasm-term`, and the NOTES' paths outside this directory (`../../host`, `../../web`,
`../../mock-llm`) are that branch's.

## Layout

| Where | What |
| --- | --- |
| `native/` | builds OpenTUI's core as a WASI reactor, `dist/opentui.wasm` (`build.sh`; one source patch, a generated `lib-wasm.zig`, a post-processing step) |
| `src/wasm-ffi.ts`, `src/boot.ts`, `src/opentui-ffi-hints.ts` | the `bun:ffi` stand-in over that module |
| `build/opentui-wasm-plugin.ts` | bundle-time edits to OpenTUI, each an exact-match replacement that fails the build when upstream moved |
| `build/opencode-edits-plugin.ts` | the one bundle-time edit to OpenCode (a submit waits for the agent list) |
| `src/shims/` | modules OpenCode and OpenTUI select per runtime, replaced here |
| `build/build-site.ts` | the bundle: `--target=node` → `dist/node/` (what the example uses), `--target=bun` → `dist/opencode-tui.bun.js` |
| `host/node-main.ts`, `host/worker-app.ts`, `host/tui-input.ts` | the Node program's entry, the TUI bundle's entry, the remote-only `TuiInput` |
| `host/bun-main.ts`, `demos/`, `build/bundle.ts`, `build/test-preload.ts` | the same core under Bun: a hello-world demo and OpenTUI's own tests against the Wasm core |
| `server/` | the server bundle: `bun install --frozen-lockfile --linker isolated && bun build.ts [out]`, pinned by its `bun.lock`; `scripts/setup.ts terminal` runs it when `.runtime/opencode-2.0.26/` is missing |
| `captures/`, `notes/` | captures and the API survey the NOTES cite |

## Build the client

```sh
cd ports/opencode
./setup-vendor.sh            # once: the checkouts and the Zig toolchain into vendor/ (gitignored, several GB)
bun run build:native         # dist/opentui.wasm (about 2.5 minutes; writes into vendor/opentui: the patch, lib-wasm.zig, Zig's outputs)
bun run build:tui:node       # dist/node/: main.js, tui.js, parser.worker.js, opentui.wasm, tree-sitter.wasm, assets/ (3 s)
```

Then `bun run prepare:editor` in `examples/terminal-app` takes `dist/node/` into the image
(`BAT_OPENCODE_CLIENT_DIR` names another directory).

### The checkouts

`vendor/` is not in git. `setup-vendor.sh` fills it from the pinned public tags and skips
whatever is already there:

| `vendor/` | From |
| --- | --- |
| `opencode` | `git clone --depth 1 --branch v2.0.26 https://github.com/anomalyco/opencode.git`, then `bun install --ignore-scripts` (2405 packages, 3.2 GB) |
| `opentui` | `git clone --depth 1 --branch v0.5.17 https://github.com/anomalyco/opentui.git`, then `bun install --ignore-scripts` (545 packages) |
| `tools/zig-x86_64-linux-0.16.0` | `https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz` |

Symlinks to checkouts kept elsewhere do as well (each entry may be a link). `build:native`
keeps Zig's cache in `vendor/tools/zig-cache`.

`bun run test:opentui` runs OpenTUI's own test suite against the Wasm core; `bun run
demo:core` draws a box with it under Bun.
