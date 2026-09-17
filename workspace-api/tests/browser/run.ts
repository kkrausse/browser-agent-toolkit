import { resolve, sep } from "node:path";
import { readRuntimeAssets } from "../../src/assets.js";

const root = resolve(import.meta.dir, "../..");
const runtimeDir = resolve(process.env.RUNTIME_DIR ?? resolve(root, "dist/runtime"));
const manifest = await readRuntimeAssets(runtimeDir);
const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "page.ts")], target: "browser", format: "esm" });
if (!build.success) throw new AggregateError(build.logs, "Browser test build failed");
const script = await build.outputs[0].text();
const session = `workspace-tests-${crypto.randomUUID()}`;
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Service-Worker-Allowed": "/",
  "Cache-Control": "no-store",
};
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/events" && request.method === "POST") {
      const { kind, detail } = await request.json();
      console.log(`[browser:${kind}]`, typeof detail === "string" ? detail : JSON.stringify(detail));
      return new Response(null, { headers });
    }
    if (url.pathname === "/distribution") return Response.json({ name: manifest.name, version: manifest.version, assetBaseUrl: "/runtime" }, { headers });
    if (url.pathname === "/page.js") return new Response(script, { headers: { ...headers, "Content-Type": "text/javascript" } });
    if (url.pathname === "/") return new Response('<!doctype html><title>Workspace browser contracts</title><body><script type="module" src="/page.js"></script>', { headers: { ...headers, "Content-Type": "text/html" } });
    if (url.pathname.startsWith("/runtime/")) {
      const path = resolve(runtimeDir, decodeURIComponent(url.pathname.slice("/runtime/".length)));
      if (!path.startsWith(runtimeDir + sep)) return new Response(null, { status: 403, headers });
      const file = Bun.file(path);
      if (await file.exists()) return new Response(file, { headers });
    }
    return new Response("Not found", { status: 404, headers });
  },
});

async function cli(args: string[], timeout = 90_000) {
  const child = Bun.spawn(["browser-control", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`browser-control exit ${code}\n${stderr}\n${stdout}`);
    return stdout;
  } finally { clearTimeout(timer); }
}
async function execute(code: string) {
  const result = JSON.parse(await cli(["execute", "--json", "--session", session, code]));
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

async function clearOwnedStorage() {
  // Navigation terminates leftover workers even when a test timed out.
  await execute(`
    await page.goto(${JSON.stringify(server.url.toString())});
    return await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
      return 'test-owned storage removed';
    });
  `);
}

let ownsStorage = false;
let failed = false;
try {
  console.log(`Runtime ${manifest.version}\nBrowser ${server.url}\nSession ${session}`);
  await cli(["session", "new", session]);
  const cases = await execute(`
    await page.goto(${JSON.stringify(server.url.toString())});
    await page.waitForFunction(() => !!window.browserTests);
    return await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const entry of root.values()) throw new Error('Refusing existing OPFS storage: ' + entry.name);
      return window.browserTests.cases;
    });
  `) as { name: string; steps: number }[];
  ownsStorage = true;
  for (const [index, test] of cases.entries()) {
    if (index > 0) await clearOwnedStorage();
    console.log(`TEST ${test.name}`);
    for (let step = 0; step < test.steps; step++) {
      const result = await execute(`
        await page.reload();
        await page.waitForFunction(() => !!window.browserTests);
        return await page.evaluate(async () => {
          let timer;
          try {
            return await Promise.race([
              window.browserTests.run(${index}, ${step}),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test step timed out')), 45000); })
            ]);
          } finally { clearTimeout(timer); }
        });
      `);
      if (!result.ok) throw new Error(`${test.name}: ${result.error}`);
    }
    console.log(`PASS ${test.name}`);
  }
} catch (error) {
  failed = true;
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    if (ownsStorage) await clearOwnedStorage();
  } catch (error) { console.error("Storage cleanup failed", error); process.exitCode = 1; }
  try { await cli(["session", "delete", session]); }
  catch (error) { console.error("Session cleanup failed", error); process.exitCode = 1; }
  await server.stop(true);
  if (!failed && !process.exitCode) console.log("All browser contracts passed; test session and storage cleaned up.");
}
