// New QA-only cohort; never alter original frozen source/artifacts or production code.
import { resolve } from "node:path";
const root = process.env.QA_FROZEN_SOURCE;
const output = process.env.QA_OUTPUT;
if (!root || !output) throw new Error("QA_FROZEN_SOURCE and QA_OUTPUT required");
const hash = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const sources: Record<string, string> = {};
for (const [file, expected] of [
  ["src/controller.ts", "a918a42da0e525b1c84f5a18e834fc7cc130fb6ac0331b770e3aa46259cfe7d3"],
  ["src/react.tsx", "cb54f8459f5ba6a12441830fa94c8e88289d53a6e661f5519bf8308af529662f"],
  ["test/fixture.ts", "8c365d7722fe132c6f80918e5430f19331c664a524db2747b621798e16fc06b4"],
]) {
  sources[file!] = hash(new Uint8Array(await Bun.file(resolve(root, file!)).arrayBuffer()));
  if (sources[file!] !== expected) throw new Error(`Frozen source mismatch: ${file}`);
}
const entry = resolve(import.meta.dir, "../test-ui/readiness-controller-swap-qa.tsx");
const build = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife", minify: false,
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
  plugins: [{ name: "frozen-candidate-only", setup(builder) {
    builder.onResolve({ filter: /^\.\.\/(src\/(controller|react)|test\/fixture)$/ }, args => {
      if (args.importer !== entry) return;
      return { path: resolve(root, args.path.slice(3) + (args.path.endsWith("react") ? ".tsx" : ".ts")) };
    });
  } }],
});
if (!build.success) throw new AggregateError(build.logs);
const script = new Uint8Array(await build.outputs[0]!.arrayBuffer());
const html = `<!doctype html><html><head><meta charset="utf-8"><title>QA controller switch</title><style>${await Bun.file(resolve(root, "src/styles.css")).text()}body{font:14px system-ui;padding:24px;max-width:1000px;margin:auto}main{height:650px}output{display:block;white-space:pre-wrap;background:#eef2f6;padding:12px}</style></head><body><div id="root"></div><script src="/lab.js"></script></body></html>`;
await Bun.write(resolve(output, "lab.js"), script);
await Bun.write(resolve(output, "index.html"), html);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/lab.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
  if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
  return new Response("Not found", { status: 404 });
} });
const receipt = { origin: String(server.url), pid: process.pid, sources,
  wrapperHash: hash(new Uint8Array(await Bun.file(entry).arrayBuffer())),
  serverHash: hash(new Uint8Array(await Bun.file(import.meta.filename).arrayBuffer())),
  bundleHash: hash(script), htmlHash: hash(html) };
await Bun.write(resolve(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
