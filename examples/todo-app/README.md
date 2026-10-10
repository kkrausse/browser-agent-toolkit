# TODO example

A React Router 7 app with a Bun/tRPC API, plus "Open editor": a preview of the app's own dev
server and an OpenCode chat that edits its source, both local to the browser tab. TODO items
live in the server's memory; source edits live in the browser.

Editor files: `src/editing.tsx` (the button), `src/editor-panel.tsx` (preview, chat, status
and timings, Exit), `server.ts` (handler and authorization), `prepare.ts`, `vite.config.ts`.

## Run

From the repository root: `bun install && bun run build` (builds the toolkit). Then here:

```sh
cp .env.example .env.local     # optional: VIVARI_MODEL_API_KEY=<key> for chat
bun run editor                 # prepare (needs bat-prepare), build, serve on :3000
```

`PORT` changes the port. Without a key the editor and preview work and chat answers with an
explanation.

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
