import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const build = await Bun.build({
  entrypoints: [resolve(root, "test-ui/readiness-lab.tsx")],
  target: "browser", minify: false,
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
});
if (!build.success) throw new AggregateError(build.logs, "Readiness lab build failed");
if (process.argv.includes("--check")) {
  console.log(`Readiness lab browser bundle built (${build.outputs[0]!.size} bytes); no server started.`);
} else {
  const script = build.outputs.find(output => output.path.endsWith(".js"))!;
  const styles = await Bun.file(resolve(root, "src/styles.css")).text();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: Number(process.env.PORT ?? 0),
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/lab.js") return new Response(script, { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
      if (path !== "/") return new Response("Not found", { status: 404 });
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Isolated chat readiness lab</title><style>
        ${styles}
        body { font: 14px system-ui; padding: 24px; max-width: 1000px; margin: auto; }
        main { height: 650px; margin-top: 16px; } .lab-controls { display: flex; gap: 12px; margin-bottom: 16px; }
        output { white-space: pre-wrap; display: block; padding: 12px; background: #eef2f6; }
      </style></head><body><div id="root"></div><script src="/lab.js"></script></body></html>`, {
        headers: { "content-type": "text/html", "cache-control": "no-store" },
      });
    },
  });
  console.log(`Isolated offline chat lab: ${server.url}`);
  console.log("Fresh origin; requests use an in-page stub; no model calls or persistence. Stop with Ctrl+C.");
}
