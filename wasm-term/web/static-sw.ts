// The static build's service worker: what a server would otherwise have to do for the directory.
//
//   1. Cross-origin isolation. Every response for the page gets COOP/COEP (the document and
//      the worker scripts need them; `SharedArrayBuffer` needs the document isolated).
//   2. Compressed files. The build ships the big files only as `<name>.gz` and lists them
//      here; a request for `<name>` is answered by fetching `<name>.gz` and inflating it as it
//      arrives (`DecompressionStream`), which is what `Content-Encoding` does in a server's
//      hands. The size before compression goes along in `X-Wasm-Term-Size`, for the page's
//      progress bar.
//
// Requests to other origins (the program's own, to OpenAI's hosts) are not touched. A classic
// script at the top of the directory, so its scope needs no `Service-Worker-Allowed`. The
// approach is `examples/terminal-app/sw.ts` of this repository.
interface FetchEventLike extends Event { request: Request; respondWith(response: Promise<Response>): void }
interface WorkerScope { registration: { scope: string }; skipWaiting(): Promise<void>; clients: { claim(): Promise<void> }; addEventListener(type: string, listener: (event: any) => void): void }
/** Published path -> size before compression. */
declare const GZIPPED: Record<string, number>;

const worker = self as unknown as WorkerScope;
const scope = new URL(worker.registration.scope);
const gzipped = new Map(Object.entries(GZIPPED));
const isolation: [string, string][] = [
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Embedder-Policy", "require-corp"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
];
const types: Record<string, string> = { js: "text/javascript", wasm: "application/wasm", json: "application/json" };
/** Named by its content: the browser's cache may answer. Everything else is revalidated, so a new build is seen. */
const hashed = /-[0-9a-f]{16}\./;

async function serve(request: Request, url: URL): Promise<Response> {
  let path = url.pathname.slice(scope.pathname.length);
  try { path = decodeURIComponent(path); } catch { /* as written */ }
  const size = gzipped.get(path);
  if (size !== undefined) {
    const response = await fetch(`${url.origin}${url.pathname}.gz`, { cache: hashed.test(path) ? "default" : "no-cache", signal: request.signal });
    if (!response.ok || !response.body) return new Response(`${path}.gz: HTTP ${response.status}`, { status: response.status || 502, headers: isolation });
    const headers = new Headers(isolation);
    headers.set("Content-Type", types[path.slice(path.lastIndexOf(".") + 1)] ?? "application/octet-stream");
    headers.set("X-Wasm-Term-Size", String(size));
    // A server that knows `.gz` (and says `Content-Encoding: gzip`) has already had the browser inflate it.
    const inflated = response.headers.get("content-encoding") === "gzip";
    return new Response(request.method === "HEAD" ? null : inflated ? response.body : response.body.pipeThrough(new DecompressionStream("gzip")), { headers });
  }
  // A navigation request cannot be remade with other options.
  const response = await (request.mode === "navigate" ? fetch(request) : fetch(url.href, { method: request.method, headers: request.headers, cache: hashed.test(path) ? "default" : "no-cache", signal: request.signal }));
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of isolation) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

worker.addEventListener("install", () => void worker.skipWaiting());
worker.addEventListener("activate", event => event.waitUntil(worker.clients.claim()));
worker.addEventListener("fetch", (event: FetchEventLike) => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return;
  // The page's own files only.
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  event.respondWith(serve(request, url));
});
