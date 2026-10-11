// The TCP relay on Deno (Deno Deploy, or `deno run`): the relay of ../tcp-relay.ts behind
// Deno.serve, configured like ../tcp-relay-main.ts.
//
//   RELAY_ORIGINS="https://app.example" deno run --allow-net --allow-env deno/main.ts
//
//   RELAY_ORIGINS   required: the page origins allowed to open tunnels
//   RELAY_HOSTS     hosts reachable on port 443. Default: opencode.ai
//   TCP_RELAY_ALLOW further `host:port` pairs (../tcp-relay.ts)
//   HOST, PORT      where to listen when not on Deno Deploy. Default 127.0.0.1:4799
//
// The relay opens a raw TCP connection to port 443 and never terminates TLS: a host that only
// lets a program reach port 443 through its own TLS cannot run it (deno/probe.ts tells).
import { Buffer } from "node:buffer";
import { createTcpRelay } from "../tcp-relay.ts";

const list = (value: string | undefined) => (value ?? "").split(/[\s,]+/).filter(Boolean);
const origins = list(Deno.env.get("RELAY_ORIGINS"));
if (!origins.length) throw new Error("RELAY_ORIGINS is required: the page origins allowed to use this relay, e.g. RELAY_ORIGINS=https://app.example");
const hosts = list(Deno.env.get("RELAY_HOSTS") ?? "opencode.ai");
const relay = createTcpRelay({ https: hosts, origins, testEndpoints: false });

Deno.serve({ hostname: Deno.env.get("HOST") ?? "127.0.0.1", port: Number(Deno.env.get("PORT")) || 4799 }, request => {
  const url = new URL(request.url);
  if (url.pathname !== "/tcp") return new Response("tcp relay: a WebSocket at /tcp?host=&port=\n", { status: 404 });
  if (!request.headers.get("origin")) return new Response("tcp relay: no Origin\n", { status: 403 });
  const tunnel = relay.accept(request, url);
  if (tunnel instanceof Response) return tunnel;
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    relay.release(tunnel);
    return new Response("tcp relay: expected a WebSocket upgrade\n", { status: 426 });
  }
  const { socket, response } = Deno.upgradeWebSocket(request);
  socket.binaryType = "arraybuffer";
  // The relay asks only `send` and `close` of its socket, which a WebSocket has.
  const ws = socket as never;
  socket.onopen = () => relay.open(ws, tunnel);
  socket.onmessage = event => relay.message(ws, tunnel, typeof event.data === "string" ? event.data : Buffer.from(event.data));
  socket.onclose = () => relay.close(tunnel);
  return response;
});
console.log(`tcp relay for ${origins.join(", ")} -> ${hosts.map(host => `${host}:443`).join(", ")}`);
