// Bundle runtime/src/sqlite for native Node and return the module factory
// bound to the node:fs backend. Used by every harness in this directory.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const wasmPath = process.env.BAT_SQLITE_WASM ?? join(here, "..", "sqlite3.wasm");

export async function loadSqlite({ fsync = true, precompiled = false } = {}) {
  const out = join(here, ".build");
  mkdirSync(out, { recursive: true });
  execFileSync("bun", ["build", join(here, "entry-node.ts"), "--target=node", "--format=esm", `--outfile=${join(out, "sqlite-node.mjs")}`], { stdio: ["ignore", "ignore", "inherit"] });
  const { createSqliteModule, createNodeBackend } = await import(pathToFileURL(join(out, "sqlite-node.mjs")).href);
  const backend = createNodeBackend({ fsync });
  const bytes = readFileSync(wasmPath);
  const wasm = precompiled ? new WebAssembly.Module(bytes) : bytes;
  return { sqlite: createSqliteModule(backend, { wasm }), backend, wasmBytes: bytes.length };
}
