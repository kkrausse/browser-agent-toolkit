// Dev page for the codex port (port 4799).
//
// The page, the Worker runtime and the kernel are wasm-term's own (web/ and
// host/, imported, not copied); this server only adds the codex module as the
// guest `codex` and the settings it needs. Integration into the shared dev
// page on 4790 is separate work.
//
//   bun ports/codex/web/server.ts
//   http://127.0.0.1:4799/?guest=codex&remote=ws://127.0.0.1:4796
//
// `remote` must be the proxy in front of `codex app-server` (mock-llm: 4796),
// not the server itself, which rejects any request with an `Origin` header.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { GuestInfo } from "../../../web/guests";

const root = join(import.meta.dir, "../../..");
const port = Number(process.env.PORT ?? 4799);
const kernelWasm = join(root, "kernel/target/wasm32-unknown-unknown/release/wasm_term_kernel.wasm");
const codexWasm = join(import.meta.dir, "../dist/codex.wasm");
const ghosttyWasm = Bun.resolveSync("@random/ghostty-web/ghostty-vt.wasm", join(root, "web"));

const guests: GuestInfo[] = [{
  name: "codex",
  kind: "wasm",
  description: "The codex TUI (codex-cli 0.162.0, wasm32-wasip1), connected to a remote codex app-server.",
  params: [{
    query: "remote",
    env: "CODEX_REMOTE_ADDR",
    label: "App server (through the Origin-stripping proxy)",
    default: "ws://127.0.0.1:4796",
    hint: "ws://HOST:PORT of the proxy in front of `codex app-server --listen`",
  }],
  // The emulated home holds config.toml and history.jsonl.
  persist: { roots: ["/home/user/.codex"], exclude: ["/home/user/.codex/tmp", "/home/user/.codex/log"] },
}];

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

function respond(body: BodyInit | null, type: string, status = 200): Response {
  return new Response(body, { status, headers: { ...isolation, "Content-Type": type } });
}

function file(path: string, type: string): Response {
  if (!existsSync(path)) return respond(`Not built: ${path}\n`, "text/plain", 404);
  return respond(Bun.file(path), type);
}

async function bundle(): Promise<Map<string, Blob>> {
  const result = await Bun.build({
    entrypoints: [join(root, "web/client.ts"), join(root, "host/worker.ts")],
    target: "browser",
    format: "esm",
    sourcemap: "inline",
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle failed");
  const outputs = new Map<string, Blob>();
  for (const output of result.outputs) outputs.set(`/${basename(output.path)}`, output);
  return outputs;
}
let bundles = await bundle();

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port,
  idleTimeout: 120,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/" || path === "/index.html") {
      bundles = await bundle();
      return file(join(root, "web/index.html"), "text/html; charset=utf-8");
    }
    const bundled = bundles.get(path);
    if (bundled) return respond(bundled, "text/javascript");
    if (path === "/ghostty-vt.wasm") return file(ghosttyWasm, "application/wasm");
    if (path === "/kernel.wasm") return file(kernelWasm, "application/wasm");
    if (path === "/guests/codex.wasm") return file(codexWasm, "application/wasm");
    if (path === "/guests.json") return respond(JSON.stringify(guests), "application/json");
    return respond("Not found\n", "text/plain", 404);
  },
});

console.log(`codex port: ${server.url}?guest=codex&remote=ws://127.0.0.1:4796`);
