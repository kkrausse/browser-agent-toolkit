// Dev server for wasm-term (port 4790).
//
// Every response carries COOP/COEP so the page is cross-origin isolated, which
// SharedArrayBuffer (and therefore the blocking syscall bridge) requires.
// Besides the page it serves the kernel wasm, the wasm guests, the JavaScript
// guests' directories (ports), and a few endpoints under /test/ that the `net`
// guest talks to.
//
// It is also a reverse proxy to the backends a guest talks to, so the page can
// reach them same-origin (no CORS, no mixed content when the page is served
// over https, one port to expose):
//   /proxy/opencode/...  ->  OPENCODE_UPSTREAM  (default http://127.0.0.1:4792), streamed
//   /proxy/codex         ->  CODEX_UPSTREAM     (default ws://127.0.0.1:4796), WebSocket
//   /proxy/http/<host>/  ->  the named host, if allowlisted: the pass-through relay (below)
//   /proxy/tcp?host&port ->  a TCP connection to an allowlisted host:port, bytes only: the tunnel (tcp-relay.ts)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, normalize } from "node:path";
import { nodeShimsPlugin } from "../host/node/bun-plugin";
import type { Manifest } from "../ports/codex/scripts/package";
import { codexGuest, codexLocalGuest } from "../ports/codex/web/guest";
import { opencodeGuest } from "../ports/opencode/web/guest";
import type { GuestInfo, JsGuest, WasmGuest } from "./guests";
import { createTcpRelay, type TcpTunnel } from "./tcp-relay";

/** Wasm guests that are ports: a packaged directory each (content-hashed, precompressed), served under /guests/<name>/. */
const wasmGuests: WasmGuest[] = [codexGuest, codexLocalGuest];

/** JavaScript guests (ports). Each is served from its own directory under /guests/<name>/. */
const jsGuests: JsGuest[] = [
  opencodeGuest,
  {
    name: "js-demo",
    kind: "js",
    description: "the node-style shim by itself: tty, raw mode, signals, files, clipboard, output flow control",
    entry: join(import.meta.dir, "../host/node/demo-guest.ts"),
  },
];

const root = join(import.meta.dir, "..");
const port = Number(process.env.PORT ?? 4790);
const kernelWasm = join(root, "kernel/target/wasm32-unknown-unknown/release/wasm_term_kernel.wasm");
const guestsDir = join(root, "guests/dist");
/** The shell: crates/bat-sh of this repository, built by host/sh/build.sh. */
const shellWasm = join(root, "host/sh/dist/bat_sh.wasm");
const ghosttyWasm = Bun.fileURLToPath(import.meta.resolve("@random/ghostty-web/ghostty-vt.wasm"));

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

function respond(body: BodyInit | null, type: string, extra: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers: { ...isolation, "Content-Type": type, ...extra } });
}

function file(path: string, type: string): Response {
  if (!existsSync(path)) return respond(`Not built: ${path}\nRun ./build.sh in wasm-term/.\n`, "text/plain", {}, 404);
  return respond(Bun.file(path), type);
}

/** Bundles the page and the worker. Rebuilt on every page load so edits show up on refresh. */
async function bundle(): Promise<Map<string, Blob>> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "client.ts"), join(root, "host/worker.ts"), join(root, "host/js-worker.ts"), join(root, "host/shell-worker.ts")],
    target: "browser",
    format: "esm",
    sourcemap: "inline",
    // "1" in the static build (web/static.ts), where the page has no server behind it.
    define: { "process.env.WASM_TERM_STATIC": '""', "process.env.WASM_TERM_TCP_RELAY": '""' },
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle failed");
  const outputs = new Map<string, Blob>();
  // Outputs are named after their entry point: /client.js, /worker.js (wasm guests), /js-worker.js (JavaScript guests),
  // /shell-worker.js (the shell a wasm guest's `proc_*` calls run).
  for (const output of result.outputs) outputs.set(`/${basename(output.path)}`, output);
  return outputs;
}
let bundles = await bundle();

