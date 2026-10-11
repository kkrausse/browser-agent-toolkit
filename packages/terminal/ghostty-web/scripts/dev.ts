import { join } from "node:path";
import { watch } from "node:fs";

const root = join(import.meta.dir, "..");
async function buildClient() {
  const result = await Bun.build({
    entrypoints: [join(root, "demo/client.ts")],
    target: "browser",
    sourcemap: "inline",
  });
  if (!result.success) throw new AggregateError(result.logs, "Demo client build failed");
  return result.outputs[0];
}
let client = await buildClient();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3108),
  routes: {
    "/": () => new Response(Bun.file(join(root, "demo/index.html"))),
    "/client.js": () => new Response(client, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" } }),
    "/ghostty-vt.wasm": () => new Response(Bun.file(join(root, "vendor/ghostty-vt.wasm")), {
      headers: { "Content-Type": "application/wasm" },
    }),
  },
  fetch: () => new Response("Not found", { status: 404 }),
});
console.log(`Ghostty Web demo: ${server.url}`);

// Bun --watch tracks the server's imports; browser-only inputs need an explicit watcher.
let builds = Promise.resolve();
let timer: ReturnType<typeof setTimeout>;
for (const directory of ["src", "demo"]) {
  watch(join(root, directory), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      builds = builds.then(async () => {
        try {
          client = await buildClient();
          console.log("Client rebuilt; refresh the browser.");
        } catch (error) {
          console.error(error);
        }
      });
    }, 75);
  });
}
