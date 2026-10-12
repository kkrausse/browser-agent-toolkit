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
`?reset=1` (forget this browser's workspace, the client's saved state and the TODO list first),
`?diag=<url>` (where the page posts its diagnostics; `0` turns them off; [the public build](#the-public-build) posts none without it),
`?diag=1` ([a panel on the page](#trying-it-on-a-phone) instead of a collector), `?mock=1` (the scripted model inside the page's own service worker: no network), `?kmem=<MiB>` (the size of the runtime's kernel memory, default 256),
`?clientLog=debug` (the client logs every level to `/tmp/opencode-client/tui.log` in the guest),
`?tunnel=<wss URL>` (a TCP relay for [the hosts a tab cannot read](#the-tunnel); `0` for none),
`?wisp=<wss URL>` ([a Wisp server](#a-wisp-server-instead) in that relay's place; `0` for none).
The cog in the panel's header is a form for `?wisp=` (applying it reloads the page at the address
that says the same) with a button for `?reset=1`; beside it, a link to the source.

After a setup, `bun run editor` in this directory repeats only the example's own steps
(`display`, `prepare:editor`, `build` into `dist/`, `start`); set `BAT_PREPARE` when `bat-prepare` is not
in `target/release` of this checkout.

## Publishing it

```sh
# in examples/terminal-app, after a setup: only the page's own steps
MODEL_URL=https://<mock host>:4311/v1 OUT_DIR=dist-published bun run build
```

`dist/` is everything a visitor needs and nothing else (45 MB, of which the dependency image
is 37 MB): copy it to a file shelf and open its URL. `MODEL_URL` is the built page's default
`?model=` and, at `/diag` of the same host, its diagnostics collector; without it the default
is port 4311 of the page's own host, which only suits a page served beside its mock.
`TUNNEL_URL=wss://<relay>/tcp` is the built page's default `?tunnel=`, `WISP_URL` its default `?wisp=`.

### The public build

```sh
# in examples/terminal-app, after a setup
PUBLIC=1 OUT_DIR=dist-public bun run build
```

A page for people who have none of this machine's services: no mock, no collector, no
sign-in. What differs from the development build, all of it decided when the page is built
(`process.env.PUBLIC` in `src/main.ts`):

| | Development build | Public build |
| --- | --- | --- |
| model | `?model=`, else `MODEL_URL`, else the mock on port 4311 of the page's host | none named: the OpenCode server's own `opencode` provider, OpenCode Zen with the key `public`, which has the models that cost nothing and needs no sign-in. `?model=` still names an endpoint |
| first model | `?modelId=`, default `scripted` | `PUBLIC_MODEL` of the build (default `ling-3.1-flash-free`), for as long as `https://opencode.ai/zen/v1/models` lists it; then the server's choice. `?modelId=<id>` names another hosted one |
| tunnel | `WISP_URL`, else `TUNNEL_URL`, else none; carries `api.openai.com`, `chatgpt.com`, OpenAI's keys document and `opencode.ai` | `WISP_URL`, else the public Wisp server `wss://wisp.mercurywork.shop/`; with `?wisp=0`, `TUNNEL_URL`, else none; carries `opencode.ai` and `chatgpt.com` (a ChatGPT plan signed in with the client's device code) |
| diagnostics | posted to the collector unless `?diag=0` | nothing is sent unless the address has `?diag=<url>` |
| ChatGPT sign-in | the bar and the client's preload module (`client-tap.js`), or [a device code](#with-a-device-code) | [a device code](#with-a-device-code) only: the bar is not installed, `client-tap.js` and `openai-jwks.json` are not shipped |
| the page says | title: model and tunnel | title: `free model from OpenCode Zen · relay <host>`; a two-line footer under the panel: what runs in the tab, whose model it is, what the relay carries, a link to the source |

**Why a first model is named.** With no credentials and no `model` in its configuration,
OpenCode 2.0.26 starts on the most recently released enabled model of its catalog
(`models.opencode.ai/api.json`, which a tab can read; `Model.default` in
`packages/core/src/model.ts`), and without a key only Zen's free models are enabled. On
2026-10-10 that was `exo-free`, which Zen answered with HTTP 410, "Model exo-free has been
deprecated", while both the catalog and Zen's model list still had it: a visitor's first
prompt failed. `ling-3.1-flash-free` answered. The page drops the name when Zen's list no
longer has it, which covers a removal but not another model in the state `exo-free` is in;
then build again with another `PUBLIC_MODEL` (empty leaves the choice to the server).

**What a host needs.** Plain static files at any path, https, nothing else: no headers, no
routes. The relay must allow the page: `RELAY_ORIGINS` in the relay's environment lists the
page's origin (scheme, host, port; not its path). The files are 55 MB, the largest 47 MB
(`editor/image-….batimg.gz`).

**On GitHub Pages** (`https://<user>.github.io/<repository>/`): `bun publish-pages.ts
dist-public --yes` (`bun run publish:pages -- --yes`) pushes the built directory, with a
`.nojekyll` beside it, to `origin` as the branch `gh-pages`: one commit with no parent,
forced, so earlier builds do not stay in the branch. Without `--yes` it prints what it would
push and stops; it refuses a development build, a file of 100 MB or more, and the branches
`main` and `master`. Served under `/browser-agent-toolkit/` by a local file server, the
whole demo scenario passed against the mock: the service worker's scope is that directory,
and the workspace's storage is named after the path (`bat/browser-agent-toolkit-editor` in
the origin's private file system). (That run was of the app that still had a backend; the
app's list is now in the origin's `localStorage`, key `todos`, which every page of the origin
shares.) Not tried on Pages itself: that the
`.gz` files arrive without a `Content-Encoding` of the host's (the worker inflates them
itself and would fail on bytes already inflated).

**What leaves the tab** on a first visit, from one run in Chrome with the network recorded:
the page's own files; `GET https://opencode.ai/zen/v1/models` (the page, once);
`GET https://models.opencode.ai/api.json` (the server's catalog); one WebSocket to the relay
per model request; and `GET https://github.com/tree-sitter/…/tree-sitter-css.wasm` when
the client first highlights a stylesheet. Zen's free models answer HTTP 429 in bursts;
OpenCode waits and tries again by itself, and the client shows that it is retrying.

**Your own key** (ctrl+p, "Connect an integration") is not something this build sets up, and
none was tried. A provider called from the tab must answer the preflight for the headers
OpenCode sends. Preflights only, asked with `curl` on 2026-10-10 with the header list of
"What a model endpoint must allow", no key, no real request, so **unverified**: OpenAI
(`api.openai.com`, with an API key), Google (`generativelanguage.googleapis.com`), Groq,
DeepSeek and xAI answered with the headers allowed; OpenRouter and Mistral answered with a
header list that has no `x-opencode-*`; Anthropic answered 400. A key typed there is kept
like the sign-in tokens [below](#the-tunnel): plain text in this browser's storage for the page.

### Trying it on a phone

```sh
# in examples/terminal-app, after a setup, `bun run display` and `bun run prepare:editor`
bun build-phone.ts          # dist-phone/: index.html, demo/, probes/
```

`dist-phone/` is the public build with two additions for a device that has no console, plus
the WebKit probes of `runtime/harness/webkit/` as pages. Put the directory on any https file
shelf and open its `index.html`; nothing is published by the script.

- **Sending the readout** (no paste on a phone): `bun diag-collector.ts` keeps every upload
  as a file under `.diagnostics/uploads/`; build with `DIAG_URL=https://<machine>:4319/diag`
  (or add `?diag=<that>` to the address) and the panel posts there by itself and from its
  Send button. From an https page the collector must be https:
  `tailscale serve --bg --https=4319 http://127.0.0.1:4319`.
- **The panel** (`src/diag.ts`; always on in this build, `?diag=1` in any other, `?panel=0`
  hides it): user agent, `crossOriginIsolated`, whether the service worker controls the page,
  `navigator.storage.estimate()`, a probe of an OPFS sync access handle, the size the kernel
  memory was made with, every start-up stage with its time (the page's own, the runtime's
  boot marks, and the trace marks of every thread), the last error with its stack and causes,
  uncaught errors, unhandled rejections, errors of the workers the page creates, what the
  runtime's supervisor reports about its process workers, and the last log lines. **Copy
  all** copies the whole readout. It is saved in `localStorage` as it changes, so a tab the
  system killed shows what it had reached when the page is opened again ("previous load").
  Once the terminal is up and nothing failed it folds into a button in the corner.
- **`?mock=1`**: the model is the scripted one of `mock-model.ts`, answered by the page's
  service worker at `<page>/mock/v1/` (`mock-script.ts`). After the page's files have
  arrived nothing leaves the tab: no key, no relay, no sign-in. `hello`, `set the heading to
  "Tasks"` and the demo's dark-theme prompt work as with the mock server.
- **`?kmem=<MiB>`**: another size for the kernel memory, if the browser refuses 256 MiB.
- **`probes/`**: `features.html` (what `probe.ts` asks, and shared memories of several
  sizes), `preload-reuse.html` (report section 10; the probes' service worker stands in for
  the script's server) and `grow-crash.html` (section 9.1; it may crash the tab, and says at
  the next load that a run never finished). They are isolated by a service worker of their
  own, `probes/sw.js`.

### The demo video

`demo/run.ts` drives a served page in Chrome (`browser-control`) through one scenario and
checks each step: a fresh workspace, two todos added in the app, one prompt typed into the
terminal ("Give this app a dark theme with a violet accent, and show how many todos are left
under the list."), the agent's edits, the app dark without a reload of its frame, a third
todo added and one ticked. `--record out.mp4 --slow` records it; `demo/gif.ts` cuts the
recording to a GIF (or an mp4) in which only the model's working time is sped up, labelled.

```sh
# the public build on its shelf: one conversation with the free model per run
bun demo/run.ts --base https://<host>/<path>/ --slow --record /tmp/take.mp4
# a development build beside the mock, whose "dark theme" script answers that prompt
bun demo/run.ts --base http://127.0.0.1:4310/ --slow --record /tmp/take.mp4
bun demo/gif.ts /tmp/take.mp4 /tmp/take.gif
```

The mock's script reads `src/style.css` and `src/App.tsx` and makes three edits to them. (It
had a second take, "theme-color", which also edited the React Router root route that rendered
`<html>`: the edits after which the preview once stopped taking input,
`docs/experiments/2026-10-11-preview-input-dead-after-edit-handoff.md`. The app has no such
route any more, its document head is `index.html`, and the take went with it.)

The README's GIF (`docs/media/terminal-demo.gif`) is the scripted take cut once more: its first
5 s dropped and the whole of it at 2.2x, labelled:

```sh
ffmpeg -ss 5 -i take.mp4 -filter_complex "[0:v]setpts=(PTS-STARTPTS)/2.2,drawbox=x=8:y=ih-52:w=110:h=44:color=black@0.75:t=fill,drawtext=fontfile='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf':text='2.2x':fontcolor=white:fontsize=28:x=20:y=h-44[v]" -map "[v]" -an fast.mp4
ffmpeg -i fast.mp4 -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" terminal-demo.gif
```

With the mock the model's words and its choice of tool calls are scripted; the tools, the
edits and the hot update are the real ones.

What a server used to do is done in the tab:

| A server would | Here |
| --- | --- |
| send COOP/COEP | the page's service worker (`sw.ts`, `dist/sw.js`) adds them to what it serves; `src/isolate.ts` registers it and reloads once, after which `crossOriginIsolated` is true |
| serve the preview's service worker with `Service-Worker-Allowed: /` | the same worker runs the runtime's (`importScripts`); its scope is the page's directory and the preview is at `<directory>/preview/<port>/` |
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
| the display | `packages/terminal/display.ts` (ghostty-web), bundled by `display.ts` here into `display/display.js` | draws bytes, reports typed input and how many cells fit; pastes the browser's clipboard as input (ctrl+v, ctrl+shift+v, cmd+v, the paste event) and writes it when the program copies (OSC 52) |

`src/main.ts` joins them in a dozen lines. The client is an ordinary program of the prepared
image: the OpenCode port built for Node (`cd ports/opencode && bun run build:native && bun run
build:tui:node`, see its README.md for the checkouts that needs), which
`prepare.ts` puts under `/app/tui/` beside the server. `process.stdout.isTTY`, raw mode,
`columns`/`rows` and `resize` are the runtime's Node stand-ins over the kernel's terminal;
OpenTUI's tree-sitter worker is a `node:worker_threads` worker (here: a second process). The
client's settings, prompt history and open tabs are files under `/home/user` in the workspace's
storage, so a reload keeps them and `?reset=1` forgets them.

`BAT_OPENCODE_CLIENT_DIR` names another built client directory (default
`../../ports/opencode/dist/node`). The client opens on its home screen; with
`OPENCODE_SESSION=<id>` in its environment it opens on that session of the server instead (the
native `--session`), which is how a page that drives a session through the server's API shows
the same conversation in the terminal (autoanimate's agent-studio does). wasm-term's program host (its own pty machine, shim and
page relay), which this page ran the client on before, is on the branch `wasm-term`.

## How the pieces talk

| From → to | How |
| --- | --- |
| terminal client → OpenCode server | `http://127.0.0.1:4096` in the guest: a socket of the runtime's kernel, with the server's per-start Basic credential in the client's environment. The page is not in between |
| page ↔ terminal client | bytes over the pty (`spawnTerminal`): keys in, drawing out, the window size |
| OpenCode server → model | the runtime hands any non-guest URL to the browser's `fetch`, so the request goes from the tab straight to `?model=`. A loopback endpoint (the mock) is named in `BAT_HOST_LOOPBACK_PORTS`, since loopback otherwise means a guest listener |
| OpenCode server → `api.openai.com` | with a tunnel configured, not the browser's fetch: the runtime's own TLS and HTTP/1.1 over a WebSocket to a TCP relay ([below](#the-tunnel)) |

`src/opencode.ts` starts and configures the OpenCode server itself, against the runtime
contract, instead of the toolkit's `openEditor`, which always sets up the page server's model
proxy, its header plugin and catalog.

**Versions.** Client and server are both 2.0.26. The server is bundled from the published
`@opencode/server` packages by `ports/opencode/server` (pinned by its `bun.lock`) into
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

### With a device code

The client's other OpenAI sign-in (same menu: ctrl+p, "Connect an integration", OpenAI) shows a
code to type on OpenAI's page in another tab. Nothing is redirected to the tab, so it needs no
bar and no pasted address, and it is the sign-in the public build has. Its model calls go to
`https://chatgpt.com/backend-api/codex/responses`, which answers without CORS headers (the
browser's fetch was blocked on the published page), so `chatgpt.com` is one of the hosts carried
by [the tunnel](#the-tunnel) in both builds. Tried by hand on the published page on 2026-10-11,
through the public Wisp server: the sign-in completed and the plan's model answered. One
account, one browser; nothing automated checks it. The token is kept as below: plain text in
this browser's storage for the page.

### The tunnel

`?tunnel=wss://<relay>/tcp` (or the build's `TUNNEL_URL`) names a TCP relay:
[`packages/relay/tcp-relay-main.ts`](../../packages/relay/tcp-relay-main.ts), a program of its
own that carries one TCP connection per WebSocket and never looks at the bytes.

```sh
# on a machine the browser can reach over https (the page is https, so the relay is wss)
cd packages/relay && RELAY_ORIGINS='https://<page origin> https://<another>' PORT=4799 bun tcp-relay-main.ts
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

#### A Wisp server instead

`?wisp=wss://<server>/` (or the build's `WISP_URL`) names a [Wisp](https://github.com/MercuryWorkshop/wisp-protocol)
server to carry the same connections: a public protocol for TCP streams over a WebSocket, with
stock servers in several languages and public instances that are nobody's of this project. TLS
and HTTP are the same code in the tab, so such a server sees what the relay above sees and no
more. The differences are in what it promises:

- **Whose it is.** The public build's default, `wss://wisp.mercurywork.shop/`, is Mercury
  Workshop's. It publishes no terms; it may throttle, refuse this page's origin one day, or go
  away. `?wisp=<another>` names another server, `?tunnel=` a relay as above; the build has no
  relay of its own to fall back to.
- **Its allowlists are its own.** The page tunnels only the hosts it names, but nothing on the
  server ties it to this page or to those hosts.
- **No flow control towards the page** in Wisp v1: what the server sends faster than the
  response's reader takes is held in the tab.
- An address with `?wisp=` or `?tunnel=` comes before either built default; with both, the
  Wisp server is used.

The tokens are a row of the server's database, `/workspace/.server/data/opencode.sqlite`, in
plain text: in this browser's storage for this page (OPFS), kept across reloads, removed by
`?reset=1`, and readable by the agent's own file and shell tools like every file there.

