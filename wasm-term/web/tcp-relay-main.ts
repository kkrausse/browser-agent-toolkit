// The TCP tunnel as a program of its own: a blind relay for pages served from somewhere else.
//
//   RELAY_ORIGINS="https://app.example https://other.example" bun tcp-relay-main.ts
//
// It answers one thing, a WebSocket at /tcp?host=<name>&port=<n>, and carries that
// connection's bytes without looking at them (tcp-relay.ts has the wire format and every
// limit). A page whose program does its own TLS (codex-local with `net=tunnel`, opened with
// `&tcp=wss://<this relay>/tcp`) gives it ciphertext only: it learns which host was
// called, when and how much, and nothing of the token, the prompt or the reply.
//
//   RELAY_ORIGINS   required: the page origins allowed to open tunnels. A WebSocket is not
//                   subject to CORS, so without this any site open in a browser that can
//                   reach the relay could use it.
//   RELAY_HOSTS     hosts reachable on port 443. Default: api.openai.com chatgpt.com auth.openai.com
//   TCP_RELAY_ALLOW further `host:port` pairs (tcp-relay.ts)
//   HOST, PORT      where to listen. Default 127.0.0.1:4799; put TLS in front (the page is https).
import { createTcpRelay, type TcpTunnel } from "./tcp-relay";

const list = (value: string | undefined) => (value ?? "").split(/[\s,]+/).filter(Boolean);
const origins = list(process.env.RELAY_ORIGINS);
if (!origins.length) {
  console.error("RELAY_ORIGINS is required: the page origins allowed to use this relay, e.g. RELAY_ORIGINS=https://app.example");
  process.exit(2);
}
const hosts = list(process.env.RELAY_HOSTS ?? "api.openai.com chatgpt.com auth.openai.com");
const relay = createTcpRelay({ https: hosts, origins, testEndpoints: false });

const server = Bun.serve<TcpTunnel>({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT) || 4799,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname !== "/tcp") return new Response("tcp relay: a WebSocket at /tcp?host=&port=\n", { status: 404 });
    // A page does not send its Origin for this to be optional.
    if (!request.headers.get("origin")) return new Response("tcp relay: no Origin\n", { status: 403 });
    const data = relay.accept(request, url);
    if (data instanceof Response) return data;
    if (server.upgrade(request, { data })) return undefined as unknown as Response;
    relay.release(data);
    return new Response("tcp relay: expected a WebSocket upgrade\n", { status: 426 });
  },
  websocket: {
    open: socket => relay.open(socket, socket.data),
    message: (socket, message) => relay.message(socket, socket.data, message),
    close: socket => relay.close(socket.data),
  },
});
console.log(`tcp relay on ${server.hostname}:${server.port} for ${origins.join(", ")} -> ${hosts.map(host => `${host}:443`).join(", ")}`);
