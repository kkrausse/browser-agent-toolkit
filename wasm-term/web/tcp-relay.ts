// The TCP tunnel:  /proxy/tcp?host=<name>&port=<n>  (a WebSocket)
//
// One WebSocket is one TCP connection. The relay resolves the name, opens the
// connection and copies bytes both ways; it never looks at them. A program that
// speaks TLS over it (codex-local with `net=tunnel`: its own rustls) therefore
// shows the relay ciphertext only: no token, no prompt, no reply, and the far end
// sees that program's TLS handshake, not this server's. Nothing is terminated,
// rewritten or added here; there is no SNI to rewrite because no ClientHello is parsed.
//
// Wire format, both directions:
//   binary frame   bytes of the stream
//   text frame     JSON about the stream
//     relay -> page   {"t":"open"}                  the TCP connection is established
//                     {"t":"ack","bytes":n}         n more of the page's bytes are written to the socket
//                     {"t":"end"}                   the peer closed its sending side (FIN)
//                     {"t":"error","code":c,"message":m}   then the WebSocket closes; c is one of
//                        denied | dns | refused | unreachable | timeout | reset | limit
//     page -> relay   {"t":"ack","bytes":n}         the program has read n more received bytes
//                     {"t":"end"}                   the program closed its sending side
// Flow control is by those acks, WINDOW bytes each way: the relay stops reading
// its socket while that much is unread by the program, and the page's side
// (host/wasi.ts) refuses writes while that much is unwritten here.
//
// What keeps it from being an open proxy for whoever can load the page:
// - an allowlist of exact `host:port` pairs. Default: port 443 of the hosts the
//   HTTP relay reaches over https (web/server.ts: api.openai.com, chatgpt.com,
//   auth.openai.com, and whatever HTTP_RELAY_ALLOW adds without an origin), and
//   the test names below. TCP_RELAY_ALLOW="host:port[=target-host:target-port] ..."
//   adds pairs;
// - the relay resolves the name itself and connects to the address it checked.
//   A name that resolves to a private, loopback, link-local, CGNAT (tailnet) or
//   otherwise non-public address is refused, unless the entry names its target
//   explicitly (`=target`: the mock, the test endpoints);
// - a WebSocket from another site is refused (Origin must be this page's own);
// - a connect timeout, an idle timeout, a lifetime and a byte limit per
//   connection, and a limit on connections open at once;
// - one log line per connection: host, port, bytes each way, duration, how it
//   ended. Never an address, never a byte of content.

import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Socket } from "node:net";
import type { ServerWebSocket } from "bun";

const WINDOW = 256 * 1024;

export interface TcpTunnel {
  kind: "tcp";
  /** For trace lines. */
  id?: number;
  /** As the program named it. */
  host: string;
  port: number;
  /** Where the connection really goes, when the allowlist entry says so; otherwise the name is resolved. */
  target?: { host: string; port: number };
  socket?: Socket;
  started: number;
  up: number;
  down: number;
  /** Received from the socket and not yet acknowledged by the program. */
  unread: number;
  /** Taken from the page and not yet written to the socket. */
  unwritten: number;
  outcome: string;
  /** Restarts the idle timer. */
  touch?: () => void;
  closed: boolean;
  timers: { connect?: ReturnType<typeof setTimeout>; idle?: ReturnType<typeof setTimeout>; life?: ReturnType<typeof setTimeout> };
  capture?: { up: Uint8Array[]; down: Uint8Array[] };
  /** Refused before any connection: the WebSocket is accepted only to say so (a browser hides a failed upgrade's status and body from the page). */
  refusal?: { code: string; message: string };
}

type Ws = ServerWebSocket<TcpTunnel>;

export interface TcpRelayOptions {
  /** Hosts allowed on port 443 (the HTTP relay's https hosts). */
  https: string[];
}

