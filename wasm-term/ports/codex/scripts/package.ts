// Turns built modules into what the dev page serves: dist/site/<name>-<hash>.wasm
// plus .br and .gz next to it, and dist/site/manifest.json that says which
// file is current. The hash in the name is of the module's bytes, so the URL
// can be cached forever and a rebuild is a new URL.
//
//   bun scripts/package.ts [--quality N] [--site DIR] <build>=<path.wasm>...
//   bun scripts/package.ts default=dist/codex-ship.wasm names=dist/codex.wasm
//   bun scripts/package.ts --site dist/site-local default=dist/codex-local-ship-opt.wasm   (the codex-local guest)
//
// `default` is what `?guest=codex` loads; other builds are `&build=<name>`
// (`names` keeps the name section, for profiling and readable traps).
// Compression is done once here, not per request: brotli for browsers (all of
// them accept it over https and on localhost), gzip as the fallback.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export interface PackagedBuild {
  /** File name in dist/site, also the last segment of its URL. */
  file: string;
  /** sha-256 of the module, hex. */
  hash: string;
  size: number;
  br: number;
  gz: number;
}
export type Manifest = Record<string, PackagedBuild>;

let site = join(import.meta.dir, "../dist/site");
const argv = process.argv.slice(2);
let quality = 9;
const builds: [string, string][] = [];
while (argv.length) {
  const arg = argv.shift()!;
  if (arg === "--quality") quality = Number(argv.shift());
  else if (arg === "--site") site = join(import.meta.dir, "..", argv.shift()!);
  else builds.push([arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]);
}
if (!builds.length) throw new Error("usage: bun scripts/package.ts [--quality N] [--site DIR] <build>=<path.wasm>...");

mkdirSync(site, { recursive: true });
const manifestPath = join(site, "manifest.json");
const manifest: Manifest = (await Bun.file(manifestPath).exists()) ? await Bun.file(manifestPath).json() : {};

for (const [name, path] of builds) {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  const file = `codex-${hash.slice(0, 16)}.wasm`;
  const target = join(site, file);
  if (!(await Bun.file(`${target}.br`).exists())) {
    await Bun.write(target, bytes);
    const started = performance.now();
    await Bun.write(`${target}.br`, brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
    }));
    await Bun.write(`${target}.gz`, gzipSync(bytes, { level: 6 }));
    console.log(`compressed ${file} in ${((performance.now() - started) / 1000).toFixed(0)} s`);
  }
  manifest[name] = { file, hash, size: bytes.length, br: statSync(`${target}.br`).size, gz: statSync(`${target}.gz`).size };
  const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
  console.log(`${name}: ${file}  ${mb(bytes.length)}  br ${mb(manifest[name]!.br)}  gz ${mb(manifest[name]!.gz)}`);
}
await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// Files no build points at any more.
const current = new Set(Object.values(manifest).flatMap(build => [build.file, `${build.file}.br`, `${build.file}.gz`]));
for (const entry of readdirSync(site)) {
  if (entry !== "manifest.json" && !current.has(entry)) rmSync(join(site, entry));
}