const TYPES: Record<string, string> = {
  ".js": "text/javascript", ".map": "application/json", ".wasm": "application/wasm", ".scm": "text/plain; charset=utf-8",
  ".json": "application/json",
};

/** A packaged guest's manifest, read on every use so a rebuild shows up without a restart. */
function manifestOf(guest: WasmGuest): Manifest | null {
  const path = join(guest.site, "manifest.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Manifest) : null;
}

function guestList(): GuestInfo[] {
  const wasm: GuestInfo[] = existsSync(guestsDir)
    ? readdirSync(guestsDir).filter(name => name.endsWith(".wasm")).sort().map(name => ({ name: basename(name, ".wasm"), kind: "wasm" }))
    : [];
  const packaged = wasmGuests.map(({ site, build, ...info }): GuestInfo => {
    const manifest = manifestOf({ site, ...info });
    const url = (file: string) => `/guests/${info.name}/${file}`;
    // Not built: the page asks for this path and shows the server's answer, which says how to build it.
    if (!manifest?.default) return { ...info, module: url("not-built.wasm") };
    return { ...info, module: url(manifest.default.file), builds: Object.fromEntries(Object.entries(manifest).map(([name, entry]) => [name, url(entry.file)])) };
  });
  return [...wasm, ...packaged, ...jsGuests.map(({ dir, build, entry, ...info }) => info)];
}

/** A packaged module: megabytes, named after its own hash. Sent in the best
 * encoding the browser takes (compressed once, when it was packaged), with the
 * real size in a header for the page's progress display, and cacheable for
 * good: a rebuild has another name. `application/wasm` is what lets the
 * browser compile it while it downloads. */
function packagedModule(request: Request, guest: WasmGuest, file: string): Response {
  const entry = Object.values(manifestOf(guest) ?? {}).find(candidate => candidate.file === file);
  const path = join(guest.site, file);
  if (!entry || !existsSync(path)) return respond(`Not built: ${path}\nRun: ${guest.build}\n`, "text/plain", {}, 404);
  const headers: Record<string, string> = {
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"${entry.hash.slice(0, 32)}"`,
    Vary: "Accept-Encoding",
    "X-Wasm-Term-Size": String(entry.size),
  };
  if (request.headers.get("if-none-match") === headers.ETag) return respond(null, "application/wasm", headers, 304);
  const accepted = (request.headers.get("accept-encoding") ?? "").split(",").map(part => part.trim().split(";")[0]);
  for (const [encoding, suffix] of [["br", ".br"], ["gzip", ".gz"]] as const) {
    if (accepted.includes(encoding) && existsSync(path + suffix)) return respond(Bun.file(path + suffix), "application/wasm", { ...headers, "Content-Encoding": encoding });
  }
  return respond(Bun.file(path), "application/wasm", headers);
}

/** A port's build output: megabytes that change only when rebuilt. Unlike the
 * rest (no-store, rebundled per load) these are revalidated with an ETag and
 * sent gzipped, which is what load time over a real network depends on. */
const compressed = new Map<string, { tag: string; body: Uint8Array }>();
async function built(request: Request, path: string, type: string): Promise<Response> {
  const stat = Bun.file(path);
  const tag = `"${stat.lastModified.toString(36)}-${stat.size.toString(36)}"`;
  const headers: Record<string, string> = { "Cache-Control": "no-cache", ETag: tag };
  if (request.headers.get("if-none-match") === tag) return respond(null, type, headers, 304);
  if (!/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "") || path.endsWith(".map")) return respond(stat, type, headers);
  let entry = compressed.get(path);
  if (entry?.tag !== tag) {
    entry = { tag, body: Bun.gzipSync(new Uint8Array(await stat.arrayBuffer())) };
    compressed.set(path, entry);
  }
  return respond(entry.body as unknown as BodyInit, type, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
}

/** Server-sent events: `count` events, one every `interval` ms, each flushed on its own. */
function sse(url: URL): Response {
  const count = Number(url.searchParams.get("count") ?? 5);
  const interval = Number(url.searchParams.get("interval") ?? 200);
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      timer = setInterval(() => {
        index++;
        controller.enqueue(encoder.encode(`event: tick\ndata: {"n":${index},"of":${count}}\n\n`));
        if (index >= count) {
          clearInterval(timer);
          controller.enqueue(encoder.encode("event: done\ndata: bye\n\n"));
          controller.close();
        }
      }, interval);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return respond(stream, "text/event-stream");
}

// ---- reverse proxy ----------------------------------------------------------

const opencodeUpstream = (process.env.OPENCODE_UPSTREAM ?? "http://127.0.0.1:4792").replace(/\/+$/, "");
const codexUpstream = (process.env.CODEX_UPSTREAM ?? "ws://127.0.0.1:4796").replace(/\/+$/, "");

/** Headers that describe one hop, not the message: never forwarded in either direction. */
const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"];

/** Forwards one request to `upstream` and streams the answer back as it arrives
 * (the opencode event stream is one response that never ends). Method, path,
 * query (opencode also accepts its credentials as `?auth_token=`), body and
 * headers, `Authorization` included, pass through unchanged. */
async function proxyHttp(request: Request, upstream: string, rest: string, search: string): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of HOP_HEADERS) headers.delete(name);
  // The upstream sees a non-browser client: no Origin, so its CORS allow-list never applies.
  headers.delete("origin");
  headers.delete("referer");
  // Bun's fetch decodes the body, so ask for it plain rather than decode and re-encode a stream.
  headers.set("accept-encoding", "identity");
  let response: Response;
  try {
    response = await fetch(`${upstream}${rest}${search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) return respond(null, "text/plain", {}, 499);
    return respond(`wasm-term proxy: ${upstream} is not reachable (${(error as Error).message})\n`, "text/plain", {}, 502);
  }
  const out = new Headers(response.headers);
  for (const name of HOP_HEADERS) out.delete(name);
  out.delete("content-encoding");
  out.delete("content-length");
  // Same-origin now: the upstream's CORS answers would only confuse, and a Basic
  // challenge would make the browser put up its own login dialog over the TUI's.
  for (const name of [...out.keys()]) if (name.startsWith("access-control-")) out.delete(name);
  out.delete("www-authenticate");
  for (const [name, value] of Object.entries(isolation)) if (name !== "Cache-Control" || !out.has("cache-control")) out.set(name, value);
  // Stops any intermediary (tailscale serve, nginx) from holding events back.
  if ((out.get("content-type") ?? "").startsWith("text/event-stream")) out.set("X-Accel-Buffering", "no");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}

// ---- pass-through HTTP relay ---------------------------------------------------
//
//   /proxy/http/<host>[:<port>]/<path>?<query>  ->  <scheme>://<host>[:<port>]/<path>?<query>
//
// For a guest that makes its own HTTP requests to servers that do not answer a
// browser's CORS checks, or that need headers a page cannot set (codex-local:
// the model API and the sign-in endpoints). The relay is stateless and adds
// nothing: no credentials, no cookies, no identity. Rules:
// - only hosts in the allowlist below, each with a fixed upstream origin;
// - only the headers the guest wrapped as `x-wasm-term-fwd-<name>` go up, under
//   their real names. Everything else on the incoming request is the browser's
//   (User-Agent, Origin, Cookie, Sec-*) or a front proxy's (X-Forwarded-*,
//   Tailscale-User-*) and is dropped;
// - the answer streams back as it arrives. `Set-Cookie` and `WWW-Authenticate`
//   come back wrapped the same way, because a browser hides the first and acts
//   on the second;
// - a redirect to another allowed host is rewritten to stay on the relay; one
//   to anywhere else is refused;
// - one log line per request: method, host, path without its query, status.
//   Never a header value, never a body.

const FORWARD_PREFIX = "x-wasm-term-fwd-";

/** host[:port] as the guest names it -> the origin requests really go to. */
const relayHosts = new Map<string, string>([
  // mock-llm: the scripted model API and the fake device-code/token/account endpoints (tests; nothing real).
  ["127.0.0.1:4791", "http://127.0.0.1:4791"],
  // The same server under an https name: codex insists on https for its ChatGPT backend URL.
  ["mock-llm.test", process.env.MOCK_LLM_UPSTREAM ?? "http://127.0.0.1:4791"],
  // What codex contacts when really signed in:
  ["api.openai.com", "https://api.openai.com"], // API key: /v1/responses
  ["chatgpt.com", "https://chatgpt.com"], // ChatGPT sign-in: /backend-api/codex/responses, /backend-api/codex/models, /backend-api/wham/*
  ["auth.openai.com", "https://auth.openai.com"], // device-code sign-in, token refresh, revoke
]);
// HTTP_RELAY_ALLOW="host[:port][=origin] ..." adds entries (https://<host> unless an origin is given).
for (const entry of (process.env.HTTP_RELAY_ALLOW ?? "").split(/[\s,]+/).filter(Boolean)) {
  const [host, origin] = entry.split("=");
  relayHosts.set(host!.toLowerCase(), origin ?? `https://${host}`);
}
const relayOrigins = new Map([...relayHosts].map(([host, origin]) => [origin, host]));

// The TCP tunnel's allowlist starts from the same hosts: every one the HTTP relay reaches over
// https is reachable as <host>:443, where the program does its own TLS. See tcp-relay.ts.
const tcpRelay = createTcpRelay({
  https: [...relayHosts].filter(([host, origin]) => origin === `https://${host}`).map(([host]) => host),
});

function relayLog(method: string, host: string, path: string, status: number | string): void {
  if (process.env.HTTP_RELAY_QUIET) return;
  console.log(`relay ${method} ${host}${path} -> ${status}`);
}

async function relayHttp(request: Request, rest: string, search: string): Promise<Response> {
  const slash = rest.indexOf("/", 1);
  const host = decodeURIComponent(slash < 0 ? rest.slice(1) : rest.slice(1, slash)).toLowerCase();
  const path = slash < 0 ? "/" : rest.slice(slash);
  const origin = relayHosts.get(host);
  if (!origin) {
    relayLog(request.method, host, path, "refused (host not allowed)");
    return respond(`wasm-term relay: host ${host} is not in the allowlist\n`, "text/plain", {}, 403);
  }
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!name.startsWith(FORWARD_PREFIX)) continue;
    const real = name.slice(FORWARD_PREFIX.length);
    if (real && !HOP_HEADERS.includes(real) && real !== "content-length") headers.append(real, value);
  }
  // Bun's fetch decodes the body, so ask for it plain rather than decode and re-encode a stream.
  headers.set("accept-encoding", "identity");
  let response: Response;
  try {
    response = await fetch(`${origin}${path}${search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) return respond(null, "text/plain", {}, 499);
    relayLog(request.method, host, path, `unreachable (${(error as Error).name})`);
    return respond(`wasm-term relay: ${host} is not reachable (${(error as Error).message})\n`, "text/plain", {}, 502);
  }
  relayLog(request.method, host, path, response.status);
  const out = new Headers();
  let cookies = 0;
  for (const [name, value] of response.headers) {
    if (HOP_HEADERS.includes(name) || name === "content-encoding" || name === "content-length" || name.startsWith("access-control-")) continue;
    if (name in { "cross-origin-opener-policy": 1, "cross-origin-embedder-policy": 1, "cross-origin-resource-policy": 1 }) continue;
    if (name === "set-cookie") continue; // below, one header each
    if (name === "www-authenticate") out.append(`${FORWARD_PREFIX}${name}`, value);
    else if (name === "location") {
      // Followed by the browser's fetch, so it has to point back at the relay.
      let target: URL | null = null;
      try { target = new URL(value, `${origin}${path}`); } catch {}
      const back = target && relayOrigins.get(target.origin);
      if (target && back) out.set("location", `/proxy/http/${back}${target.pathname}${target.search}`);
      else return respond(`wasm-term relay: ${host} redirected to a host that is not in the allowlist\n`, "text/plain", {}, 502);
    } else out.append(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) out.append(`${FORWARD_PREFIX}set-cookie-${cookies++}`, cookie);
  for (const [name, value] of Object.entries(isolation)) if (name !== "Cache-Control" || !out.has("cache-control")) out.set(name, value);
  if ((out.get("content-type") ?? "").startsWith("text/event-stream")) out.set("X-Accel-Buffering", "no");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}

/** One browser WebSocket relayed to an upstream one. */
interface Relay {
  kind: "relay";
  url: string;
  protocols: string[];
  upstream?: WebSocket;
  /** Frames from the browser that arrived before the upstream connection opened. */
  pending: (string | Uint8Array)[];
}
type SocketData = { kind: "echo" } | Relay | TcpTunnel;

const server = Bun.serve<SocketData>({
  hostname: process.env.HOST ?? "127.0.0.1",
  port,
  idleTimeout: 120,
  async fetch(request, server) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/" || path === "/index.html") {
      bundles = await bundle();
      return file(join(import.meta.dir, "index.html"), "text/html; charset=utf-8");
    }
    const bundled = bundles.get(path);
    if (bundled) return respond(bundled, "text/javascript");
    if (path === "/ghostty-vt.wasm") return file(ghosttyWasm, "application/wasm");
    if (path === "/kernel.wasm") return file(kernelWasm, "application/wasm");
    if (path === "/bat_sh.wasm") return existsSync(shellWasm) ? respond(Bun.file(shellWasm), "application/wasm") : respond(`Not built: ${shellWasm}\nRun wasm-term/host/sh/build.sh\n`, "text/plain", {}, 404);
    const guest = /^\/guests\/([\w-]+)\.wasm$/.exec(path);
    if (guest) return file(join(guestsDir, `${guest[1]}.wasm`), "application/wasm");
    if (path === "/guests.json") return respond(JSON.stringify(guestList()), "application/json");
    const packaged = /^\/guests\/([\w-]+)\/([\w.-]+\.wasm)$/.exec(path);
    const wasmGuest = packaged && wasmGuests.find(candidate => candidate.name === packaged[1]);
    if (packaged && wasmGuest) return packagedModule(request, wasmGuest, packaged[2]!);
    const jsFile = /^\/guests\/([\w-]+)\/(.+)$/.exec(path);
    const jsGuest = jsFile && jsGuests.find(candidate => candidate.name === jsFile[1]);
    if (jsFile && jsGuest) {
      const relative = normalize(jsFile[2]!);
      if (relative.startsWith("..")) return respond("Not found\n", "text/plain", {}, 404);
      if (jsGuest.entry) {
        if (relative !== "guest.js") return respond("Not found\n", "text/plain", {}, 404);
        const built = await Bun.build({ entrypoints: [jsGuest.entry], target: "browser", format: "esm", sourcemap: "inline", plugins: [nodeShimsPlugin()] });
        if (!built.success) throw new AggregateError(built.logs, `bundling ${jsGuest.name} failed`);
        return respond(built.outputs[0]!, "text/javascript");
      }
      const target = join(jsGuest.dir!, relative);
      if (!existsSync(target)) return respond(`Not built: ${target}\nRun: ${jsGuest.build}\n`, "text/plain", {}, 404);
      return built(request, target, TYPES[extname(target)] ?? "application/octet-stream");
    }

    // ---- reverse proxy -------------------------------------------------------
    if (path === "/proxy/opencode" || path.startsWith("/proxy/opencode/")) {
      // No idle timeout: the event stream may be quiet for longer than any limit.
      server.timeout(request, 0);
      return proxyHttp(request, opencodeUpstream, path.slice("/proxy/opencode".length) || "/", url.search);
    }
    if (path.startsWith("/proxy/http/")) {
      // No idle timeout: a model's event stream may pause for longer than any limit.
      server.timeout(request, 0);
      return relayHttp(request, path.slice("/proxy/http".length), url.search);
    }
    if (path === "/proxy/codex" || path.startsWith("/proxy/codex/")) {
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map(part => part.trim()).filter(Boolean);
      const data: Relay = { kind: "relay", url: `${codexUpstream}${path.slice("/proxy/codex".length)}${url.search}`, protocols, pending: [] };
      if (server.upgrade(request, { data })) return undefined as unknown as Response;
      return respond("expected a WebSocket upgrade\n", "text/plain", {}, 426);
    }

    if (path === "/proxy/tcp") {
      const data = tcpRelay.accept(request, url);
      if (data instanceof Response) return data;
      if (server.upgrade(request, { data })) return undefined as unknown as Response;
      tcpRelay.release(data);
      return respond("expected a WebSocket upgrade\n", "text/plain", {}, 426);
    }
    if (path === "/proxy/tcp/capture") return tcpRelay.capture(url);
    // The private CA of mock-llm's TLS front (mock-llm/up.sh writes it): what a program is given to trust
    // when, and only when, its backend is the mock. Public by nature; it signs one test name.
    if (path === "/test/mock-ca.pem") {
      const ca = process.env.MOCK_LLM_CA ?? join(root, ".state/mock-tls/ca.pem");
      return existsSync(ca) ? respond(Bun.file(ca), "application/x-pem-file") : respond(`No test CA at ${ca}: run mock-llm/up.sh\n`, "text/plain", {}, 404);
    }

    // ---- endpoints for the `net` guest -------------------------------------
    if (path === "/test/ws") {
      if (server.upgrade(request, { data: { kind: "echo" } })) return undefined as unknown as Response;
      return respond("expected a WebSocket upgrade\n", "text/plain", {}, 426);
    }
    if (path === "/test/sse") return sse(url);
    if (path === "/test/echo") {
      const body = await request.text();
      return respond(JSON.stringify({ method: request.method, body, header: request.headers.get("x-wasm-term") }), "application/json", { "X-Echo": "yes" });
    }
    return respond("Not found\n", "text/plain", {}, 404);
  },
  websocket: {
    // Room for the largest frames a relayed protocol sends (codex thread history).
    maxPayloadLength: 64 * 1024 * 1024,
    open(socket) {
      const data = socket.data;
      if (data.kind === "echo") {
        socket.send("hello from /test/ws");
        return;
      }
      if (data.kind === "tcp") return tcpRelay.open(socket as never, data);
      const upstream = new WebSocket(data.url, data.protocols);
      upstream.binaryType = "arraybuffer";
      data.upstream = upstream;
      upstream.onopen = () => {
        for (const frame of data.pending.splice(0)) upstream.send(frame);
      };
      upstream.onmessage = event => {
        socket.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
      };
      // 1005/1006 are reserved: they describe a close and cannot be sent in one.
      upstream.onclose = event => socket.close([1005, 1006, 1015].includes(event.code) ? 1011 : event.code, event.reason);
      upstream.onerror = () => socket.close(1011, "upstream unreachable");
    },
    close(socket, code, reason) {
      const data = socket.data;
      if (data.kind === "tcp") return tcpRelay.close(data);
      if (data.kind !== "relay") return;
      data.upstream?.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
    },
    message(socket, message) {
      const data = socket.data;
      if (data.kind === "tcp") return tcpRelay.message(socket as never, data, message);
      if (data.kind === "relay") {
        const frame = typeof message === "string" ? message : new Uint8Array(message);
        if (data.upstream?.readyState === WebSocket.OPEN) data.upstream.send(frame);
        else data.pending.push(frame);
        return;
      }
      // Echo: text comes back upper-cased, binary comes back reversed, "bye" closes.
      if (typeof message === "string") {
        if (message === "bye") socket.close(1000, "goodbye");
        else socket.send(`echo: ${message}`);
      } else {
        socket.send(new Uint8Array(message).reverse());
      }
    },
  },
});

console.log(`wasm-term: ${server.url}  (launcher; or ?guest=repl, ?guest=opencode, ?guest=codex, ...)`);
