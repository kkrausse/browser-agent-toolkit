// Prototype server, loopback only, port 4797. Cross-origin isolated like
// wasm-term's own (SharedArrayBuffer needs it). Bundles the page and the two
// Worker entries on every page load.
//
//   BAT_SH_WASM=<bat-rust>/crates/bat-sh/js/bat_sh.wasm bun web/server.ts

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

const here = import.meta.dir;
const root = join(here, "../../..");
const port = Number(process.env.PORT ?? 4797);
const files: Record<string, [string, string]> = {
  "/kernel.wasm": [join(root, "kernel/target/wasm32-unknown-unknown/release/wasm_term_kernel.wasm"), "application/wasm"],
  "/guest.wasm": [join(here, "../guest/target/wasm32-wasip1/release/shell-proto-guest.wasm"), "application/wasm"],
  "/bat_sh.wasm": [process.env.BAT_SH_WASM ?? "/home/kkrausse/devfs/repos/kkrausse/bat-rust/.claude/worktrees/codex-shell/crates/bat-sh/js/bat_sh.wasm", "application/wasm"],
};
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};
const respond = (body: BodyInit, type: string, status = 200) => new Response(body, { status, headers: { ...isolation, "Content-Type": type } });

async function bundle(): Promise<Map<string, Blob>> {
  const result = await Bun.build({
    entrypoints: [join(here, "page.ts"), join(here, "../host/guest-worker.ts"), join(here, "../host/shell-worker.ts")],
    target: "browser",
    format: "esm",
    sourcemap: "inline",
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle failed");
  return new Map(result.outputs.map(output => [`/${basename(output.path)}`, output as Blob]));
}
let bundles = await bundle();

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") {
      bundles = await bundle();
      return respond(Bun.file(join(here, "index.html")), "text/html; charset=utf-8");
    }
    const bundled = bundles.get(path);
    if (bundled) return respond(bundled, "text/javascript");
    const entry = files[path];
    if (entry) return existsSync(entry[0]) ? respond(Bun.file(entry[0]), entry[1]) : respond(`not built: ${entry[0]}\n`, "text/plain", 404);
    return respond("not found\n", "text/plain", 404);
  },
});
console.log(`shell-proto on http://127.0.0.1:${port}/`);
