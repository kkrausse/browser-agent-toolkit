# TODO example

A React Router 7 app with a Bun/tRPC API, plus "Open editor": a preview of the app's own dev
server and an OpenCode chat that edits its source, both local to the browser tab. TODO items
live in the server's memory; source edits live in the browser.

Editor files: `src/editing.tsx` (the button; calls `preloadEditor()` when it is rendered),
`src/editor-panel.tsx` (preview, chat or codex, status and timings, Exit), `server.ts` (handler and
authorization), `prepare.ts`, `vite.config.ts`, and two recordings of a real start that
`prepare.ts` passes on: `startup-modules.json` (the modules Vite had loaded when the app
showed, emitted as one script the browser keeps compiled) and `editor-startup-order.txt`
(what a start reads from the dependency image, laid out first so a first open does not
wait for the whole download). Both only cost speed when stale; record them again after a
dependency upgrade (`bench/startup/run.ts --trace --record-modules`, `bench/first-open/trace.ts`).

## Run

From the repository root, one command (builds the Wasm pieces, the `bat-prepare` CLI, the
runtime and the toolkit, fetches the pinned OpenCode server, then prepares, builds and
serves this example):

```sh
cp examples/todo-app/.env.example examples/todo-app/.env.local   # optional: EDITOR_MODEL_API_KEY=<key> for chat
PORT=3000 bun run editor
```

`bun run setup` is the build part alone; it is incremental (about 5 s when nothing
changed; 113 s to a running server from a fresh clone with warm Cargo and Bun caches). It
needs bun, node 24 and cargo with the targets `wasm32-wasip1-threads` and
`wasm32-unknown-unknown`; bubblewrap is used when present. Use Chrome. After a setup, `bun run editor` in
this directory repeats only prepare, build and serve (it finds `target/release/bat-prepare`
and `.runtime/opencode-2.0.3`; set `BAT_PREPARE` / `BAT_OPENCODE_DIR` when they are
elsewhere, e.g. with a custom `CARGO_TARGET_DIR`).

Without a key the editor and preview work and chat answers with an explanation.
"Reset workspace" on the home page deletes this browser's source edits and chat sessions;
the next open starts from the prepared source again.

## Codex as the second agent

The panel can run the codex TUI instead of the OpenCode chat: **OpenCode | Codex** in its
header, or `?agent=codex` on the page address. It is codex 0.162.0 whole (TUI, app-server and
agent core as one `wasm32-wasip1` module, [`wasm-term`](../../wasm-term/README.md)'s
`codex-local`) in a Worker of this tab, working in `/workspace`: the same files the dev server
serves. It reads them through its shell (`rg`, `nl -ba`, `sed -n`), edits them with
`apply_patch`, and the preview hot-reloads. Its commands are processes of the runtime, so `node`
and the app's `node_modules/.bin` work (`npx tsc --noEmit -p .`); `git`, `python` and package
installs do not. The OpenCode chat stays attached while Codex is shown, and both see each
other's edits at once: there is one filesystem.

```sh
# once: wasm-term's built files and the shipped codex module (wasm-term/README.md, "codex-local");
# WASM_TERM_DIR names a wasm-term directory that has them when this checkout does not
bun run codex          # bundles codex/ and links the module into the gitignored .editor/codex/
bun run editor         # as before; the server offers Codex when .editor/codex/ exists
```

Nothing is added to the server but static files under `/codex/`. Model traffic leaves the tab
the two ways the static codex page has (`wasm-term/README.md`, "Static build"):

| | |
| --- | --- |
| default (`net=direct`) | the browser's `fetch` straight to OpenAI. An API key and the sign-in itself work from any origin; a ChatGPT subscription only from the origins `chatgpt.com` accepts, of which this example can be one: serve on port 3000 (the default) and open **`http://localhost:3000`**, not `127.0.0.1`. The panel says which case the page is in |
| `CODEX_TCP_RELAY=wss://host/tcp` in the server's environment, or `&tcp=wss://host/tcp` | codex's own TLS through a relay that only copies bytes (`wasm-term/web/tcp-relay-main.ts`, run it with `RELAY_ORIGINS=<this page's origin>`); no origin list applies |

