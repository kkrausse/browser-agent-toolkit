# TODO example

A React Router 7 app with a Bun/tRPC API, plus "Open editor": a preview of the app's own dev
server and an OpenCode chat that edits its source, both local to the browser tab. TODO items
live in the server's memory; source edits live in the browser.

Editor files: `src/editing.tsx` (the button), `src/editor-panel.tsx` (preview, chat, status
and timings, Exit), `server.ts` (handler and authorization), `prepare.ts`, `vite.config.ts`.

## Run

From the repository root, one command (builds the Wasm pieces, the `bat-prepare` CLI, the
runtime and the toolkit, fetches the pinned OpenCode server, then prepares, builds and
serves this example):

```sh
cp examples/todo-app/.env.example examples/todo-app/.env.local   # optional: VIVARI_MODEL_API_KEY=<key> for chat
PORT=3000 bun run editor
```

`bun run setup` is the build part alone; it is incremental (about 8 s when nothing
changed, a few minutes the first time). It needs bun, node 24 and cargo with the targets
`wasm32-wasip1-threads` and `wasm32-unknown-unknown`. After a setup, `bun run editor` in
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
bun demo/run.ts --base http://127.0.0.1:3000 [--runs 3] [--session bat-demo]
bun demo/run.ts --base http://127.0.0.1:3000 --slow --record /tmp/take.mp4
bun demo/gif.ts /tmp/take.mp4 ../../docs/media/todo-editor-demo-rust.gif
```

### Without the browser runtime (development)

```sh
PORT=4110 bun run editor:fake
```

The same page, but Vite and OpenCode run natively behind the server through the toolkit's
fake host (`fake-host.ts`); nothing is sandboxed. It needs Node 24 and the pinned OpenCode
bundle (`BAT_OPENCODE_DIR`, default: the old checkout next to this repository). The scratch
workspace is `EDITOR_FAKE_DIR` (default `/tmp/bat-toolkit-todo`; delete it to start from the
prepared source). Native ports: `EDITOR_PREVIEW_PORT` (4111), `EDITOR_AGENT_PORT` (4112).

## Timings

The panel's last line shows milliseconds from "Open editor" to each startup step
(`manifest`, `boot`, `source`, `preview.spawn`, `preview.listening`, `preview.ready`,
`agent.spawn`, `agent.listening`, `agent.ready`, `chat.ready`, and `preview.visible` when the
app shows in the frame). `window.__editorTimings` holds the same: `current` and one entry
per open in `runs`.
