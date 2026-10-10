# Terminal example

The TODO app of `../todo-app` with the real OpenCode terminal client beside it, everything in
one browser tab: the app's Vite dev server and the OpenCode 2.0.3 server run on the toolkit's
runtime, the OpenCode 2.0.26 TUI runs on [wasm-term](#the-terminal-half)'s pty machine in a
ghostty-web terminal. The terminal is a panel on the right: **Close** / **OpenCode** slide it,
the grip on its left edge drags its width, and the terminal refits. No chat UI.

The page's server (`server.ts`) is a static file server with COOP/COEP plus the TODO app's own
`/api`. There is no model proxy: the OpenCode server in the tab fetches its model endpoint
**directly, cross-origin** (`?model=<base URL>`, an OpenAI Responses API).

## Run

```sh
# repository root: build everything, prepare, serve on http://127.0.0.1:4310 (PORT)
bun run terminal
# another terminal: the scripted model the page points at by default (http://<page host>:4311/v1)
bun examples/terminal-app/mock-model.ts
```

Open `http://127.0.0.1:4310/` in Chrome. Type `hello`, then `set the heading to "Tasks"`: the
client shows the read and the edit, the file changes in the tab's filesystem and the app
hot-reloads. Page parameters: `?model=<base URL>`, `?modelId=<id>` (default `scripted`),
`?reset=1` (forget this browser's workspace and the client's saved state first).

After a setup, `bun run editor` in this directory repeats only the example's own steps
(`wasm-term`, `prepare:editor`, `build`, `start`); set `BAT_PREPARE` when `bat-prepare` is not
in `target/release` of this checkout.

## The terminal half

wasm-term lives in another repository (`random`, branch `wasm-term`) and its build outputs
are megabytes, so none of it is checked in. `wasm-term.ts` bundles its page wiring
(`web/embed.ts`, `host/js-worker.ts`) and copies its built files into the gitignored
`.wasm-term/`; it says what is missing. `WASM_TERM_DIR` names the checkout's `wasm-term`
directory.

## How the pieces talk

| From → to | How |
| --- | --- |
| terminal client → OpenCode server | the client is given the address `http://opencode.in-tab`; wasm-term relays its `fetch` calls under that prefix to the page (`pageFetch`), which answers with `runtime.endpoint(4096).fetch` and adds the server's per-start Basic credential. The event stream stays a stream |
| OpenCode server → model | the runtime hands any non-guest URL to the browser's `fetch`, so the request goes from the tab straight to `?model=`. A loopback endpoint (the mock) is named in `BAT_HOST_LOOPBACK_PORTS`, since loopback otherwise means a guest listener |
| app in the frame → `/api` | the page's server (`setHostPaths`) |

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
