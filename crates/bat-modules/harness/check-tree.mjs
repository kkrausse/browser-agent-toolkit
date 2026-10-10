// Transform every module file under DIR with the Wasm build and compile the
// result with V8 inside the loader's wrapper (compile only, nothing runs).
// Catches any edit that produced invalid JavaScript.
//
//   node check-tree.mjs DIR

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createTransform } from "../js/transform.ts";

const here = dirname(fileURLToPath(import.meta.url));
const transform = await createTransform(readFileSync(join(here, "../js/bat_modules.wasm")));
const root = process.argv[2];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && /\.(c|m)?(j|t)sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) yield path;
  }
}

const types = new Map();
function packageType(dir) {
  if (types.has(dir)) return types.get(dir);
  let type;
  const file = join(dir, "package.json");
  if (existsSync(file)) {
    try { type = JSON.parse(readFileSync(file, "utf8")).type; } catch {}
  } else if (dirname(dir) !== dir && !dir.endsWith("/node_modules")) type = packageType(dirname(dir));
  types.set(dir, type);
  return type;
}

const count = { files: 0, cjs: 0, esm: 0, async: 0, rejected: 0, invalid: 0, ms: 0 };
for (const path of walk(root)) {
  const source = readFileSync(path, "utf8");
  count.files++;
  const type = packageType(dirname(path));
  const start = performance.now();
  const out = transform(source, path, { packageType: type === "module" || type === "commonjs" ? type : undefined });
  count.ms += performance.now() - start;
  if (!out.ok) {
    count.rejected++;
    if (count.rejected <= 15) console.log(`REJECTED ${path}\n   ${out.diagnostics[0]?.line}:${out.diagnostics[0]?.column} ${out.diagnostics[0]?.message}`);
    continue;
  }
  const { kind } = out.facts;
  count[kind === "esm" ? "esm" : "cjs"]++;
  if (out.facts.async) count.async++;
  const head = kind === "esm" ? `(${out.facts.async ? "async " : ""}function* (__bat) {` : "(function (exports, require, module, __filename, __dirname, __bat) {";
  try {
    new vm.Script(`${head}${out.code}\n})`, { filename: path });
  } catch (error) {
    count.invalid++;
    if (count.invalid <= 15) console.log(`INVALID ${path}\n   ${error.message}`);
  }
}
console.log(
  `${count.files} files in ${count.ms.toFixed(0)} ms (single-threaded Wasm): ${count.cjs} cjs, ${count.esm} esm (${count.async} async), ${count.rejected} rejected by the transform, ${count.invalid} whose output V8 refuses`,
);
process.exit(count.invalid ? 1 : 0);
