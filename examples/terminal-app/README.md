# Terminal example

The TODO app of `../todo-app` with the real OpenCode terminal client beside it, everything in
one browser tab, on one runtime: the app's Vite dev server, the OpenCode 2.0.26 server and the
OpenCode 2.0.26 TUI are all processes of the toolkit's runtime. The TUI runs on a terminal of
the runtime's kernel (a pty with a line discipline) and is drawn by a
[ghostty-web display](#the-terminal-half) on the page. The terminal is a panel on the right: **Close** / **OpenCode** slide it,
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
hot-reloads. ``run `echo hi` `` makes the mock call the shell tool, which runs without a
permission dialog: this page's configuration allows every tool (the agent's reach is the tab). Page parameters: `?model=<base URL>`, `?modelId=<id>` (default `scripted`),
`?reset=1` (forget this browser's workspace and the client's saved state first),
`?diag=<url>` (where the page posts its diagnostics; `0` turns them off),
`?clientLog=debug` (the client logs every level to `/tmp/opencode-client/tui.log` in the guest),
`?tunnel=<wss URL>` (a TCP relay for [the hosts a tab cannot read](#the-tunnel); `0` for none).

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
`TUNNEL_URL=wss://<relay>/tcp` is the built page's default `?tunnel=`.

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

Three separate things, none of which knows the others:

| Piece | Where | What it is |
| --- | --- | --- |
| the terminal | the runtime's kernel (`crates/bat-kernel/src/tty.rs`, on `crates/bat-pty`) | a pty pair: canonical and raw mode, echo, ^C, window size |
| the handle | `runtime.spawnTerminal(launch, { cols, rows, onOutput })` | starts a program with the pty as its stdin, stdout and stderr; `write(bytes)`, `resize(size)`, `exited` |
| the display | `wasm-term/web/display.ts` (ghostty-web), bundled by `wasm-term.ts` into `wasm-term/display.js` | draws bytes, reports typed input and how many cells fit; pastes the browser's clipboard as input (ctrl+v, ctrl+shift+v, cmd+v, the paste event) and writes it when the program copies (OSC 52) |

`src/main.ts` joins them in a dozen lines. The client is an ordinary program of the prepared
image: wasm-term's OpenCode port built for Node (`cd wasm-term/ports/opencode && bun run
build:native && bun run build:tui:node`, see its NOTES.md for the checkouts that needs), which
`prepare.ts` puts under `/app/tui/` beside the server. `process.stdout.isTTY`, raw mode,
`columns`/`rows` and `resize` are the runtime's Node stand-ins over the kernel's terminal;
OpenTUI's tree-sitter worker is a `node:worker_threads` worker (here: a second process). The
client's settings, prompt history and open tabs are files under `/home/user` in the workspace's
storage, so a reload keeps them and `?reset=1` forgets them.

wasm-term's program host (its own pty machine, shim and page relay) is not used here any more.
`WASM_TERM_DIR` names another `wasm-term` directory for the display and the client build
(default `../../wasm-term`).

## How the pieces talk

| From → to | How |
| --- | --- |
| terminal client → OpenCode server | `http://127.0.0.1:4096` in the guest: a socket of the runtime's kernel, with the server's per-start Basic credential in the client's environment. The page is not in between |
| page ↔ terminal client | bytes over the pty (`spawnTerminal`): keys in, drawing out, the window size |
| OpenCode server → model | the runtime hands any non-guest URL to the browser's `fetch`, so the request goes from the tab straight to `?model=`. A loopback endpoint (the mock) is named in `BAT_HOST_LOOPBACK_PORTS`, since loopback otherwise means a guest listener |
| OpenCode server → `api.openai.com` | with a tunnel configured, not the browser's fetch: the runtime's own TLS and HTTP/1.1 over a WebSocket to a TCP relay ([below](#the-tunnel)) |
| app in the frame → `/api` | the service worker, to the guest program on port 3001 (`setGuestPaths`) |

`src/opencode.ts` starts and configures the OpenCode server itself, against the runtime
contract, instead of the toolkit's `openEditor`, which always sets up the page server's model
proxy, its header plugin and catalog.

**Versions.** Client and server are both 2.0.26. The server is bundled from the published
`@opencode/server` packages by `scripts/opencode-server` (pinned by its `bun.lock`) into
`.runtime/opencode-2.0.26/`; `bun run terminal` builds it when it is missing, and `prepare.ts`
names that directory. The directory carries an `application.json`, which is what makes
`bat-prepare` take it in place of the 2.0.3 artefact its policy pins (the TODO example and its
React chat stay on 2.0.3).

**Diagnostics.** The server runs with `BAT_FETCH_DIAG=1`: every request of it that the
browser's fetch rejected, or that was answered 400 or more, is one stderr line
(`[bat fetch] POST https://host/path -> HTTP 401`, never the query, headers or bodies), which
the page logs and posts with the rest. A tunnelled request leaves a line whatever its outcome
(`-> HTTP 200 (tunnel via <relay>, TLSv1_3 …)`, or which of the relay, TLS and HTTP failed).
From the collector's file:

```sh
jq -r 'select(.kind == "log" and (.data | test("bat fetch|sign-in"))) | "\(.at) \(.id) \(.data)"' /tmp/bat-terminal-diag.jsonl
```

**What a model endpoint must allow** to be called from the tab: answer the preflight
(`OPTIONS`, any 2xx) and the request with `Access-Control-Allow-Origin` for the page's origin
(or `*`; no cookies are sent), `Access-Control-Allow-Methods: POST`, and
`Access-Control-Allow-Headers` covering what OpenCode sends: `authorization`, `content-type`,
`x-opencode-client`, `x-opencode-project`, `x-opencode-session`, `x-session-affinity`,
`x-session-id`. The key is the provider's `apiKey`, sent as `Authorization: Bearer …`; here it
is a placeholder. From an https page the endpoint must be https too.

## Sign in with ChatGPT

OpenCode 2.0.26 can use a ChatGPT plan: ctrl+p, "Connect an integration", OpenAI, "Sign in
with ChatGPT". That is an authorization-code flow with PKCE whose redirect goes to a listener
the server opens on `127.0.0.1:<random port>`. OpenAI accepts only loopback redirects for it
(an https address of this page is refused with `invalid_authorize_request`, param
`redirect_uri`), and in the tab that listener is a socket inside the runtime, which no other
browser tab can reach. So the last step is by hand (`src/signin.ts`):

1. While the client shows "Waiting for authorization…", a bar appears above the terminal
   (the page learns of the attempt from a preload module it gives the client, `client-tap.ts`:
   it reports the client's sign-in exchanges, and nothing else, through a file the page watches).
   **Open the sign-in page** opens OpenAI's page in a new tab (the page also tries to open it
   by itself; a popup blocker may stop that).
2. Sign in and approve there. The browser then goes to
   `http://127.0.0.1:<port>/auth/callback?code=…` and shows a connection error: nothing on
   the machine listens there. That is expected.
3. Copy that address from the address bar, paste it into the bar's field, **Finish sign-in**.
   The page hands the request to the server's listener (`runtime.endpoint(port).fetch`); the
   server exchanges the code at `auth.openai.com` and checks the identity token. The bar, the
   log and the client say how it went.

What the server then calls: `auth.openai.com/api/accounts/oauth/token` (exchange and refresh),
straight from the tab, which that endpoint allows for any origin; and two things a tab cannot
read, because they are answered without `Access-Control-Allow-Origin`:
`api.openai.com/v1/responses` with the plan's token, and
`auth.openai.com/.well-known/jwks.json`, which the identity check reads. Those need
[the tunnel](#the-tunnel). Without one, the keys come from a copy `build.ts` ships
(`openai-jwks.json`, `BAT_FETCH_MAP`; when OpenAI rotates them the check fails with "invalid ID
token" until the page is built again), the sign-in completes, and every model call fails.

### The tunnel

`?tunnel=wss://<relay>/tcp` (or the build's `TUNNEL_URL`) names a TCP relay:
[`wasm-term/web/tcp-relay-main.ts`](../../wasm-term/web/tcp-relay-main.ts), a program of its
own that carries one TCP connection per WebSocket and never looks at the bytes.

```sh
# on a machine the browser can reach over https (the page is https, so the relay is wss)
cd wasm-term/web && RELAY_ORIGINS='https://<page origin> https://<another>' PORT=4799 bun tcp-relay-main.ts
```

With it, the server's requests to `api.openai.com` and for the keys document are made by the
runtime itself (`BAT_FETCH_TUNNEL`): TLS runs in the tab (rustls as Wasm, certificates checked
against the Mozilla roots built into `editor/runtime/bat_tls.wasm`; nothing in the page or its
address can turn the check off or add a root), then HTTP/1.1, one request per connection. The
title and the log say which relay is in use.

- **What the relay sees**: which of its allowed hosts was called (the same name is in the TLS
  ClientHello), when, and how many bytes went each way; one log line per connection
  (`tcp api.openai.com:443 -> closed by the page up=3754 down=2201 0.2s`). **Never** the
  token, the prompt or the reply: it has TLS records only. OpenAI sees the relay machine's
  address, and a request that is the server's own: no `Origin`, no cookies.
- **What keeps it from being an open proxy**: `RELAY_ORIGINS` (a WebSocket is not subject to
  CORS, so the relay checks the page's origin itself), an allowlist of destinations (default
  `api.openai.com`, `chatgpt.com`, `auth.openai.com`, port 443), no private addresses, and
  limits per connection. Whoever can open the page from an allowed origin can use the relay
  to reach those hosts, with their own credentials.
- **Not done**: HTTP/2, connection reuse (each request is a new TCP and TLS handshake, about
  0.1–0.2 s), and the Responses WebSocket transport. OpenCode's OpenAI provider tries that
  first, is answered as a plain GET, logs "session websocket connect failed; using http" and
  posts; that warning is expected with every OpenAI prompt.
- **Roots** change only with a new `bat_tls.wasm` (`runtime/src/net/tls/native/build.sh`).

The tokens are a row of the server's database, `/workspace/.server/data/opencode.sqlite`, in
plain text: in this browser's storage for this page (OPFS), kept across reloads, removed by
`?reset=1`, and readable by the agent's own file and shell tools like every file there.

