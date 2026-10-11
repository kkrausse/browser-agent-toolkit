# OpenCode in a tab with a ChatGPT sign-in: handoff (2026-10-10)

Branch `opencode-2.0.26` (pushed), up to date with `origin/wasm-term` at `b7b7ec7`, 13 commits
ahead of it. For whoever consolidates this into `wasm-term` and carries the same thing over to
codex.

## What exists

`examples/terminal-app`: a directory of static files. In one tab: the toolkit runtime runs the
real OpenCode 2.0.26 server and the todo app's dev server; the real OpenCode 2.0.26 TUI
(wasm-term, `web/embed.ts`) is in a side panel and talks to that server through the page.
Its README has the build, the parameters and the sign-in steps.

- Live: `https://raspberrypi.<tailnet>.ts.net/artifacts/bat-terminal-app/` (artifact slug
  `bat-terminal-app`) and `https://diesel2.<tailnet>.ts.net:4310/` (tmux `bat-terminal`,
  file server over this worktree's `examples/terminal-app/dist/`).
- Mock model and diagnostics collector: tmux `bat-terminal-mock`, :4311,
  `/tmp/bat-terminal-diag.jsonl`.
- Blind relay: tmux `tcp-relay`, `wasm-term/web/tcp-relay-main.ts` on 127.0.0.1:4799, tailnet
  `wss://diesel2.<tailnet>.ts.net:4799/tcp`, origins: the two pages above, log
  `/tmp/tcp-relay.log`.

Builds that are served must be made with the relay baked in, or the page silently loses it:

```sh
cd examples/terminal-app
TUNNEL_URL=wss://diesel2.<tailnet>.ts.net:4799/tcp bun run build          # dist/, served on :4310
MODEL_URL=https://diesel2.<tailnet>.ts.net:4311/v1 TUNNEL_URL=wss://diesel2.<tailnet>.ts.net:4799/tcp OUT_DIR=dist-published bun run build
~/devfs/repos/kkrausse/random/scripts/deploy-artifact.sh $PWD/dist-published bat-terminal-app
```

## What was learned about OpenAI from a browser (measured 2026-10-10)

| Step | Host | From a browser tab |
| --- | --- | --- |
| "Sign in with ChatGPT" authorize | `auth.openai.com` | redirect URI must be loopback (`http://127.0.0.1:<port>/auth/callback`); an https web address is refused (`invalid_authorize_request`, param `redirect_uri`). No device-code variant for this flow. |
| Token exchange, refresh | `auth.openai.com/api/accounts/oauth/token` | works by `fetch` (CORS `*`) |
| ID-token keys | `auth.openai.com/.well-known/jwks.json` | no CORS header: tunnelled (or the bundled copy when no tunnel) |
| Inference with the plan token | `api.openai.com/v1/responses` | preflight allowed, but the 200 response has no `Access-Control-Allow-Origin`: unreadable by `fetch`. Sent from outside a browser with the user's token it returned 200 and streamed `gpt-6.1-sol`. So it goes through the tunnel. |
| Legacy Codex sign-in inference | `chatgpt.com/backend-api/codex` | preflight refused except from a fixed list of `http://localhost:<port>` origins (wasm-term `ports/codex/NOTES.md`, section 12) |

Plan usage is only the Responses API (`POST /v1/responses`, `stream: true`, `store: false`) and
`GET /v1/models`; OpenAI's page says not to point this flow at `chatgpt.com/backend-api`.

## How the sign-in completes in a tab

The server's callback listener is a kernel socket in the runtime; the user's browser cannot reach
it. `examples/terminal-app/src/signin.ts`: the page reads the pending attempt from the client's
own connect request, shows a bar with the sign-in link and a field; the user's browser ends on a
dead `http://127.0.0.1:<port>/auth/callback?code=…` address, they paste that address into the
bar, and the page delivers it to the listener with `runtime.endpoint(port).fetch`. The user did
this for real once: token exchange succeeded, a model was offered.

## How model calls leave the tab

`runtime/src/net/tunnel.ts` and `fetch.ts`: `BAT_FETCH_TUNNEL` (hosts or URL prefixes) and
`BAT_FETCH_TUNNEL_URL`. A listed host's request is made by the runtime itself: a WebSocket to the
relay (`tcp-relay.ts` wire format), rustls as Wasm for TLS (`runtime/src/net/tls/`, Mozilla
roots, no way to skip verification), its own HTTP/1.1 client. The relay sees host, timing and byte
counts. `BAT_FETCH_DIAG=1` prints one line per such request.

Verified without an account: OpenAI's readable 401 through the tunnel from both sites, streaming
and certificate rejection against a local TLS server, the update path keeping the stored
workspace and credential. **Not verified: a 200 streamed reply with a real plan token through the
tunnel, and token refresh.** The user was about to try; nothing is recorded yet.

## Open items

1. The user's real test of a prompt on the plan through the tunnel (read failures with the `jq`
   line in the example README, and `/tmp/tcp-relay.log`).
2. Codex with this same sign-in: the user wants to try the "Sign in with ChatGPT" flow above
   (loopback redirect plus paste-back, then `api.openai.com/v1/responses` with the plan token)
   in codex-local, in place of the legacy device-code flow that needs `chatgpt.com`. Whether
   codex-cli 0.162 has that flow at all is not checked. With `net=tunnel` codex already does its
   own TLS, so only the sign-in and the endpoint are in question.
3. One relay program for both: `wasm-term/web/tcp-relay-main.ts` is already what terminal-app
   uses. `RELAY_ORIGINS` has to list every page origin.
4. Limits of the tunnel: HTTP/1.1 only, no connection reuse (a TCP + TLS handshake per request,
   87–159 ms measured), no WebSocket transport to the model (OpenCode's attempt costs one extra
   request and logs `session websocket connect failed; using http`).
5. Credentials are plain text in `/workspace/.server/data/opencode.sqlite` in the tab, and the
   agent may now read them: every tool is allowed without asking (`src/opencode.ts`), at the
   user's request.
6. The todo example stays on OpenCode 2.0.3 with the React chat UI; versions are chosen per
   example by the directory it prepares with.
7. Not run anywhere but Chrome.