Sign-in happens inside the TUI (device code, or an API key). `auth.json` and the rest of
codex's home are in this origin's IndexedDB (database `wasm-term`, namespace `todo-codex`),
readable by any script the origin serves; commands codex runs do not see that directory.
**Clear stored credentials** under the terminal deletes the stored sign-in and restarts codex
(`/logout` in the TUI also revokes the token). "Reset workspace" does not touch codex's home.

How it is put together (`codex/`, bundled apart from the app):

| File | |
| --- | --- |
| `codex/worker.ts` | wasm-term's program Worker, attached to the runtime's kernel like a process worker (the page hands it the kernel module and shared memory) |
| `codex/kernel-fs.ts` | the WASI `path_*` / `fd_*` imports with `/workspace` routed to kernel calls; codex's home and `/tmp` stay in wasm-term's own tree |
| `codex/kernel-proc.ts` | codex's commands as kernel processes (`/bin/sh` with pipes) |
| `codex/terminal.ts` | page side: the terminal, the settings, releasing the Worker from the kernel before it is terminated, the stored credentials |
| `codex/environment.md` | what codex tells the model about this machine |
| `src/codex-panel.tsx`, `src/codex-api.ts` | the panel; it loads `/codex/terminal.js` when Codex is first chosen |

`codex/check.ts` checks all of it in Chrome against the scripted model (no sign-in, no tokens);
its header has the commands. Page parameters for that: `codex-backend=mock`, `codex-mock=<url>`.

Known limits: the kernel thread of the codex Worker reads dependency files through the
supervisor (slower than a process worker's own handle; source files are not affected); a
rename between `/workspace` and codex's own directories fails with `EXDEV`; the model's
`tty: true` commands get pipes; nothing was tried with a real model or a real sign-in (both network modes were only run as far as
the sign-in screen; with a relay the page's connections do arrive at it), or in a browser other than Chrome.

## Demo driver

`demo/run.ts` drives the README scenario in Chrome through the `browser-control` CLI and
checks every step (todos on the home page, editor ready, the prompt, the hot-updated dark
preview with its counter, "Ship it" and a tick inside the preview). Each run is one real
model conversation.

```sh
bun demo/run.ts --base http://127.0.0.1:3000 [--runs 3] [--session bat-demo]   # in examples/todo-app
bun demo/run.ts --base http://127.0.0.1:3000 --slow --record /tmp/take.mp4
bun demo/gif.ts /tmp/take.mp4 ../../docs/media/todo-editor-demo-rust.gif
```

### Without the browser runtime (development)

```sh
PORT=4110 bun run editor:fake
```

The same page, but Vite and OpenCode run natively behind the server through the toolkit's
fake host (`fake-host.ts`); nothing is sandboxed. It needs Node 24 and the pinned OpenCode
bundle (`BAT_OPENCODE_DIR`, default `.runtime/opencode-2.0.3` after `bun run setup`). The scratch
workspace is `EDITOR_FAKE_DIR` (default `/tmp/bat-toolkit-todo`; delete it to start from the
prepared source). Native ports: `EDITOR_PREVIEW_PORT` (4111), `EDITOR_AGENT_PORT` (4112).

## Timings

The panel's last line shows milliseconds from "Open editor" to each startup step
(`manifest`, `boot`, `source`, `preview.spawn`, `preview.listening`, `preview.ready`,
`agent.spawn`, `agent.listening`, `agent.ready`, `chat.ready`, and `preview.visible` when the
app shows in the frame). The preview and the agent are spawned together. `window.__editorTimings` holds the same: `current` and one entry
per open in `runs`.

`bench/startup/run.ts --port <port>` opens the editor repeatedly and reports these steps
(no chat message is sent); the measured table is in the repository README.
