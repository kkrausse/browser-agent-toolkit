// Stress test: run the OpenCode 2.0.3 server bundle (one 27.7 MB ES module
// with a top-level await) through the Wasm transform and the reference loader
// on native Node, until it listens, then ask it for /api/health and stop it.
//
//   node --experimental-import-meta-resolve opencode.mjs [DIR_WITH_server.js]
//
// The server gets a throwaway HOME/XDG tree and database under the system
// temp directory. It binds 127.0.0.1:4096 (fixed in the bundle).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory =
  process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ??
  "/home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit/vivari/.runtime/opencode-release-2.0.3/.runtime/opencode-bun-server";

if (process.argv.includes("--child")) {
  const { createLoader } = await import("./loader.mjs");
  const { createNodeHost } = await import("./node-host.mjs");
  const start = performance.now();
  const host = await createNodeHost({
    onTransform: (id, out) =>
      console.log(
        `HARNESS transformed ${id.split("/").pop()}: ${out.facts.kind}, async=${out.facts.async}, ${out.code.length} chars, ${out.facts.imports.length} static imports, in ${host.stats.ms.toFixed(0)} ms (Wasm)`,
      ),
  });
  const loader = createLoader(host);
  process.chdir(directory);
  await loader.runMain(join(directory, "server.js"));
  console.log(`HARNESS main module finished after ${(performance.now() - start).toFixed(0)} ms`);
} else {
  const scratch = mkdtempSync(join(tmpdir(), "bat-opencode-"));
  const password = "harness-password";
  const child = spawn(process.execPath, ["--experimental-import-meta-resolve", fileURLToPath(import.meta.url), "--child", directory], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      PATH: process.env.PATH,
      HOME: join(scratch, "home"),
      OPENCODE_TEST_HOME: join(scratch, "home"),
      XDG_CONFIG_HOME: join(scratch, "config"),
      XDG_STATE_HOME: join(scratch, "state"),
      XDG_DATA_HOME: join(scratch, "data"),
      XDG_CACHE_HOME: join(scratch, "cache"),
      TMPDIR: scratch,
      OPENCODE_PASSWORD: password,
      OPENCODE_DATABASE_PATH: join(scratch, "opencode.sqlite"),
      OPENCODE_TREE_SITTER_WASM_PATH: join(directory, "tree-sitter.wasm"),
      OPENCODE_TREE_SITTER_BASH_WASM_PATH: join(directory, "tree-sitter-bash.wasm"),
      OPENCODE_TREE_SITTER_POWERSHELL_WASM_PATH: join(directory, "tree-sitter-powershell.wasm"),
    },
  });
  const started = performance.now();
  let output = "";
  let result = "FAIL: exited before OPENCODE_SERVER_PROCESS_READY";
  const timer = setTimeout(() => {
    result = "FAIL: no OPENCODE_SERVER_PROCESS_READY within 60 s";
    child.kill("SIGKILL");
  }, 60_000);
  child.stdout.on("data", async (chunk) => {
    const before = output.length;
    output += chunk;
    process.stdout.write(chunk);
    if (!output.slice(Math.max(0, before - 40)).includes("OPENCODE_SERVER_PROCESS_READY") || result.startsWith("PASS")) return;
    const ready = performance.now() - started;
    try {
      const response = await fetch("http://127.0.0.1:4096/api/health", {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      });
      const body = await response.text();
      result = `${response.ok ? "PASS" : "FAIL"}: listening after ${ready.toFixed(0)} ms; GET /api/health -> ${response.status} ${body.slice(0, 200)}`;
    } catch (error) {
      result = `FAIL: ready after ${ready.toFixed(0)} ms but /api/health failed: ${error}`;
    }
    child.stdin.end(); // the server shuts down when stdin ends
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  });
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    rmSync(scratch, { recursive: true, force: true });
    console.log(`${result} (child exit ${code ?? signal})`);
    process.exit(result.startsWith("PASS") ? 0 : 1);
  });
}
