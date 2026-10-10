# TODO example

A React Router 7 app with a Bun/tRPC API, plus "Open editor": a preview of the app's own dev
server and an OpenCode chat that edits its source, both local to the browser tab. TODO items
live in the server's memory; source edits live in the browser.

Editor files: `src/editing.tsx` (the button; calls `preloadEditor()` when it is rendered),
`src/editor-panel.tsx` (preview, chat, status and timings, Exit), `server.ts` (handler and
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
