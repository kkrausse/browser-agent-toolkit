// Independent repaired harness. Build-only is offline; serve-only never rebuilds.
import { resolve } from "node:path";
const root = process.env.QA_FROZEN_SOURCE;
const output = process.env.QA_OUTPUT;
if (!root || !output) throw new Error("QA_FROZEN_SOURCE (opencode-chat root) and QA_OUTPUT required");
const buildOnly = process.env.QA_BUILD_ONLY === "1";
const serveOnly = process.env.QA_SERVE_ONLY === "1";
if (buildOnly === serveOnly) throw new Error("Choose exactly one: QA_BUILD_ONLY=1 or QA_SERVE_ONLY=1");
const hash = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const fileHash = async (path: string) => hash(new Uint8Array(await Bun.file(path).arrayBuffer()));
const manifestPath = resolve(root, "../../candidate-manifest.json");
const manifest = await Bun.file(manifestPath).json();
if (manifest.commit !== "691cd5aa0880349968773047402adec0bfeb16df") throw new Error("Wrong frozen candidate");
const sources: Record<string, string> = {};
for (const [file, expected] of Object.entries(manifest.sources)) {
  sources[file] = await fileHash(resolve(root, file));
  if (sources[file] !== expected) throw new Error(`Frozen source mismatch: ${file}`);
}
// Record all transitive candidate source bytes, beyond the original selected-file manifest.
for await (const file of new Bun.Glob("src/**/*.{ts,tsx,css}").scan({ cwd: root }))
  sources[file] = await fileHash(resolve(root, file));
const receiptPath = resolve(output, "freeze-receipt.json");
if (buildOnly) {
  if (await Bun.file(receiptPath).exists()) throw new Error("Refuse to overwrite frozen repaired cohort");
  const entry = resolve(import.meta.dir, "../test-ui/readiness-controller-swap-repaired-qa.tsx");
  const adapter = resolve(import.meta.dir, "../test-ui/controller-swap-repaired-fixture.ts");
  const build = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife", minify: false,
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    plugins: [{ name: "frozen-candidate-only", setup(builder) {
      builder.onResolve({ filter: /^\.\.\/(src\/(controller|react)|test\/fixture)$/ }, args => {
        if (args.importer !== entry && args.importer !== adapter) return;
        return { path: resolve(root, args.path.slice(3) + (args.path.endsWith("react") ? ".tsx" : ".ts")) };
      });
    } }],
  });
  if (!build.success) throw new AggregateError(build.logs);
  const script = new Uint8Array(await build.outputs[0]!.arrayBuffer());
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Repaired QA controller switch</title><style>${await Bun.file(resolve(root, "src/styles.css")).text()}body{font:14px system-ui;padding:24px;max-width:1000px;margin:auto}main{height:650px}output{display:block;white-space:pre-wrap;background:#eef2f6;padding:12px}</style></head><body><div id="root"></div><script src="/lab.js"></script></body></html>`;
  const files: Record<string, string> = {};
  for (const [relative, original] of [
    ["qa-source/test-ui/readiness-controller-swap-repaired-qa.tsx", entry],
    ["qa-source/test-ui/controller-swap-repaired-fixture.ts", adapter],
    ["qa-source/scripts/serve-controller-swap-repaired-qa.ts", import.meta.filename],
  ]) {
    const bytes = new Uint8Array(await Bun.file(original!).arrayBuffer());
    await Bun.write(resolve(output, relative!), bytes); files[relative!] = hash(bytes);
  }
  await Bun.write(resolve(output, "lab.js"), script); files["lab.js"] = hash(script);
  await Bun.write(resolve(output, "index.html"), html); files["index.html"] = hash(html);
  const receipt = { status: "OFFLINE_FROZEN_LIVE_PENDING", candidateCommit: manifest.commit,
    candidateManifestHash: await fileHash(manifestPath), candidateRoot: root, sources, files,
    fixtureInputs: { directory: "/hidden", sessionID: "ses1", modelPath: "/proxy/api/session/ses1/model",
      method: "POST", body: { model: { providerID: "p", id: "m or m2" } },
      models: ["Model · p", "QA Model Two · p"], releaseStatus: 204,
      rejection: "injected transport Error", activation: "unmodified frozen fixture HTTP 204" },
  };
  await Bun.write(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ receiptPath, ...receipt }));
} else {
  const receipt = await Bun.file(receiptPath).json();
  if (receipt.candidateRoot !== root || receipt.candidateManifestHash !== await fileHash(manifestPath) ||
      Object.keys(receipt.sources).length !== Object.keys(sources).length ||
      Object.entries(sources).some(([file, value]) => receipt.sources[file] !== value))
    throw new Error("Frozen candidate receipt mismatch");
  for (const [file, expected] of Object.entries(receipt.files))
    if (await fileHash(resolve(output, file)) !== expected) throw new Error(`Frozen harness mismatch: ${file}`);
  if (await fileHash(import.meta.filename) !== receipt.files["qa-source/scripts/serve-controller-swap-repaired-qa.ts"])
    throw new Error("Server must match frozen server bytes");
  const script = new Uint8Array(await Bun.file(resolve(output, "lab.js")).arrayBuffer());
  const html = await Bun.file(resolve(output, "index.html")).text();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/lab.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response("Not found", { status: 404 });
  } });
  const serving = { status: "LIVE_PENDING", origin: String(server.url), pid: process.pid,
    freezeReceiptHash: await fileHash(receiptPath), bundleHash: hash(script), htmlHash: hash(html),
    candidateCommit: receipt.candidateCommit };
  const serveReceipt = resolve(output, `serve-receipt-${process.pid}-${Date.now()}.json`);
  await Bun.write(serveReceipt, JSON.stringify(serving, null, 2));
  console.log(JSON.stringify({ serveReceipt, ...serving }));
}
