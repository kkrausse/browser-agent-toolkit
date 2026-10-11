# TCP relay

A blind relay for pages that run their own TLS: one WebSocket at `/tcp?host=<name>&port=<n>` is
one TCP connection, and the relay copies bytes both ways without looking at them. The toolkit
runtime's tunnel (`runtime/src/net/tunnel.ts`, `BAT_FETCH_TUNNEL`) is its client; the terminal
example's `?tunnel=` names one (`examples/terminal-app/README.md`, "The tunnel").

```sh
# on a machine the browser can reach over https (the page is https, so the relay is wss)
cd packages/relay && RELAY_ORIGINS='https://<page origin> https://<another>' PORT=4799 bun tcp-relay-main.ts
```

The runtime's tunnel also speaks Wisp v1 (`BAT_FETCH_TUNNEL_PROTOCOL=wisp`, the example's `?wisp=`),
for which any stock or public Wisp server will do and nothing here is needed.

`tcp-relay-main.ts` is the program (its header lists `RELAY_ORIGINS`, `RELAY_HOSTS`,
`TCP_RELAY_ALLOW`, `HOST`, `PORT`); `tcp-relay.ts` has the wire format, the allowlist and every
limit. No dependencies.

On Deno (`tcp-relay-deno.ts`, the same relay behind `Deno.serve`; `RELAY_HOSTS` defaults to
`opencode.ai` there):

```sh
RELAY_ORIGINS='https://<page origin>' deno run --allow-net --allow-env --allow-sys tcp-relay-deno.ts
```

On Deno Deploy: an app whose entry point is `tcp-relay-deno.ts` (with `tcp-relay.ts` beside it,
at the root of what is uploaded; an entry point in a subdirectory failed its build), and
`RELAY_ORIGINS` in its environment. `tcp-relay-deno-probe.ts` answers whether a host can run
the relay at all: it needs a raw TCP connection to port 443 that the platform does not wrap in
its own TLS. Deno Deploy allows it (probed 2026-10-11).

Both files came from wasm-term's dev server (`wasm-term/web/`, now only on the branch
`wasm-term`), which mounted the same relay at `/proxy/tcp`. Comments in `tcp-relay.ts` that
name `host/wasi.ts`, `web/server.ts` or `web/verify` refer to that tree.
