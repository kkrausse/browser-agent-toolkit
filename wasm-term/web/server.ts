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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, normalize } from "node:path";
import { nodeShimsPlugin } from "../host/node/bun-plugin";
import type { Manifest } from "../ports/codex/scripts/package";
import { codexGuest } from "../ports/codex/web/guest";
import { opencodeGuest } from "../ports/opencode/web/guest";
import type { GuestInfo, JsGuest, WasmGuest } from "./guests";

/** Wasm guests that are ports: a packaged directory each (content-hashed, precompressed), served under /guests/<name>/. */
const wasmGuests: WasmGuest[] = [codexGuest];

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
    entrypoints: [join(import.meta.dir, "client.ts"), join(root, "host/worker.ts"), join(root, "host/js-worker.ts")],
    target: "browser",
    format: "esm",
    sourcemap: "inline",
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle failed");
  const outputs = new Map<string, Blob>();
  // Outputs are named after their entry point: /client.js, /worker.js (wasm guests), /js-worker.js (JavaScript guests).
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

/** One browser WebSocket relayed to an upstream one. */
interface Relay {
  kind: "relay";
  url: string;
  protocols: string[];
  upstream?: WebSocket;
  /** Frames from the browser that arrived before the upstream connection opened. */
  pending: (string | Uint8Array)[];
}
type SocketData = { kind: "echo" } | Relay;

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
    if (path === "/proxy/codex" || path.startsWith("/proxy/codex/")) {
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map(part => part.trim()).filter(Boolean);
      const data: Relay = { kind: "relay", url: `${codexUpstream}${path.slice("/proxy/codex".length)}${url.search}`, protocols, pending: [] };
      if (server.upgrade(request, { data })) return undefined as unknown as Response;
      return respond("expected a WebSocket upgrade\n", "text/plain", {}, 426);
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
      if (data.kind !== "relay") return;
      data.upstream?.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
    },
    message(socket, message) {
      const data = socket.data;
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
