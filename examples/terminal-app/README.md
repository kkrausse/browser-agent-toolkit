# Terminal example

The TODO app of `../todo-app` with the real OpenCode terminal client beside it, everything in
one browser tab: the app's Vite dev server and the OpenCode 2.0.3 server run on the toolkit's
runtime, the OpenCode 2.0.26 TUI runs on [wasm-term](#the-terminal-half)'s pty machine in a
ghostty-web terminal. The terminal is a panel on the right: **Close** / **OpenCode** slide it,
the grip on its left edge drags its width, and the terminal refits. No chat UI.

The example is a **directory of static files** (`dist/`, with an `index.html`): any file
server can serve it, at any path, with no headers or routes of its own. There is no model
proxy either: the OpenCode server in the tab fetches its model endpoint **directly,
cross-origin** (`?model=<base URL>`, an OpenAI Responses API).

## Run

```sh
# repository root: build everything, prepare, serve on http://127.0.0.1:4310 (PORT)
bun run terminal
# another terminal: the scripted model the page points at by default (http://<page host>:4311/v1)
bun examples/terminal-app/mock-model.ts
```

`server.ts` is a plain file server over `dist/` (`bunx serve dist` does the same). Open
`http://127.0.0.1:4310/` in Chrome. Type `hello`, then `set the heading to "Tasks"`: the
client shows the read and the edit, the file changes in the tab's filesystem and the app
hot-reloads. Page parameters: `?model=<base URL>`, `?modelId=<id>` (default `scripted`),
`?reset=1` (forget this browser's workspace and the client's saved state first),
`?diag=<url>` (where the page posts its diagnostics; `0` turns them off).

After a setup, `bun run editor` in this directory repeats only the example's own steps
(`wasm-term`, `prepare:editor`, `build` into `dist/`, `start`); set `BAT_PREPARE` when `bat-prepare` is not
in `target/release` of this checkout.

## Publishing it

```sh
# in examples/terminal-app, after a setup: only the page's own steps
MODEL_URL=https://<mock host>:4311/v1 OUT_DIR=dist-published bun run build
```

`dist/` is everything a visitor needs and nothing else (57 MB, of which the dependency image
is 45 MB): copy it to a file shelf and open its URL. `MODEL_URL` is the built page's default
`?model=` and, at `/diag` of the same host, its diagnostics collector; without it the default
is port 4311 of the page's own host, which only suits a page served beside its mock.

What a server used to do is done in the tab:

| A server would | Here |
| --- | --- |
| send COOP/COEP | the page's service worker (`sw.ts`, `dist/sw.js`) adds them to what it serves; `src/isolate.ts` registers it and reloads once, after which `crossOriginIsolated` is true |
| serve the preview's service worker with `Service-Worker-Allowed: /` | the same worker runs the runtime's (`importScripts`); its scope is the page's directory and the preview is at `<directory>/preview/<port>/` |
| serve the TODO app's `/api` | `todo-api.ts`, the app's tRPC router bundled into one file, runs as a third guest program on port 3001; the service worker hands the frame's `/api/…` requests to it (`setGuestPaths`). The list is a file in the workspace |
| pick a compressed copy by `Accept-Encoding` | the build ships big files only as `<name>.gz`; the worker answers `<name>` by inflating that as it arrives (`DecompressionStream`) |

Every URL is relative to the page, so the directory works at `/` and at
`/artifacts/<name>/` alike; the guest's dev server is told its base at start
(`BROWSER_AGENT_BASE`).

## The terminal half

wasm-term is [`wasm-term/`](../../wasm-term/README.md) of this repository; its build outputs
are megabytes and gitignored, so they have to be built there first. `wasm-term.ts` bundles its
page wiring (`web/embed.ts`, `host/js-worker.ts`) and copies its built files into the gitignored
`.wasm-term/`; it says what is missing. `WASM_TERM_DIR` names another `wasm-term` directory
(default `../../wasm-term`).

## How the pieces talk

| From → to | How |
| --- | --- |
| terminal client → OpenCode server | the client is given the address `http://opencode.in-tab`; wasm-term relays its `fetch` calls under that prefix to the page (`pageFetch`), which answers with `runtime.endpoint(4096).fetch` and adds the server's per-start Basic credential. The event stream stays a stream |
| OpenCode server → model | the runtime hands any non-guest URL to the browser's `fetch`, so the request goes from the tab straight to `?model=`. A loopback endpoint (the mock) is named in `BAT_HOST_LOOPBACK_PORTS`, since loopback otherwise means a guest listener |
| app in the frame → `/api` | the service worker, to the guest program on port 3001 (`setGuestPaths`) |

`src/opencode.ts` starts and configures the OpenCode server itself, against the runtime
contract, instead of the toolkit's `openEditor`, which always sets up the page server's model
proxy, its header plugin and catalog.

**Versions.** The client is 2.0.26, the server 2.0.3. 115 of about 144 routes are the same;
`src/compat.ts` translates the renamed ones the client uses and answers `/api/info`. Routes
with no older equivalent (credentials, pairing, `/api/location/reload`) get the server's 404.

**What a model endpoint must allow** to be called from the tab: answer the preflight
(`OPTIONS`, any 2xx) and the request with `Access-Control-Allow-Origin` for the page's origin
(or `*`; no cookies are sent), `Access-Control-Allow-Methods: POST`, and
`Access-Control-Allow-Headers` covering what OpenCode sends: `authorization`, `content-type`,
`x-opencode-client`, `x-opencode-project`, `x-opencode-session`, `x-session-affinity`,
`x-session-id`. The key is the provider's `apiKey`, sent as `Authorization: Bearer …`; here it
is a placeholder. From an https page the endpoint must be https too.