/** Addresses the relay never connects to on a name's say-so. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast and reserved
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT: tailnet addresses live here
    if (a === 169 && b === 254) return false; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
    return true;
  }
  if (family === 6) {
    const text = address.toLowerCase().split("%")[0]!;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (mapped) return isPublicAddress(mapped[1]!);
    // Expand to eight groups to look at the prefix.
    const [head = "", tail = ""] = text.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = text.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
    const words = groups.map(group => parseInt(group, 16));
    if (words.length !== 8 || words.some(Number.isNaN)) return false;
    const first = words[0]!;
    if (words.slice(0, 7).every(word => word === 0)) return false; // :: and ::1
    if ((first & 0xfe00) === 0xfc00) return false; // unique local (tailnet fd7a:...)
    if ((first & 0xffc0) === 0xfe80) return false; // link-local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (first === 0x2001 && words[1] === 0xdb8) return false; // documentation
    if (first === 0x64 && words[1] === 0xff9b) return false; // NAT64: an IPv4 address in disguise
    if (words.slice(0, 5).every(word => word === 0)) return false; // IPv4-compatible and other ::/80 forms
    return true;
  }
  return false;
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" } });
}

export function createTcpRelay(options: TcpRelayOptions) {
  const connectMs = Number(process.env.TCP_RELAY_CONNECT_MS ?? 10_000);
  const idleMs = Number(process.env.TCP_RELAY_IDLE_MS ?? 10 * 60_000);
  const lifetimeMs = Number(process.env.TCP_RELAY_LIFETIME_MS ?? 6 * 3600_000);
  const maxBytes = Number(process.env.TCP_RELAY_MAX_BYTES ?? 2 * 1024 ** 3);
  const maxConnections = Number(process.env.TCP_RELAY_MAX_CONNECTIONS ?? 32);
  /** Test runs only: keep what was carried for connections whose allowlist entry names its target (the mock, never a real host). */
  const capturing = process.env.TCP_RELAY_CAPTURE === "1";
  const captures: { host: string; port: number; up: Uint8Array[]; down: Uint8Array[] }[] = [];
  let open = 0;
  /** Debugging (TCP_RELAY_TRACE=1): one line per frame, sizes and control messages only. */
  const tracing = process.env.TCP_RELAY_TRACE === "1";
  let serial = 0;
  const trace = (tunnel: TcpTunnel, what: string) => {
    if (tracing) console.log(`tcp#${tunnel.id} ${performance.now().toFixed(1)} ${what} (unread ${tunnel.unread}, unwritten ${tunnel.unwritten})`);
  };

  // ---- test endpoints (the `tcp` guest, web/verify) ---------------------------
  // On loopback, on ports the system picks; reachable only by name through the allowlist below.
  const testServer = (onConnection: (socket: Socket) => void): number => {
    const server = createServer({ allowHalfOpen: true }, socket => {
      socket.on("error", () => {});
      onConnection(socket);
    }).listen(0, "127.0.0.1");
    return (server.address() as { port: number }).port;
  };
  // Echo. When the client closes its sending side: "bye\n", then the server's own FIN.
  const echoPort = testServer(socket => {
    socket.pipe(socket, { end: false });
    socket.on("end", () => socket.end("bye\n"));
  });
  // Sends "hello\n", then resets the connection at the first byte it is sent.
  const resetPort = testServer(socket => {
    socket.write("hello\n");
    socket.once("data", () => socket.resetAndDestroy());
  });

  /** `host:port` as the program names it -> where it goes (undefined: wherever the name resolves, if public). */
  const allow = new Map<string, { host: string; port: number } | undefined>();
  for (const host of options.https) allow.set(`${host}:443`, undefined);
  const alias = (name: string, target: string) => {
    const colon = target.lastIndexOf(":");
    allow.set(name, { host: target.slice(0, colon), port: Number(target.slice(colon + 1)) });
  };
  // mock-llm behind its TLS front (mock-llm/compose.yaml, service `tls`): the same server the HTTP relay
  // reaches as `mock-llm.test`, here with a certificate for that name from the mock's private CA.
  const mockTls = process.env.MOCK_LLM_TLS_UPSTREAM ?? "127.0.0.1:4797";
  alias("mock-llm.test:443", mockTls);
  // Two ways for that server to be the wrong one, for checking that a program verifies certificates:
  // a certificate no CA vouches for, and the good certificate under a name it does not cover.
  alias("untrusted.mock-llm.test:443", process.env.MOCK_LLM_TLS_UNTRUSTED ?? "127.0.0.1:4798");
  alias("wrong-name.mock-llm.test:443", mockTls);
  alias("tcp-echo.test:7", `127.0.0.1:${echoPort}`);
  alias("tcp-reset.test:7", `127.0.0.1:${resetPort}`);
  alias("tcp-closed.test:7", "127.0.0.1:1"); // nothing listens: connection refused
  // Allowed by name and still refused, because the name resolves to loopback: the rule a test can see.
  allow.set("localhost:7", undefined);
  for (const entry of (process.env.TCP_RELAY_ALLOW ?? "").split(/[\s,]+/).filter(Boolean)) {
    const [name, target] = entry.split("=");
    if (target) alias(name!.toLowerCase(), target);
    else allow.set(name!.toLowerCase(), undefined);
  }

  function log(tunnel: TcpTunnel): void {
    if (process.env.TCP_RELAY_QUIET) return;
    console.log(`tcp ${tunnel.host}:${tunnel.port} -> ${tunnel.outcome} up=${tunnel.up} down=${tunnel.down} ${((performance.now() - tunnel.started) / 1000).toFixed(1)}s`);
  }

  /** Ends a tunnel once: socket, timers, the count, the log line. */
  function finish(ws: Ws | null, tunnel: TcpTunnel, outcome: string, error?: { code: string; message: string }): void {
    if (tunnel.closed) return;
    tunnel.closed = true;
    tunnel.outcome = outcome;
    for (const timer of Object.values(tunnel.timers)) clearTimeout(timer);
    tunnel.socket?.destroy();
    open--;
    log(tunnel);
    if (!ws) return;
    try {
      if (error) ws.send(JSON.stringify({ t: "error", ...error }));
      ws.close(error ? 1011 : 1000, outcome.slice(0, 100));
    } catch {
      // already gone
    }
  }

  async function start(ws: Ws, tunnel: TcpTunnel): Promise<void> {
    let address: string;
    let port = tunnel.port;
    if (tunnel.target) {
      ({ host: address, port } = tunnel.target);
    } else {
      let found: { address: string; family: number }[];
      try {
        found = isIP(tunnel.host) ? [{ address: tunnel.host, family: isIP(tunnel.host) }] : await lookup(tunnel.host, { all: true });
      } catch {
        return finish(ws, tunnel, "dns failure", { code: "dns", message: "the name does not resolve" });
      }
      if (tunnel.closed) return;
      // Every answer has to be public: a name with one private address among its answers is not trusted for any.
      if (found.length === 0 || !found.every(entry => isPublicAddress(entry.address))) {
        return finish(ws, tunnel, "refused (not a public address)", { code: "denied", message: "the name resolves to an address the relay does not connect to" });
      }
      address = (found.find(entry => entry.family === 4) ?? found[0]!).address;
    }
    // By address, so that what was checked is what is connected to.
    const socket = connect({ host: address, port, allowHalfOpen: true });
    tunnel.socket = socket;
    socket.setNoDelay(true);
    tunnel.timers.connect = setTimeout(() => finish(ws, tunnel, "connect timeout", { code: "timeout", message: "the connection was not established in time" }), connectMs);
    tunnel.timers.life = setTimeout(() => finish(ws, tunnel, "lifetime limit", { code: "limit", message: "the connection reached the relay's time limit" }), lifetimeMs);
    const touch = () => {
      clearTimeout(tunnel.timers.idle);
      tunnel.timers.idle = setTimeout(() => finish(ws, tunnel, "idle timeout", { code: "timeout", message: "nothing was sent or received for too long" }), idleMs);
    };
    tunnel.touch = touch;
    socket.on("connect", () => {
      clearTimeout(tunnel.timers.connect);
      if (tunnel.closed) return;
      tunnel.outcome = "open";
      touch();
      tunnel.id = ++serial;
      trace(tunnel, `open ${tunnel.host}:${tunnel.port}`);
      ws.send(JSON.stringify({ t: "open" }));
    });
    socket.on("data", (chunk: Buffer) => {
      if (tunnel.closed) return;
      touch();
      tunnel.down += chunk.length;
      tunnel.unread += chunk.length;
      tunnel.capture?.down.push(new Uint8Array(chunk));
      trace(tunnel, `down ${chunk.length} -> send ${ws.send(chunk)}`);
      if (tunnel.unread >= WINDOW) socket.pause();
      if (tunnel.up + tunnel.down > maxBytes) finish(ws, tunnel, "byte limit", { code: "limit", message: "the connection reached the relay's byte limit" });
    });
    socket.on("end", () => {
      trace(tunnel, "peer end");
      if (!tunnel.closed) ws.send(JSON.stringify({ t: "end" }));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code === "ECONNREFUSED" ? "refused"
        : error.code === "ECONNRESET" || error.code === "EPIPE" ? "reset"
        : error.code === "ETIMEDOUT" ? "timeout"
        : error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH" ? "unreachable"
        : "reset";
      const message = code === "refused" ? "connection refused" : code === "reset" ? "connection reset by peer" : code === "timeout" ? "connection timed out" : "host unreachable";
      finish(ws, tunnel, message, { code, message });
    });
    socket.on("close", () => finish(ws, tunnel, tunnel.outcome === "open" ? "closed" : tunnel.outcome));
  }

  return {
    /** Checks a request for a tunnel: the WebSocket's data, or the refusal. */
    accept(request: Request, url: URL): TcpTunnel | Response {
      const host = (url.searchParams.get("host") ?? "").toLowerCase();
      const port = Number(url.searchParams.get("port"));
      const refuse = (why: string, status = 403) => {
        if (!process.env.TCP_RELAY_QUIET) console.log(`tcp ${host.slice(0, 80)}:${port} -> refused (${why})`);
        return text(`wasm-term tcp relay: ${why}\n`, status);
      };
      // A WebSocket is not subject to CORS: without this any site open in a browser on the tailnet could use the relay.
      const origin = request.headers.get("origin");
      if (origin) {
        let sameSite = false;
        try { sameSite = new URL(origin).host === (request.headers.get("host") ?? url.host); } catch {}
        if (!sameSite) return refuse("cross-site request");
      }
      if (!host || !Number.isInteger(port)) return refuse("host and port are required", 400);
      const key = `${host}:${port}`;
      const target = allow.get(key);
      const tunnel: TcpTunnel = {
        kind: "tcp", host, port, target, started: performance.now(), up: 0, down: 0, unread: 0, unwritten: 0,
        outcome: "connecting", closed: false, timers: {},
        capture: capturing && target ? { up: [], down: [] } : undefined,
      };
      const upgrade = (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
      const refusal = !allow.has(key) ? { code: "denied", message: "not in the relay's allowlist", status: 403 }
        : open >= maxConnections ? { code: "limit", message: "the relay has too many connections open", status: 503 }
        : null;
      if (refusal && !upgrade) return refuse(refusal.message, refusal.status);
      if (refusal) {
        refuse(refusal.message);
        return { ...tunnel, closed: true, refusal };
      }
      open++;
      return tunnel;
    },
    /** An accepted request whose upgrade did not happen. */
    release(tunnel: TcpTunnel): void {
      if (!tunnel.refusal) finish(null, tunnel, "no upgrade");
    },
    open(ws: Ws, tunnel: TcpTunnel): void {
      if (tunnel.refusal) {
        ws.send(JSON.stringify({ t: "error", ...tunnel.refusal }));
        ws.close(1008, "refused");
        return;
      }
      if (tunnel.capture) captures.push({ host: tunnel.host, port: tunnel.port, ...tunnel.capture });
      void start(ws, tunnel);
    },
    message(ws: Ws, tunnel: TcpTunnel, message: string | Buffer): void {
      if (tunnel.closed) return;
      if (typeof message === "string") {
        let control: { t?: string; bytes?: number };
        try { control = JSON.parse(message); } catch { return; }
        trace(tunnel, `page ${message}`);
        if (control.t === "ack" && Number.isFinite(control.bytes)) {
          tunnel.unread = Math.max(0, tunnel.unread - Number(control.bytes));
          if (tunnel.unread < WINDOW) tunnel.socket?.resume();
        } else if (control.t === "end") {
          tunnel.socket?.end();
        }
        return;
      }
      const socket = tunnel.socket;
      // The page holds data back until "open", and never sends more than a window ahead of the acks.
      if (!socket || tunnel.outcome !== "open") return finish(ws, tunnel, "protocol error", { code: "reset", message: "data before the connection was open" });
      const chunk = new Uint8Array(message);
      tunnel.touch?.();
      tunnel.up += chunk.length;
      tunnel.unwritten += chunk.length;
      if (tunnel.unwritten > 4 * WINDOW) return finish(ws, tunnel, "protocol error", { code: "reset", message: "more data than the window allows" });
      tunnel.capture?.up.push(chunk.slice());
      trace(tunnel, `up ${chunk.length}`);
      socket.write(chunk, error => {
        if (error || tunnel.closed) return;
        tunnel.unwritten -= chunk.length;
        trace(tunnel, `written ${chunk.length}`);
        ws.send(JSON.stringify({ t: "ack", bytes: chunk.length }));
      });
    },
    close(tunnel: TcpTunnel): void {
      finish(null, tunnel, tunnel.outcome === "open" ? "closed by the page" : tunnel.outcome);
    },
    /** Test runs (TCP_RELAY_CAPTURE=1): what the relay carried, per connection, base64. `?clear=1` forgets it. */
    capture(url: URL): Response {
      if (!capturing) return text("capture is off (TCP_RELAY_CAPTURE=1 on a test server)\n", 404);
      const join = (parts: Uint8Array[]) => Buffer.concat(parts).toString("base64");
      const body = JSON.stringify(captures.map(entry => ({ host: entry.host, port: entry.port, up: join(entry.up), down: join(entry.down) })));
      if (url.searchParams.get("clear") === "1") captures.length = 0;
      return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" } });
    },
  };
}
