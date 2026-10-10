// Dev server for wasm-term (port 4790).
//
// Every response carries COOP/COEP so the page is cross-origin isolated, which
// SharedArrayBuffer (and therefore the blocking syscall bridge) requires.
// Besides the page it serves the kernel wasm, the wasm guests, the JavaScript
// guests' directories (ports), and a few endpoints under /test/ that the `net`
// guest talks to.

import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join, normalize } from "node:path";
import { nodeShimsPlugin } from "../host/node/bun-plugin";
import { opencodeGuest } from "../ports/opencode/web/guest";
import type { GuestInfo, JsGuest } from "./guests";

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

function guestList(): GuestInfo[] {
  const wasm: GuestInfo[] = existsSync(guestsDir)
    ? readdirSync(guestsDir).filter(name => name.endsWith(".wasm")).sort().map(name => ({ name: basename(name, ".wasm"), kind: "wasm" }))
    : [];
  return [...wasm, ...jsGuests.map(({ dir, build, entry, ...info }) => info)];
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

const server = Bun.serve({
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
      return respond(Bun.file(target), TYPES[extname(target)] ?? "application/octet-stream");
    }

    // ---- endpoints for the `net` guest -------------------------------------
    if (path === "/test/ws") {
      if (server.upgrade(request)) return undefined as unknown as Response;
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
    open(socket) {
      socket.send("hello from /test/ws");
    },
    message(socket, message) {
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

console.log(`wasm-term: ${server.url}  (launcher; or ?guest=repl, ?guest=opencode, ...)`);
