// The TCP relay on Deno (Deno Deploy, or `deno run`): the relay of tcp-relay.ts behind
// Deno.serve, configured like tcp-relay-main.ts.
//
//   RELAY_ORIGINS="https://app.example" deno run --allow-net --allow-env --allow-sys tcp-relay-deno.ts
//
//   RELAY_ORIGINS   required: the page origins allowed to open tunnels
//   RELAY_HOSTS     hosts reachable on port 443. Default: opencode.ai
//   TCP_RELAY_ALLOW further `host:port` pairs (tcp-relay.ts)
//   HOST, PORT      where to listen. With neither, Deno's own default, which is what Deno
//                   Deploy routes to; set one to run it on a machine (HOST defaults to 127.0.0.1)
//
// The relay opens a raw TCP connection to port 443 and never terminates TLS: a host that only
// lets a program reach port 443 through its own TLS cannot run it (tcp-relay-deno-probe.ts tells).
import { Buffer } from "node:buffer";
import { createTcpRelay } from "./tcp-relay.ts";

const list = (value: string | undefined) => (value ?? "").split(/[\s,]+/).filter(Boolean);
const origins = list(Deno.env.get("RELAY_ORIGINS"));
// Not an exit: on a host that deploys before its environment is set, the first start has none.
if (!origins.length) console.error("RELAY_ORIGINS is not set: every request is refused until it names the page origins allowed to use this relay");
const hosts = list(Deno.env.get("RELAY_HOSTS") ?? "opencode.ai");
const relay = createTcpRelay({ https: hosts, origins, testEndpoints: false });

const [host, port] = [Deno.env.get("HOST"), Deno.env.get("PORT")];
Deno.serve(host || port ? { hostname: host ?? "127.0.0.1", port: Number(port) || 4799 } : {}, request => {
  const url = new URL(request.url);
  if (!origins.length) return new Response("tcp relay: RELAY_ORIGINS is not set\n", { status: 503 });
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
  socket.onopen = () => relay.open(socket, tunnel);
  socket.onmessage = event => relay.message(socket, tunnel, typeof event.data === "string" ? event.data : Buffer.from(event.data));
  socket.onclose = () => relay.close(tunnel);
  return response;
});
console.log(`tcp relay for ${origins.join(", ")} -> ${hosts.map(host => `${host}:443`).join(", ")}`);
