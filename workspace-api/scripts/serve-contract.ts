import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const built = await Bun.build({ entrypoints: [resolve(root, "tests/browser-contract.ts")], target: "browser", format: "esm" });
if (!built.success) throw new AggregateError(built.logs);
const code = await built.outputs[0].text();
const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin", "Service-Worker-Allowed": "/", "Cache-Control": "no-store" };
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT ?? 43917), async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response('<!doctype html><title>Workspace API contracts</title><pre></pre><script type="module" src="/contract.js"></script>', { headers: { ...headers, "content-type": "text/html" } });
  if (path === "/contract.js") return new Response(code, { headers: { ...headers, "content-type": "text/javascript" } });
  if (path.includes("..")) return new Response("invalid path", { status: 400, headers });
  let file;
  if (path.startsWith("/runtime/")) file = Bun.file(resolve(root, "dist", path.slice(1)));
  else if (path.startsWith("/tools/")) file = Bun.file(resolve(root, "../vivari/.runtime/opencode-package", path.slice(7)));
  if (file && await file.exists()) return new Response(file, { headers });
  return new Response("not found", { status: 404, headers });
} });
console.log(`Contract origin: ${server.url}`);
